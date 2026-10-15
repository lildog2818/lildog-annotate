import {
	blockInsertLine,
	canUseInline,
	extendToBalanceBackticks,
	findBlockAtLine,
	findInlineAnnotations,
	lineOffsets,
	locateText,
	normalizeForCompare,
	planEditorDecorations,
	planLegacyMigration,
	serializeBlock,
	serializeInline,
	stripInlineMarkdown,
} from "../src/format.ts";

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

// ------------------------------------------------------- 行内批注（现行格式）

const sample = "前面<!--lildog: 为什么？-->梯度消失<!--/lildog-->后面";
const found = findInlineAnnotations(sample);
check("现行格式：能解析出 1 条", found.length, 1);
check("现行格式：原文", found[0]?.text, "梯度消失");
check("现行格式：批注内容", found[0]?.body, "为什么？");
check("现行格式：格式标记", found[0]?.format, "marker");
check(
	"现行格式：原文区间精确",
	sample.slice(found[0]!.textFrom, found[0]!.textTo),
	"梯度消失",
);
check(
	"现行格式：起始标记被完整识别",
	sample.slice(found[0]!.hiddenRanges[0][0], found[0]!.hiddenRanges[0][1]),
	"<!--lildog: 为什么？-->",
);
check(
	"现行格式：结束标记被完整识别",
	sample.slice(found[0]!.hiddenRanges[1][0], found[0]!.hiddenRanges[1][1]),
	"<!--/lildog-->",
);
check(
	"现行格式：藏起来的区间不碰原文",
	found[0]!.hiddenRanges.every(
		([from, to]) => to <= found[0]!.textFrom || from >= found[0]!.textTo,
	),
	true,
);

check(
	"现行格式：生成",
	serializeInline("梯度消失", "为什么会衰减？"),
	"<!--lildog: 为什么会衰减？-->梯度消失<!--/lildog-->",
);
check(
	"现行格式：自己生成的能自己解析回来",
	findInlineAnnotations(serializeInline("梯度消失", "为什么会衰减？"))[0],
	{
		from: 0,
		to: 40,
		text: "梯度消失",
		body: "为什么会衰减？",
		textFrom: 22,
		textTo: 26,
		hiddenRanges: [
			[0, 22],
			[26, 40],
		],
		format: "marker",
	},
);
check(
	"现行格式：换行被压成空格",
	serializeInline("梯度消失", "第一行\n第二行"),
	"<!--lildog: 第一行 第二行-->梯度消失<!--/lildog-->",
);
check(
	"现行格式：--> 被转义，不会提前闭合注释",
	serializeInline("梯度消失", "条件是 a --> b"),
	"<!--lildog: 条件是 a -- > b-->梯度消失<!--/lildog-->",
);

// 这是这次出问题的场景：原文里有等号、反引号、==，旧格式全都处理不了
const tricky = "1/(1+x) = 1 − x + x² − …";
check("现行格式：原文含 = 不再是问题", canUseInline(tricky), true);
check("现行格式：原文含反引号不再是问题", canUseInline("`code = 1`"), true);
check("现行格式：原文含 == 也不再是问题", canUseInline("a == b"), true);
check(
	"现行格式：含 = 的批注能原样往返",
	findInlineAnnotations(serializeInline(tricky, "是什么公式"))[0]?.text,
	tricky,
);

check("行内：跨行仍然不可用", canUseInline("第一行\n第二行"), false);
check("行内：含注释起始符不可用", canUseInline("a <!-- b"), false);
check("行内：含 lildog 不可用", canUseInline("lildog 这个词"), false);

// ------------------------------------------------------- 行内批注（旧格式兼容）

const legacySample =
	"反向传播懂了，但是==梯度消失==<!-- lildog: 为什么会衰减？ -->没想明白。";
const legacy = findInlineAnnotations(legacySample);
check("旧格式：仍然能解析", legacy.length, 1);
check("旧格式：原文", legacy[0]?.text, "梯度消失");
check("旧格式：批注内容", legacy[0]?.body, "为什么会衰减？");
check("旧格式：格式标记", legacy[0]?.format, "legacy");
check(
	"旧格式：隐藏区间就是那段注释",
	legacySample.slice(legacy[0]!.hiddenRanges[0][0], legacy[0]!.hiddenRanges[0][1]),
	"<!-- lildog: 为什么会衰减？ -->",
);

