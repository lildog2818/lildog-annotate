import {
	blockInsertLine,
	canUseInline,
	findBlockAtLine,
	findInlineAnnotations,
	serializeBlock,
	serializeInline,
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

// ---------------------------------------------------------------- 行内批注

const inlineSample = "反向传播懂了，但是==梯度消失==<!-- lildog: 为什么会衰减？ -->没想明白。";
const found = findInlineAnnotations(inlineSample);
check("行内：能解析出 1 条", found.length, 1);
check("行内：原文", found[0]?.text, "梯度消失");
check("行内：批注内容", found[0]?.body, "为什么会衰减？");
check(
	"行内：区间切出来的就是标记本身",
	inlineSample.slice(found[0]!.from, found[0]!.to),
	"==梯度消失==<!-- lildog: 为什么会衰减？ -->",
);
check(
	"行内：高亮区间的偏移正确",
	inlineSample.slice(found[0]!.textFrom, found[0]!.textTo),
	"梯度消失",
);
check(
	"行内：隐藏注释的起点正确",
	inlineSample.slice(found[0]!.commentFrom, found[0]!.to),
	"<!-- lildog: 为什么会衰减？ -->",
);

check(
	"行内：生成",
	serializeInline("梯度消失", "为什么会衰减？"),
	"==梯度消失==<!-- lildog: 为什么会衰减？ -->",
);
check(
	"行内：换行被压成空格",
	serializeInline("梯度消失", "第一行\n第二行"),
	"==梯度消失==<!-- lildog: 第一行 第二行 -->",
);
check(
	"行内：--> 被转义，不会提前闭合注释",
	serializeInline("梯度消失", "条件是 a --> b"),
	"==梯度消失==<!-- lildog: 条件是 a -- > b -->",
);

const roundTrip = serializeInline("梯度消失", "为什么会衰减？");
check("行内：自己生成的能自己解析回来", findInlineAnnotations(roundTrip)[0]?.body, "为什么会衰减？");

check("行内：单行可用", canUseInline("梯度消失"), true);
check("行内：跨行不可用", canUseInline("第一行\n第二行"), false);
check("行内：含 == 不可用", canUseInline("a == b"), false);

check("行内：全文多条按顺序解析", findInlineAnnotations(
	"==甲==<!-- lildog: 1 -->中间==乙==<!-- lildog: 2 -->",
).map((a) => a.body), ["1", "2"]);

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
