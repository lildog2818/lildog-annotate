import { MarkdownPostProcessorContext, setTooltip } from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	hoverTooltip,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { findInlineAnnotations } from "./format";

/**
 * 给编辑器里的行内批注加一条虚线下划线，提示「这里是有批注的」。
 * 高亮本身由 Obsidian 的 ==…== 负责，这里只是补一个记号。
 */
const annotatedMark = Decoration.mark({ class: "lildog-ann" });

function buildDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc.toString();
	const { from: vpFrom, to: vpTo } = view.viewport;
	for (const ann of findInlineAnnotations(doc)) {
		if (ann.to < vpFrom || ann.from > vpTo) continue;
		builder.add(ann.from, ann.to, annotatedMark);
	}
	return builder.finish();
}

export function createUnderlineExtension() {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view);
				}
			}
		},
		{
			decorations: (value) => value.decorations,
		},
	);
}

/**
 * 编辑器（实时预览 / 源码模式）里悬停显示批注内容。
 * 编辑器里能直接读到源码，所以这里的位置判断是精确的。
 */
export function createHoverExtension(enabled: () => boolean) {
	return hoverTooltip(
		(view, pos) => {
			if (!enabled()) return null;
			const ann = findInlineAnnotations(view.state.doc.toString()).find(
				(item) => pos >= item.from && pos <= item.to,
			);
			if (!ann || !ann.body.trim()) return null;
			return {
				pos: ann.from,
				end: ann.to,
				above: true,
				create: () => {
					const dom = document.createElement("div");
					dom.addClass("lildog-tooltip");
					dom.createDiv({ cls: "lildog-tooltip-label", text: "批注" });
					dom.createDiv({ cls: "lildog-tooltip-body", text: ann.body });
					return { dom };
				},
			};
		},
		{ hoverTime: 150 },
	);
}

/**
 * 阅读视图里 HTML 注释被渲染器丢掉了，所以改用「按原文配对」的办法：
 * 先从该段落的源码里取出所有行内批注，再按文字内容找到对应的 <mark>。
 */
export function decorateReadingView(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
): void {
	const info = ctx.getSectionInfo(el);
	if (!info) return;
	const annotations = findInlineAnnotations(info.text);
	if (!annotations.length) return;

	const marks = Array.from(el.querySelectorAll("mark"));
	if (!marks.length) return;

	const used = new Set<Element>();
	for (const ann of annotations) {
		const target = marks.find(
			(mark) =>
				!used.has(mark) &&
				(mark.textContent ?? "").trim() === ann.text.trim(),
		);
		if (!target) continue;
		used.add(target);
		target.addClass("lildog-ann");
		if (ann.body.trim()) {
			setTooltip(target as HTMLElement, ann.body, { placement: "top" });
		}
	}
}
