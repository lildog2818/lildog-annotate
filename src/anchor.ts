/**
 * 把「用户在界面上选中的一段」翻译成「源码里的绝对偏移」。
 *
 * 这是整个插件唯一允许决定「批注写哪儿」的地方。规则只有一条：
 * **算得准才算数，算不准就拒绝**（返回 ok:false + 一句人话），绝不退回
 * 「在全文里按文字就近猜」—— 那正是「批注跳到别的位置」的来源。
 *
 * 四条路径，按可靠性排序：
 *   1. 编辑器普通选区：Obsidian 编辑器选区本身就是源码偏移，最准；
 *   2. 编辑器里的 DOM 选区：让 CodeMirror 把 DOM 位置换算成偏移（含代码块、公式）；
 *   3. 表格单元格：DOM 里第几行第几格 → 源码里第几行第几格（表格行在源码里就是一行，
 *      行列号能一一对应），格子内部再按「渲染文字 ↔ 源码文字」的映射表精确定位；
 *   4. 阅读视图：没有 CodeMirror，只能按文字找，但**按出现次序对号入座**（第 n 次
 *      出现配第 n 次出现），次序对不上就拒绝。
 *
 * 表格格外小心的原因：标记多包住一个没转义的 `|` 就会多切一格，包住整行更是会让
 * 那一行以 `<!--` 开头、按 GFM 直接把表格截断。
 */