check(
	"两种格式混在一篇里能同时解析",
	findInlineAnnotations(
		"==甲==<!-- lildog: 旧1 -->中间<!--lildog: 新-->乙<!--/lildog-->尾巴",
	).map((a) => `${a.format}:${a.body}`),
	["legacy:旧1", "marker:新"],
);

// ------------------------------------------- 回归：批注文字里含 = 和行内代码
// 真实案例（数字信号处理笔记）：旧版正则排除了 =，导致整条批注解析不出来，
// 编辑器里标记藏不住、阅读视图里也配不上对。

const dspLine =
	"用 ==`1/(1+x) = 1 − x + x² − …==<!-- lildog: 这个又是什么公式，等价无穷小吗 -->` 摊开：";
const dsp = findInlineAnnotations(dspLine);
check("回归：原文含 = 时能解析出批注", dsp.length, 1);
check("回归：原文取对（含行内代码）", dsp[0]?.text, "`1/(1+x) = 1 − x + x² − …");
check("回归：批注内容取对", dsp[0]?.body, "这个又是什么公式，等价无穷小吗");

check(
	"回归：同一行两条批注不会互相吞掉",
	findInlineAnnotations(
		"==a = b==<!-- lildog: 1 -->中间==c==<!-- lildog: 2 -->",
	).map((a) => a.body),
	["1", "2"],
);
check(
	"回归：换成新格式后，原文里的 = 和反引号都不再破坏排版",
	findInlineAnnotations(
		serializeInline("`1/(1+x) = 1 − x + x² − …`", "这个又是什么公式"),
	)[0]?.text,
	"`1/(1+x) = 1 − x + x² − …`",
);

check(
	"归一化：行内代码被剥掉",
	normalizeForCompare("`1/(1+x) = 1 − x`"),
	normalizeForCompare("1/(1+x) = 1 − x"),
);
check("归一化：链接取文字", stripInlineMarkdown("[文字](https://example.com)"), "文字");
check("归一化：wikilink 取别名", stripInlineMarkdown("[[目标|别名]]"), "别名");
check(
	"归一化：粗体斜体被剥掉",
	normalizeForCompare("**重点**和*强调*"),
	normalizeForCompare("重点和强调"),
);

// ------------------------------------------- 反引号兜底 与 旧格式迁移

const codeDoc = "用 `1/(1+x) = 1` 摊开";
check(
	"反引号：选区带开头反引号但没带结尾时，补上结尾",
	extendToBalanceBackticks(codeDoc, 2, 14),
	15,
);
check("反引号：本来就配对就不动", extendToBalanceBackticks(codeDoc, 2, 15), 15);
check(
	"反引号：后面不是反引号就不动",
	extendToBalanceBackticks("用 `code 摊开", 2, 7),
	7,
);

const legacyLine = "用 ==`1/(1+x) = 1 − x + x² − …==<!-- lildog: B -->` 摊开";
const legacyAnn = findInlineAnnotations(legacyLine)[0]!;
const plan = planLegacyMigration(legacyLine, legacyAnn);
check("迁移：会把漏掉的结尾反引号一并纳入", plan.text, "`1/(1+x) = 1 − x + x² − …`");
const migrated =
	legacyLine.slice(0, plan.from) + plan.replacement + legacyLine.slice(plan.to);
check(
	"迁移：迁移后的源码能被新格式解析",
	findInlineAnnotations(migrated).map((a) => `${a.format}:${a.text}`),
	["marker:`1/(1+x) = 1 − x + x² − …`"],
);
check("迁移：迁移后源码里不再有 == 定界符", migrated.includes("=="), false);
check(
	"迁移：迁移后的完整源码正确",
	migrated,
	"用 <!--lildog: B-->`1/(1+x) = 1 − x + x² − …`<!--/lildog--> 摊开",
);

