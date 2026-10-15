import { MarkdownPostProcessorContext, Notice, setTooltip, TFile } from "obsidian";
import type { App } from "obsidian";
import { EditorView, hoverTooltip } from "@codemirror/view";
import { findInlineAnnotations, normalizeForCompare, stripInlineMarkdown } from "./format";
import type { InlineAnnotation } from "./format";
import { buildEditorDecorations } from "./decorations";
import { diag } from "./diagnostics";

/**
 * 编辑器装饰的注册方式照抄社区里跑通的插件（Annoteca）：
 * 用 EditorView.decorations 这个 facet 的 compute，而不是 ViewPlugin。
 * 依赖 doc 与 selection —— 文档变了重建，光标选中批注时把标记露出来。
 *
 * 另外：装饰构建一旦失败，标记就会全露在正文里。这种事不能再悄悄发生，
 * 所以失败时弹一次提示（推迟到下一帧，避免在 CM6 的计算过程里做副作用）。
 */
export function createEditorDecorations() {
	let warned = false;
	return EditorView.decorations.compute(["doc", "selection"], (state) => {
		const decorations = buildEditorDecorations(state);
		if (!warned && diag.editorLastError) {
			warned = true;
			const reason = diag.editorLastError;
			window.setTimeout(() => {
				new Notice(
					`Lildog Annotate：批注标记隐藏失败（${reason}）。命令面板里跑「运行自检」可以把诊断报告写进库里。`,
					12000,
				);
			}, 0);
		}
		return decorations;
	});
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
					dom.createDiv({ cls: "lildog-tooltip-body", text: ann.body });
					return { dom };
				},
			};
		},
		{ hoverTime: 150 },
	);
}

/**
 * 阅读视图：批注标记在渲染时就被丢掉了，所以要从源码里把批注取出来，
 * 再在渲染结果里找到对应的文字。
 *
 * 两步走：
 *   1. 优先找 Obsidian 自己渲染出来的 <mark>（旧格式 ==高亮== 的产物）；
 *   2. 找不到就自己把那段文字包进 <mark>。这样即使没有现成高亮，批注也照样
 *      有虚线和悬停内容。
 */
export async function decorateReadingView(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	app: App,
): Promise<void> {
	diag.postProcessorRuns++;

	const annotations = await collectAnnotations(el, ctx, app);
	if (!annotations.length) return;

	const marks = Array.from(el.querySelectorAll("mark")) as HTMLElement[];
	diag.marksFound += marks.length;

	const used = new Set<Element>();
	for (const ann of annotations) {
		const target =
			findMatchingMark(marks, used, ann.text) ?? wrapTextNode(el, ann.text);
		if (!target) continue;
		used.add(target);
		diag.annotationsMatched++;
		target.addClass("lildog-ann");
		if (ann.body.trim()) {
			setTooltip(target, ann.body, { placement: "top" });
		}
	}
}

async function collectAnnotations(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	app: App,
): Promise<InlineAnnotation[]> {
	const info = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
	if (info && typeof info.text === "string") {
		const found = findInlineAnnotations(info.text);
		if (found.length) return found;
	} else {
		diag.sectionInfoMissing++;
	}

	// 兜底：整篇读一遍，按文字内容配对
	const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (file instanceof TFile) {
		diag.fallbackReads++;
		return findInlineAnnotations(await app.vault.cachedRead(file));
	}
	return [];
}

/** 按文字内容找 Obsidian 渲染出来的高亮，比对时剥掉行内语法 */
function findMatchingMark(
	marks: HTMLElement[],
	used: Set<Element>,
	text: string,
): HTMLElement | null {
	const want = normalizeForCompare(text);
	if (!want) return null;
	return (
		marks.find(
			(mark) =>
				!used.has(mark) && normalizeForCompare(mark.textContent ?? "") === want,
		) ?? null
	);
}

/** 没有现成的高亮，就自己把这段文字包进 <mark> */
function wrapTextNode(el: HTMLElement, text: string): HTMLElement | null {
	const candidates: string[] = [];
	const raw = text.trim();
	if (raw) candidates.push(raw);
	const stripped = stripInlineMarkdown(text);
	if (stripped && stripped !== raw) candidates.push(stripped);
	if (!candidates.length) return null;

	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const parent = node.parentElement;
		if (!parent || parent.closest(".lildog-ann")) continue;
		const haystack = node.textContent ?? "";
		for (const needle of candidates) {
			const index = haystack.indexOf(needle);
			if (index === -1) continue;
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + needle.length);
			const mark = document.createElement("mark");
			mark.addClass("lildog-ann");
			try {
				range.surroundContents(mark);
			} catch {
				return null;
			}
			return mark;
		}
	}
	return null;
}
