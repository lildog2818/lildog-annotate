import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorPosition } from "obsidian";
import {
	blockInsertLine,
	canUseInline,
	findBlockAtLine,
	findInlineAnnotations,
	serializeBlock,
	serializeBlockWithQuote,
	serializeInline,
} from "./format";
import { AnnotateModal } from "./modal";
import { FloatingAnnotateButton } from "./floating";
import type { SelectionSnapshot } from "./floating";
import {
	createEditorDecorations,
	createHoverExtension,
	decorateReadingView,
} from "./hover";
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

interface SelectionRange {
	text: string;
	from: EditorPosition;
	to: EditorPosition;
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
		// 悬停预览（阅读视图）
		this.registerMarkdownPostProcessor((el, ctx) => {
			if (this.settings.hoverPreview) decorateReadingView(el, ctx);
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
		editor.focus();
		editor.setSelection(snapshot.from, snapshot.to);
		this.openComposer(editor, {
			text: snapshot.text,
			from: snapshot.from,
			to: snapshot.to,
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
			from: editor.getCursor("from"),
			to: editor.getCursor("to"),
		});
	}

	private handleMouseUp(evt: MouseEvent): void {
		if (!this.settings.showFloatingButton) return;
		const target = evt.target as HTMLElement | null;
		if (!target || !target.closest(".cm-editor")) return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const editor = view.editor;
		if (!editor.somethingSelected()) {
			this.floating?.hide();
			return;
		}

		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
		const rect = selection.getRangeAt(0).getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return;

		this.floating?.show(
			{
				view,
				from: editor.getCursor("from"),
				to: editor.getCursor("to"),
				text: editor.getSelection(),
			},
			rect,
		);
	}

	// ---------------------------------------------------------------- 写入

	private openComposer(editor: Editor, range: SelectionRange): void {
		let mode = this.settings.mode;
		if (mode === "inline" && !canUseInline(range.text)) {
			mode = "block";
			new Notice("选区跨行或含有 ==，已改用段落批注");
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
		range: SelectionRange,
		body: string,
	): void {
		if (mode === "inline") {
			if (editor.getRange(range.from, range.to) !== range.text) {
				new Notice("原文已经变化，批注没有写入，请重新选中");
				return;
			}
			editor.replaceRange(
				serializeInline(range.text, body),
				range.from,
				range.to,
			);
			return;
		}

		const lines = editor.getValue().split("\n");
		const insertAt = blockInsertLine(lines, range.to.line);
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

	// ---------------------------------------------------------------- 设置

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