// ---------------------------------------------------------------- 定位文字

check(
	"行偏移：每行起点算对",
	lineOffsets("甲\n乙丙\n丁"),
	[0, 2, 5],
);
{
	const doc = "第一行\n第二行里有梯度消失\n第三行";
	const hit = locateText(doc, "梯度消失");
	check("定位：能在全文里找到文字", [hit?.fromOffset, hit?.toOffset], [9, 13]);
	check("定位：切出来的就是那段文字", doc.slice(hit!.fromOffset, hit!.toOffset), "梯度消失");
	check("定位：出现次数", hit?.matches, 1);
}
{
	const doc = "第一行\n第二行里有梯度消失\n第三行";
	check("定位：限定范围能找到", doc.slice(
		locateText(doc, "第二行", 4, 8)?.fromOffset ?? 0,
		locateText(doc, "第二行", 4, 8)?.toOffset ?? 0,
	), "第二行");
	check("定位：范围内没有就返回 null", locateText(doc, "第一行", 4, 20), null);
}
{
	const hit = locateText("ab ab ab", "ab");
	check("定位：重复文字会报告次数", hit?.matches, 3);
	check("定位：重复时取第一处", hit?.fromOffset, 0);
}
check("定位：空文字返回 null", locateText("随便什么", "   "), null);

// ---------------------------------------------------------------- 装饰规划
// 这一段锁死「标记藏不住」的根因：装饰必须严格按 from 递增，
// 否则 RangeSetBuilder 抛异常、被吞掉，标记就全露在正文里。

const planDoc = "前<!--lildog: 为什么？-->正文<!--/lildog-->后";
const planAnn = findInlineAnnotations(planDoc)[0]!;
{
	const plan = planEditorDecorations(planDoc, []);
	check("装饰规划：解析到 1 条批注", plan.annotations, 1);
	check(
		"装饰规划：藏起始标记 + 高亮原文 + 藏结束标记",
		plan.entries.map((e) => `${e.kind}:${planDoc.slice(e.from, e.to)}`),
		[
			"hide:<!--lildog: 为什么？-->",
			"mark:正文",
			"hide:<!--/lildog-->",
		],
	);
	check(
		"装饰规划：严格按 from 递增（RangeSetBuilder 的硬要求）",
		plan.entries.every((e, i) => i === 0 || plan.entries[i - 1].to <= e.from),
		true,
	);
}

{
	const many = "<!--lildog: 一-->甲<!--/lildog-->中间<!--lildog: 二-->乙<!--/lildog-->尾巴";
	const plan = planEditorDecorations(many, []);
	check("装饰规划：多条批注共 6 段", plan.entries.length, 6);
	check(
		"装饰规划：多条批注同样严格递增",
		plan.entries.every((e, i) => i === 0 || plan.entries[i - 1].to <= e.from),
		true,
	);
	check(
		"装饰规划：高亮分别落在甲和乙上",
		plan.entries
			.filter((e) => e.kind === "mark")
			.map((e) => many.slice(e.from, e.to)),
		["甲", "乙"],
	);
}

{
	const legacyDoc = "==正文==<!-- lildog: 为什么？ -->";
	const plan = planEditorDecorations(legacyDoc, []);
	check(
		"装饰规划：旧格式是「高亮 + 藏注释」两段",
		plan.entries.map((e) => `${e.kind}:${legacyDoc.slice(e.from, e.to)}`),
		["mark:正文", "hide:<!-- lildog: 为什么？ -->"],
	);
}

// 什么时候露出原始标记
{
	const cursorInText = planEditorDecorations(planDoc, [
		[planAnn.textFrom + 1, planAnn.textFrom + 1],
	]);
	check("装饰规划：折叠光标停在原文里，标记仍然藏着", cursorInText.entries.length, 3);

	const selecting = planEditorDecorations(planDoc, [
		[planAnn.textFrom, planAnn.textTo],
	]);
	check(
		"装饰规划：拖选/双击选中原文，标记露出来",
		selecting.entries.map((e) => e.kind),
		["mark"],
	);

	const cursorInMarker = planEditorDecorations(planDoc, [[planAnn.from + 2, planAnn.from + 2]]);
	check(
		"装饰规划：光标停在被藏起来的标记里，标记露出来",
		cursorInMarker.entries.map((e) => e.kind),
		["mark"],
	);

	const cursorAtEnd = planEditorDecorations(planDoc, [
		[planDoc.length, planDoc.length],
	]);
	check("装饰规划：刚写完批注、光标在批注末尾时，标记仍然藏着", cursorAtEnd.entries.length, 3);
}

