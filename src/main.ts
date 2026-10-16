import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorPosition } from "obsidian";
import { hexToRgba } from "./colors";
import {
	blockInsertLine,
	canUseInline,
	extendToBalanceBackticks,
	findBlockAtLine,
	findInlineAnnotations,
	lineOffsets,
	locateText,
	planLegacyMigration,
	serializeBlock,
	serializeBlockWithQuote,
	serializeInline,
} from "./format";
import type { TextLocation } from "./format";
import { AnnotateModal } from "./modal";
import { BUILD_ID } from "./build";
import { diag } from "./diagnostics";
import { FloatingAnnotateButton } from "./floating";
import type { SelectionSnapshot } from "./floating";
import { createAtomicRanges } from "./decorations";
import { createEditorDecorations, decorateReadingView } from "./hover";
import { HoverCard } from "./hovercard";
import type { HoverTarget } from "./hovercard";
import { rectUnderPointer, resolveHighlight } from "./resolve";
import { writeSelfCheckReport } from "./selfcheck";
import { DEFAULT_SETTINGS, LildogSettingTab, sanitizeSettings } from "./settings";
import type { AnnotationMode, LildogSettings } from "./settings";
import { injectStyles, removeStyles } from "./style";

/** 光标位置处找到的一条批注 */
interface FoundAnnotation {
	kind: AnnotationMode;
	from: EditorPosition;
	to: EditorPosition;
	/** 被批注的原文 */
	text: string;
	/** 批注内容 */
	body: string;
}

/** 一段待批注的原文，用源码偏移表示（编辑器位置在阅读视图里拿不到） */
interface SourceRange {
	text: string;
	fromOffset: number;
	toOffset: number;
	/** 选区所在的视图，插入后用它把改动落盘 */
	view?: MarkdownView;
}

