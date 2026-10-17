import { EditorView } from "@codemirror/view";
import { findInlineAnnotations, normalizeForCompare } from "./format";
import type { InlineAnnotation } from "./format";
import { cellElementOf, findOuterCmView, locateCell } from "./anchor";

/**
 * 从一个「带批注的高亮元素」倒推出它是哪一条批注。
 *
 * 三条通道，按可靠性排序：
 *   1. **装饰时记在元素上的偏移**（dataset）：最准，重复值也不会认错；
 *   2. **源码位置**：编辑器里用 CodeMirror 把 DOM 位置换算成偏移；表格单元格里
 *      先算出这一格在源码里的区间，再取「原文完全落在这格里」的那一条；
 *   3. 按文字配对兜底 —— 但必须**位置也对得上**（在同一段源码附近），
 *      不再「全文找第一处」：重复值一多就会认成别的那条，浮窗里改的也就是别的那条。
 *
 * 返回值里带一句人话解释，直接写进自检报告：出问题时不用猜是哪一步断的。
 */
export interface ResolvedHighlight {
	annotation: InlineAnnotation | null;
	/** 解析过程的人话说明 */
	reason: string;
	/** 编辑器里换算出来的 DOM 偏移（阅读视图下是 dataset 里的起点） */
	pos: number | null;
}

export function resolveHighlight(
	el: HTMLElement,
	doc: string,
	annotations: InlineAnnotation[] = findInlineAnnotations(doc),
): ResolvedHighlight {
	// 1) 装饰时记下的偏移
	const marked = Number(el.dataset.lildogFrom);
	const markedTo = Number(el.dataset.lildogTo);
	if (Number.isFinite(marked) && Number.isFinite(markedTo)) {
		const exact = annotations.find((ann) => ann.from === marked && ann.to === markedTo);
		if (exact) {
			return { annotation: exact, reason: `按高亮上记的偏移 ${marked}-${markedTo} 命中`, pos: marked };
		}
	}

	const text = normalizeForCompare(el.textContent ?? "");
	const byText = (list: InlineAnnotation[]): InlineAnnotation | null =>
		list.find((ann) => normalizeForCompare(ann.text) === text) ?? null;

	// 2) 编辑器：源码位置
	const cmEl = el.closest(".cm-editor");
	if (cmEl) {
		const cmView = findOuterCmView(el);
		if (!cmView) {
			return { annotation: null, reason: "拿不到 CodeMirror 视图", pos: null };
		}

		let pos: number | null = null;
		let posError = "";
		try {
			pos = cmView.posAtDOM(el);
		} catch (error) {
			posError = error instanceof Error ? error.message : String(error);
		}

		if (pos !== null) {
			const byPos = annotations.find((ann) => pos! >= ann.from && pos! <= ann.to);
			if (byPos) {
				return { annotation: byPos, reason: `DOM 位置 ${pos} 落在它的区间里`, pos };
			}

			// 表格单元格：位置会落到整个 widget 的起点上，得按「第几行第几格」算
			const cellEl = cellElementOf(el);
			if (cellEl) {
				const located = locateCell(doc, cellEl);
				if (located.ok) {
					const inside = annotations.filter(
						(ann) => ann.textFrom >= located.loc.from && ann.textTo <= located.loc.to,
					);
					if (inside.length === 1) {
						return { annotation: inside[0], reason: "格子区间里唯一的一条批注", pos };
					}
					const picked = byText(inside);
					if (picked) {
						return { annotation: picked, reason: "格子区间里按文字认领", pos };
					}
					return {
						annotation: null,
						reason: `这一格（源码 ${located.loc.from}-${located.loc.to}）里有 ${inside.length} 条批注，认不准是哪一条`,
						pos,
					};
				}
				return { annotation: null, reason: `表格位置算不出来：${located.reason}`, pos };
			}

			// 别的块级 widget（公式、代码块…）：位置在附近 + 文字对得上才算
			const near = annotations.filter((ann) => {
				const slack = Math.max(160, ann.text.length * 4);
				return pos! >= ann.from - slack && pos! <= ann.to + slack;
			});
			const picked = byText(near);
			if (picked) {
				return { annotation: picked, reason: `块级 widget：位置 ${pos} 在附近且文字对得上`, pos };
			}
		}

		return {
			annotation: null,
			reason:
				pos === null
					? `位置换算失败（${posError || "未知原因"}），按文字也没在附近匹配上`
					: `DOM 位置 ${pos} 附近没有文字对得上的批注（元素文字「${el.textContent ?? ""}」）`,
			pos,
		};
	}

	// 3) 阅读视图：没有 CodeMirror，只能按文字（段落范围内由装饰时保证）
	if (Number.isFinite(marked) && Number.isFinite(markedTo)) {
		return {
			annotation: null,
			reason: `高亮上记的偏移 ${marked}-${markedTo} 跟文件里的批注对不上（文件可能刚被改过）`,
			pos: marked,
		};
	}
	return {
		annotation: null,
		reason: "阅读视图的高亮上没有记源码偏移（装饰没跑，或被别的插件重建了 DOM）",
		pos: null,
	};
}

/**
 * 高亮元素在鼠标底下那一块的矩形。
 *
 * 被批注的文字折行时，一个 span 会有好几段 client rect，`getBoundingClientRect()`
 * 返回的是把它们全包住的**大盒子**：中心点可能落在两行之间的空白上，
 * 拿它去定位浮窗就会飘到别处，甚至让鼠标「停在」浮窗上。
 */
export function rectUnderPointer(el: HTMLElement, x: number, y: number): DOMRect {
	const rects = Array.from(el.getClientRects());
	const hit = rects.find(
		(rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
	);
	return hit ?? rects[0] ?? el.getBoundingClientRect();
}