import { Editor, MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";
import { MARKER, normalizeForCompare } from "./format";
import {
	cellAtOffset,
	cellLocation,
	isOffsetOnDelimiterRow,
	lineOffsets,
	lineOfOffset,
	tableBlockAt,
} from "./tablemap";
import type { CellLocation } from "./tablemap";
import {
	collapseWhitespace,
	countOccurrences,
	findNearestOccurrence,
	mapRangeToSource,
	nthOccurrenceIndex,
	stripInlineWithMap,
} from "./textmap";

/** 定位成功：一段可以用源码偏移写入的原文 */
export interface ResolvedAnchor {
	view: MarkdownView;
	/** 被批注的原文（源码里的那一段，包含里面看不见的行内语法） */
	text: string;
	fromOffset: number;
	toOffset: number;
	/** 位置是怎么定出来的（写进自检报告，出问题不用猜） */
	how: string;
	/** 锚点落在表格行里：批注正文里的 `|` 要转义 */
	inTable: boolean;
	/** 选区跨了单元格：行内批注不允许，得降级成段落批注 */
	crossCell: boolean;
	/**
	 * 锚点落在表格里时记下「第几行第几格」（0 起行号）。
	 * Obsidian 的表格编辑器会把你点过的格子提交一次、顺手把整张表重排（补齐空格），
	 * 于是弹窗期间偏移就过期了 —— 记着格号，提交时能在**同一格**里重新对位。
	 */
	cell?: { line: number; col: number };
}

export type AnchorResult =
	| { ok: true; anchor: ResolvedAnchor }
	| { ok: false; reason: string; hint: string };

function refuse(reason: string, hint: string): AnchorResult {
	return { ok: false, reason, hint };
}

function elementOf(node: Node | null): Element | null {
	if (!node) return null;
	if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
	return node.parentElement;
}

/**
 * 元素所在的表格单元格（不在格子里就 null）。
 * 刻意用 `Element` 而不是 `HTMLElement`，并容忍「长得像元素但没实现全套 DOM」的对象：
 * 这份代码在无 DOM 的测试环境里也要能加载。
 */
function cellOf(el: Element | null): Element | null {
	if (!el || typeof el.closest !== "function") return null;
	return el.closest("td, th") ?? null;
}

function hasClass(el: Element, name: string): boolean {
	const list = el.classList;
	return !!list && typeof list.contains === "function" && list.contains(name);
}

/** 选区起点在某个元素内容里的字符偏移（拿不到就 null） */
function offsetWithin(container: Element, node: Node, offset: number): number | null {
	try {
		const before = document.createRange();
		before.selectNodeContents(container);
		before.setEnd(node, offset);
		return before.toString().length;
	} catch {
		return null;
	}
}

/**
 * 最外层的 CodeMirror 视图。
 * 表格的格子被点开时，Obsidian 会在格子里塞一个**嵌套的** CodeMirror 编辑器，
 * 那种情况下最近的 `.cm-editor` 是里面那层，而我们要的是外面那层（源码那层）。
 */
function outerCmView(el: Element): EditorView | null {
	if (typeof el.closest !== "function") return null;
	const nearest = el.closest(".cm-editor");
	if (!nearest) return null;

	let outer: Element = nearest;
	let node: Element | null = nearest.parentElement ?? null;
	while (node) {
		if (hasClass(node, "cm-editor")) outer = node;
		node = node.parentElement ?? null;
	}
	return (
		EditorView.findFromDOM(outer as HTMLElement) ??
		EditorView.findFromDOM(nearest as HTMLElement)
	);
}

/** 外面那层 CodeMirror 视图（表格格子里的嵌套编辑器不算） */
export function findOuterCmView(el: Element): EditorView | null {
	return outerCmView(el);
}

/**
 * DOM 里的这一格在源码里对应哪一格。
 * 渲染时一行表格 ↔ 源码里一行，所以「第几行第几格」可以一一对应，
 * 表格 widget 的源码起点从 CodeMirror 拿 —— 不猜、不按文字找。
 */
export function locateCell(
	doc: string,
	cellEl: Element,
): { ok: true; loc: CellLocation } | { ok: false; reason: string } {
	const cmView = outerCmView(cellEl);
	if (!cmView) return { ok: false, reason: "这张表在阅读视图里，拿不到源码位置" };

	let widgetFrom: number;
	try {
		widgetFrom = cmView.posAtDOM(cellEl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `表格位置换算失败（${message}）` };
	}

	const lines = doc.split("\n");
	const headerLine = lineOfOffset(lineOffsets(doc), widgetFrom);
	const block = tableBlockAt(lines, headerLine);
	if (!block || block.headerLine !== headerLine) {
		return { ok: false, reason: "表格在源码里的位置对不上" };
	}

	const tableEl = cellEl.closest("table");
	const rowEl = cellEl.closest("tr");
	if (!tableEl || !rowEl) return { ok: false, reason: "这一格不在表格里" };
	const rowIndex = Array.prototype.indexOf.call(tableEl.rows, rowEl);
	const colIndex = Array.prototype.indexOf.call(rowEl.cells, cellEl);
	if (rowIndex < 0 || colIndex < 0) return { ok: false, reason: "数不出这一格是第几行第几列" };

	// 渲染出来的表**没有** `| --- |` 那一行：DOM 第 0 行是表头，第 1 行才是第一条数据行，
	// 而源码里表头下面紧跟着分隔行。少算这一行就会把「甲」那行读成分隔行。
	const sourceLine = rowIndex === 0 ? block.headerLine : block.headerLine + rowIndex + 1;
	const loc = cellLocation(doc, sourceLine, colIndex);
	if (!loc) {
		return { ok: false, reason: `表格第 ${rowIndex + 1} 行第 ${colIndex + 1} 格在源码里找不到` };
	}
	return { ok: true, loc };
}

/** 元素所在的表格单元格（不在格子里就 null） */
export function cellElementOf(el: Element | null): Element | null {
	return cellOf(el);
}

/** 定位结果必须跟选中的文字对得上，否则一律拒绝（宁可失败，也不写错地方） */
function verifySlice(doc: string, from: number, to: number, needle: string): boolean {
	if (from < 0 || to > doc.length || to <= from) return false;
	// 别人的批注标记不能被吞进来（标记一定含 `<!--`；正文里出现「lildog」这个词不算）
	if (doc.slice(from, to).includes("<!--")) return false;
	return normalizeForCompare(doc.slice(from, to)) === normalizeForCompare(needle);
}

function buildAnchor(
	view: MarkdownView,
	doc: string,
	fromOffset: number,
	toOffset: number,
	how: string,
	inTable: boolean,
	crossCell: boolean,
	cell?: { line: number; col: number },
): AnchorResult {
	const text = doc.slice(fromOffset, toOffset);
	if (!text.trim()) {
		return refuse("选中的是空白", "请选中有文字的部分");
	}
	return {
		ok: true,
		anchor: { view, text, fromOffset, toOffset, how, inTable, crossCell, cell },
	};
}

/**
 * 偏移过期了，但原文没变：在**同一格**里按文字重新对位。
 *
 * 什么时候会过期：表格格子被点开时 Obsidian 会在格子里开嵌套编辑器，弹窗一抢焦点它就
 * 把这一格提交、顺手把整张表重排（每列补空格对齐），行内偏移整体平移。
 * 这里只在那一格里找，找不到、或者格里有重复文字认不准，就返回 null（调用方据此拒绝写入）。
 */
export function reanchorInCell(
	doc: string,
	cell: { line: number; col: number },
	text: string,
): { from: number; to: number } | null {
	const loc = cellLocation(doc, cell.line, cell.col);
	if (!loc || !text) return null;
	if (loc.text === text) return { from: loc.from, to: loc.to };

	// 1) 原文能在这格里唯一找到（格子在编辑态时选中的就是源码原文）
	const rawAt = loc.text.indexOf(text);
	if (rawAt !== -1 && loc.text.indexOf(text, rawAt + 1) === -1) {
		return { from: loc.from + rawAt, to: loc.from + rawAt + text.length };
	}

	// 2) 按渲染后的文字对位（剥掉 `**` 这类记号）
	const flat = stripInlineWithMap(loc.text);
	const needle = collapseWhitespace(text);
	const hit = findNearestOccurrence(flat.text, needle, 0);
	if (!hit || hit.matches > 1) return null;
	const mapped = mapRangeToSource(loc.text, flat, hit.index, needle.length);
	if (!mapped) return null;
	return { from: loc.from + mapped.from, to: loc.from + mapped.to };
}

// ---------------------------------------------------------------- 表格

interface CellContext {
	loc: CellLocation;
	cellEl: Element;
}

/** DOM 里的这一格，对应源码里的哪一行哪一格 */
function cellContextFor(
	editor: Editor,
	cellEl: Element,
): { ok: true; ctx: CellContext } | { ok: false; reason: string; hint: string } {
	const located = locateCell(editor.getValue(), cellEl);
	if (!located.ok) {
		return {
			ok: false,
			reason: located.reason,
			hint: "请先点一下表格让它进入编辑态，再选中文字；实在不行重新点一次格子",
		};
	}
	return { ok: true, ctx: { loc: located.loc, cellEl } };
}

/** 选区在同一格内部：把「渲染后的文字」映射回「这一格的源码」 */
function resolveWithinCell(
	view: MarkdownView,
	editor: Editor,
	range: Range,
	ctx: CellContext,
): AnchorResult {
	const doc = editor.getValue();
	const raw = ctx.loc.text;
	const needle = collapseWhitespace(range.toString());
	if (!needle) return refuse("选中的是空白", "请选中有文字的部分");

	// 格子被点开时里面是一个嵌套编辑器，显示的是**源码**（`**粗体**`），
	// 而渲染态显示的是渲染后的文字；提示位置按当前实际显示的那一层算才准。
	const container = ctx.cellEl.querySelector(".cm-content") ?? ctx.cellEl;
	const domStart = offsetWithin(container, range.startContainer, range.startOffset) ?? 0;
	const flat = stripInlineWithMap(raw);

	let mapped: { from: number; to: number } | null = null;
	let how = "";

	const byRendered = findNearestOccurrence(flat.text, needle, domStart);
	if (byRendered) {
		mapped = mapRangeToSource(raw, flat, byRendered.index, needle.length);
		if (mapped) {
			how =
				byRendered.matches > 1
					? `单元格内按渲染文字命中（这一格里有 ${byRendered.matches} 处相同）`
					: "单元格内按渲染文字命中";
		}
	}
	if (!mapped) {
		// 格子正处在编辑态时，DOM 里显示的就是源码本身
		const bySource = findNearestOccurrence(raw, needle, domStart);
		if (bySource) {
			mapped = { from: bySource.index, to: bySource.index + needle.length };
			how = "单元格内按源码文字命中";
		}
	}
	if (!mapped) {
		return refuse(
			"这一格里认不出选中的文字",
			"请只选格子里的文字（含公式、粗体时可以先点一下格子再选）",
		);
	}

	const fromOffset = ctx.loc.from + mapped.from;
	const toOffset = ctx.loc.from + mapped.to;
	if (!verifySlice(doc, fromOffset, toOffset, needle)) {
		return refuse("定位结果跟选中的文字对不上", "请重新选中要批注的文字");
	}
	return buildAnchor(view, doc, fromOffset, toOffset, how, true, false, {
		line: ctx.loc.line,
		col: ctx.loc.col,
	});
}

/** 选区跨了单元格：行内批注不允许，整段交给段落批注（落点在整张表之后） */
function resolveAcrossCells(
	view: MarkdownView,
	editor: Editor,
	startCellEl: Element,
	endCellEl: Element,
): AnchorResult {
	const tableEl = startCellEl.closest("table");
	if (!tableEl || tableEl !== endCellEl.closest("table")) {
		return refuse("选区跨了两张表格", "请在一张表里选，或者分开批注");
	}
	const start = cellContextFor(editor, startCellEl);
	if (!start.ok) return start;
	const end = cellContextFor(editor, endCellEl);
	if (!end.ok) return end;

	const fromOffset = Math.min(start.ctx.loc.from, end.ctx.loc.from);
	const toOffset = Math.max(start.ctx.loc.to, end.ctx.loc.to);
	const doc = editor.getValue();
	return buildAnchor(
		view,
		doc,
		fromOffset,
		toOffset,
		`跨单元格（第 ${start.ctx.loc.col + 1} 格 → 第 ${end.ctx.loc.col + 1} 格）`,
		true,
		true,
		{ line: start.ctx.loc.line, col: start.ctx.loc.col },
	);
}

// ---------------------------------------------------------------- 非表格的块

/**
 * 公式 / 代码块这类被替换成 widget 的内容。
 * 位置从 widget 自己的源码起点开始找（不再是全文乱找），找不到就拒绝。
 */
function resolveWidgetText(
	view: MarkdownView,
	editor: Editor,
	cmView: EditorView,
	el: Element,
	range: Range,
): AnchorResult {
	const doc = editor.getValue();
	const needle = collapseWhitespace(range.toString());
	if (!needle) return refuse("选中的是空白", "请选中有文字的部分");

	let from: number;
	try {
		from = cmView.posAtDOM(el);
	} catch {
		return refuse("这个块的位置换算失败", "请先点一下它展开成源码，再选中文字");
	}

	const windowText = doc.slice(from, Math.min(doc.length, from + Math.max(needle.length * 4, 240)));
	const flat = stripInlineWithMap(windowText);
	const hit = findNearestOccurrence(flat.text, needle, 0);
	const mapped = hit ? mapRangeToSource(windowText, flat, hit.index, needle.length) : null;
	if (!mapped) {
		return refuse("这个块里认不出选中的文字", "请先点一下它展开成源码，再选中文字");
	}

	const fromOffset = from + mapped.from;
	const toOffset = from + mapped.to;
	if (!verifySlice(doc, fromOffset, toOffset, needle)) {
		return refuse("定位结果跟选中的文字对不上", "请先点一下它展开成源码，再选中文字");
	}
	return buildAnchor(view, doc, fromOffset, toOffset, "块级 widget 内按文字命中", false, false);
}

// ---------------------------------------------------------------- 阅读视图

function resolveReadingView(
	view: MarkdownView,
	editor: Editor,
	range: Range,
): AnchorResult {
	const doc = editor.getValue();
	const needle = collapseWhitespace(range.toString());
	if (!needle) return refuse("选中的是空白", "请选中有文字的部分");

	const startEl = elementOf(range.startContainer);
	const endEl = elementOf(range.endContainer);
	const sectionEl = (startEl?.closest("[data-lildog-start]") ??
		endEl?.closest("[data-lildog-start]")) as HTMLElement | null;
	if (!sectionEl) {
		return refuse("阅读视图里认不出这段属于哪一段", "请改用编辑器（阅读视图里定位要靠段落行号）");
	}

	const startLine = Number(sectionEl.dataset.lildogStart);
	const endLine = Number(sectionEl.dataset.lildogEnd);
	if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
		return refuse("这一段没有行号，认不出它在源码里的位置", "请改用编辑器批注");
	}

	const offsets = lineOffsets(doc);
	const sectionFrom = offsets[startLine] ?? 0;
	const sectionTo = offsets[endLine + 1] ?? doc.length;
	const sectionSource = doc.slice(sectionFrom, sectionTo);
	const flat = stripInlineWithMap(sectionSource);

	// 选区在「这一段渲染出来的文字」里是第几次出现？
	const domBefore = offsetWithin(sectionEl, range.startContainer, range.startOffset) ?? 0;
	const renderedBefore = collapseWhitespace((sectionEl.textContent ?? "").slice(0, domBefore));
	const ordinal = countOccurrences(renderedBefore, needle);

	const index = nthOccurrenceIndex(flat.text, needle, ordinal);
	if (index === null) {
		return refuse(
			"这段文字在这一段里出现了多次，认不准是哪一处",
			"请在编辑器里选中后再批注（阅读视图只能按出现次序配对）",
		);
	}

	const mapped = mapRangeToSource(sectionSource, flat, index, needle.length);
	if (!mapped) {
		return refuse("这段文字在源码里的位置不连续", "请在编辑器里选中后再批注");
	}

	const fromOffset = sectionFrom + mapped.from;
	const toOffset = sectionFrom + mapped.to;
	if (!verifySlice(doc, fromOffset, toOffset, needle)) {
		return refuse("定位结果跟选中的文字对不上", "请在编辑器里选中后再批注");
	}

	const inTable = tableBlockAt(doc.split("\n"), lineOfOffset(offsets, fromOffset)) !== null;
	return buildAnchor(
		view,
		doc,
		fromOffset,
		toOffset,
		`阅读视图里第 ${ordinal + 1} 次出现`,
		inTable,
		false,
	);
}

