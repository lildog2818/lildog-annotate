/**
 * Markdown 表格的几何：把「第几行第几格」翻译成源码里的绝对偏移。
 *
 * 为什么单独一份：表格是唯一会**改结构**的地方 —— 被批注的那一行只要多一个
 * 没转义的 `|`，单元格就会多切一格；更糟的是那一行要是以 `<!--` 开头（把整行
 * 包进批注标记的样子），按 GFM 它会被当成 HTML 块的开始，**整张表在那里断掉**。
 * 所以切分规则、单元格区间、跨格判定必须是纯函数、能单测，写入 / 渲染 / 自检
 * 三条路共用同一份实现，谁都不许自己再写一套。
 *
 * 这里只认 GFM 的表格规则：首尾管道可省略、管道之间的空白被去掉、`\|` 是
 * 转义（包括写在行内代码里也一样，GFM 就是这么要求的）。
 */

/** 一行里切出来的单元格（偏移相对行首） */
export interface RowCell {
	/** 单元格内容起点（已去掉首尾空白），相对行首 */
	from: number;
	/** 单元格内容终点（已去掉首尾空白），相对行首 */
	to: number;
	/** 内容原文 */
	text: string;
}

/** 一张表在源码里的行范围（0 起行号，含首尾） */
export interface TableBlock {
	/** 表头行 */
	headerLine: number;
	/** `| --- |` 分隔行 */
	delimiterLine: number;
	/** 最后一行数据行 */
	endLine: number;
}

/** 某个单元格在文档里的位置 */
export interface CellLocation extends TableBlock {
	/** 单元格所在行 */
	line: number;
	/** 第几列（0 起） */
	col: number;
	/** 单元格内容在文档里的绝对起点 */
	from: number;
	/** 单元格内容在文档里的绝对终点 */
	to: number;
	/** 单元格内容原文 */
	text: string;
}

/**
 * 会打断表格的块级开头：GFM 规定「表格在第一个空行或另一个块级结构的开头处断开」。
 * 其中 `<!--` 这条对我们最要命 —— 旧版本真写出过「整行包进批注标记」的样子。
 */
const BLOCK_START =
	/^[ \t]*(#{1,6}[ \t]|>|[-+*][ \t]|\d+[.)][ \t]|```|~~~|<!--|<[A-Za-z/!])/;

/** 第 index 个字符前面是不是有奇数个反斜杠（也就是它被转义了） */
export function isEscapedAt(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

/** 这一段文字里有没有「没被转义的」管道（有 = 跨了单元格） */
export function hasUnescapedPipe(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "|" && !isEscapedAt(text, i)) return true;
	}
	return false;
}

/** 每行起始处的字符偏移（lineOffsets[i] 是第 i 行的起点） */
export function lineOffsets(doc: string): number[] {
	const offsets = [0];
	for (let i = 0; i < doc.length; i++) {
		if (doc[i] === "\n") offsets.push(i + 1);
	}
	return offsets;
}

/** 某个偏移落在第几行（0 起） */
export function lineOfOffset(offsets: number[], offset: number): number {
	let lo = 0;
	let hi = Math.max(0, offsets.length - 1);
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * 按未转义的 `|` 切一行。首尾那两个「空段」是可选的首尾管道造出来的，不算单元格；
 * 但首尾管道前面/后面如果**不是空白**（比如 `X| a | b |` 的 `X`），那就是真的第一格
 * —— 这正是「标记把整行包起来」时内容整体右移一格、最后一格被丢掉的原因。
 */
export function splitRowCells(line: string): RowCell[] {
	const pipes: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "|" && !isEscapedAt(line, i)) pipes.push(i);
	}
	if (!pipes.length) return [];

	const segments: Array<[number, number]> = [];
	let start = 0;
	for (const pipe of pipes) {
		segments.push([start, pipe]);
		start = pipe + 1;
	}
	segments.push([start, line.length]);

	if (segments.length > 1 && line.slice(segments[0][0], segments[0][1]).trim() === "") {
		segments.shift();
	}
	const last = segments[segments.length - 1];
	if (segments.length > 1 && line.slice(last[0], last[1]).trim() === "") {
		segments.pop();
	}

	return segments.map(([from, to]) => {
		const raw = line.slice(from, to);
		const lead = raw.length - raw.replace(/^[ \t]+/, "").length;
		const text = raw.trim();
		return { from: from + lead, to: from + lead + text.length, text };
	});
}

/** 分隔行：`| --- | :--: |`（至少要有一个管道，否则那是别的块级结构） */
export function isDelimiterLine(line: string): boolean {
	if (!hasUnescapedPipe(line)) return false;
	const cells = splitRowCells(line);
	if (!cells.length) return false;
	return cells.every((cell) => /^:?-+:?$/.test(cell.text));
}

/** 可能是表格数据行：非空、有管道、且不是别的块级结构的开头 */
export function isTableRowLine(line: string): boolean {
	if (!line.trim()) return false;
	if (BLOCK_START.test(line)) return false;
	return hasUnescapedPipe(line);
}

