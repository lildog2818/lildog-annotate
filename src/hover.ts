import { MarkdownPostProcessorContext, Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { EditorView } from "@codemirror/view";
import { findInlineAnnotations, lineOffsets, MARKER, normalizeForCompare, stripInlineMarkdown } from "./format";
import type { InlineAnnotation } from "./format";
import { cellElementOf, findOuterCmView, locateCell } from "./anchor";
import { buildEditorDecorations } from "./decorations";
import { diag } from "./diagnostics";

/**
 * 编辑器装饰的注册方式照抄社区里跑通的插件（Annoteca）：
 * 用 EditorView.decorations 这个 facet 的 compute，而不是 ViewPlugin。
 * 依赖 doc 与 selection —— 文档变了重建，光标选中批注时把标记露出来。
 *
 * 另外：装饰构建一旦失败，标记就会全露在正文里。这种事不能再悄悄发生，
 * 所以失败时弹一次提示（推迟到下一帧，避免在 CM6 的计算过程里做副作用）。
 */
export function createEditorDecorations() {
	let warned = false;
	return EditorView.decorations.compute(["doc", "selection"], (state) => {
		const decorations = buildEditorDecorations(state);
		if (!warned && diag.editorLastError) {
			warned = true;
			const reason = diag.editorLastError;
			window.setTimeout(() => {
				new Notice(
					`Lildog Annotate：批注标记隐藏失败（${reason}）。命令面板里跑「运行自检」可以把诊断报告写进库里。`,
					12000,
				);
			}, 0);
		}
		return decorations;
	});
}

/**
 * 给渲染出来的内容加高亮。
 *
 * 两条完全不同的路：
 *   - **阅读视图**（拿得到段落行号）：按段落圈定源码范围，再按「第几次出现」对号入座；
 *   - **实时预览里的块级 widget**（表格单元格、公式块…）：`getSectionInfo` 恒为 null，
 *     这时**按源码位置决定画在哪** —— 先用 CodeMirror 把元素换算成源码偏移，
 *     再看这条批注的原文是不是真的落在那一段/那一格里。位置算不出来就**不画**，
 *     绝不用「按文字找第一处」硬套 —— 那正是重复值（`✅`、`—`、`4 阶`）时
 *     高亮画到别的格子上的原因。
 */
export async function decorateReadingView(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	app: App,
): Promise<void> {
	diag.postProcessorRuns++;

	const info = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
	if (!info) diag.sectionInfoMissing++;
	// 后处理器每一段都会跑：这一段源码里没有批注就直接撤，省掉一次文件读
	if (info && typeof info.text === "string" && !info.text.includes(MARKER)) return;

	const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (!(file instanceof TFile)) return;
	diag.fallbackReads++;
	const doc = await app.vault.cachedRead(file);
	const annotations = findInlineAnnotations(doc);
	if (!annotations.length) return;

	if (info) {
		const section = sectionRange(doc, info.lineStart, info.lineEnd);
		const mine = annotations.filter((ann) => ann.from >= section.from && ann.from < section.to);
		if (!mine.length) return;
		decorateInReadingView(el, doc, mine, section);
		return;
	}

	decorateBySourcePosition(el, doc, annotations);
}

/** 阅读视图：段落范围内，第 n 次出现配第 n 次出现 */
function decorateInReadingView(
	el: HTMLElement,
	doc: string,
	mine: InlineAnnotation[],
	_section: { from: number; to: number },
): void {
	const marks = Array.from(el.querySelectorAll("mark")) as HTMLElement[];
	diag.marksFound += marks.length;

	const used = new Set<Element>();
	// 同一条批注的原文在这一段里出现多次时，按源码里出现的先后依次认领
	const claimed = new Map<string, number>();
	for (const ann of mine) {
		const key = normalizeForCompare(ann.text);
		if (!key) continue;
		const ordinal = claimed.get(key) ?? 0;
		claimed.set(key, ordinal + 1);

		const hit =
			takeNthMark(marks, used, ann.text, ordinal) ??
			wrapNthInElement(el, ann.text, ordinal);
		if (!hit) continue;
		used.add(hit);
		diag.annotationsMatched++;
		diag.positionMatched++;
		markElement(hit, ann);
	}
}

interface TextHit {
	node: Text;
	index: number;
	length: number;
	/** 在整个元素文字里的绝对位置（用来判「第几次出现」和「离哪儿最近」） */
	at: number;
	/** 已经包在高亮里了 */
	inMark: boolean;
}

/** 用来匹配的一段原文：渲染后文字（剥掉 `**` 之类）优先，原文兜底 */
function candidatesFor(text: string): string[] {
	const raw = text.trim();
	const stripped = stripInlineMarkdown(text);
	return Array.from(new Set([stripped, raw].filter((item) => item.length > 0)));
}

/** 把元素里所有候选文字的出现位置按文档顺序收齐 */
function collectHits(el: HTMLElement, candidates: string[]): TextHit[] {
	const hits: TextHit[] = [];
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let cursor = 0;
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const text = node.textContent ?? "";
		const start = cursor;
		cursor += text.length;
		if (!text) continue;
		const inMark = !!node.parentElement?.closest(".lildog-ann");
		for (const needle of candidates) {
			let at = text.indexOf(needle);
			while (at !== -1) {
				hits.push({
					node: node as Text,
					index: at,
					length: needle.length,
					at: start + at,
					inMark,
				});
				at = text.indexOf(needle, at + 1);
			}
		}
	}
	return hits.sort((a, b) => a.at - b.at);
}