// ---------------------------------------------------------------- 对外

/**
 * 这条 DOM 选区落在表格单元格里吗。
 * 落在格子里就别用编辑器选区 —— 表格是块级 widget，编辑器选区很可能还停在别处，
 * 那正是「批注写到别的位置」的老路。
 */
export function isCellSelection(range: Range | null): boolean {
	if (!range) return false;
	const el = elementOf(range.startContainer) ?? elementOf(range.endContainer);
	return !!cellOf(el);
}

/** 当前浏览器选区，折叠或没有就返回 null */
export function currentDomRange(): Range | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	return selection.getRangeAt(0);
}

/**
 * 编辑器普通选区 → 源码偏移。
 * 返回 null 表示「这条路径不适用」（没有编辑器选区，或者选区是旧的 / 跟 DOM 里选中的
 * 不是同一段），调用方接着走 DOM 那条路，而不是拿旧选区去写。
 */
export function resolveEditorSelection(
	view: MarkdownView,
	editor: Editor,
	domText: string,
): AnchorResult | null {
	if (!editor.somethingSelected()) return null;
	const doc = editor.getValue();
	const fromOffset = editor.posToOffset(editor.getCursor("from"));
	const toOffset = editor.posToOffset(editor.getCursor("to"));
	const slice = doc.slice(fromOffset, toOffset);
	// 旧选区（比如鼠标正在表格 widget 里选字，编辑器选区还停在别处）必须挡掉：
	// 文字相同还不够，得跟 DOM 里选中的那段对得上
	if (!domText.trim()) return null;
	if (normalizeForCompare(slice) !== normalizeForCompare(domText)) return null;
	if (!verifySlice(doc, fromOffset, toOffset, domText)) return null;
	const line = editor.offsetToPos(fromOffset).line;
	const inTable = tableBlockAt(doc.split("\n"), line) !== null;
	return buildAnchor(view, doc, fromOffset, toOffset, "编辑器选区（精确偏移）", inTable, false);
}

