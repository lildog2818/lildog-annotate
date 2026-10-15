/**
 * 批注的存储格式定义与纯函数实现。
 *
 * 设计原则：批注必须是**笔记正文里的纯文本**，这样人和 AI 都能直接用
 * 文本工具（编辑器 / grep / 大模型读文件）读到，不依赖任何插件数据库。
 *
 * 行内批注（inline）：
 *   ==被批注的文字==<!-- lildog: 批注内容 -->
 *
 * 段落批注（block）：
 *   > [!lildog] 批注
 *   > 原文：被批注的文字
 *   >
 *   > 批注内容
 */

export const MARKER = "lildog";

/** 行内批注整段（含高亮与隐藏注释） */
export interface InlineAnnotation {
	/** 匹配起点（`==` 的位置） */
	from: number;
	/** 匹配终点（`-->` 之后） */
	to: number;
	/** 被批注的原文（不含 `==`） */
	text: string;
	/** 批注内容 */
	body: string;
	/** 高亮部分的起点（`==` 之后） */
	textFrom: number;
	/** 高亮部分的终点（后一个 `==` 之前） */
	textTo: number;
	/** 隐藏注释的起点（`<!--` 的位置） */
	commentFrom: number;
}

/** 段落批注（以行为单位） */
export interface BlockAnnotation {
	/** callout 首行行号（0 起） */
	startLine: number;
	/** callout 末行行号（含） */
	endLine: number;
	/** 原文引用 */
	quote: string;
	/** 批注内容 */
	body: string;
}

const INLINE_SOURCE = (): string =>
	`==([^=\\n]+?)==[ \\t]*<!--\\s*${MARKER}:\\s*([\\s\\S]*?)\\s*-->`;

export function inlineRegex(): RegExp {
	return new RegExp(INLINE_SOURCE(), "g");
}

/** 段落批注的 callout 首行：`> [!lildog] 批注` */
export function blockHeadRegex(): RegExp {
	return new RegExp(`^>[ \\t]*\\[!${MARKER}\\][ \\t]*(.*)$`);
}

export function isBlockHead(line: string): boolean {
	return blockHeadRegex().test(line);
}

/** 找出全文所有行内批注，按出现顺序返回 */
export function findInlineAnnotations(doc: string): InlineAnnotation[] {
	const re = inlineRegex();
	const out: InlineAnnotation[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(doc)) !== null) {
		const textFrom = m.index + 2;
		const textTo = textFrom + m[1].length;
		const commentRel = m[0].indexOf("<!--", textTo - m.index);
		out.push({
			from: m.index,
			to: m.index + m[0].length,
			text: m[1],
			body: m[2],
			textFrom,
			textTo,
			commentFrom: commentRel === -1 ? textTo + 2 : m.index + commentRel,
		});
		if (m.index === re.lastIndex) re.lastIndex++;
	}
	return out;
}

/**
 * 行内批注要求：单行、不含 `==`、不含注释起始符。
 * 不满足时调用方应回退到段落批注。
 */
export function canUseInline(text: string): boolean {
	return (
		text.trim().length > 0 &&
		!text.includes("\n") &&
		!text.includes("\r") &&
		!text.includes("==") &&
		!text.includes("<!--")
	);
}

/** 批注正文里的 `-->` 会提前关闭 HTML 注释，做转义 */
function escapeBody(body: string): string {
	return body.replace(/-->/g, "-- >");
}

/** 生成行内批注文本 */
export function serializeInline(text: string, body: string): string {
	const oneLine = escapeBody(body).replace(/\s*\r?\n\s*/g, " ").trim();
	return `==${text}==<!-- ${MARKER}: ${oneLine} -->`;
}

/** 生成段落批注文本 */
export function serializeBlock(text: string, body: string): string {
	return serializeBlockWithQuote(shortenQuote(text), body);
}

/** 用已经定好的原文引用生成段落批注（编辑时避免引文被反复截断） */
export function serializeBlockWithQuote(quote: string, body: string): string {
	const bodyLines = body
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (line.trim().length ? `> ${line}` : ">"));
	return [
		`> [!${MARKER}] 批注`,
		`> 原文：${quote}`,
		">",
		...bodyLines,
	].join("\n");
}

function shortenQuote(text: string, limit = 100): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 找出包含指定行的段落批注。
 * 判定：从该行向上找最近的一个 callout 首行，且中间没有空行跳出 callout。
 */
export function findBlockAtLine(
	lines: string[],
	line: number,
): BlockAnnotation | null {
	const isQuote = (s: string) => /^[ \t]*>/.test(s);

	// 向上找到 callout 的首行
	let start = -1;
	for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
		if (isBlockHead(lines[i])) {
			start = i;
			break;
		}
		if (!isQuote(lines[i])) break;
	}
	if (start === -1) return null;

	// 向下吃到 callout 结束
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		if (!isQuote(lines[i])) break;
		end = i;
	}
	if (line > end) return null;

	return {
		startLine: start,
		endLine: end,
		quote: parseBlockQuote(lines, start, end),
		body: parseBlockBody(lines, start, end),
	};
}

function parseBlockQuote(lines: string[], start: number, end: number): string {
	for (let i = start + 1; i <= end; i++) {
		const m = /^[ \t]*>[ \t]*原文：(.*)$/.exec(lines[i]);
		if (m) return m[1].trim();
	}
	return "";
}

function parseBlockBody(lines: string[], start: number, end: number): string {
	const out: string[] = [];
	for (let i = start + 1; i <= end; i++) {
		const raw = lines[i];
		if (/^[ \t]*>[ \t]*原文：/.test(raw)) continue;
		const stripped = raw.replace(/^[ \t]*>[ \t]?/, "");
		out.push(stripped);
	}
	// 去掉正文与引用之间的空行、结尾空行
	while (out.length && out[0].trim() === "") out.shift();
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	return out.join("\n").trim();
}

/**
 * 段落批注应插入到第几行之前（0 起行号）。
 * 规则：紧跟选区所在段落之后；若后面紧接着已有引用块，则跳过整个引用块，
 * 免得把新 callout 插进别人的 callout 里面。
 */
export function blockInsertLine(lines: string[], toLine: number): number {
	let i = toLine + 1;
	while (i < lines.length && /^[ \t]*>/.test(lines[i])) i++;
	return i;
}
