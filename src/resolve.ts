import { EditorView } from "@codemirror/view";
import { findInlineAnnotations, normalizeForCompare } from "./format";
import type { InlineAnnotation } from "./format";

/**
 * 从一个「带批注的高亮元素」倒推出它是哪一条批注。
 *
 * 两条通道：
 *   1. 编辑器：用 CodeMirror 把 DOM 位置换算成文档偏移（精确）；
 *   2. 阅读视图：用装饰时记在 dataset 上的源码偏移。
 * 换算不出来时退回按文字配对 —— 比对前会剥掉 `**`、反引号这类行内语法，
 * 否则「原文是 **必须加运放**、元素文字是 必须加运放」会配不上，浮窗就弹不出来。
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
	const cmEl = el.closest(".cm-editor") as HTMLElement | null;
	if (cmEl) {
		const cmView = EditorView.findFromDOM(cmEl);
		if (!cmView) {
			return { annotation: null, reason: "拿不到 CodeMirror 视图（EditorView.findFromDOM 返回 null）", pos: null };
		}
		let pos: number | null = null;
		let posError = "";
		try {
			pos = cmView.posAtDOM(el);
		} catch (error) {
			posError = error instanceof Error ? error.message : String(error);
		}
		if (pos !== null) {
			const byPos = annotations.find(
				(ann) => pos! >= ann.from && pos! <= ann.to,
			);
			if (byPos) {
				return { annotation: byPos, reason: `DOM 位置 ${pos} 落在它的区间里`, pos };
			}
		}
		const text = (el.textContent ?? "").trim();
		const byText = annotations.find(
			(ann) => normalizeForCompare(ann.text) === normalizeForCompare(text),
		);
		if (byText) {
			return {
				annotation: byText,
				reason:
					pos === null
						? `位置换算失败（${posError || "未知原因"}），按文字配对成功`
						: `DOM 位置 ${pos} 不在任何批注区间里，按文字配对成功`,
				pos,
			};
		}
		return {
			annotation: null,
			reason:
				pos === null
					? `位置换算失败（${posError || "未知原因"}），按文字配对也没匹配上（元素文字「${text}」）`
					: `DOM 位置 ${pos} 不在任何批注区间里，按文字配对也没匹配上（元素文字「${text}」）`,
			pos,
		};
	}

	// 阅读视图
	const from = Number(el.dataset.lildogFrom);
	const to = Number(el.dataset.lildogTo);
	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		return {
			annotation: null,
			reason: "阅读视图的高亮上没有记源码偏移（装饰没跑，或被别的插件重建了 DOM）",
			pos: null,
		};
	}
	const byOffset =
		annotations.find((ann) => ann.from === from && ann.to === to) ??
		annotations.find((ann) => from >= ann.from && from < ann.to);
	if (!byOffset) {
		return {
			annotation: null,
			reason: `高亮上记的偏移 ${from}-${to} 跟文件里的批注对不上（文件可能刚被改过）`,
			pos: from,
		};
	}
	return { annotation: byOffset, reason: `按高亮上记的偏移 ${from}-${to} 命中`, pos: from };
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
