/**
 * 验收：拿真实的正则读测试库里的样例笔记（test/vault/批注测试.md），确认
 *   1. 现行格式 / 旧格式都解析得出来，条数对得上；
 *   2. 同一段文字出现多次时，能按「选区所在位置」就近命中 —— 这是
 *      「不用管出现几次，在哪选就在哪批注」的算法底座；
 *   3. 笔记里没有落单的标记（半截标记会让整条批注解析不出来）。
 *
 * 跑法：npm run test:accept（也可以直接 npm test，它串在最后）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findInlineAnnotations, lineOffsets, locateText } from "../src/format.ts";

const here = dirname(fileURLToPath(import.meta.url));
const notePath = join(here, "vault", "批注测试.md");
const doc = readFileSync(notePath, "utf8");

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

function checkThat(name: string, ok: boolean, detail = ""): void {
	if (ok) passed++;
	else failures.push(`${name}${detail ? `\n  ${detail}` : ""}`);
}

// ---------------------------------------------------------------- 解析

const annotations = findInlineAnnotations(doc);
const markers = annotations.filter((a) => a.format === "marker");
const legacy = annotations.filter((a) => a.format === "legacy");

check("样例笔记：解析出的批注条数", annotations.length, 9);
check("样例笔记：现行格式条数", markers.length, 8);
check("样例笔记：旧格式条数", legacy.length, 1);
checkThat(
	"样例笔记：夹着公式 / 行内代码的批注也解析得出来",
	annotations.some((a) => a.text.includes("$\\omega_c$")) &&
		annotations.some((a) => a.text.includes("`code = 1`")),
);
checkThat(
	"样例笔记：每条都取到了原文和批注内容",
	annotations.every((a) => a.text.trim().length > 0 && a.body.trim().length > 0),
	JSON.stringify(annotations.map((a) => [a.text, a.body])),
);
checkThat(
	"样例笔记：原文含 = 与反引号的那条也在里头",
	annotations.some((a) => a.text.includes("1/(1+x)") && a.text.includes("`")),
);
checkThat(
	"样例笔记：表格 / 列表 / 代码块 / 引用块里的批注都认出来了",
	["单元格甲", "无序列表第二项", "这行代码", "这里也想批注。"].every((text) =>
		annotations.some((a) => a.text === text),
	),
);
checkThat(
	"样例笔记：旧格式那条还能被读到（迁移命令要用）",
	legacy[0]?.text === "旧格式批注",
);

// ---------------------------------------------------------------- 半截标记

const opens = (doc.match(/<!--lildog:/g) ?? []).length;
const closes = (doc.match(/<!--\/lildog-->/g) ?? []).length;
check("样例笔记：起始 / 结束标记数量一致（没有半截标记）", [opens, closes], [
	markers.length,
	markers.length,
]);

// ------------------------------------------- 同一段文字出现多次：就近命中

const repeated = "梯度消失";
const offsets = lineOffsets(doc);
const lines = doc.split("\n");
// 第 2 节：同一段文字出现多次（按标题定位，改笔记也不会把测试带偏）
const startLine = lines.findIndex((line) => line.startsWith("## 2."));
const endLine = lines.findIndex((line, index) => index > startLine && line.startsWith("## 3.")) - 1;
checkThat(
	"样例笔记：找得到「同一段文字出现多次」那一节",
	startLine >= 0 && endLine > startLine,
);
const sectionStart = offsets[startLine] ?? 0;
const sectionEnd = offsets[endLine + 1] ?? doc.length;
const section = doc.slice(sectionStart, sectionEnd);

const inSection: number[] = [];
let scan = section.indexOf(repeated);
while (scan !== -1) {
	inSection.push(sectionStart + scan);
	scan = section.indexOf(repeated, scan + 1);
}
check("重复文字：这一节里出现 3 次", inSection.length, 3);

const second = inSection[1]!;
const hitFirst = locateText(doc, repeated, sectionStart, sectionEnd);
const hitSecond = locateText(doc, repeated, sectionStart, sectionEnd, second);
const hitThird = locateText(doc, repeated, sectionStart, sectionEnd, inSection[2]!);

check("重复文字：不给位置时仍然取第一处（老行为不变）", hitFirst?.fromOffset, inSection[0]);
check("重复文字：选中第二处就落在第二处", hitSecond?.fromOffset, second);
check("重复文字：选中第三处就落在第三处", hitThird?.fromOffset, inSection[2]);
check("重复文字：三种都报告同样的出现次数", [hitFirst?.matches, hitSecond?.matches], [3, 3]);
check(
	"重复文字：切出来的就是选中的那一段",
	doc.slice(hitThird!.fromOffset, hitThird!.toOffset),
	repeated,
);

// 跨节的干扰：第 1 节里也有「梯度消失」，全库定位时不能被它带偏
check("重复文字：全文里共 4 处（含第 1 节那条）", locateText(doc, repeated)?.matches, 4);

// ---------------------------------------------------------------- 结果

if (failures.length) {
	console.error(`\n✗ 验收 ${failures.length} 项失败，${passed} 项通过\n`);
	for (const item of failures) console.error(`- ${item}\n`);
	process.exit(1);
}
console.log(`\n✓ 测试库验收全部 ${passed} 项通过（样例笔记 ${annotations.length} 条批注）\n`);