/** 编辑器 / 阅读视图里的 DOM 选区 → 源码偏移 */
export function resolveDomSelection(
	view: MarkdownView,
	editor: Editor,
	range: Range,
): AnchorResult {
	const doc = editor.getValue();
	const startEl = elementOf(range.startContainer);
	const endEl = elementOf(range.endContainer);
	if (!startEl || !endEl) return refuse("认不出选区落在哪个元素上", "请重新选中要批注的文字");
	if (startEl.closest(".lildog-card") || startEl.closest(".lildog-float-btn")) {
		return refuse("选区落在插件的浮窗里", "请重新选中正文");
	}

	const cmView = outerCmView(startEl);
	if (!cmView) return resolveReadingView(view, editor, range);

	const startCell = cellOf(startEl);
	const endCell = cellOf(endEl);
	if (startCell || endCell) {
		if (!startCell || !endCell) {
			return refuse(
				"选区一半在表格单元格里、一半在外面",
				"请只在单元格内部选一段，或者整张表一起选",
			);
		}
		if (startCell === endCell) {
			const ctx = cellContextFor(editor, startCell);
			if (!ctx.ok) return ctx;
			return resolveWithinCell(view, editor, range, ctx.ctx);
		}
		return resolveAcrossCells(view, editor, startCell, endCell);
	}

	// 普通编辑器内容（不在表格里）：让 CodeMirror 直接换算
	if (cmView.dom.contains(range.startContainer) && cmView.dom.contains(range.endContainer)) {
		try {
			const fromOffset = cmView.posAtDOM(range.startContainer, range.startOffset);
			const toOffset = cmView.posAtDOM(range.endContainer, range.endOffset);
			const needle = collapseWhitespace(range.toString());
			if (fromOffset !== toOffset && verifySlice(doc, fromOffset, toOffset, needle)) {
				const line = lineOfOffset(lineOffsets(doc), fromOffset);
				const inTable = tableBlockAt(doc.split("\n"), line) !== null;
				return buildAnchor(view, doc, fromOffset, toOffset, "编辑器 DOM 精确换算", inTable, false);
			}
		} catch {
			// 落到下面的块级 widget 处理
		}
	}

	return resolveWidgetText(view, editor, cmView, startEl, range);
}