function wrapHit(hit: TextHit): HTMLElement | null {
	const range = document.createRange();
	try {
		range.setStart(hit.node, hit.index);
		range.setEnd(hit.node, hit.index + hit.length);
	} catch {
		return null;
	}
	const mark = document.createElement("mark");
	mark.addClass("lildog-ann");
	try {
		range.surroundContents(mark);
	} catch {
		return null;
	}
	return mark;
}

/** 按源码里的先后认领第 ordinal 次出现 */
function wrapNthInElement(el: HTMLElement, text: string, ordinal: number): HTMLElement | null {
	const hits = collectHits(el, candidatesFor(text));
	const target = hits[ordinal];
	if (!target || target.inMark) return null;
	return wrapHit(target);
}

/**
 * 按源码位置就近认领（表格单元格 / 块级 widget 用）。
 * hint 是这段原文在源码里距离「这个元素起点」的位置：同一格里出现多次时，
 * 取离它最近的那一处 —— 而不是永远取第一处。
 *
 * 这一条**幂等**：这个元素里已经为这条批注画过高亮了就直接收手。
 * 补画会被反复调用（点一下、改一下正文都会排一次），不挡住就会越画越多 ——
 * 一条批注在 DOM 里留下好几个 mark。
 */
function wrapNearestInElement(
	el: HTMLElement,
	ann: InlineAnnotation,
	hint: number,
): HTMLElement | null {
	if (el.querySelector(`.lildog-ann[data-lildog-from="${ann.from}"]`)) return null;
	const open = collectHits(el, candidatesFor(ann.text)).filter((hit) => !hit.inMark);
	if (!open.length) return null;
	let best = open[0];
	for (const hit of open) {
		if (Math.abs(hit.at - hint) < Math.abs(best.at - hint)) best = hit;
	}
	return wrapHit(best);
}

/** 优先用 Obsidian 自己渲染出来的高亮（旧格式 ==高亮== 的产物） */
function takeNthMark(
	marks: HTMLElement[],
	used: Set<Element>,
	text: string,
	ordinal: number,
): HTMLElement | null {
	const want = normalizeForCompare(text);
	if (!want) return null;
	const hits = marks.filter(
		(mark) => !used.has(mark) && normalizeForCompare(mark.textContent ?? "") === want,
	);
	return hits[ordinal] ?? null;
}