/**
 * 这一行属于哪张表（不属于任何表就返回 null）。
 *
 * 找法：分隔行要么就在这一行（数据行会往上找到它），要么在下面一行（这一行是表头）；
 * 找到分隔行以后再往下吃到不是数据行为止。空行、别的块级结构的开头（尤其行首的 `<!--`）
 * 都会把表断开。
 */
export function tableBlockAt(lines: string[], line: number): TableBlock | null {
	if (line < 0 || line >= lines.length) return null;

	let delimiter = -1;
	for (let i = Math.min(line, lines.length - 1); i >= 1; i--) {
		if (isDelimiterLine(lines[i])) {
			delimiter = i;
			break;
		}
		// 往上走的时候碰到不像数据行的东西，说明这一行不在表里
		if (i < line && !isTableRowLine(lines[i])) break;
	}
	if (delimiter === -1 && line + 1 < lines.length && isDelimiterLine(lines[line + 1])) {
		delimiter = line + 1;
	}
	if (delimiter < 1) return null;
	if (!hasUnescapedPipe(lines[delimiter - 1])) return null;

	let end = delimiter;
	while (end + 1 < lines.length && isTableRowLine(lines[end + 1])) end++;
	if (line < delimiter - 1 || line > end) return null;
	return { headerLine: delimiter - 1, delimiterLine: delimiter, endLine: end };
}

/** 某个偏移在不在某张表的数据区里（含表头、分隔行、数据行） */
export function isOffsetInTableRow(doc: string, offset: number): boolean {
	const lines = doc.split("\n");
	const line = lineOfOffset(lineOffsets(doc), offset);
	return tableBlockAt(lines, line) !== null;
}

/**
 * 某个偏移落在表格的**分隔行**（`| --- | --- |`）上吗。
 *
 * 分隔行是整张表的地基：那一格里的文字必须是 `---` / `:--:` 这种样子，只要被批注标记
 * 包住（`| <!--lildog: …-->---<!--/lildog--> | --- |`），整行就不再是分隔行 ——
 * 实测 Obsidian 会把这张表当普通段落渲染（插件的 tableBlockAt 也一样认不出来），
 * 也就是「批注一句话，表格没了」。所以这里必须挡住。
 */
export function isOffsetOnDelimiterRow(doc: string, offset: number): boolean {
	const lines = doc.split("\n");
	const line = lineOfOffset(lineOffsets(doc), offset);
	const block = tableBlockAt(lines, line);
	return !!block && block.delimiterLine === line;
}

/**
 * 这个偏移是不是「表格行的开头」——它前面的整行前缀只有空白（含 ch 0）。
 *
 * 行内批注的标记写在原文**前面**，落在这种位置会让那一行以 `<!--` 开头。
 * 实测 Obsidian 会把这种行当成 HTML 块（GFM 的 HTML 块允许最多 3 个空格缩进），
 * **整张表在那里断掉**：后面几行掉出表格、以纯文本显示。没有前导管道的表格
 * （`甲 | 乙`）批注第一格就是这个样子，所以这里也要挡住。
 */
export function isAtTableRowStart(doc: string, offset: number): boolean {
	const lines = doc.split("\n");
	const offsets = lineOffsets(doc);
	const line = lineOfOffset(offsets, offset);
	if (!tableBlockAt(lines, line)) return false;
	return doc.slice(offsets[line] ?? 0, offset).trim() === "";
}

/** 整张表在文档里的绝对区间（不含最后一行末尾的换行） */
export function tableRange(
	doc: string,
	line: number,
): { from: number; to: number; block: TableBlock } | null {
	const lines = doc.split("\n");
	const block = tableBlockAt(lines, line);
	if (!block) return null;
	const offsets = lineOffsets(doc);
	const from = offsets[block.headerLine] ?? 0;
	const to = (offsets[block.endLine] ?? 0) + (lines[block.endLine]?.length ?? 0);
	return { from, to, block };
}

/** 第 line 行第 col 格在文档里的位置（分隔行不是内容行，返回 null） */
export function cellLocation(doc: string, line: number, col: number): CellLocation | null {
	const lines = doc.split("\n");
	const block = tableBlockAt(lines, line);
	if (!block) return null;
	if (block.delimiterLine === line) return null;
	const cell = splitRowCells(lines[line])[col];
	if (!cell) return null;
	const base = lineOffsets(doc)[line] ?? 0;
	return {
		...block,
		line,
		col,
		from: base + cell.from,
		to: base + cell.to,
		text: cell.text,
	};
}

/**
 * 某个偏移落在哪一格（只认单元格内容本身；落在管道的空白里就返回 null）。
 * 分隔行不是内容行：它的「格子」里写的是 `---`，一个字都不能改，所以不算。
 */
export function cellAtOffset(doc: string, offset: number): CellLocation | null {
	const lines = doc.split("\n");
	const offsets = lineOffsets(doc);
	const line = lineOfOffset(offsets, offset);
	const block = tableBlockAt(lines, line);
	if (!block) return null;
	if (block.delimiterLine === line) return null;
	const base = offsets[line] ?? 0;
	const cells = splitRowCells(lines[line]);
	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col];
		if (offset >= base + cell.from && offset <= base + cell.to) {
			return {
				...block,
				line,
				col,
				from: base + cell.from,
				to: base + cell.to,
				text: cell.text,
			};
		}
	}
	return null;
}
