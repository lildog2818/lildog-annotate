import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorPosition } from "obsidian";
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
import {
	createEditorDecorations,
	createHoverExtension,
	decorateReadingView,
} from "./hover";
import { writeSelfCheckReport } from "./selfcheck";
import { DEFAULT_SETTINGS, LildogSettingTab } from "./settings";
import type { AnnotationMode, LildogSettings } from "./settings";

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

export default class LildogAnnotatePlugin extends Plugin {
	settings: LildogSettings = { ...DEFAULT_SETTINGS };
	private floating: FloatingAnnotateButton | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new LildogSettingTab(this.app, this));

		// 批注记号 + 悬停预览（编辑器）
		this.registerEditorExtension([
			createEditorDecorations(),
			createHoverExtension(() => this.settings.hoverPreview),
		]);
		// 阅读视图：给每个段落打上行号范围（阅读视图里按文字反查源码要用），并挂悬停预览
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const info = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
			if (info) {
				el.dataset.lildogStart = String(info.lineStart);
				el.dataset.lildogEnd = String(info.lineEnd);
			}
			if (this.settings.hoverPreview) {
				await decorateReadingView(el, ctx, this.app);
			}
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

		// 选中文字后的浮动按钮
		this.floating = new FloatingAnnotateButton((snapshot) =>
			this.annotateSnapshot(snapshot),
		);
		this.register(() => this.floating?.destroy());
		this.registerDomEvent(document, "mouseup", (evt) => this.handleMouseUp(evt));
		this.registerDomEvent(document, "mousedown", (evt) => {
			if (!this.floating?.contains(evt.target)) this.floating?.hide();
		});
		this.registerDomEvent(window, "scroll", () => this.floating?.hide(), {
			capture: true,
		});
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
	 * 反查源码」，并用段落行号范围缩小查找范围。
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
			const located = this.locateInSection(doc, domText, anchor);
			if (!located) {
				action = "没能在源码里定位到选中的文字";
			} else {
				snapshot = {
					view,
					text: doc.slice(located.fromOffset, located.toOffset),
					fromOffset: located.fromOffset,
					toOffset: located.toOffset,
				};
				action =
					located.matches > 1
						? `浮出按钮（按文字反查，命中 ${located.matches} 处，用第一处）`
						: "浮出按钮（按文字反查）";
				if (located.matches > 1) {
					new Notice(
						`这段文字在笔记里出现 ${located.matches} 次，批注会加在第一处`,
						4000,
					);
				}
			}
		}

		diag.lastSelection =
			`target=${describeTarget(target)} | 在编辑器内=${inEditor} | 编辑器选区=${editorText.trim().length > 0} | ` +
			`浏览器选区折叠=${collapsed} | 矩形=${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "无"} | ` +
			`模式=${view ? view.getMode() : "无"} | 动作=${action}`;

		if (!snapshot || !rect) return;
		this.floating?.show(snapshot, rect);
	}

	/** 在选区所属段落（阅读视图里打了行号）的源码范围内找这段文字 */
	private locateInSection(
		doc: string,
		text: string,
		anchor: Element | null,
	): TextLocation | null {
		const sectionEl = anchor?.closest(
			"[data-lildog-start]",
		) as HTMLElement | null;
		if (sectionEl) {
			const startLine = Number(sectionEl.dataset.lildogStart);
			const endLine = Number(sectionEl.dataset.lildogEnd);
			if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
				const offsets = lineOffsets(doc);
				const start = offsets[startLine] ?? 0;
				const end = offsets[endLine + 1] ?? doc.length;
				const hit = locateText(doc, text, start, end);
				if (hit) return hit;
			}
		}
		return locateText(doc, text);
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
			editor.replaceRange(
				serializeInline(doc.slice(range.fromOffset, toOffset), body),
				editor.offsetToPos(range.fromOffset),
				editor.offsetToPos(toOffset),
			);
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
			void this.app.vault.modify(view.file, editor.getValue());
			return;
		}
		view.requestSave?.();
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
					editor.replaceRange(
						serializeInline(found.text, body),
						found.from,
						found.to,
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
