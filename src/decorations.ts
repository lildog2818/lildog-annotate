import { Decoration, DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { EditorSelection, RangeSet, RangeSetBuilder } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { findInlineAnnotations, planEditorDecorations } from "./format";
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

/** 光标落在被藏起来的标记里时，把它挪到最近的一端（返回新位置，没落在里面就返回 null） */
export function cursorOutOfMarker(
	doc: string,
	pos: number,
): number | null {
	for (const ann of findInlineAnnotations(doc)) {
		for (const [start, end] of ann.hiddenRanges) {
			if (pos > start && pos < end) {
				return pos - start <= end - pos ? start : end;
			}
		}
	}
	return null;
}

/**
 * 光标守门员：把「落在藏起来的标记内部」的光标挪出来。
 *
 * 为什么需要它：重载 Obsidian 会恢复上次的光标位置，而这个位置完全可能
 * 落在标记内部（例如以前点在那段空白上留下的）。光标一旦在里面，标记
 * 就会一直露在正文里（老版本就是靠「露出」来提示这件事），正文看着很脏。
 * 现在改成：光标自动挪到最近的一端，标记继续藏着。
 *
 * 用 ViewPlugin 而不是 updateListener：编辑器**初始状态**也要检查一遍
 * （恢复的光标就在初始状态里），updateListener 不会为初始状态触发。
 */
export function createCursorGuard() {
	let scheduled = false;
	const fix = (view: EditorView) => {
		if (scheduled) return;
		const fixNow = () => {
			scheduled = false;
			const state = view.state;
			let changed = false;
			const ranges = state.selection.ranges.map((range) => {
				if (!range.empty) return range;
				const moved = cursorOutOfMarker(state.doc.toString(), range.from);
				if (moved === null) return range;
				changed = true;
				return EditorSelection.cursor(moved);
			});
			if (!changed || view.state.selection !== state.selection) return;
			view.dispatch({ selection: EditorSelection.create(ranges) });
		};
		scheduled = true;
		// 推迟到下一帧：不在视图正在更新的过程里再派发一次事务
		window.setTimeout(fixNow, 0);
	};

	return ViewPlugin.fromClass(
		class {
			constructor(view: EditorView) {
				fix(view);
			}
			update(update: ViewUpdate) {
				if (update.selectionSet || update.docChanged) fix(update.view);
			}
		},
	);
}
