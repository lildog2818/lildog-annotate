import { MarkdownPostProcessorContext, setIcon, setTooltip } from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
	hoverTooltip,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { findInlineAnnotations } from "./format";

/** 带批注的文字加一条虚线下划线 */
const annotatedMark = Decoration.mark({ class: "lildog-ann" });

/**
 * 把隐藏注释折叠成一个小图标，免得正文里横着一段 `<!-- lildog: … -->`。
 * 点一下图标，光标会落进批注里，原始标记就会露出来方便改。
 */
class AnnotationIcon extends WidgetType {
	constructor(readonly body: string) {
		super();
	}

	eq(other: AnnotationIcon): boolean {
		return other.body === this.body;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.addClass("lildog-widget");
		setIcon(span, "message-square");
		if (this.body.trim()) span.setAttribute("aria-label", this.body);
		return span;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

function buildDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc.toString();
	const { from: viewportFrom, to: viewportTo } = view.viewport;
	const selection = view.state.selection.ranges;

	for (const ann of findInlineAnnotations(doc)) {
		if (ann.to < viewportFrom || ann.from > viewportTo) continue;

		builder.add(ann.from, ann.textTo + 2, annotatedMark);

		// 光标或选区碰到这条批注时，把原始标记露出来，方便直接编辑
		const touched = selection.some(
			(range) => range.from <= ann.to && range.to >= ann.from,
		);
		if (!touched && ann.commentFrom < ann.to) {
			builder.add(
				ann.commentFrom,
				ann.to,
				Decoration.replace({ widget: new AnnotationIcon(ann.body) }),
			);
		}
	}
	return builder.finish();
}

export function createEditorDecorations() {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet
				) {
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