{
	const plan = planEditorDecorations("一段普通文字，没有任何批注。", []);
	check("装饰规划：没有批注就不产生装饰", plan.entries.length, 0);
	check("装饰规划：没有批注时计数为 0", plan.annotations, 0);
}

// ------------------------------------------------------- 代码块里的内容也能批注

{
	const withFence = [
		"真正的一条：<!--lildog: 我是真批注-->甲<!--/lildog-->",
		"",
		"```js",
		"const a = 1; // <!--lildog: 代码块里也能批注-->这行代码<!--/lildog-->",
		"```",
		"",
		"尾巴",
	].join("\n");
	const found = findInlineAnnotations(withFence);
	check("代码块：代码块里的批注同样识别（可以给代码加批注）", found.length, 2);
	check(
		"代码块：两条都能取到内容",
		found.map((a) => a.body),
		["我是真批注", "代码块里也能批注"],
	);
}

{
	// 只有单个标记（缺另一半）不成对，所以文档里可以安全地展示语法
	const docOnly = [
		"起始标记：<!--lildog: 批注内容-->",
		"结束标记：<!--/lildog-->",
	].join("\n");
	check(
		"只写了半截标记不构成批注（方便写文档）",
		findInlineAnnotations(docOnly).length,
		0,
	);
}

// ---------------------------------------------------------------- 段落批注

const block = serializeBlock("梯度消失", "为什么会衰减？");
check(
	"段落：生成",
	block,
	"> [!lildog] 批注\n> 原文：梯度消失\n>\n> 为什么会衰减？",
);

const docLines = [
	"第一段，讲反向传播。",
	"",
	...block.split("\n"),
	"",
	"第二段，讲别的。",
];
const parsedBlock = findBlockAtLine(docLines, 2);
check("段落：光标在批注块里能找到", parsedBlock?.startLine, 2);
check("段落：结束行", parsedBlock?.endLine, 5);
check("段落：原文引用", parsedBlock?.quote, "梯度消失");
check("段落：批注内容", parsedBlock?.body, "为什么会衰减？");

const parsedFromInside = findBlockAtLine(docLines, 4);
check("段落：光标在正文行上也能找到（属于同一条批注）", parsedFromInside?.body, "为什么会衰减？");
check("段落：光标在普通段落上找不到", findBlockAtLine(docLines, 0), null);
check("段落：光标在批注块后的空行上找不到", findBlockAtLine(docLines, 6), null);

const multiLine = serializeBlock("链式求导", "第一行\n\n第三行");
check(
	"段落：多行批注保持分段",
	multiLine,
	"> [!lildog] 批注\n> 原文：链式求导\n>\n> 第一行\n>\n> 第三行",
);
check(
	"段落：多行批注能被解析回来",
	findBlockAtLine(multiLine.split("\n"), 0)?.body,
	"第一行\n\n第三行",
);

// ---------------------------------------------------------------- 插到哪一行

check(
	"插入点：紧跟选区所在段落",
	blockInsertLine(["甲", "乙", "丙"], 0),
	1,
);
check(
	"插入点：跳过紧随其后的引用块，不塞进别人的 callout",
	blockInsertLine(["甲", "> [!note] 别的", "> 内容", "丙"], 0),
	3,
);
check("插入点：段落是最后一行时落在文末", blockInsertLine(["甲"], 0), 1);

// ---------------------------------------------------------------- 结果

if (failures.length) {
	console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过\n`);
	for (const f of failures) console.error(`- ${f}\n`);
	process.exit(1);
}
console.log(`\n✓ 全部 ${passed} 项断言通过\n`);
