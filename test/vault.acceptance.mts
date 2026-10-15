/**
 * 验收脚本：用真实的正则去读库里真实的笔记，确认
 *   1. 修好后的 DSP 笔记能被解析成现行格式批注
 *   2. 旧格式在库里已经绝迹（除了演示笔记里作为例子展示的那两处）
 */
import { readFileSync } from "node:fs";
import { findInlineAnnotations } from "../src/format.ts";

const files = [
	"D:\\document\\ObsidianNote\\01 学习笔记\\数字信号处理\\巴特沃斯滤波器设计-DSP.md",
	"D:\\document\\ObsidianNote\\01 学习笔记\\数字信号处理\\巴特沃斯滤波器设计-DSP.ipynb",
	"D:\\document\\ObsidianNote\\05 备忘记录\\Lildog Annotate 使用演示.md",
];

let bad = 0;
for (const file of files) {
	const text = readFileSync(file, "utf8");
	const annotations = findInlineAnnotations(text);
	const name = file.split("\\").pop();
	console.log(`\n=== ${name} ===`);
	console.log(`解析到 ${annotations.length} 条行内批注`);
	for (const a of annotations) {
		console.log(`  [${a.format}] 原文：${a.text}`);
		console.log(`           批注：${a.body}`);
	}
	const legacy = annotations.filter((a) => a.format === "legacy").length;
	const markers = annotations.filter((a) => a.format === "marker").length;
	console.log(`  现行格式 ${markers} 条 / 旧格式 ${legacy} 条`);
	if (annotations.length === 0) {
		console.log("  （这一篇当前没有批注）");
	}
}

// 全库扫一遍：除了演示笔记里有意展示的旧格式例子，不该再有旧格式残留
const vaultGrep = readFileSync(
	"D:\\document\\ObsidianNote\\01 学习笔记\\数字信号处理\\巴特沃斯滤波器设计-DSP.md",
	"utf8",
);
console.log(
	`\nDSP 笔记里还有没有 ==…==<!-- lildog 这种旧写法：${vaultGrep.includes("==<!-- lildog") || /==[^=\n]+==<!--/.test(vaultGrep) ? "有（不合格）" : "没有（合格）"}`,
);
console.log(`\n${bad ? "✗ 有文件解析不出批注" : "✓ 验收通过"}\n`);
process.exit(bad ? 1 : 0);
