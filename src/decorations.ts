import { Decoration, DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { EditorSelection, RangeSet, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Text } from "@codemirror/state";
import { findInlineAnnotations, planEditorDecorations } from "./format";
import type { DecorationEntry, DecorationPlan } from "./format";
import { diag } from "./diagnostics";

/** 带批注的文字加高亮 + 虚线下划线：既是提示，也是悬停的落点 */
const annotatedMark = Decoration.mark({ class: "lildog-ann" });

/** 把标记从正文里彻底藏掉（照社区跑通的写法，显式关掉 inclusive） */
const hiddenMarker = Decoration.replace({ inclusive: false });

interface PlanCacheEntry {
	/** 这份规划是按哪套选区算出来的（选区一变，「露不露标记」就跟着变） */
	selectionKey: string;
	plan: DecorationPlan;
}

/**
 * 「文档 + 选区 → 装饰规划」的单份缓存。
 *
 * 同一份文档、同一套选区，在一次输入里最多会被问四遍：装饰本体、原子区间、
 * 光标守门员、widget 底色。每一遍都要把整篇正则扫一次、再 `doc.toString()` 一次 ——
 * 笔记一大，打字就会卡在重复的解析上。用 `state.doc`（Text 对象）当键缓存：
 * 文档一变就是新对象，键自然失配，不会读到旧结果。
 */
const planCache = new WeakMap<Text, PlanCacheEntry>();

function selectionKeyOf(state: EditorState): string {
	return state.selection.ranges.map((range) => `${range.from}-${range.to}`).join(",");
}

function planFor(state: EditorState): DecorationPlan {
	const selectionKey = selectionKeyOf(state);
	const cached = planCache.get(state.doc);
	if (cached && cached.selectionKey === selectionKey) return cached.plan;

	const plan = planEditorDecorations(
		state.doc.toString(),
		state.selection.ranges.map((range) => [range.from, range.to] as const),
	);
	planCache.set(state.doc, { selectionKey, plan });
	return plan;
}

/**
 * 构建编辑器里的装饰。
 *
 * 排序在 planEditorDecorations 里做完了 —— RangeSetBuilder 要求严格按
 * from 递增，早期版本把原文高亮排在起始标记之前，它抛了异常、被 catch
 * 吞掉，结果一条替换装饰都没生成，标记全露在正文里。
 */
export function buildEditorDecorations(state: EditorState): DecorationSet {
	try {
		const plan = planFor(state);
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
		const ranges = planFor(state)
			.entries.filter((entry) => entry.kind === "hide" && entry.from < entry.to)
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

/** 同上，但直接读已经算好的装饰规划（守门员每动一次光标都会问，别再扫一遍全文） */
function cursorOutOfHidden(
	entries: DecorationEntry[],
	pos: number,
): number | null {
	for (const entry of entries) {
		if (entry.kind !== "hide") continue;
		if (pos > entry.from && pos < entry.to) {
			return pos - entry.from <= entry.to - pos ? entry.from : entry.to;
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
			// 藏起来的标记就是「当前没被选区压着」的那些：拿装饰规划，不再自己扫全文
			const hidden = planFor(state).entries.filter((entry) => entry.kind === "hide");
			if (!hidden.length) return;
			let changed = false;
			const ranges = state.selection.ranges.map((range) => {
				if (!range.empty) return range;
				const moved = cursorOutOfHidden(hidden, range.from);
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

/** 落在批注里的 widget 补上的类名 */
const WIDGET_CLASS = "lildog-ann-widget";

/**
 * 让高亮连成一条：批注里嵌着公式（`$…$`）这类 **widget** 时，
 * 它们是被「替换」出来的 DOM，CM6 的 mark 装饰盖不到 widget 本体上 ——
 * 批注以公式开头/结尾时它还会变成高亮的**兄弟节点**，于是紫带中间缺一块、
 * 看着断断续续（用户报的就是这个）。
 *
 * Obsidian 的行内公式元素是 `span.math`（不是 `.cm-widget`），所以两个都扫。
 * 按文档位置判断它在不在某条批注的原文范围里，在的话补一个类，样式里给同样的底色。
 *
 * 补画是**成帧合并**的：一次输入会连着来好几个 update，攒到下一帧只画一次。
 */
export function createWidgetHighlighter() {
	const paint = (view: EditorView) => {
		// 批注原文的区间就是规划里的 mark 条目（装饰已经算过一遍，这里直接复用）
		const ranges = planFor(view.state).entries.filter((entry) => entry.kind === "mark");
		const widgets = Array.from(
			view.dom.querySelectorAll<HTMLElement>(".math, .cm-widget, .cm-inline-math"),
		);
		if (!ranges.length) {
			// 批注全删了：widget 的 DOM 不会自己重建，得把之前补过的底色收回来
			for (const el of widgets) el.removeClass(WIDGET_CLASS);
			return;
		}
		for (const el of widgets) {
			let pos: number | null = null;
			try {
				pos = view.posAtDOM(el);
			} catch {
				pos = null;
			}
			const inside =
				pos !== null && ranges.some((range) => pos! >= range.from && pos! <= range.to);
			if (inside) el.addClass(WIDGET_CLASS);
			else el.removeClass(WIDGET_CLASS);
		}
	};

	return ViewPlugin.fromClass(
		class {
			private queued = false;

			constructor(private view: EditorView) {
				this.queue();
			}

			update(update: ViewUpdate) {
				if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return;
				this.queue();
			}

			private queue(): void {
				if (this.queued) return;
				this.queued = true;
				window.setTimeout(() => {
					this.queued = false;
					paint(this.view);
				}, 0);
			}
		},
	);
}
