import { Decoration, DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { planEditorDecorations } from "./format";
import { diag } from "./diagnostics";

/** 带批注的文字加高亮 + 虚线下划线：既是提示，也是悬停的落点 */
const annotatedMark = Decoration.mark({ class: "lildog-ann" });

/** 把标记从正文里彻底藏掉（照社区跑通的写法，显式关掉 inclusive） */
const hiddenMarker = Decoration.replace({ inclusive: false });

/**
 * 构建编辑器里的装饰。
 *
 * 排序在 planEditorDecorations 里做完了 —— RangeSetBuilder 要求严格按
 * from 递增，早期版本把原文高亮排在起始标记之前，它抛了异常、被 catch
 * 吞掉，结果一条替换装饰都没生成，标记全露在正文里。
 */
export function buildEditorDecorations(state: EditorState): DecorationSet {
	try {
		const plan = planEditorDecorations(
			state.doc.toString(),
			state.selection.ranges.map((range) => [range.from, range.to] as const),
		);
		diag.editorBuilds++;
		diag.editorAnnotationsSeen = plan.annotations;

		const builder = new RangeSetBuilder<Decoration>();
		for (const entry of plan.entries) {
			builder.add(
				entry.from,
				entry.to,
				entry.kind === "mark" ? annotatedMark : hiddenMarker,
			);
		}
		return builder.finish();
	} catch (error) {
		diag.editorLastError =
			error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error("[lildog-annotate] 构建编辑器装饰失败", error);
		return Decoration.none;
	}
}