/**
 * 光标停在某个表格单元格里、又没选任何文字时：批注**整格**。
 *
 * 这条入口不依赖鼠标拖选，也不依赖 DOM：光标位置本身就是源码偏移，
 * 拿它反查「第几行第几格」就够了 —— 实时预览里跨格拖选会被 Obsidian 的格子编辑器
 * 接管，这条是那时最省事的办法（快捷键 Ctrl/Cmd + Shift + A）。
 * 不在表格里就返回 null（交给调用方去提示「请先选中文字」）。
 */
export function resolveCursorCell(view: MarkdownView, editor: Editor): AnchorResult | null {
	const doc = editor.getValue();
	const cursor = editor.posToOffset(editor.getCursor());
	// 光标停在分隔行上：那一格的 `---` 是整张表的地基，一个字都不能动
	// （cellAtOffset 也不认它，这里单独给一句明确的提示）
	if (isOffsetOnDelimiterRow(doc, cursor)) {
		return refuse(
			"光标停在表格的分隔行（`| --- |`）上",
			"请把光标放进要批注的那一格，或者先选中一段文字",
		);
	}
	const loc = cellAtOffset(doc, cursor);
	if (!loc) return null;
	if (!loc.text.trim()) return refuse("这一格是空的", "请先在格子里写点内容");
	return buildAnchor(
		view,
		doc,
		loc.from,
		loc.to,
		`光标所在单元格整格（第 ${loc.col + 1} 列）`,
		true,
		false,
		{ line: loc.line, col: loc.col },
	);
}
