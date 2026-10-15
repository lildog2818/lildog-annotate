import { MarkdownView, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import { BUILD_ID } from "./build";
import { diag } from "./diagnostics";
import { findInlineAnnotations, stripInlineMarkdown } from "./format";

const REPORT_PATH = "DSH/lildog-自检报告.md";

/** 两次自检之间的分隔，报告只保留最近几次 */
const RUN_SEPARATOR = "\n<!-- lildog:run -->\n";
const MAX_RUNS = 4;

function fence(text: string): string {
	return `~~~\n${text}\n~~~`;
}

function clip(text: string, limit: number): string {
	return text.length > limit
		? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字）`
		: text;
}

function describeNodes(el: Element | null): string {
	if (!el) return "无";
	return Array.from(el.childNodes)
		.map((node) => {
			if (node.nodeType === 8) return "HTML注释(8)";
			if (node.nodeType === 3) {
				const text = (node.textContent ?? "").trim();
				return `文本(3):${text.length > 12 ? `${text.slice(0, 12)}…` : text}`;
			}
			if (node.nodeType === 1) {
				return `元素<${(node as Element).tagName.toLowerCase()}>`;
			}
			return `类型${node.nodeType}`;
		})
		.join(" | ");
}

/**
 * 把插件的运行时状态写成一份报告塞进库里。
 * 界面里的错误我这边看不到，留一条能读的通道。
 */
export async function writeSelfCheckReport(
	app: App,
	pluginVersion: string,
): Promise<string> {
	const lines: string[] = [];

	lines.push("# Lildog Annotate 自检报告");
	lines.push("");
	lines.push(`- 插件版本：${pluginVersion}`);
	lines.push(`- 加载的构建：${BUILD_ID}`);
	lines.push(`- 生成时间：${new Date().toLocaleString("zh-CN")}`);
	lines.push(`- 编辑器装饰构建次数：${diag.editorBuilds}`);
	lines.push(`- 编辑器装饰报错：${diag.editorLastError ?? "无"}`);
	lines.push(`- 最近一次构建解析到的行内批注：${diag.editorAnnotationsSeen} 条`);
	lines.push(
		`- 阅读视图后处理器：调用 ${diag.postProcessorRuns} 次 / getSectionInfo 为空 ${diag.sectionInfoMissing} 次 / 兜底整篇读 ${diag.fallbackReads} 次`,
	);
	lines.push(
		`- 阅读视图：见过 mark ${diag.marksFound} 个 / 配对成功 ${diag.annotationsMatched} 条`,
	);
	lines.push(
		`- 整个界面里 .lildog-ann（批注高亮）元素：${document.querySelectorAll(".lildog-ann").length} 个`,
	);
	lines.push(`- 最近一次选中文字探测：${diag.lastSelection}`);
	lines.push("");
	lines.push("## 逐窗格探针");

	const leaves = app.workspace.getLeavesOfType("markdown");
	if (!leaves.length) {
		lines.push("当前没有打开的 Markdown 窗格。");
	}

	leaves.forEach((leaf, index) => {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;

		const mode = view.getMode() === "preview" ? "阅读视图" : "编辑视图";
		const container = view.containerEl;
		const annotations = findInlineAnnotations(view.editor.getValue());

		lines.push("");
		lines.push(`### 窗格 ${index + 1}：${mode} — ${view.file?.path ?? "未知"}`);
		lines.push(`- 文件里共 ${annotations.length} 条行内批注`);
		lines.push(
			`- 该窗格 .cm-line ${container.querySelectorAll(".cm-line").length} 个 / .lildog-ann ${container.querySelectorAll(".lildog-ann").length} 个 / mark ${container.querySelectorAll("mark").length} 个`,
		);

		const first = annotations[0];
		if (!first) {
			lines.push("- 该文件没有行内批注，跳过 DOM 探针。");
			return;
		}

		lines.push(`- 第 1 条：原文「${first.text}」 / 批注「${first.body}」`);

		// 编辑态：看标记有没有被藏住
		const cmLines = Array.from(
			container.querySelectorAll(".cm-line"),
		) as HTMLElement[];
		// 实时预览会吃掉行内代码的反引号，所以两种形式都拿来找
		const candidates = [first.text, stripInlineMarkdown(first.text)].filter(
			(candidate) => candidate.trim().length > 0,
		);
		const hit = cmLines.find((line) =>
			candidates.some((candidate) => (line.textContent ?? "").includes(candidate)),
		);
		if (hit) {
			lines.push(
				"- 编辑 DOM：该行 textContent（出现 lildog 或 `<!--` 就是没藏住）：",
			);
			lines.push(fence(clip(hit.textContent ?? "", 600)));
			lines.push("- 编辑 DOM：该行 innerHTML：");
			lines.push(fence(clip(hit.innerHTML, 900)));
		}

		// 阅读态：看配对有没有成功
		const marks = Array.from(
			container.querySelectorAll("mark"),
		) as HTMLElement[];
		const annotated = container.querySelector(
			"mark.lildog-ann",
		) as HTMLElement | null;
		if (annotated) {
			lines.push("- 阅读 DOM：已配对的高亮 outerHTML：");
			lines.push(fence(clip(annotated.outerHTML, 400)));
		} else if (marks[0]) {
			lines.push("- 阅读 DOM：没有配对上。第一个 mark 的 outerHTML：");
			lines.push(fence(clip(marks[0].outerHTML, 400)));
			lines.push(
				`- 该高亮所在容器的子节点：${describeNodes(marks[0].parentElement)}`,
			);
		} else if (mode === "阅读视图") {
			lines.push("- 阅读 DOM：这个窗格里一个 <mark> 都没有。");
		}
	});

	// ---------------------------------------------------------------- 写文件
	const content = `${lines.join("\n")}\n`;
	const path = normalizePath(REPORT_PATH);
	const folder = "DSH";
	if (!app.vault.getAbstractFileByPath(folder)) {
		try {
			await app.vault.createFolder(folder);
		} catch {
			// 多半是已经被别处建好了
		}
	}

	const existing = app.vault.getAbstractFileByPath(path);
	let merged = content;
	if (existing instanceof TFile) {
		const previous = await app.vault.read(existing);
		const runs = [content, ...previous.split(RUN_SEPARATOR)]
			.filter((run) => run.trim().length)
			.slice(0, MAX_RUNS);
		merged = runs.join(RUN_SEPARATOR);
		await app.vault.modify(existing, merged);
	} else {
		await app.vault.create(path, merged);
	}
	return path;
}