/** 比对两段文字时先压掉空白，避免渲染差异导致误判 */
function sameText(a: string, b: string): boolean {
	return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

function describeTarget(target: HTMLElement | null): string {
	if (!target) return "null";
	const cls =
		target.className && typeof target.className === "string"
			? `.${target.className.trim().split(/\s+/).slice(0, 3).join(".")}`
			: "";
	return `${target.tagName.toLowerCase()}${cls}`;
}

/**
 * 选区在 DOM 里的起点，占整段文字的百分比。
 *
 * 同一段文字在笔记里出现多次时，光靠文字内容分不出是哪一处（这正是以前
 * 「批注会加在第一处」的原因）。这里量一个相对位置，让源码里的查找就近命中。
 */
function domRatio(el: HTMLElement, range: Range): number {
	const total = (el.textContent ?? "").length;
	if (total <= 0) return 0;
	try {
		const before = document.createRange();
		before.setStart(el, 0);
		before.setEnd(range.startContainer, range.startOffset);
		const index = before.toString().length;
		return Math.min(1, Math.max(0, index / total));
	} catch {
		return 0;
	}
}

export default class LildogAnnotatePlugin extends Plugin {
	settings: LildogSettings = { ...DEFAULT_SETTINGS };
	private floating: FloatingAnnotateButton | null = null;
	private hoverCard: HoverCard | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		// 样式自己注入一份：不依赖 Obsidian 有没有（或者是不是最新的）加载 styles.css
		injectStyles();
		this.addSettingTab(new LildogSettingTab(this.app, this));
		this.applyAppearance();

		// 批注记号（编辑器）：标记藏起来 + 被批注的文字上色。
		// 原子区间让光标进不到藏起来的标记里（否则一点就整条露出来）
		this.registerEditorExtension([createEditorDecorations(), createAtomicRanges()]);
		// 阅读视图：给每个段落打上行号范围（阅读视图里按文字反查源码要用），
		// 并把批注对应的文字找出来上色、记下源码偏移
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const info = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
			if (info) {
				el.dataset.lildogStart = String(info.lineStart);
				el.dataset.lildogEnd = String(info.lineEnd);
			}
			await decorateReadingView(el, ctx, this.app);
		});

		this.addCommand({
			id: "add-annotation",
			name: "添加批注",
			icon: "message-square-plus",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "A" }],
			editorCallback: (editor) => this.addAnnotation(editor),
		});
		this.addCommand({
			id: "edit-annotation",
			name: "编辑光标处的批注",
			icon: "pencil",
			editorCallback: (editor) => this.editAnnotation(editor),
		});
		this.addCommand({
			id: "delete-annotation",
			name: "删除光标处的批注",
			icon: "trash",
			editorCallback: (editor) => this.deleteAnnotation(editor),
		});
		this.addCommand({
			id: "migrate-legacy",
			name: "把旧格式批注转成新格式",
			icon: "wand-2",
			editorCallback: (editor) => this.migrateLegacy(editor),
		});
		this.addCommand({
			id: "run-self-check",
			name: "运行自检（把诊断报告写进库里的 DSH 目录）",
			icon: "stethoscope",
			callback: async () => {
				const path = await writeSelfCheckReport(
					this.app,
					this.manifest.version,
					this.settings,
				);
				new Notice(`自检报告已写入：${path}\n构建：${BUILD_ID}`);
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (editor.somethingSelected()) {
					menu.addItem((item) =>
						item
							.setTitle("添加批注")
							.setIcon("message-square-plus")
							.onClick(() => this.addAnnotation(editor)),
					);
				}
				const target = this.findAnnotation(editor);
				if (target) {
					menu.addItem((item) =>
						item
							.setTitle("编辑这条批注")
							.setIcon("pencil")
							.onClick(() => this.editAnnotation(editor, target)),
					);
					menu.addItem((item) =>
						item
							.setTitle("删除这条批注")
							.setIcon("trash")
							.onClick(() => this.deleteAnnotation(editor, target)),
					);
				}
			}),
		);

		// 悬停浮窗：内容直接可改，回车即收
		this.hoverCard = new HoverCard({
			fontSize: () => this.settings.cardFontSize,
			onSave: (target, body) => this.saveFromCard(target, body),
		});
		this.register(() => this.hoverCard?.destroy());

		// 选中文字后的浮动按钮
		this.floating = new FloatingAnnotateButton((snapshot) =>
			this.annotateSnapshot(snapshot),
		);
		this.register(() => this.floating?.destroy());
		this.registerDomEvent(document, "mouseup", (evt) => this.handleMouseUp(evt));
		this.registerDomEvent(document, "mouseover", (evt) => this.handleHoverStart(evt), true);
		this.registerDomEvent(document, "mouseout", (evt) => this.handleHoverEnd(evt), true);
		this.registerDomEvent(
			document,
			"keydown",
			(evt) => {
				// 回车 / Esc 之后浮窗立刻收起来，不用再去点别的地方
				if (evt.key !== "Enter" && evt.key !== "Escape") return;
				if (this.hoverCard?.contains(evt.target as Node)) return;
				this.hoverCard?.hide();
			},
			true,
		);
		this.registerDomEvent(document, "mousedown", (evt) => {
			if (!this.floating?.contains(evt.target)) this.floating?.hide();
			if (!this.hoverCard?.contains(evt.target as Node)) this.hoverCard?.hide();
		});
		this.registerDomEvent(
			window,
			"scroll",
			() => {
				this.floating?.hide();
				this.hoverCard?.hide();
			},
			{ capture: true },
		);
		// 正文一变（打字、撤销、别的插件改动），浮窗里的偏移就失效了，直接收起
		this.registerEvent(
			this.app.workspace.on("editor-change", () => this.hoverCard?.hide()),
		);
	}

	onunload(): void {
		this.clearAppearance();
		removeStyles();
	}

	// ---------------------------------------------------------------- 外观

	/** 把设置里的颜色 / 字号写进 CSS 变量：样式表只管用变量，不再有硬编码颜色 */
	applyAppearance(): void {
		const style = document.body.style;
		const { annotatedTextColor, highlightColor, highlightOpacity } = this.settings;
		style.setProperty("--lildog-annotate-fg", annotatedTextColor);
		style.setProperty(
			"--lildog-annotate-bg",
			hexToRgba(highlightColor, highlightOpacity),
		);
		style.setProperty(
			"--lildog-annotate-line",
			hexToRgba(highlightColor, Math.min(1, highlightOpacity + 0.45)),
		);
		style.setProperty("--lildog-card-font-size", `${this.settings.cardFontSize}px`);
		this.hoverCard?.refreshStyle();
	}

	private clearAppearance(): void {
		const style = document.body.style;
		for (const name of [
			"--lildog-annotate-fg",
			"--lildog-annotate-bg",
			"--lildog-annotate-line",
			"--lildog-card-font-size",
		]) {
			style.removeProperty(name);
		}
	}

	/** 设置页改了东西后让它立刻生效（也顺手把浮窗收掉，免得看到旧样式） */
	hideHoverCard(): void {
		this.hoverCard?.hide();
	}

	// ---------------------------------------------------------------- 悬停浮窗

	private handleHoverStart(evt: MouseEvent): void {
		const card = this.hoverCard;
		if (!card) return;
		const node = evt.target;
		if (!(node instanceof Element)) return;
		if (card.contains(node)) {
			card.cancelHide();
			return;
		}
		if (!this.settings.hoverPreview) return;

		const el = node.closest(".lildog-ann") as HTMLElement | null;
		if (!el) return;

		const target = this.resolveHoverTarget(el, evt);
		if (!target) {
			diag.hoverMisses++;
			return;
		}
		diag.hoverShows++;
		diag.lastHover = `${target.view.getMode() === "preview" ? "阅读视图" : "编辑器"} · 原文「${target.text.slice(0, 20)}」 · 批注「${target.body.slice(0, 20)}」`;
		// 用鼠标底下那一块的矩形定位：高亮折行时 getBoundingClientRect 会是一个跨行大盒子
		card.show(target, rectUnderPointer(el, evt.clientX, evt.clientY));
	}

	private handleHoverEnd(evt: MouseEvent): void {
		const node = evt.target;
		if (!(node instanceof Element)) return;
		const el = node.closest(".lildog-ann");
		if (!el) return;
		const to = evt.relatedTarget as Node | null;
		if (to && (el.contains(to) || this.hoverCard?.contains(to))) return;
		this.hoverCard?.scheduleHide();
	}

	/**
	 * 从悬停到的高亮元素倒推出是哪一条批注。
	 *
	 * 解析过程交给 resolveHighlight（它会把「为什么没解析出来」记进 diag，
	 * 自检报告里能直接看到）。
	 */
	private resolveHoverTarget(
		el: HTMLElement,
		evt?: MouseEvent,
	): HoverTarget | null {
		const view = this.markdownViewFor(el);
		if (!view) {
			diag.lastHover = `悬停到高亮，但没找到它属于哪个 Markdown 窗格（${describeTarget(el)}）`;
			return null;
		}
		const doc = view.editor.getValue();
		const resolved = resolveHighlight(el, doc);
		diag.lastHoverResolve = resolved.reason;
		if (!resolved.annotation) {
			diag.lastHover = `悬停到高亮但认不出是哪条批注：${resolved.reason}`;
			return null;
		}
		const ann = resolved.annotation;
		return { view, from: ann.from, to: ann.to, text: ann.text, body: ann.body };
	}

	/** 浮窗里点了保存：把新的批注内容写回笔记 */
	private saveFromCard(target: HoverTarget, body: string): void {
		const editor = target.view.editor;
		const doc = editor.getValue();
		const ann = findInlineAnnotations(doc).find(
			(item) => item.from === target.from && item.to === target.to,
		);
		if (!ann) {
			new Notice("这条批注已经变化，请重新悬停后再改");
			return;
		}
		const replacement = serializeInline(ann.text, body);
		editor.replaceRange(
			replacement,
			editor.offsetToPos(ann.from),
			editor.offsetToPos(ann.to),
		);
		// 光标落在整条批注之后：标记立刻收起，不用再点别处
		editor.setCursor(editor.offsetToPos(ann.from + replacement.length));
		this.persist(editor, {
			text: ann.text,
			fromOffset: ann.from,
			toOffset: ann.to,
			view: target.view,
		});
		diag.hoverEdits++;
	}

	/** 高亮元素属于哪个 Markdown 窗格（编辑器可能被拖到别的叶子里） */
	private markdownViewFor(el: Element): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(el)) {
				return view;
			}
		}
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	// ---------------------------------------------------------------- 入口

	/** 选区上方的小按钮被点击 */
	private annotateSnapshot(snapshot: SelectionSnapshot): void {
		const editor = snapshot.view.editor;
		// 阅读视图里不去动编辑器焦点，免得把视图切走
		if (snapshot.view.getMode() !== "preview") {
			editor.focus();
			editor.setSelection(
				editor.offsetToPos(snapshot.fromOffset),
				editor.offsetToPos(snapshot.toOffset),
			);
		}
		this.openComposer(editor, {
			text: snapshot.text,
			fromOffset: snapshot.fromOffset,
			toOffset: snapshot.toOffset,
			view: snapshot.view,
		});
	}

	private addAnnotation(editor: Editor): void {
		const text = editor.getSelection();
		if (!text.trim()) {
			new Notice("请先选中要批注的文字");
			return;
		}
		this.floating?.hide();
		this.hoverCard?.hide();
		this.openComposer(editor, {
			text,
			fromOffset: editor.posToOffset(editor.getCursor("from")),
			toOffset: editor.posToOffset(editor.getCursor("to")),
			view: this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined,
		});
	}

	/**
	 * 选中文字后决定要不要浮出按钮。
	 *
	 * 编辑器里的普通选区位置精确，直接用；阅读视图、以及编辑器里被渲染成
	 * 块级 widget 的表格等位置，编辑器选区拿不到，就退回「用 DOM 里的文字
	 * 反查源码」，并按选区在段落里的相对位置就近命中 —— 同一段文字重复出现
	 * 时，批注加在**你选的那一处**，而不是第一处。
	 */
	private handleMouseUp(evt: MouseEvent): void {
		if (!this.settings.showFloatingButton) {
			diag.lastSelection = "设置里关掉了「选中文字后浮出批注按钮」";
			return;
		}

		const selection = window.getSelection();
		const collapsed =
			!selection || selection.rangeCount === 0 || selection.isCollapsed;
		const domText = collapsed ? "" : selection!.toString();
		const range = collapsed ? null : selection!.getRangeAt(0);
		const rect = range ? range.getBoundingClientRect() : null;
		const anchor = range ? range.startContainer.parentElement : null;

		const target = evt.target as HTMLElement | null;
		const inEditor = !!target?.closest(".cm-editor");
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor ?? null;
		const editorText = editor && editor.somethingSelected() ? editor.getSelection() : "";
		// 只有编辑器选区跟浏览器里选中的是同一段文字时才用它，
		// 否则可能是残留的旧选区（比如鼠标正在表格 widget 里选字）
		const useEditorSelection =
			inEditor && !!editorText.trim() && sameText(editorText, domText);

		let action: string;
		let snapshot: SelectionSnapshot | null = null;

		if (collapsed || !domText.trim()) {
			action = "浏览器里没有选区";
		} else if (!view || !editor) {
			action = "当前没有 Markdown 视图";
		} else if (!rect) {
			action = "拿不到选区矩形";
		} else if (useEditorSelection) {
			snapshot = {
				view,
				text: editorText,
				fromOffset: editor.posToOffset(editor.getCursor("from")),
				toOffset: editor.posToOffset(editor.getCursor("to")),
			};
			action = "浮出按钮（编辑器选区）";
		} else {
			const doc = editor.getValue();
			const located = this.locateInSection(doc, domText, anchor, range);
			if (!located) {
				action = "没能在源码里定位到选中的文字";
			} else {
				snapshot = {
					view,
					text: doc.slice(located.fromOffset, located.toOffset),
					fromOffset: located.fromOffset,
					toOffset: located.toOffset,
				};
				action = `浮出按钮（按文字反查，${located.matches} 处相同，取选区所在那一处）`;
			}
		}

		diag.lastSelection =
			`target=${describeTarget(target)} | 在编辑器内=${inEditor} | 编辑器选区=${editorText.trim().length > 0} | ` +
			`浏览器选区折叠=${collapsed} | 矩形=${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "无"} | ` +
			`模式=${view ? view.getMode() : "无"} | 动作=${action}`;

		if (!snapshot || !rect) return;
		this.floating?.show(snapshot, rect);
	}

	/**
	 * 在选区所属段落（阅读视图里打了行号）的源码范围内找这段文字。
	 * 找不到再退回全文，并且都带上「选区在 DOM 里的相对位置」作为就近依据。
	 */
	private locateInSection(
		doc: string,
		text: string,
		anchor: Element | null,
		range: Range | null,
	): TextLocation | null {
		const sectionEl = anchor?.closest("[data-lildog-start]") as HTMLElement | null;
		const ratio = sectionEl && range ? domRatio(sectionEl, range) : 0;

		if (sectionEl) {
			const startLine = Number(sectionEl.dataset.lildogStart);
			const endLine = Number(sectionEl.dataset.lildogEnd);
			if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
				const offsets = lineOffsets(doc);
				const start = offsets[startLine] ?? 0;
				const end = offsets[endLine + 1] ?? doc.length;
				const prefer = start + ratio * Math.max(0, end - start);
				const hit = locateText(doc, text, start, end, prefer);
				if (hit) return hit;
			}
		}
		return locateText(doc, text, 0, doc.length, ratio * doc.length);
	}

	// ---------------------------------------------------------------- 写入

	private openComposer(editor: Editor, range: SourceRange): void {
		let mode = this.settings.mode;
		if (mode === "inline" && !canUseInline(range.text)) {
			mode = "block";
			new Notice("选区跨行（或含有注释起始符），已改用段落批注");
		}

		new AnnotateModal(this.app, {
			title: mode === "inline" ? "添加行内批注" : "添加段落批注",
			quote: range.text,
			onSubmit: (body) => this.insertAnnotation(editor, mode, range, body),
		}).open();
	}

	private insertAnnotation(
		editor: Editor,
		mode: AnnotationMode,
		range: SourceRange,
		body: string,
	): void {
		const doc = editor.getValue();

		// 已经是某条批注的一部分，就别再套一层（嵌套标记会把解析搞乱）
		const nested = findInlineAnnotations(doc).find(
			(ann) => range.fromOffset < ann.to && range.toOffset > ann.from,
		);
		if (nested) {
			new Notice("这段文字已经在一条批注里了");
			return;
		}

		this.hoverCard?.hide();

		if (mode === "inline") {
			if (doc.slice(range.fromOffset, range.toOffset) !== range.text) {
				new Notice("原文已经变化，批注没有写入，请重新选中");
				return;
			}
			// 选区带反引号但没配对时，把结尾补上，别把代码块劈开
			const toOffset = extendToBalanceBackticks(
				doc,
				range.fromOffset,
				range.toOffset,
			);
			const replacement = serializeInline(doc.slice(range.fromOffset, toOffset), body);
			editor.replaceRange(
				replacement,
				editor.offsetToPos(range.fromOffset),
				editor.offsetToPos(toOffset),
			);
			// 光标停在整条批注之后：标记马上就藏起来，不用再点一下别的地方
			editor.setCursor(editor.offsetToPos(range.fromOffset + replacement.length));
			this.persist(editor, range);
			return;
		}

		const lines = editor.getValue().split("\n");
		const insertAt = blockInsertLine(
			lines,
			editor.offsetToPos(range.toOffset).line,
		);
		const block = serializeBlock(range.text, body);
		const blockLines = block.split("\n");
		const tail = blockLines[blockLines.length - 1];

		if (insertAt >= lines.length) {
			const last = lines.length - 1;
			editor.replaceRange("\n" + block, {
				line: last,
				ch: lines[last].length,
			});
			editor.setCursor({ line: last + blockLines.length, ch: tail.length });
		} else {
			editor.replaceRange(block + "\n", { line: insertAt, ch: 0 });
			editor.setCursor({
				line: insertAt + blockLines.length - 1,
				ch: tail.length,
			});
		}
		this.persist(editor, range);
	}

	/**
	 * 把改动落盘。
	 * 编辑器里 requestSave 就够了；阅读视图里编辑器不是当前显示的视图，
	 * Obsidian 不会自动保存，得直接写一遍文件（内容和编辑器内存一致）。
	 */
	private persist(editor: Editor, range: SourceRange): void {
		const view = range.view;
		if (!view) return;
		if (view.getMode() === "preview" && view.file) {
			void this.app.vault
				.modify(view.file, editor.getValue())
				.then(() => this.refreshReadingView(view));
			return;
		}
		view.requestSave?.();
	}

	/**
	 * 阅读视图里改写文件后，让它按新内容重画一遍。
	 *
	 * 批注高亮是渲染时由插件加上去的：不重画，这一段就一直是旧样子 ——
	 * 表现正是「批注明明写进去了，却看不到高亮、也悬停不出浮窗」。
	 */
	private refreshReadingView(view: MarkdownView): void {
		const preview = view.previewMode as unknown as {
			rerender?: (full?: boolean) => void;
			renderer?: { rerender?: () => void };
		} | null;
		try {
			if (typeof preview?.rerender === "function") preview.rerender(true);
			else if (typeof preview?.renderer?.rerender === "function") {
				preview.renderer.rerender();
			}
		} catch {
			// 内部接口：拿不到就算了，下次重画时高亮照样会出现
		}
	}

	// ---------------------------------------------------------------- 查找

	private findAnnotation(editor: Editor): FoundAnnotation | null {
		const doc = editor.getValue();
		const cursor = editor.posToOffset(editor.getCursor());

		for (const ann of findInlineAnnotations(doc)) {
			if (cursor >= ann.from && cursor <= ann.to) {
				return {
					kind: "inline",
					from: editor.offsetToPos(ann.from),
					to: editor.offsetToPos(ann.to),
					text: ann.text,
					body: ann.body,
				};
			}
		}

		const lines = doc.split("\n");
		const block = findBlockAtLine(lines, editor.getCursor().line);
		if (block) {
			return {
				kind: "block",
				from: { line: block.startLine, ch: 0 },
				to: { line: block.endLine, ch: lines[block.endLine].length },
				text: block.quote,
				body: block.body,
			};
		}
		return null;
	}

	// ---------------------------------------------------------------- 改写

	private editAnnotation(editor: Editor, target?: FoundAnnotation): void {
		const found = target ?? this.findAnnotation(editor);
		if (!found) {
			new Notice("光标所在位置没有批注");
			return;
		}

		new AnnotateModal(this.app, {
			title: found.kind === "inline" ? "编辑行内批注" : "编辑段落批注",
			quote: found.text,
			value: found.body,
			onSubmit: (body) => {
				const current = editor.getRange(found.from, found.to);
				if (found.kind === "inline") {
					if (!current.includes("lildog")) {
						new Notice("这条批注已经变化，请重试");
						return;
					}
					const replacement = serializeInline(found.text, body);
					editor.replaceRange(replacement, found.from, found.to);
					// 光标挪到批注之后：标记立刻收起，不用再点别的地方
					editor.setCursor(
						editor.offsetToPos(editor.posToOffset(found.from) + replacement.length),
					);
				} else {
					if (!current.includes("[!lildog]")) {
						new Notice("这条批注已经变化，请重试");
						return;
					}
					editor.replaceRange(
						serializeBlockWithQuote(found.text, body),
						found.from,
						found.to,
					);
				}
			},
		}).open();
	}

	private deleteAnnotation(editor: Editor, target?: FoundAnnotation): void {
		const found = target ?? this.findAnnotation(editor);
		if (!found) {
			new Notice("光标所在位置没有批注");
			return;
		}

		if (found.kind === "inline") {
			const current = editor.getRange(found.from, found.to);
			if (!current.includes("lildog")) {
				new Notice("这条批注已经变化，请重试");
				return;
			}
			// 只去掉批注，原文留下
			editor.replaceRange(found.text, found.from, found.to);
			editor.setCursor(editor.offsetToPos(editor.posToOffset(found.from) + found.text.length));
			return;
		}

		const lines = editor.getValue().split("\n");
		if (found.to.line + 1 < lines.length) {
			editor.replaceRange("", found.from, {
				line: found.to.line + 1,
				ch: 0,
			});
		} else {
			editor.replaceRange("", found.from, found.to);
		}
	}

	// ---------------------------------------------------------------- 迁移

	/** 把早期版本写下的 ==原文==<!-- lildog: … --> 转成现行格式 */
	private migrateLegacy(editor: Editor): void {
		const doc = editor.getValue();
		const legacy = findInlineAnnotations(doc).filter(
			(ann) => ann.format === "legacy",
		);
		if (!legacy.length) {
			new Notice("这篇笔记里没有旧格式批注");
			return;
		}

		// 从后往前替换，前面的偏移才不会被搅乱
		for (const ann of legacy.slice().reverse()) {
			const plan = planLegacyMigration(doc, ann);
			editor.replaceRange(
				plan.replacement,
				editor.offsetToPos(plan.from),
				editor.offsetToPos(plan.to),
			);
		}
		new Notice(`已把 ${legacy.length} 条旧格式批注转成新格式`);
	}

	// ---------------------------------------------------------------- 设置

	async loadSettings(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
