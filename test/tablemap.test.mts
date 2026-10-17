/**
 * 表格几何的纯函数测试。
 *
 * 这里守的是三条症状背后真正会**改文档结构**的那一层：
 *   - 标记包住没转义的 `|` → 那一行多切一格（内容右移、最后一格被丢）
 *   - 标记包住整行（行首是 `<!--`）→ 按 GFM 那一行是 HTML 块的开始，表格在那里断掉
 *   - 段落批注插在表格中间 → 表格被劈成两半
 */

import {
	blockInsertLine,
	canUseInlineInTable,
	explainInlineRefusal,
	findInlineAnnotations,
	planLegacyMigration,
	serializeInline,
} from "../src/format.ts";
import {
	cellAtOffset,
	cellLocation,
	hasUnescapedPipe,
	isAtTableRowStart,
	isDelimiterLine,
	isOffsetInTableRow,
	isOffsetOnDelimiterRow,
	lineOfOffset,
	lineOffsets,
	splitRowCells,
	tableBlockAt,
	tableRange,
} from "../src/tablemap.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) {
		passed++;
	} else {
		failures.push(`${name}\n  实际: ${a}\n  期望: ${b}`);
	}
}

const texts = (line: string): string[] => splitRowCells(line).map((cell) => cell.text);

// ---------------------------------------------------------------- 行号

const lineDoc = "第一行\n第二行\n\n第四行";
check("行号：各行起点", lineOffsets(lineDoc), [0, 4, 8, 9]);
check(
	"行号：偏移落在哪一行",
	[0, 3, 4, 7, 8, 9].map((offset) => lineOfOffset(lineOffsets(lineDoc), offset)),
	[0, 0, 1, 1, 2, 3],
);

// ---------------------------------------------------------------- 切格

check("切格：标准行", texts("| a | b |"), ["a", "b"]);
check("切格：首尾管道可以省", texts("a | b"), ["a", "b"]);
check("切格：只省尾管道", texts("| a | b"), ["a", "b"]);
check("切格：只省首管道", texts("a | b |"), ["a", "b"]);
check(
	"切格：行首的非空文本会变成第一格（整行被包住时内容右移就是这个原因）",
	texts("X| a | b |"),
	["X", "a", "b"],
);
check("切格：转义管道不算分隔符", texts("| a \\| b | c |"), ["a \\| b", "c"]);
check("切格：内容两侧空白被去掉", texts("|   a   | b |"), ["a", "b"]);
check("切格：没有管道的行不是表格行", splitRowCells("普通一行"), []);

const padded = "|   a   | b |";
const paddedCell = splitRowCells(padded)[0];
check("切格：单元格区间贴着内容", padded.slice(paddedCell.from, paddedCell.to), "a");

check("管道：没转义的算跨格", hasUnescapedPipe("a | b"), true);
check("管道：转义的管道不算", hasUnescapedPipe("a \\| b"), false);
check("管道：双反斜杠后的管道算（反斜杠自己被转义了）", hasUnescapedPipe("a \\\\| b"), true);

check("分隔行：标准", isDelimiterLine("| --- | --- |"), true);
check("分隔行：带对齐", isDelimiterLine("| :-- | --: |"), true);
check("分隔行：没有管道就不是表格", isDelimiterLine("----"), false);
check("分隔行：内容是普通文字", isDelimiterLine("| a | b |"), false);

// ---------------------------------------------------------------- 表格范围

const tableDoc = [
	"前言里也有 | 一个管道",
	"| 名称 | 值 |",
	"| --- | --- |",
	"| 甲 | ✅ |",
	"| 乙 | ✅ |",
	"",
	"后面",
].join("\n");
const tableLines = tableDoc.split("\n");

check("表格范围：从表头行能找到整张表", tableBlockAt(tableLines, 1), {
	headerLine: 1,
	delimiterLine: 2,
	endLine: 4,
});
check("表格范围：从数据行也能找到同一张表", tableBlockAt(tableLines, 4), {
	headerLine: 1,
	delimiterLine: 2,
	endLine: 4,
});
check("表格范围：表格上方的管道段不算表", tableBlockAt(tableLines, 0), null);
check("表格范围：空行不是表格", tableBlockAt(tableLines, 5), null);
check("表格范围：表格下方的文字不算表", tableBlockAt(tableLines, 6), null);

const gapLines = ["| a | b |", "| --- | --- |", "", "| c | d |"];
check("表格范围：空行会断开表格（后面那行不算表）", tableBlockAt(gapLines, 3), null);

