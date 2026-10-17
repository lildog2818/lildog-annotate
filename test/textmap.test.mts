/**
 * 「渲染后文字 ↔ 源码文字」对齐的测试。
 *
 * 守的是这条：**DOM 里选中的是渲染后的文字，写进文件的是源码偏移**。表格单元格里
 * `**粗体**`、`` `代码` ``、`$公式$`、已有批注的注释都必须能对回去；对不回去就得
 * 返回 null（宁可不批注），绝不能蒙一个位置 —— 那正是「批注跳到别的格子」的来源。
 */

import {
	collapseWhitespace,
	countOccurrences,
	findNearestOccurrence,
	mapRangeToSource,
	nthOccurrenceIndex,
	stripInlineWithMap,
} from "../src/textmap.ts";

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

/** 渲染后的文字里 [from, to) 对应回源码是哪一段 */
function sourceSlice(raw: string, from: number, length: number): string | null {
	const stripped = stripInlineWithMap(raw);
	const mapped = mapRangeToSource(raw, stripped, from, length);
	return mapped ? raw.slice(mapped.from, mapped.to) : null;
}

// ---------------------------------------------------------------- 剥语法

const bold = "**等 DRDY 下降沿中断**再读";
check("粗体：渲染后的文字", stripInlineWithMap(bold).text, "等 DRDY 下降沿中断再读");
check("粗体：第一个字映射回源码下标 2", stripInlineWithMap(bold).map[0], 2);
check("斜体：星号同样丢掉", stripInlineWithMap("*斜体*字").text, "斜体字");
check("删除线：波浪号丢掉", stripInlineWithMap("~~删除~~了").text, "删除了");
check("下划线：夹在字中间的下划线是正文", stripInlineWithMap("a_b_c").text, "a_b_c");
check("下划线：成对的边界下划线是语法", stripInlineWithMap("_斜体_").text, "斜体");
check(
	"下划线：收尾那个后面还跟着字 → CommonMark 也不当语法，照样留下",
	stripInlineWithMap("_斜体_字").text,
	"_斜体_字",
);
check("行内代码：内容原样保留", stripInlineWithMap("`a_b` 与 `**c**`").text, "a_b 与 **c**");
check("公式：美元号丢掉", stripInlineWithMap("$x^2$ 项").text, "x^2 项");
check("转义：反斜杠不显示", stripInlineWithMap("a \\| b").text, "a | b");
check("注释：整段消失", stripInlineWithMap("贡献 (<!--lildog: x-->nVrm<!--/lildog-->s)").text, "贡献 (nVrms)");
check("Wiki 链接：带别名留别名", stripInlineWithMap("[[目标|别名]]后").text, "别名后");
check("Wiki 链接：没别名留目标", stripInlineWithMap("[[目标]]后").text, "目标后");
check("普通链接：留文字", stripInlineWithMap("[文字](https://a.b)后").text, "文字后");
check("图片：留替代文字", stripInlineWithMap("![图](x.png)后").text, "图后");
check("空白：连续空白压成一个", stripInlineWithMap("甲   乙").text, "甲 乙");
check("空白：首尾空白去掉", stripInlineWithMap("  甲  ").text, "甲");
check("中文：粗体字与普通字一样处理", stripInlineWithMap("**甲**乙").text, "甲乙");

// ---------------------------------------------------------------- 映射回源码

check("映射：粗体里的文字对回原文（不含星号）", sourceSlice(bold, 2, 4), "DRDY");
check("映射：整段粗体文字对回原文（不含星号）", sourceSlice(bold, 0, 12), "等 DRDY 下降沿中断");
check("映射：行内代码里的字对回原文", sourceSlice("`a_b` 与 `**c**`", 0, 3), "a_b");
check(
	"映射：中间夹着别人的批注标记 → 拒绝（不把别的标记吞进来）",
	sourceSlice("贡献 (<!--lildog: x-->nVrm<!--/lildog-->s)", 4, 5),
	null,
);
check(
	"映射：中间夹着粗体定界符是允许的",
	sourceSlice("**甲**和**乙**", 0, 3),
	"甲**和**乙",
);
check("映射：越界返回 null", sourceSlice(bold, 0, 99), null);
check("映射：长度为 0 返回 null", sourceSlice(bold, 0, 0), null);

// ---------------------------------------------------------------- 出现次数

const repeated = "✅ 甲 ✅ 乙 ✅";
check("次数：重复值计数", countOccurrences(repeated, "✅"), 3);
check("次数：第 0 次", nthOccurrenceIndex(repeated, "✅", 0), 0);
check("次数：第 2 次", nthOccurrenceIndex(repeated, "✅", 2), 8);
check("次数：要第 3 次就没有了", nthOccurrenceIndex(repeated, "✅", 3), null);
check("次数：找不到就是 0", countOccurrences(repeated, "丙"), 0);

const nearest = findNearestOccurrence(repeated, "✅", 7);
check("就近：取离提示最近的那一次", nearest?.index, 8);
check("就近：同时报出总次数", nearest?.matches, 3);
check("就近：找不到返回 null", findNearestOccurrence(repeated, "丙", 0), null);

check("空白归一：比对前压掉空白", collapseWhitespace("  甲   乙  "), "甲 乙");

// ---------------------------------------------------------------- 端到端：单元格里选渲染文字

const cellRaw = "**等 DRDY 下降沿中断**再读";
const domText = "等 DRDY 下降沿中断";
const flat = stripInlineWithMap(cellRaw);
const hit = findNearestOccurrence(flat.text, collapseWhitespace(domText), 0);
const mapped = hit
	? mapRangeToSource(cellRaw, flat, hit.index, collapseWhitespace(domText).length)
	: null;
check(
	"端到端：渲染文字选中 → 源码区间正确",
	mapped ? cellRaw.slice(mapped.from, mapped.to) : null,
	"等 DRDY 下降沿中断",
);

// ---------------------------------------------------------------- 结果

if (failures.length) {
	console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过\n`);
	for (const f of failures) console.error(`- ${f}\n`);
	process.exit(1);
}
console.log(`\n✓ 全部 ${passed} 项断言通过\n`);
