/**
 * 颜色 / 数字设置的收口逻辑。
 * 这些值都存在 data.json 里、用户手一改就可能写错，错了不该让插件崩，
 * 也不该让批注变成看不见的透明色。
 */
import {
	clampNumber,
	DEFAULT_HIGHLIGHT_COLOR,
	DEFAULT_TEXT_COLOR,
	hexToRgb,
	hexToRgba,
	normalizeHex,
} from "../src/colors.ts";

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

check("颜色：三位简写补全", normalizeHex("#ABC", "#000000"), "#aabbcc");
check("颜色：统一小写", normalizeHex("#A1b2C3", "#000000"), "#a1b2c3");
check("颜色：带空格也能认", normalizeHex("  #7e7af5  ", "#000000"), "#7e7af5");
check("颜色：认不出来退回默认", normalizeHex("rgb(1,2,3)", "#7e7af5"), "#7e7af5");
check("颜色：空值退回默认", normalizeHex(undefined, "#7e7af5"), "#7e7af5");
check("颜色：默认文字色是暖色（和紫色底分得开）", DEFAULT_TEXT_COLOR, "#d9822b");
check("颜色：默认底色是强调紫", DEFAULT_HIGHLIGHT_COLOR, "#7e7af5");

check("取 RGB：算对", hexToRgb("#7e7af5"), { r: 126, g: 122, b: 245 });
check("取 RGB：非法值返回 null", hexToRgb("lildog"), null);

check("透明度：默认底色", hexToRgba("#7e7af5", 0.32), "rgba(126, 122, 245, 0.32)");
check("透明度：1 不带小数点", hexToRgba("#7e7af5", 1), "rgba(126, 122, 245, 1)");
check("透明度：0 也写得出来", hexToRgba("#000000", 0), "rgba(0, 0, 0, 0)");
check("透明度：越界会被夹住", hexToRgba("#7e7af5", 5), "rgba(126, 122, 245, 1)");
check("透明度：非法颜色退回默认色", hexToRgba("坏掉的", 0.5), "rgba(126, 122, 245, 0.5)");

check("数字：越界夹到上限", clampNumber(999, 11, 24, 14), 24);
check("数字：越界夹到下限", clampNumber(-3, 11, 24, 14), 11);
check("数字：字符串数字也认", clampNumber("16", 11, 24, 14), 16);
check("数字：NaN 用默认值", clampNumber("大一点", 11, 24, 14), 14);
check("数字：undefined 用默认值", clampNumber(undefined, 11, 24, 14), 14);

if (failures.length) {
	console.error(`\n✗ 颜色设置 ${failures.length} 项失败，${passed} 项通过\n`);
	for (const item of failures) console.error(`- ${item}\n`);
	process.exit(1);
}
console.log(`\n✓ 颜色 / 数字设置全部 ${passed} 项通过\n`);