const brokenLines = [
	"| a | b |",
	"| --- | --- |",
	"<!--lildog: x-->| c | d |<!--/lildog-->",
	"| e | f |",
];
check(
	"表格范围：整行被包进批注标记后，那一行不再是表格行",
	tableBlockAt(brokenLines, 2),
	null,
);
check(
	"表格范围：断表之后表格只剩表头 + 分隔行",
	tableBlockAt(brokenLines, 1)?.endLine,
	1,
);
check("表格范围：断表之后的行也不算表", tableBlockAt(brokenLines, 3), null);

// ---------------------------------------------------------------- 单元格

const valueCell = cellLocation(tableDoc, 3, 1);
check("单元格：内容", valueCell?.text, "✅");
check(
	"单元格：区间贴住内容",
	valueCell ? tableDoc.slice(valueCell.from, valueCell.to) : null,
	"✅",
);
check("单元格：行号与列号", [valueCell?.line, valueCell?.col], [3, 1]);
check("单元格：反查偏移回到同一格", cellAtOffset(tableDoc, valueCell!.from)?.col, 1);
check("单元格：越界的列拿不到", cellLocation(tableDoc, 3, 9), null);
check("单元格：表外的行拿不到", cellLocation(tableDoc, 6, 0), null);

const firstMark = tableDoc.indexOf("✅");
const secondMark = tableDoc.indexOf("✅", firstMark + 1);
check("单元格：重复值各有各的格（第一处）", cellAtOffset(tableDoc, firstMark)?.line, 3);
check("单元格：重复值各有各的格（第二处）", cellAtOffset(tableDoc, secondMark)?.line, 4);

const wholeTable = tableRange(tableDoc, 3);
check(
	"整表区间：从表头盖到末行（不含末行换行）",
	wholeTable ? tableDoc.slice(wholeTable.from, wholeTable.to) : null,
	"| 名称 | 值 |\n| --- | --- |\n| 甲 | ✅ |\n| 乙 | ✅ |",
);
check("是否在表格行里：单元格内容", isOffsetInTableRow(tableDoc, firstMark), true);
check("是否在表格行里：表外段落", isOffsetInTableRow(tableDoc, 0), false);

// ---------------------------------------------------------------- 正文里的管道

const pipeBody = "a | b 是什么意思";
const safeLine = "| 甲 | " + serializeInline("✅", pipeBody, { inTable: true }) + " |";
const rawLine = "| 甲 | " + serializeInline("✅", pipeBody) + " |";
check("表格行内：正文里的管道被转义", safeLine.includes("a \\| b"), true);
check("表格行内：转义之后这一行还是 2 格", splitRowCells(safeLine).length, 2);
check(
	"表格行内：不转义就会多切一格（这就是表格错位的样子）",
	splitRowCells(rawLine).length,
	3,
);

const writtenDoc = "| 名称 | 值 |\n| --- | --- |\n" + safeLine;
const reparsed = findInlineAnnotations(writtenDoc);
check("表格行内：正文能原样读回来", reparsed[0]?.body, pipeBody);
check("表格行内：原文一个字没动", reparsed[0]?.text, "✅");

const plainDoc = "正文<!--lildog: 范数 \\|x\\| 怎么算-->梯度<!--/lildog-->后面";
check(
	"表外：正文里的 \\| 原样保留（那是 LaTeX，不是我们的转义）",
	findInlineAnnotations(plainDoc)[0]?.body,
	"范数 \\|x\\| 怎么算",
);

// ---------------------------------------------------------------- 行内能不能用

check("行内判定：单元格内部可以用", canUseInlineInTable(tableDoc, firstMark, "✅"), true);
check("行内判定：跨格不行", canUseInlineInTable(tableDoc, firstMark, "甲 | ✅"), false);
check(
	"行内判定：表外的管道不受影响（普通段落里的 a | b 照样能批注）",
	canUseInlineInTable("段落 a | b", 3, "a | b"),
	true,
);
check("行内判定：跨行仍然不行", canUseInlineInTable("段落", 0, "第一行\n第二行"), false);
const escapedCellLine = "| a \\| b | c |";
check(
	"行内判定：原文里本来就有转义管道也算单元格内",
	canUseInlineInTable(escapedCellLine, escapedCellLine.indexOf("a"), "a \\| b"),
	true,
);

// ---------------------------------------------------------------- 会改坏表格的两处位置
//
// 这两条都实测过（隔离实例里交给 Obsidian 自己渲染）：
//   · 分隔行里写进标记 → 那一行不再是分隔行，整张表被当普通段落渲染
//   · 标记落在表格行首（没有前导管道的表格批注第一格）→ 那一行以 `<!--` 开头，
//     按 GFM 是 HTML 块的开始，表格在那里断掉，后面几行掉出表格

