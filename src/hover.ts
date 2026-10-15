import { MarkdownPostProcessorContext, Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { EditorView } from "@codemirror/view";
import { findInlineAnnotations, lineOffsets, MARKER, normalizeForCompare, stripInlineMarkdown } from "./format";
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
 * 阅读视图：批注标记在渲染时就被丢掉了，所以要从源码里把批注取出来，
 * 再在渲染结果里找到对应的文字。
 *
 * 两步走：
 *   1. 优先找 Obsidian 自己渲染出来的 <mark>（旧格式 ==高亮== 的产物）；
 *   2. 找不到就自己把那段文字包进 <mark>。
 * 无论走哪条路，都把批注在源码里的绝对偏移记在 dataset 上 —— 悬停浮窗
 * 要拿它把改动写回文件（阅读视图里拿不到编辑器选区）。
 */
export async function decorateReadingView(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	app: App,
): Promise<void> {
	diag.postProcessorRuns++;

	const info = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
	if (!info) diag.sectionInfoMissing++;
	// 后处理器每一段都会跑：这一段源码里没有批注就直接撤，省掉一次文件读
	if (info && typeof info.text === "string" && !info.text.includes(MARKER)) return;

	const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (!(file instanceof TFile)) return;
	diag.fallbackReads++;
	const doc = await app.vault.cachedRead(file);
	const annotations = findInlineAnnotations(doc);
	if (!annotations.length) return;

	const section = info ? sectionRange(doc, info.lineStart, info.lineEnd) : null;
	const mine = section
		? annotations.filter((ann) => ann.from >= section.from && ann.from < section.to)
		: annotations;
	if (!mine.length) return;

	const marks = Array.from(el.querySelectorAll("mark")) as HTMLElement[];
	diag.marksFound += marks.length;

	const used = new Set<Element>();
	for (const ann of mine) {
		const target =
			findMatchingMark(marks, used, ann.text) ?? wrapTextNode(el, ann.text);
		if (!target) continue;
		used.add(target);
		diag.annotationsMatched++;
		target.addClass("lildog-ann");
		target.dataset.lildogFrom = String(ann.from);
		target.dataset.lildogTo = String(ann.to);
	}
}

/** 某个段落（行号范围）在源码里的字符范围 */
function sectionRange(
	doc: string,
	lineStart: number,
	lineEnd: number,
): { from: number; to: number } {
	const offsets = lineOffsets(doc);
	const from = offsets[lineStart] ?? 0;
	const to = offsets[lineEnd + 1] ?? doc.length;
	return { from, to: Math.max(from, to) };
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
