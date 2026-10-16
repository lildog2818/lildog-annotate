import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { RangeSet, RangeSetBuilder } from "@codemirror/state";
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

/**
 * 把「被藏起来的标记」登记成 CodeMirror 的**原子区间**。
 *
 * 这一步不做的话，鼠标点在标记那一段（视觉上是空的）上时，光标会被塞进
 * 标记**内部**；插件看到「光标停在标记里」就把整条批注的原始标记露出来
 * —— 表现就是「批注着批注着，正文里突然冒出一堆 `<!--lildog: …-->`」。
 * 登记成原子区间后，点击/方向键都会自动跳到最近的一端，光标进不去。
 *
 * 只登记**藏起来**的标记：标记已经露出来（用户要直接改）时不设原子，
 * 否则光标又进不去、改不了。
 */
export function buildAtomicRanges(state: EditorState) {
	try {
		const plan = planEditorDecorations(
			state.doc.toString(),
			state.selection.ranges.map((range) => [range.from, range.to] as const),
		);
		const ranges = plan.entries
			.filter((entry) => entry.kind === "hide" && entry.from < entry.to)
			.map((entry) => Decoration.replace({}).range(entry.from, entry.to));
		return ranges.length ? RangeSet.of(ranges, true) : Decoration.none;
	} catch {
		return Decoration.none;
	}
}

export function createAtomicRanges() {
	return EditorView.atomicRanges.of((view) => buildAtomicRanges(view.state));
}