const guardDoc = ["| 名称 | 值 |", "| --- | --- |", "| 甲 | 乙 |"].join("\n");
const guardLines = guardDoc.split("\n");
const delimiterAt = guardDoc.indexOf("---");
const dataCellAt = guardDoc.indexOf("甲");

check("分隔行：偏移落在分隔行上", isOffsetOnDelimiterRow(guardDoc, delimiterAt), true);
check("分隔行：数据格不算", isOffsetOnDelimiterRow(guardDoc, dataCellAt), false);
check("分隔行：表外文字不算", isOffsetOnDelimiterRow("段落里的 --- 不算表", 4), false);
check("分隔行：光标反查不认它（批注整格要挡住）", cellAtOffset(guardDoc, delimiterAt), null);
check("分隔行：cellLocation 也不认它", cellLocation(guardDoc, 1, 0), null);
check("分隔行：行内批注被拒绝", canUseInlineInTable(guardDoc, delimiterAt, "---"), false);
check(
	"分隔行：拒绝原因说清了是哪一行",
	explainInlineRefusal(guardDoc, delimiterAt, "---")?.includes("分隔行"),
	true,
);

// 真写进去会怎样：那一格不再是纯 `---`，整张表当场不成表 —— 这就是守卫存在的理由
const brokenDelimiter = guardLines
	.map((line, index) =>
		index === 1 ? line.replace("---", serializeInline("---", "批注", { inTable: true })) : line,
	)
	.join("\n");
check(
	"分隔行：写进去的话表格就认不出来了（守卫的理由）",
	tableBlockAt(brokenDelimiter.split("\n"), 0),
	null,
);

const pipelessDoc = ["甲 | 乙", "--- | ---", "丙 | 丁"].join("\n");
check("行首：第一格就在行首", isAtTableRowStart(pipelessDoc, 0), true);
check("行首：后面的格不在行首", isAtTableRowStart(pipelessDoc, pipelessDoc.indexOf("乙")), false);
check("行首：缩进的表格行同样算行首", isAtTableRowStart(" 甲 | 乙\n--- | ---", 1), true);
check("行首：第一格不能用行内批注", canUseInlineInTable(pipelessDoc, 0, "甲"), false);
check(
	"行首：拒绝原因说清了是行首",
	explainInlineRefusal(pipelessDoc, 0, "甲")?.includes("行首"),
	true,
);

const pipelessControl = "| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |";
check("行首：有前导管道的表格照旧可以批注", canUseInlineInTable(pipelessControl, 2, "甲"), true);
check("行首：表外文字不受影响", isAtTableRowStart("甲 | 乙", 0), false);

// 文字层面的三条原因，也要能说给用户听（从前只会说「已改用段落批注」）
check(
	"行内拒绝原因：跨行",
	explainInlineRefusal("随便什么", 0, "第一行\n第二行")?.includes("跨了行"),
	true,
);
check(
	"行内拒绝原因：含 `<!--`",
	explainInlineRefusal("随便什么", 0, "a <!-- b")?.includes("<!--"),
	true,
);
check(
	"行内拒绝原因：含保留词",
	explainInlineRefusal("随便什么", 0, "lildog 这个词")?.includes("lildog"),
	true,
);
check("行内可以用时没有拒绝原因", explainInlineRefusal(tableDoc, firstMark, "✅"), null);

// ---------------------------------------------------------------- 旧格式迁移

const legacyTableDoc = "| a | ==旧批注==<!-- lildog: 有 \\| 管道 --> | b |";
const legacyAnn = findInlineAnnotations(legacyTableDoc)[0];
check(
	"旧格式迁移：表格行内的正文会把管道重新转义",
	legacyAnn ? planLegacyMigration(legacyTableDoc, legacyAnn).replacement.includes("\\|") : null,
	true,
);

// ---------------------------------------------------------------- 段落批注插到哪一行

const blockLines = ["前言", "| a | b |", "| --- | --- |", "| c | d |", "后面"];
check("插入点：选区在表头行 → 整张表之后", blockInsertLine(blockLines, 1), 4);
check("插入点：选区在表格末行 → 整张表之后", blockInsertLine(blockLines, 3), 4);
check("插入点：选区在表外不受影响", blockInsertLine(blockLines, 0), 1);

const quoteAfterTable = [
	"| a | b |",
	"| --- | --- |",
	"| c | d |",
	"> [!note] 别人的",
	"> 内容",
	"后面",
];
check("插入点：表格后面紧跟引用块时跳过整个引用块", blockInsertLine(quoteAfterTable, 2), 5);

// ---------------------------------------------------------------- 结果

if (failures.length) {
	console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过\n`);
	for (const f of failures) console.error(`- ${f}\n`);
	process.exit(1);
}
console.log(`\n✓ 全部 ${passed} 项断言通过\n`);
