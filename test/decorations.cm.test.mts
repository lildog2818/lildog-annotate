/**
 * 装饰构建的回归测试（真的 CodeMirror，不是桩）。
 *
 * 锁死那个坑：RangeSetBuilder 要求装饰严格按 from 递增，顺序错了它会抛异常；
 * 异常一旦被 catch 吞掉，返回的集合里一条替换装饰都没有 —— 标记就全露在正文里。
 * 所以这里既断言「不抛异常」，也断言「藏起来的区间确实存在」。
 *
 * 由 test/run-cm-tests.mjs 用 esbuild 打包后运行（Node 的 ESM 解析器不认
 * 无扩展名导入，直接跑会失败）。
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { buildEditorDecorations } from "../src/decorations.ts";
import { diag, resetDiagnostics } from "../src/diagnostics.ts";
import { findInlineAnnotations } from "../src/format.ts";

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

interface RangeInfo {
	text: string;
	kind: "mark" | "hide";
}

function inspect(
	doc: string,
	selection?: EditorSelection,
): { ranges: RangeInfo[]; error: string | null } {
	resetDiagnostics();
	const state = EditorState.create({ doc, selection });
	const set = buildEditorDecorations(state);
	const ranges: RangeInfo[] = [];
	set.between(0, state.doc.length, (from, to, value: Decoration) => {
		const spec = (value as unknown as { spec?: { class?: string } }).spec;
		ranges.push({
			text: doc.slice(from, to),
			kind: spec?.class === "lildog-ann" ? "mark" : "hide",
		});
	});
	return { ranges, error: diag.editorLastError };
}

const markerDoc = "前<!--lildog: 为什么？-->正文<!--/lildog-->后";

{
	const { ranges, error } = inspect(markerDoc);
	check("现行格式：构建装饰不抛异常", error, null);
	check("现行格式：起始标记 + 原文 + 结束标记，三段装饰都生成", ranges, [
		{ text: "<!--lildog: 为什么？-->", kind: "hide" },
		{ text: "正文", kind: "mark" },
		{ text: "<!--/lildog-->", kind: "hide" },
	]);
}

{
	const many =
		"<!--lildog: 一-->甲<!--/lildog-->中间<!--lildog: 二-->乙<!--/lildog-->尾巴";
	const { ranges, error } = inspect(many);
	check("多条批注：不报错", error, null);
	check("多条批注：6 段装饰", ranges.length, 6);
	check(
		"多条批注：高亮落在甲和乙上",
		ranges.filter((r) => r.kind === "mark").map((r) => r.text),
		["甲", "乙"],
	);
	check(
		"多条批注：藏掉四段标记",
		ranges.filter((r) => r.kind === "hide").map((r) => r.text),
		[
			"<!--lildog: 一-->",
			"<!--/lildog-->",
			"<!--lildog: 二-->",
			"<!--/lildog-->",
		],
	);
}

{
	const legacyDoc = "==正文==<!-- lildog: 为什么？ -->";
	const { ranges, error } = inspect(legacyDoc);
	check("旧格式：不报错", error, null);
	check("旧格式：高亮 + 藏注释", ranges, [
		{ text: "正文", kind: "mark" },
		{ text: "<!-- lildog: 为什么？ -->", kind: "hide" },
	]);
}

// 真实场景：你笔记里那一行（含行内代码、等号）
{
	const real =
		"**（选读）为什么是 `(f/fc)^2n` 而不是别的**：把幅度平方按 ω 的偶次幂展开，写成 `|H|² = 1/(1 + a₁ω² + a₂ω⁴ + …)`（分母常数项取 1，是为了直流增益等于 1），用 <!--lildog: 这个又是什么公式，等价无穷小吗-->`1/(1+x) = 1 − x + x² − …`<!--/lildog-->摊开：";
	const { ranges, error } = inspect(real);
	check("真实笔记那一行：不报错", error, null);
	check("真实笔记那一行：3 段装饰", ranges.length, 3);
	check(
		"真实笔记那一行：两段标记都被藏掉",
		ranges.filter((r) => r.kind === "hide").map((r) => r.text),
		["<!--lildog: 这个又是什么公式，等价无穷小吗-->", "<!--/lildog-->"],
	);
	check(
		"真实笔记那一行：高亮落在行内代码上",
		ranges.filter((r) => r.kind === "mark").map((r) => r.text),
		["`1/(1+x) = 1 − x + x² − …`"],
	);
}

// 露出原始标记的时机
{
	const ann = findInlineAnnotations(markerDoc)[0]!;
	check(
		"折叠光标停在原文里：标记仍然藏着",
		inspect(markerDoc, EditorSelection.cursor(ann.textFrom + 1)).ranges.length,
		3,
	);
	check(
		"拖选/双击选中原文：标记露出来",
		inspect(
			markerDoc,
			EditorSelection.single(ann.textFrom, ann.textTo),
		).ranges.map((r) => r.kind),
		["mark"],
	);
	check(
		"光标停在被藏起来的标记里：标记露出来",
		inspect(markerDoc, EditorSelection.cursor(ann.from + 2)).ranges.map(
			(r) => r.kind,
		),
		["mark"],
	);
	check(
		"刚写完批注、光标在批注末尾：标记仍然藏着",
		inspect(markerDoc, EditorSelection.cursor(markerDoc.length)).ranges.length,
		3,
	);
	check("空文档不崩", inspect("").ranges.length, 0);
	check("没有批注的文档不产生装饰", inspect("很普通的一段话。").ranges.length, 0);
}

if (failures.length) {
	console.error(`\n✗ 装饰测试 ${failures.length} 项失败，${passed} 项通过\n`);
	for (const f of failures) console.error(`- ${f}\n`);
	process.exit(1);
}
console.log(`\n✓ 装饰测试全部 ${passed} 项通过（真的 CodeMirror）\n`);
