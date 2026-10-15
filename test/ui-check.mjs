/**
 * 界面级检查：连到隔离测试实例，用**真实的鼠标和键盘**把这几件事走一遍。
 *
 *   1. 高亮看得清：另一种文字颜色 + 强调色底 + 同色下划线（不再是灰底）
 *   2. 悬停浮窗里直接能改批注（点「编辑」→ 输入 → 回车保存并立刻收起）
 *   3. 浮窗字号跟设置走，改设置立刻生效
 *   4. 阅读视图同样高亮、同样能悬停改
 *   5. 同一段文字出现多次时，**在哪选就在哪批注**（不再提示「加在第一处」）
 *
 * 跑法：npm run test:vault 起实例，再 npm run test:ui。
 * 检查过程会改测试库里的样例笔记，跑完自动还原。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createChecker, sleep } from "./cdp.mjs";

const { check, report } = createChecker();
const cdp = await connect();
const { evaluate } = cdp;

const NOTE = "批注测试.md";
const WANT_SHOTS = process.argv.includes("--shots");
const shotDir = join(dirname(fileURLToPath(import.meta.url)), ".shots");

/** 存一张界面截图（--shots 时才存，落在 test/.shots 里，不入库） */
async function shoot(name) {
	if (!WANT_SHOTS) return;
	mkdirSync(shotDir, { recursive: true });
	const result = await cdp.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(shotDir, `${name}.png`), Buffer.from(result.data, "base64"));
}

// ---------------------------------------------------------------- 准备

