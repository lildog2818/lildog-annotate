import { MarkdownView, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import { BUILD_ID } from "./build";
import { diag } from "./diagnostics";
import { explainReveal, findInlineAnnotations } from "./format";
import { countLildogRules, hasInjectedStyles } from "./style";
import { resolveHighlight } from "./resolve";

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
	appearance: {
		annotatedTextColor: string;
		highlightColor: string;
		highlightOpacity: number;
		cardFontSize: number;
	},
): Promise<string> {
	const settings = appearance;
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
	lines.push(
		`- 悬停浮窗：弹出 ${diag.hoverShows} 次 / 认不出来 ${diag.hoverMisses} 次 / 在浮窗里改完 ${diag.hoverEdits} 次`,
	);
	lines.push(`- 最近一次悬停解析：${diag.lastHoverResolve}`);
	lines.push(`- 最近一次悬停：${diag.lastHover}`);
	lines.push(`- 最近一次选中文字探测：${diag.lastSelection}`);
	lines.push(
		`- 外观：批注文字 ${settings.annotatedTextColor} / 底色 ${settings.highlightColor} ${Math.round(settings.highlightOpacity * 100)}% / 浮窗字号 ${settings.cardFontSize}px`,
	);
	lines.push("");
	lines.push("## 样式自检");
	lines.push(
		`- 运行期注入的样式：${hasInjectedStyles() ? "有（插件自己注入了一份，和主题无关）" : "没有（异常）"}`,
	);
	lines.push(
		`- 界面上跟 lildog 有关的 CSS 规则：${countLildogRules()} 条（插件目录里的 styles.css 有没有被 Obsidian 加载，看这个和上面那条）`,
	);
	const style = document.body.style;
	lines.push(
		`- body 上的变量：底色 ${style.getPropertyValue("--lildog-annotate-bg") || "（没设）"} / 文字 ${style.getPropertyValue("--lildog-annotate-fg") || "（没设）"} / 下划线 ${style.getPropertyValue("--lildog-annotate-line") || "（没设）"} / 浮窗字号 ${style.getPropertyValue("--lildog-card-font-size") || "（没设）"}`,
	);
	const firstHighlight = document.querySelector(".lildog-ann") as HTMLElement | null;
	if (firstHighlight) {
		const cs = getComputedStyle(firstHighlight);
		lines.push(
			`- 第一个高亮的计算样式：颜色 ${cs.color} / 底色 ${cs.backgroundColor} / 下划线 ${cs.boxShadow || "无"}`,
		);
		lines.push(
			`- 如果「颜色」和「底色」看起来跟正文一样、下划线是 none，说明样式没生效 —— 那就是这份报告要抓的问题。`,
		);
	} else {
		lines.push("- 界面上一个 .lildog-ann 都没有：要么当前笔记没有批注，要么装饰没建起来。");
	}
	if (diag.lastSelection) lines.push(`- 最近一次选中探测：${diag.lastSelection}`);
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
		const doc = view.editor.getValue();
		const annotations = findInlineAnnotations(doc);
		const highlights = Array.from(
			container.querySelectorAll(".lildog-ann"),
		) as HTMLElement[];
		const selections = view.editor
			.listSelections()
			.map(
				(range) =>
					[
						view.editor.posToOffset(range.anchor),
						view.editor.posToOffset(range.head),
					] as const,
			);

		lines.push("");
		lines.push(`### 窗格 ${index + 1}：${mode} — ${view.file?.path ?? "未知"}`);
		lines.push(
			`- 文件里共 ${annotations.length} 条行内批注；这个窗格里有 ${highlights.length} 个高亮元素`,
		);
		lines.push(
			`- 该窗格 .cm-line ${container.querySelectorAll(".cm-line").length} 个 / mark ${container.querySelectorAll("mark").length} 个`,
		);
		lines.push(
			`- 光标/选区：${selections.map((sel) => `${sel[0]}-${sel[1]}`).join(" / ") || "无"}`,
		);

		// 阅读视图是不是根本没渲染（渲染为空时既没有高亮也没有悬停落点）
		if (mode === "阅读视图") {
			const preview = view.previewMode as unknown as {
				renderer?: { text?: string };
			} | null;
			const renderedText = preview?.renderer?.text ?? "";
			const sizer = container.querySelector(".markdown-preview-sizer");
			const visible = (container.querySelector(".markdown-reading-view")?.textContent ?? "")
				.length;
			lines.push(
				`- 阅读视图渲染状态：渲染器里的文本 ${renderedText.length} 字 / 预览容器子节点 ${sizer?.children.length ?? 0} 个 / 界面上可见文字 ${visible} 字`,
			);
			if (visible === 0) {
				lines.push(
					"- 阅读视图现在是空的：正文都没渲染出来，高亮和悬停自然也没有。切一下编辑/阅读模式，或者重开这篇笔记看看。",
				);
			}
		}

		// 编辑器 DOM 里有没有把原始标记露出来（露出来时正文里会出现 lildog 字样）
		const cmLines = Array.from(
			container.querySelectorAll(".cm-line"),
		) as HTMLElement[];
		const leaked = cmLines.filter((line) =>
			(line.textContent ?? "").includes("lildog"),
		);
		lines.push(
			`- 编辑器 DOM 里露出 lildog 字样的行：${leaked.length} 行${leaked.length ? "（下面逐条说明是谁弄露的）" : ""}`,
		);

		if (!annotations.length) {
			lines.push("- 该文件没有行内批注，跳过逐条探针。");
			return;
		}

		// 逐条：露出判定 + 高亮几何 + 悬停解析，一次把「为什么看不见 / 弹不出来」说清
		annotations.forEach((ann, order) => {
			lines.push("");
			lines.push(
				`#### 第 ${order + 1} 条：原文「${clip(ann.text, 40)}」 / 批注「${clip(ann.body, 40)}」`,
			);
			lines.push(
				`- 源码区间 ${ann.from}-${ann.to}（原文 ${ann.textFrom}-${ann.textTo}，格式 ${ann.format}）`,
			);
			const reveal = explainReveal(ann, selections);
			lines.push(
				`- 原始标记：${reveal.revealed ? `露出 —— ${reveal.why}` : "已藏住"}`,
			);

			const mine = highlights.filter(
				(el) => resolveHighlight(el, doc, annotations).annotation === ann,
			);
			if (!mine.length) {
				lines.push(
					"- 界面上没有对应的高亮：装饰没建起来（看上面的装饰报错），或者这一段当前没渲染。",
				);
				return;
			}
			mine.forEach((el, sub) => {
				const resolved = resolveHighlight(el, doc, annotations);
				const box = el.getBoundingClientRect();
				const rects = Array.from(el.getClientRects()).filter(
					(rect) => rect.width > 0 && rect.height > 0,
				);
				if (rects.length === 0) {
					// 另一个视图模式留在 DOM 里的残影（阅读视图的 <mark> 在编辑模式下就是 0×0），不算问题
					lines.push(
						`- 高亮 #${sub + 1}：<${el.tagName.toLowerCase()}>「${clip(el.textContent ?? "", 20)}」当前不可见（0×0），多半是另一个视图模式的残留 DOM，跳过几何检查。`,
					);
					return;
				}
				const rect = rects[0]!;
				const cx = Math.round(rect.left + rect.width / 2);
				const cy = Math.round(rect.top + rect.height / 2);
				const stack = document.elementsFromPoint(cx, cy);
				// 插件自己的浮窗/按钮可能正压在上面，做几何判定时要跳过它们
				const hit =
					stack.find(
						(node) =>
							!node.classList?.contains("lildog-card") &&
							!node.classList?.contains("lildog-float-btn"),
					) ?? null;
				const hitIsHighlight = stack.some((node) => node === el || el.contains(node));
				lines.push(
					`- 高亮 #${sub + 1}：<${el.tagName.toLowerCase()}> 文字「${clip(el.textContent ?? "", 24)}」，` +
						`几何 ${Math.round(box.width)}x${Math.round(box.height)}，client rect ${rects.length} 段` +
						`${rects.length > 1 ? "（文字折行了：一个高亮横跨两行，鼠标要停在文字上才落得到它）" : ""}`,
				);
				lines.push(
					`  - 文字中心命中的元素：${
						hit ? `${hit.tagName.toLowerCase()}（${hitIsHighlight ? "命中链里有这个高亮，鼠标停得上来" : "命中链里没有这个高亮 —— 鼠标停在这段文字上时落不到它，悬停浮窗就不会弹"}）` : "无"
					}`,
				);
				lines.push(`  - 悬停能不能认出这条批注：${resolved.reason}`);
			});
		});

		// 阅读态：看配对有没有成功（老问题：按文字找 DOM 可能找不到）
		if (mode === "阅读视图") {
			const annotated = container.querySelector(
				"mark.lildog-ann",
			) as HTMLElement | null;
			const marks = Array.from(container.querySelectorAll("mark")) as HTMLElement[];
			if (annotated) {
				lines.push("");
				lines.push("- 阅读 DOM：已配对的高亮 outerHTML：");
				lines.push(fence(clip(annotated.outerHTML, 400)));
			} else if (marks[0]) {
				lines.push("");
				lines.push("- 阅读 DOM：没有配对上。第一个 mark 的 outerHTML：");
				lines.push(fence(clip(marks[0].outerHTML, 400)));
				lines.push(`- 该高亮所在容器的子节点：${describeNodes(marks[0].parentElement)}`);
			} else {
				lines.push("");
				lines.push("- 阅读 DOM：这个窗格里一个 <mark> 都没有。");
			}
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
