/**
 * 「渲染出来的文字」↔「源码文字」的对齐。
 *
 * 为什么需要：批注落在表格单元格里时，DOM 里选中的是**渲染后**的文字
 * （`**等 DRDY 下降沿中断**` 在界面上是 `等 DRDY 下降沿中断`），而写进文件的是
 * **源码**偏移。两者对不上就没法精确定位 —— 老版本正是靠「在全文里 search 这段
 * 文字、就近取一处」蒙的，于是重复值一多就写到别的格子里去。
 *
 * 这里把「源码 → 渲染后文字」做成一张**带下标的映射表**：剥掉行内语法、把连续空白
 * 压成一个空格，但每一步都记着这个字在原串里的位置。拿着它就能把 DOM 里的选区
 * 精确翻译回源码偏移，翻译不出来就老实返回 null（宁可不批注，也不猜）。
 */

export interface StrippedText {
	/** 剥掉行内语法之后的文字 */
	text: string;
	/** map[i] = text[i] 在原文里的下标 */
	map: number[];
}

/** 可能是强调语法的定界符 */
const DELIMITERS = new Set(["*", "_", "~"]);

/** 字符分类：决定这一段要不要剥、要不要原样保留 */
const NORMAL = 0;
/** 行内代码的内容：原样保留（里面的下划线、星号都是字面量） */
const CODE = 1;
/** HTML 注释：渲染时整段消失 */
const COMMENT = 2;
/** 行内代码的定界反引号：不显示 */
const TICK = 3;

function isSpaceChar(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch);
}

function isPunctChar(ch: string | undefined): boolean {
	if (ch === undefined) return true;
	if (DELIMITERS.has(ch)) return true;
	return /[\p{P}\p{S}]/u.test(ch);
}

interface DelimRun {
	char: string;
	start: number;
	end: number;
}

/**
 * 先给每个字符分类，再把「成对的强调定界符」标出来。
 *
 * 成对判定按 CommonMark 的 flanking 规则（含 `_` 不允许词中强调那一条）：
 *   `**粗体**` 的星号成对 → 剥掉
 *   `a_b_c` 的下划线两侧都是字 → 是正文，留下
 *   `_斜体_字` 的收尾下划线后面还跟着字 → CommonMark 也不认为它成对，一样留下
 */
function analyze(raw: string): { kind: Uint8Array; syntax: Set<number> } {
	const kind = new Uint8Array(raw.length);
	let i = 0;
	let inCode = false;
	while (i < raw.length) {
		if (raw.startsWith("<!--", i)) {
			const end = raw.indexOf("-->", i + 4);
			const stop = end === -1 ? raw.length : end + 3;
			for (let k = i; k < stop; k++) kind[k] = COMMENT;
			i = stop;
			continue;
		}
		if (raw[i] === "`") {
			let n = 0;
			while (raw[i + n] === "`") n++;
			for (let k = i; k < i + n; k++) kind[k] = TICK;
			i += n;
			inCode = !inCode;
			continue;
		}
		kind[i] = inCode ? CODE : NORMAL;
		i++;
	}

	const runs: DelimRun[] = [];
	for (let at = 0; at < raw.length; ) {
		const ch = raw[at];
		if (kind[at] === NORMAL && DELIMITERS.has(ch)) {
			let end = at;
			while (end < raw.length && raw[end] === ch && kind[end] === NORMAL) end++;
			runs.push({ char: ch, start: at, end });
			at = end;
			continue;
		}
		at++;
	}

	const syntax = new Set<number>();
	const open: Record<string, DelimRun[]> = { "*": [], _: [], "~": [] };
	for (const run of runs) {
		const prev = raw[run.start - 1];
		const next = raw[run.end];
		const left = !isSpaceChar(next) && (!isPunctChar(next) || isSpaceChar(prev) || isPunctChar(prev));
		const right = !isSpaceChar(prev) && (!isPunctChar(prev) || isSpaceChar(next) || isPunctChar(next));
		let canOpen = left;
		let canClose = right;
		if (run.char === "_") {
			canOpen = left && (!right || isPunctChar(prev));
			canClose = right && (!left || isPunctChar(next));
		}
		const stack = open[run.char];
		if (canClose && stack.length) {
			const opener = stack.pop() as DelimRun;
			syntax.add(opener.start);
			syntax.add(run.start);
		} else if (canOpen) {
			stack.push(run);
		}
	}

	return { kind, syntax };
}

/**
 * 剥掉行内语法并压掉连续空白，同时记下每个字在原文里的下标。
 *
 * 覆盖的语法：`**粗体**`、`*斜体*`、`~~删除~~`、`` `行内代码` ``（代码里的内容原样保留）、
 * `$公式$`、`[文字](链接)`、`![图](链接)`、`[[目标|别名]]`、`\转义`、`<!--注释-->`。
 */
