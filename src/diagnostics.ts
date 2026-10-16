/**
 * 运行时诊断计数。
 *
 * 插件的装饰/后处理器都跑在 Obsidian 的界面里，出问题时日志拿不到，
 * 所以把关键中间状态记下来，由「运行自检」命令写进库里的报告文件。
 */

export interface DiagnosticCounters {
	/** 编辑器装饰重建次数（每次输入都会加，能涨说明扩展活着） */
	editorBuilds: number;
	/** 编辑器装饰构建时捕获到的异常信息 */
	editorLastError: string | null;
	/** 最近一次构建时在当前文档里解析到的行内批注数 */
	editorAnnotationsSeen: number;
	/** 阅读视图后处理器被调用的次数 */
	postProcessorRuns: number;
	/** getSectionInfo 返回空的次数 */
	sectionInfoMissing: number;
	/** 后处理器见过的 <mark> 总数 */
	marksFound: number;
	/** 成功配对上的批注数 */
	annotationsMatched: number;
	/** 走整篇兜底读取的次数 */
	fallbackReads: number;
	/** 悬停浮窗弹出来的次数 */
	hoverShows: number;
	/** 悬停到高亮、但认不出是哪条批注的次数 */
	hoverMisses: number;
	/** 在悬停浮窗里改完批注的次数 */
	hoverEdits: number;
	/** 最近一次悬停解析的说明（成功 / 失败的原因） */
	lastHoverResolve: string;
	/** 最近一次悬停浮窗的目标（弹不出来时看这里） */
	lastHover: string;
	/** 最近一次「选中文字」探测：浮动按钮为什么出现/没出现 */
	lastSelection: string;
}

export const diag: DiagnosticCounters = {
	editorBuilds: 0,
	editorLastError: null,
	editorAnnotationsSeen: 0,
	postProcessorRuns: 0,
	sectionInfoMissing: 0,
	marksFound: 0,
	annotationsMatched: 0,
	fallbackReads: 0,
	hoverShows: 0,
	hoverMisses: 0,
	hoverEdits: 0,
	lastHoverResolve: "（还没有悬停过）",
	lastHover: "（还没有悬停过批注）",
	lastSelection: "（还没有在编辑器里选过文字）",
};

export function resetDiagnostics(): void {
	diag.editorBuilds = 0;
	diag.editorLastError = null;
	diag.editorAnnotationsSeen = 0;
	diag.postProcessorRuns = 0;
	diag.sectionInfoMissing = 0;
	diag.marksFound = 0;
	diag.annotationsMatched = 0;
	diag.fallbackReads = 0;
	diag.hoverShows = 0;
	diag.hoverMisses = 0;
	diag.hoverEdits = 0;
	diag.lastHoverResolve = "（还没有悬停过）";
	diag.lastHover = "（还没有悬停过批注）";
	diag.lastSelection = "（还没有在编辑器里选过文字）";
}
