/**
 * 批注的存储格式定义与纯函数实现。
 *
 * 设计原则：批注必须是**笔记正文里的纯文本**，这样人和 AI 都能直接用
 * 文本工具（编辑器 / grep / 大模型读文件）读到，不依赖任何插件数据库。
 *
 * 现行格式（成对标记，中间是原文，原文一个字都不动）：
 *   <!--lildog: 批注内容-->被批注的文字<!--/lildog-->
 *
 * 为什么不用 ==高亮== 包住原文：
 *   Obsidian 自己解析不了跨等号的 ==…==（`==a = b==` 在实时预览里配不上对），
 *   落单的 == 还会跟文档后面别的 == 配对，把一大段文字错误地高亮。
 *   批注公式、代码时这种情况太常见，所以高亮改由插件自己渲染。
 *
 * 旧格式（v1.0/1.1 写过，仍然能解析、编辑、删除）：
 *   ==被批注的文字==<!-- lildog: 批注内容 -->
 */

export const MARKER = "lildog";

export type InlineFormat = "marker" | "legacy";

/** 行内批注 */
export interface InlineAnnotation {
	/** 整段批注的范围 */
	from: number;
	/** 整段批注的结束 */
	to: number;
	/** 被批注的原文（不含任何标记） */
	text: string;
	/** 批注内容 */
	body: string;
	/** 原文起点 */
	textFrom: number;
	/** 原文终点 */
	textTo: number;
	/** 需要从正文里藏起来的标记区间 */
	hiddenRanges: Array<[number, number]>;
	format: InlineFormat;
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

// 正文里不可能有 `-->`（写入时会转义），所以这里也不允许，免得跨过别人的标记乱吃
const OPEN_MARKER = (): string =>
	`<!--\\s*${MARKER}:\\s*((?:(?!-->)[\\s\\S])*?)\\s*-->`;
const CLOSE_MARKER = (): string => `<!--\\s*/${MARKER}\\s*-->`;

/** 现行格式：<!--lildog: 批注-->原文<!--/lildog--> */
function markerRegex(): RegExp {
	// 原文里不允许出现 `<!--`（canUseInline 已经保证），否则会把后面别的标记吞进来
	return new RegExp(
		`${OPEN_MARKER()}((?:(?!<!--)[^\\n])+?)${CLOSE_MARKER()}`,
		"g",
	);
}

/** 旧格式：==原文==<!-- lildog: 批注 --> */
function legacyRegex(): RegExp {
	return new RegExp(`==([^\\n]+?)==[ \\t]*${OPEN_MARKER()}`, "g");
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
	const found: InlineAnnotation[] = [];

	const pairRe = markerRegex();
	let m: RegExpExecArray | null;
	while ((m = pairRe.exec(doc)) !== null) {
		const whole = m[0];
		const openEnd = whole.indexOf("-->") + 3;
		const textFrom = m.index + openEnd;
		const textTo = textFrom + m[2].length;
		found.push({
			from: m.index,
			to: m.index + whole.length,
			text: m[2],
			body: m[1],
			textFrom,
			textTo,
			hiddenRanges: [
				[m.index, textFrom],
				[textTo, m.index + whole.length],
			],
			format: "marker",
		});
		if (m.index === pairRe.lastIndex) pairRe.lastIndex++;
	}

	const legacyRe = legacyRegex();
	while ((m = legacyRe.exec(doc)) !== null) {
		const whole = m[0];
		const start = m.index;
		const end = start + whole.length;
		// 已经被现行格式吃掉的区间就跳过
		if (!found.some((ann) => start < ann.to && end > ann.from)) {
			const textFrom = start + 2;
			const textTo = textFrom + m[1].length;
			const commentRel = whole.indexOf("<!--", textTo - start);
			found.push({
				from: start,
				to: end,
				text: m[1],
				body: m[2],
				textFrom,
				textTo,
				hiddenRanges: [[start + commentRel, end]],
				format: "legacy",
			});
		}
		if (m.index === legacyRe.lastIndex) legacyRe.lastIndex++;
	}

	found.sort((a, b) => a.from - b.from);
	return found;
}

/**
 * 行内批注要求：单行、不含注释起始符、不含 lildog 这个词。
 *
 * 注意这里既不排除 `=`，也不排除反引号：批注公式和代码是刚需，
 * 现行格式下这些字符都不会破坏排版。
 */
export function canUseInline(text: string): boolean {
	return (
		text.trim().length > 0 &&
		!text.includes("\n") &&
		!text.includes("\r") &&
		!text.includes("<!--") &&
		!text.includes(MARKER)
	);
}

/** 批注正文里的 `-->` 会提前关闭 HTML 注释，做转义 */
function escapeBody(body: string): string {
	return body.replace(/-->/g, "-- >");
}

/** 生成行内批注文本 */
export function serializeInline(text: string, body: string): string {
	const oneLine = escapeBody(body).replace(/\s*\r?\n\s*/g, " ").trim();
	return `<!--${MARKER}: ${oneLine}-->${text}<!--/${MARKER}-->`;
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
 * 批注一段行内代码时，选区常常带着开头的反引号、却没带上结尾那个
 * （于是代码块被劈成两半）。这里做个很小的兜底：反引号数量是奇数、
 * 而紧跟在后面的正好是反引号时，把结尾往后挪一位。
 */
export function extendToBalanceBackticks(
	doc: string,
	fromOffset: number,
	toOffset: number,
): number {
	const text = doc.slice(fromOffset, toOffset);
	const ticks = (text.match(/`/g) ?? []).length;
	if (ticks % 2 === 1 && doc[toOffset] === "`") return toOffset + 1;
	return toOffset;
}

/**
 * 把一条旧格式批注改成现行格式所需的替换方案。
 *
 * 旧格式的注释写在原文**后面**，所以选区漏掉的收尾反引号会落在注释之后：
 *   ==`code==<!-- lildog: 批注 -->`   →   <!--lildog: 批注-->`code`<!--/lildog-->
 * 这里把它一起纳入，代码块才不会被劈开。
 */
export function planLegacyMigration(
	doc: string,
	ann: InlineAnnotation,
): { from: number; to: number; text: string; replacement: string } {
	const inner = doc.slice(ann.textFrom, ann.textTo);
	const ticks = (inner.match(/`/g) ?? []).length;
	const suffix = ticks % 2 === 1 && doc[ann.to] === "`" ? "`" : "";
	const text = inner + suffix;
	return {
		from: ann.from,
		to: ann.to + suffix.length,
		text,
		replacement: serializeInline(text, ann.body),
	};
}

/**
 * 去掉行内 Markdown 语法，用于把源码文字和渲染后的 DOM 文字对齐。
 * 例：源码里的 `` `1/(1+x)` `` 在阅读视图里是 `1/(1+x)`。
 */
export function stripInlineMarkdown(text: string): string {
	return text
		.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_all, target, alias) =>
			String(alias || target),
		)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 比对用的归一化形式：剥掉行内语法后再压掉全部空白 */
export function normalizeForCompare(text: string): string {
	return stripInlineMarkdown(text).replace(/\s+/g, "");
}

// ---------------------------------------------------------------- 定位文字

export interface TextLocation {
	fromOffset: number;
	toOffset: number;
	/** 这段文字在范围内出现了几次 */
	matches: number;
}

/** 每行起始处的字符偏移（lineOffsets[i] 是第 i 行的起点） */
export function lineOffsets(doc: string): number[] {
	const offsets = [0];
	for (let i = 0; i < doc.length; i++) {
		if (doc[i] === "\n") offsets.push(i + 1);
	}
	return offsets;
}

/**
 * 在源码里定位一段文字。阅读视图和编辑器里的表格（块级 widget）拿不到
 * 编辑器选区，只能靠 DOM 里的文字反查源码，这里就是干这个的。
 *
 * preferOffset 是「用户大概选在这里」的源码偏移：同一段文字出现多次时，
 * 取离它最近的那一处 —— 在哪选的就在哪批注，而不是一律用第一处。
 */
export function locateText(
	doc: string,
	text: string,
	startOffset = 0,
	endOffset = doc.length,
	preferOffset?: number,
): TextLocation | null {
	const needle = text.trim();
	if (!needle) return null;
	const from = Math.max(0, Math.min(startOffset, doc.length));
	const to = Math.max(from, Math.min(endOffset, doc.length));
	const haystack = doc.slice(from, to);
	const first = haystack.indexOf(needle);
	if (first === -1) return null;

	const offsets: number[] = [];
	let scan: number = first;
	while (scan !== -1) {
		offsets.push(scan);
		scan = haystack.indexOf(needle, scan + 1);
	}

	let index = first;
	if (typeof preferOffset === "number" && Number.isFinite(preferOffset) && offsets.length > 1) {
		const want = preferOffset - from;
		index = offsets.reduce((best, candidate) =>
			Math.abs(candidate - want) < Math.abs(best - want) ? candidate : best,
		);
	}

	return {
		fromOffset: from + index,
		toOffset: from + index + needle.length,
		matches: offsets.length,
	};
}

// ---------------------------------------------------------------- 装饰规划

export type DecorationKind = "mark" | "hide";

export interface DecorationEntry {
	from: number;
	to: number;
	/** mark：给原文加高亮；hide：把标记藏起来 */
	kind: DecorationKind;
}

export interface DecorationPlan {
	entries: DecorationEntry[];
	/** 文档里解析到的行内批注条数 */
	annotations: number;
}

/**
 * 规划编辑器里要加的装饰。
 *
 * 返回结果保证按 from 严格递增 —— 这是 RangeSetBuilder 的硬要求，
 * 顺序错了它会直接抛异常。现行格式每个批注有两段要藏的标记（原文前、
 * 原文后），很容易排错，所以统一在这里排好序，调用方照着加即可。
 *
 * selections 是当前光标/选区的 [from, to] 列表，决定要不要把原始标记露出来。
 * 判定规则见 explainReveal，那一条函数同时也给自检报告解释「是谁把它弄露的」。
 */
export function planEditorDecorations(
	doc: string,
	selections: ReadonlyArray<readonly [number, number]>,
): DecorationPlan {
	const entries: DecorationEntry[] = [];
	const annotations = findInlineAnnotations(doc);

	for (const ann of annotations) {
		const reveal = explainReveal(ann, selections).revealed;

		if (!reveal) {
			for (const [from, to] of ann.hiddenRanges) {
				if (from < to) entries.push({ from, to, kind: "hide" });
			}
		}
		if (ann.textFrom < ann.textTo) {
			entries.push({ from: ann.textFrom, to: ann.textTo, kind: "mark" });
		}
	}

	entries.sort((a, b) => a.from - b.from);
	return { entries, annotations: annotations.length };
}

/**
 * 这条批注现在会不会露出原始标记，以及是被哪个选区弄露的。
 *
 * 规则（自检报告里会照着念一遍，出问题时不用猜）：
 *   - 选中了被批注的原文（哪怕一部分）→ 露出，方便直接改标记
 *   - 整个标记区间被选中 → 露出
 *   - 折叠光标落在被藏起来的标记里面 → 露出（正常点不进去，粘贴/拖动可能落进去）
 *   - 其余一律藏住 —— 尤其不能再把「选区边界刚好碰到批注」当成露出，
 *     否则随手选一段文字就会看到一堆 `<!--lildog: …-->`
 */
export function explainReveal(
	ann: InlineAnnotation,
	selections: ReadonlyArray<readonly [number, number]>,
): { revealed: boolean; why: string } {
	for (const [from, to] of selections) {
		if (to > from && from < ann.textTo && to > ann.textFrom) {
			return { revealed: true, why: `选区 ${from}-${to} 选中了原文` };
		}
	}
	for (const [from, to] of selections) {
		if (to <= from) continue;
		const marker = ann.hiddenRanges.find(
			([start, end]) => from <= start && to >= end,
		);
		if (marker) {
			return {
				revealed: true,
				why: `选区 ${from}-${to} 整段选中了标记 ${marker[0]}-${marker[1]}`,
			};
		}
	}
	for (const [from, to] of selections) {
		if (from !== to) continue;
		const marker = ann.hiddenRanges.find(([start, end]) => from > start && to < end);
		if (marker) {
			return {
				revealed: true,
				why: `光标 ${from} 落在被藏起来的标记 ${marker[0]}-${marker[1]} 里面`,
			};
		}
	}
	return { revealed: false, why: "没有选区压着它" };
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