export function stripInlineWithMap(raw: string): StrippedText {
	const { kind, syntax } = analyze(raw);
	const out: string[] = [];
	const map: number[] = [];

	const push = (ch: string, at: number): void => {
		if (/\s/.test(ch)) {
			if (!out.length) return; // 开头的空白不要
			if (out[out.length - 1] === " ") return; // 连续空白压成一个
			out.push(" ");
			map.push(at);
			return;
		}
		out.push(ch);
		map.push(at);
	};

	const pushText = (text: string, at: number): void => {
		for (let k = 0; k < text.length; k++) push(text[k], at + k);
	};

	let i = 0;
	while (i < raw.length) {
		const k = kind[i];

		if (k === COMMENT || k === TICK) {
			i++;
			continue;
		}

		const ch = raw[i];

		// 行内代码里的内容：一个字都不动
		if (k === CODE) {
			push(ch, i);
			i++;
			continue;
		}

		// 成对的强调定界符：整段丢掉
		if (DELIMITERS.has(ch) && syntax.has(i)) {
			while (i < raw.length && raw[i] === ch) i++;
			continue;
		}

		// [[目标|别名]] / [[目标]]
		if (raw.startsWith("[[", i)) {
			const end = raw.indexOf("]]", i + 2);
			if (end !== -1) {
				const inner = raw.slice(i + 2, end);
				const bar = inner.indexOf("|");
				const shown = bar === -1 ? inner : inner.slice(bar + 1);
				pushText(shown, i + 2 + (bar === -1 ? 0 : bar + 1));
				i = end + 2;
				continue;
			}
		}

		// [文字](链接) 与 ![文字](链接)
		const isImage = raw[i] === "!" && raw[i + 1] === "[";
		if (raw[i] === "[" || isImage) {
			const openAt = isImage ? i + 1 : i;
			const close = raw.indexOf("]", openAt + 1);
			if (close !== -1 && raw[close + 1] === "(") {
				const paren = raw.indexOf(")", close + 2);
				if (paren !== -1) {
					pushText(raw.slice(openAt + 1, close), openAt + 1);
					i = paren + 1;
					continue;
				}
			}
		}

		// 转义：反斜杠本身不显示
		if (ch === "\\" && i + 1 < raw.length) {
			push(raw[i + 1], i + 1);
			i += 2;
			continue;
		}

		// 公式定界符
		if (ch === "$") {
			i++;
			continue;
		}

		push(ch, i);
		i++;
	}

	while (out.length && out[out.length - 1] === " ") {
		out.pop();
		map.pop();
	}

	return { text: out.join(""), map };
}

/** 把连续空白压成一个空格并去掉首尾空白（比对用） */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** needle 在 haystack 里出现了几次 */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count++;
		at = haystack.indexOf(needle, at + 1);
	}
	return count;
}

/** needle 第 n 次（0 起）出现的位置；不够 n+1 次就返回 null */
export function nthOccurrenceIndex(
	haystack: string,
	needle: string,
	n: number,
): number | null {
	if (!needle || n < 0) return null;
	let at = haystack.indexOf(needle);
	for (let k = 0; k < n && at !== -1; k++) at = haystack.indexOf(needle, at + 1);
	return at === -1 ? null : at;
}

/**
 * 取离 hint 最近的那一次出现。
 * 返回出现位置、总次数；一次都没有就返回 null。
 */
export function findNearestOccurrence(
	haystack: string,
	needle: string,
	hint: number,
): { index: number; matches: number } | null {
	if (!needle) return null;
	const offsets: number[] = [];
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		offsets.push(at);
		at = haystack.indexOf(needle, at + 1);
	}
	if (!offsets.length) return null;
	let best = offsets[0];
	for (const candidate of offsets) {
		if (Math.abs(candidate - hint) < Math.abs(best - hint)) best = candidate;
	}
	return { index: best, matches: offsets.length };
}

/**
 * 把「渲染后文字里的区间」翻译成「源码里的区间」。
 *
 * 中间夹着别的**注释**（`<!--`）就返回 null：那说明这一段跨过了别人的批注标记，
 * 把它吞进新批注里会把标记解析搞乱。夹着粗体这类定界符是允许的（渲染时看不见，
 * 但包进去不会破坏任何东西）。越界同样返回 null。
 */
export function mapRangeToSource(
	raw: string,
	stripped: StrippedText,
	index: number,
	length: number,
): { from: number; to: number } | null {
	if (length <= 0) return null;
	if (index < 0 || index + length > stripped.map.length) return null;
	for (let k = index; k < index + length - 1; k++) {
		const gap = raw.slice(stripped.map[k] + 1, stripped.map[k + 1]);
		if (gap.includes("<!--")) return null;
	}
	const from = stripped.map[index];
	const to = stripped.map[index + length - 1] + 1;
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
	return { from, to };
}