await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 80 && !window.app?.workspace?.layoutReady; i++) await sleep(250);
	return !!window.app;
})()`);

const original = await evaluate(`(async () => {
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	return await app.vault.read(file);
})()`);
check("测试库里能找到样例笔记", typeof original === "string" && original.includes("lildog"), NOTE);

await evaluate(`(async () => {
	const app = window.app;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(true);
	await leaf.openFile(file);
	await sleep(900);
	const view = leaf.view;
	if (view.getMode() !== "source") {
		app.commands.executeCommandById("markdown:toggle-preview");
		await sleep(1200);
	}
	// 回到第 1 节，保证带批注的文字在视口里
	view.editor.scrollIntoView({ from: { line: 0, ch: 0 }, to: { line: 6, ch: 0 } }, false);
	view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
	await sleep(600);
	return view.getMode();
})()`);

/** 把带批注的高亮元素挂到视口中间，返回它的坐标 */
async function highlightSpot(selector) {
	return evaluate(`(() => {
		const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
		const el = els.find((item) => {
			const r = item.getBoundingClientRect();
			return r.width > 24 && r.height > 8 && r.top > 120 && r.bottom < window.innerHeight - 120;
		}) ?? els[0];
		if (!el) return null;
		el.scrollIntoView({ block: "center" });
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return {
			x: r.left + r.width / 2,
			y: r.top + r.height / 2,
			text: el.textContent ?? "",
			color: cs.color,
			background: cs.backgroundColor,
			shadow: cs.boxShadow,
			count: els.length
		};
	})()`);
}

// ---------------------------------------------------------------- 1. 编辑器里的高亮

console.log("\n【1】编辑器里的批注高亮");
const marker = await highlightSpot(".cm-content .lildog-ann");
check("编辑器里有带批注的高亮", !!marker, marker ? `${marker.count} 个` : "");
check("高亮文字换了一种颜色（默认暖橙 #d9822b）", marker?.color === "rgb(217, 130, 43)", marker?.color);
check("底色是强调紫 32%，不再是灰底", marker?.background === "rgba(126, 122, 245, 0.32)", marker?.background);
check("带一条同色下划线（提高辨识度）", /inset/.test(marker?.shadow ?? ""), marker?.shadow);
	if (!marker) {
	console.error("\n✗ 编辑器里一个批注高亮都没有，后面的检查没法继续：先确认测试库笔记内容和插件构建。\n");
	process.exit(1);
}
await shoot("01-编辑器高亮");

// ---------------------------------------------------------------- 2. 悬停浮窗

console.log("\n【2】悬停浮窗（直接改批注 + 回车即收）");
await cdp.hover(marker.x, marker.y);
await sleep(500);

const card = await evaluate(`(() => {
	const el = document.querySelector(".lildog-card");
	if (!el || el.style.display === "none") return { visible: false };
	const cs = getComputedStyle(el);
	return {
		visible: true,
		fontSize: cs.fontSize,
		text: el.querySelector(".lildog-card-body")?.textContent ?? "",
		quote: el.querySelector(".lildog-card-quote")?.textContent ?? "",
		hasEditButton: !!el.querySelector(".lildog-card-btn"),
		bodyHidden: getComputedStyle(el.querySelector(".lildog-card-edit")).display === "none"
	};
})()`);
check("鼠标停在批注上浮窗弹出来", card.visible);
check("浮窗里显示批注内容", (card.text ?? "").length > 0, card.text);
check("浮窗里显示被批注的原文", (card.quote ?? "").includes("原文："), card.quote);
check("浮窗字号 = 设置里的 14px", card.fontSize === "14px", card.fontSize);
check("浮窗里有「编辑批注」按钮，初始不在编辑态", card.hasEditButton && card.bodyHidden);

const editButton = await evaluate(`(() => {
	const el = document.querySelector(".lildog-card-btn");
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await cdp.click(editButton.x, editButton.y);
await sleep(300);

const editing = await evaluate(`(() => {
	const ta = document.querySelector(".lildog-card-textarea");
	if (!ta) return { found: false };
	return {
		found: true,
		shown: getComputedStyle(ta.closest(".lildog-card-edit")).display !== "none",
		focused: document.activeElement === ta,
		value: ta.value
	};
})()`);
check(
	"点「编辑批注」后浮窗里直接出现输入框并聚焦",
	editing.found && editing.shown && editing.focused,
);
check("输入框里预填了原来的批注内容", (editing.value ?? "").length > 0, editing.value);
await shoot("02-浮窗里直接改批注");

const NEW_BODY = "界面检查：这条批注是在浮窗里改的";
await cdp.type(NEW_BODY);
await sleep(200);
await cdp.key("Enter", { keyCode: 13 });
await sleep(600);

const afterEnter = await evaluate(`(() => {
	const el = document.querySelector(".lildog-card");
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const doc = view.editor.getValue();
	const cmText = Array.from(document.querySelectorAll(".cm-content .cm-line"))
		.map((line) => line.textContent)
		.join(" ");
	return {
		hidden: !el || el.style.display === "none",
		saved: doc.includes(${JSON.stringify(NEW_BODY)}),
		leaked: cmText.includes("lildog"),
		notices: Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent)
	};
})()`);
check("回车后浮窗立刻收起（不用再点别的地方）", afterEnter.hidden);
check("改完的批注内容写进了笔记", afterEnter.saved);
check("笔记正文里没有露出 lildog 标记", !afterEnter.leaked);

// ---------------------------------------------------------------- 3. 阅读视图

console.log("\n【3】阅读视图");
await evaluate(`(async () => {
	const app = window.app;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = app.workspace.getLeavesOfType("markdown")[0].view;
	if (view.getMode() !== "preview") {
		app.commands.executeCommandById("markdown:toggle-preview");
		await sleep(1400);
	}
	return view.getMode();
})()`);

const reading = await highlightSpot(".markdown-reading-view .lildog-ann");
check("阅读视图里也有批注高亮", !!reading, reading ? `${reading.count} 个` : "");
check("阅读视图高亮同样是另一种文字颜色", reading?.color === "rgb(217, 130, 43)", reading?.color);
check("阅读视图高亮同样有强调色底", reading?.background === "rgba(126, 122, 245, 0.32)", reading?.background);

if (reading) {
	await cdp.hover(reading.x, reading.y);
	await sleep(500);
	const readingCard = await evaluate(`(() => {
		const el = document.querySelector(".lildog-card");
		if (!el || el.style.display === "none") return { visible: false };
		return {
			visible: true,
			text: el.querySelector(".lildog-card-body")?.textContent ?? "",
			hasEdit: !!el.querySelector(".lildog-card-btn")
		};
	})()`);
	check("阅读视图里悬停同样弹出浮窗", readingCard.visible, readingCard.text);
	check("阅读视图的浮窗里同样能改（有编辑按钮）", readingCard.hasEdit);
	await shoot("03-阅读视图浮窗");
	// 挪开鼠标，浮窗该自己收起来
	await cdp.mouse("mouseMoved", 5, 5);
	await sleep(700);
	const afterLeave = await evaluate(
		`(() => { const el = document.querySelector(".lildog-card"); return !el || el.style.display === "none"; })()`,
	);
	check("鼠标移开后浮窗自动收起", afterLeave);

	// 阅读视图里真的改一次：这条路径走的是 vault.modify（预览模式下编辑器不保存）
	const READ_BODY = "界面检查：阅读视图里改的批注";
	await cdp.hover(reading.x, reading.y);
	await sleep(500);
	const editButton2 = await evaluate(`(() => {
		const el = document.querySelector(".lildog-card-btn");
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (editButton2) {
		await cdp.click(editButton2.x, editButton2.y);
		await sleep(300);
		await cdp.type(READ_BODY);
		await sleep(200);
		await cdp.key("Enter", { keyCode: 13 });
		await sleep(900);
		const readSaved = await evaluate(`(async () => {
			const app = window.app;
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
			const text = await app.vault.read(file);
			const el = document.querySelector(".lildog-card");
			return {
				onDisk: text.includes(${JSON.stringify(READ_BODY)}),
				cardHidden: !el || el.style.display === "none"
			};
		})()`);
		check("阅读视图的浮窗里改完能写回文件", readSaved.onDisk);
		check("阅读视图里回车后浮窗也立刻收起", readSaved.cardHidden);
	} else {
		check("阅读视图里能再次唤出浮窗", false, "没找到「编辑批注」按钮");
	}
}

// ---------------------------------------------------------------- 4. 设置立刻生效

console.log("\n【4】设置里的颜色和字号");
const appearance = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const plugin = window.app.plugins.plugins["lildog-annotate"];
	const pick = () => document.querySelector(".markdown-reading-view .lildog-ann") ?? document.querySelector(".lildog-ann");
	const before = getComputedStyle(pick()).color;
	plugin.settings.annotatedTextColor = "#1e88e5";
	plugin.settings.cardFontSize = 19;
	plugin.applyAppearance();
	await sleep(150);
	const after = getComputedStyle(pick()).color;
	const fontSizeVar = getComputedStyle(document.body).getPropertyValue("--lildog-card-font-size").trim();
	plugin.settings.annotatedTextColor = "#d9822b";
	plugin.settings.cardFontSize = 14;
	plugin.applyAppearance();
	await sleep(150);
	return { before, after, fontSizeVar, restored: getComputedStyle(pick()).color };
})()`);
check(
	"设置里改批注文字颜色会立刻生效",
	appearance.after === "rgb(30, 136, 229)" && appearance.before !== appearance.after,
	`${appearance.before} → ${appearance.after}`,
);
check("设置里改浮窗字号会立刻生效", appearance.fontSizeVar === "19px", appearance.fontSizeVar);
check("改回默认颜色也立刻生效", appearance.restored === appearance.before, appearance.restored);

// ---------------------------------------------------------------- 5. 在哪选就在哪批注

console.log("\n【5】同一段文字出现多次：在哪选就在哪批注");
const occurrence = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	// 阅读视图是懒渲染的：滚到第 2 节，那几段才会出现在 DOM 里
	const lines = view.editor.getValue().split(String.fromCharCode(10));
	const line = lines.findIndex((item) => item.startsWith("## 2."));
	if (line >= 0 && view.previewMode?.applyScroll) {
		view.previewMode.applyScroll(Math.max(0, line - 1));
		await sleep(900);
	}
	const root = view.containerEl.querySelector(".markdown-reading-view");
	if (!root) return { error: "没有阅读视图" };
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const hits = [];
	let node;
	while ((node = walker.nextNode())) {
		if (node.parentElement?.closest(".lildog-ann")) continue;
		const text = node.textContent ?? "";
		let index = text.indexOf("梯度消失");
		while (index !== -1) {
			hits.push({ node, index });
			index = text.indexOf("梯度消失", index + 1);
		}
	}
	if (hits.length < 3) return { error: "没凑够三处「梯度消失」，实际 " + hits.length };
	const third = hits[2];
	third.node.parentElement.scrollIntoView({ block: "center" });
	await sleep(200);
	const range = document.createRange();
	range.setStart(third.node, third.index);
	range.setEnd(third.node, third.index + 4);
	const r = range.getBoundingClientRect();
	return {
		left: r.left,
		right: r.right,
		top: r.top,
		height: r.height,
		total: hits.length
	};
})()`);
check("阅读视图里找到同一段文字的三处", !occurrence.error, occurrence.error ?? `共 ${occurrence.total} 处`);

if (!occurrence.error) {
	const y = occurrence.top + occurrence.height / 2;
	// 真实的拖选：从第三个「梯度消失」的开头拖到结尾
	await cdp.mouse("mouseMoved", occurrence.left - 8, y);
	await cdp.mouse("mousePressed", occurrence.left + 1, y);
	await cdp.mouse("mouseMoved", occurrence.left + 12, y, { button: "left", buttons: 1 });
	await cdp.mouse("mouseMoved", occurrence.right - 1, y, { button: "left", buttons: 1 });
	await cdp.mouse("mouseReleased", occurrence.right - 1, y);
	await sleep(700);

	const floated = await evaluate(`(() => {
		const el = document.querySelector(".lildog-float-btn");
		const notices = Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? "");
		if (!el || el.style.display === "none") return { shown: false, notices };
		const r = el.getBoundingClientRect();
		return { shown: true, x: r.left + r.width / 2, y: r.top + r.height / 2, notices };
	})()`);
	check("选中第三处后浮出「批注」按钮", floated.shown);
	check(
		"不再提示「出现 N 次 / 会加在第一处」",
		!floated.notices.some((text) => text.includes("第一处") || text.includes("次，批注会加在")),
		floated.notices.join(" | ") || "（没有提示）",
	);

	if (floated.shown) {
		await cdp.click(floated.x, floated.y);
		await sleep(500);
		const modalOpen = await evaluate(
			`(() => !!document.querySelector(".lildog-modal textarea.lildog-textarea"))()`,
		);
		check("点按钮后弹出批注输入框", modalOpen);

		const BODY = "界面检查：批注应该落在第三处";
		await cdp.type(BODY);
		await sleep(200);
		await cdp.key("Enter", { keyCode: 13, modifiers: 2 });
		await sleep(900);

		const landed = await evaluate(`(() => {
			const doc = window.app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue();
			const marker = "<!--lildog: " + ${JSON.stringify(BODY)} + "-->";
			const index = doc.indexOf(marker);
			if (index === -1) return { found: false };
			const section = doc.indexOf("## 2.");
			const before = (doc.slice(section, index).match(/梯度消失/g) ?? []).length;
			return {
				found: true,
				before,
				covered: doc.slice(index, index + 160).includes("梯度消失")
			};
		})()`);
		check("批注写进了笔记", landed.found);
		check("批注落在选中的第三处（前面正好两处相同文字）", landed.before === 2, `前面 ${landed.before} 处`);
		check("被批注的文字就是那一段", landed.covered);
	}
}

// ---------------------------------------------------------------- 还原

await evaluate(`(async () => {
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	await app.vault.modify(file, ${JSON.stringify(original)});
	return true;
})()`);
await sleep(600);
const restored = await evaluate(`(async () => {
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	return (await app.vault.read(file)) === ${JSON.stringify(original)};
})()`);
check("检查过程改动的样例笔记已经还原", restored);

cdp.close();
const ok = report();
process.exit(ok ? 0 : 1);