/**
 * 实时预览的块级 widget：按源码位置决定画在哪一条批注上。
 * 算不出位置就计数跳过（宁可不画，也不画错格子）。
 */
function decorateBySourcePosition(
	el: HTMLElement,
	doc: string,
	annotations: InlineAnnotation[],
): void {
	const cmView = findOuterCmView(el);
	if (!cmView) {
		diag.positionMisses++;
		return;
	}

	let at: number;
	try {
		at = cmView.posAtDOM(el);
	} catch {
		diag.positionMisses++;
		return;
	}

	const cellEl = cellElementOf(el);
	if (cellEl) {
		const located = locateCell(doc, cellEl);
		if (!located.ok) {
			diag.positionMisses++;
			return;
		}
		const loc = located.loc;
		// 只画**原文完全落在这格里**的批注：隔壁格子里同样的文字不该在这里亮起来
		const mine = annotations.filter((ann) => ann.textFrom >= loc.from && ann.textTo <= loc.to);
		for (const ann of mine) {
			const hit = wrapNearestInElement(el, ann, ann.textFrom - loc.from);
			if (!hit) continue;
			diag.annotationsMatched++;
			diag.positionMatched++;
			markElement(hit, ann);
		}
		return;
	}

	// 其它 widget（公式、代码块…）：源码位置在这条批注附近，且文字对得上才画
	for (const ann of annotations) {
		const slack = Math.max(160, ann.text.length * 4);
		if (at < ann.from || at > ann.to + slack) continue;
		const hit = wrapNearestInElement(el, ann, Math.max(0, ann.textFrom - at));
		if (!hit) continue;
		diag.annotationsMatched++;
		diag.positionMatched++;
		markElement(hit, ann);
	}
}

/** 记下这条高亮对应哪条批注（悬停浮窗靠它把改动写回文件） */
function markElement(el: HTMLElement, ann: InlineAnnotation): void {
	el.addClass("lildog-ann");
	el.dataset.lildogFrom = String(ann.from);
	el.dataset.lildogTo = String(ann.to);
}

/**
 * 把界面上现有的表格格子重新装饰一遍（幂等，重复调用不会套两层）。
 *
 * 为什么需要：Obsidian 的表格 widget 会**缓存每个格子渲染出来的 DOM**。你在格子里
 * 待过（它开嵌套编辑器、把渲染态藏起来），离开时它把**编辑前那份缓存**显示回来 ——
 * 那份是批注存在之前渲染的，后处理器不会再跑，于是「批注过了，格子里却没有高亮」。
 * 所以写完批注、点开表格、正文变动之后，都由插件自己补画一遍。
 *
 * 正在编辑的格子（里面有嵌套 CodeMirror）跳过：那块的 DOM 归 CodeMirror 管，
 * 外面往里插节点会打架；那种格子的高亮由编辑器装饰负责。
 * 一个 `td` 里可能留着好几份渲染内容（进过编辑态的格子会再建一份），
 * **每一份都画**：哪一份最终被显示出来由 Obsidian 决定，我们只保证「显示出来的那份带高亮」。
 */
export function redecorateTableCells(containerEl: Element, doc: string): void {
	const annotations = findInlineAnnotations(doc);
	if (!annotations.length) return;
	for (const cell of Array.from(containerEl.querySelectorAll("td, th"))) {
		if (cell.querySelector(".cm-editor")) continue;
		for (const wrapper of Array.from(cell.querySelectorAll(".table-cell-wrapper"))) {
			decorateBySourcePosition(wrapper as HTMLElement, doc, annotations);
		}
	}
}

/** 某个段落（行号范围）在源码里的字符范围 */
function sectionRange(
	doc: string,
	lineStart: number,
	lineEnd: number,
): { from: number; to: number } {
	const offsets = lineOffsets(doc);
	const from = offsets[lineStart] ?? 0;
	const to = offsets[lineEnd + 1] ?? doc.length;
	return { from, to: Math.max(from, to) };
}
