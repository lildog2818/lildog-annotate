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
	const app = window.app;
	for (let i = 0; i < 80 && !app?.workspace?.layoutReady; i++) await sleep(250);
	// 只留一个窗格：后台标签页的内容是空的，拿它做检查会得出假结论
	const leaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of leaves) {
		if (leaf !== app.workspace.activeLeaf) leaf.detach();
	}
	await sleep(500);
	return !!app;
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

/** 把带批注的高亮元素挂到视口中间，返回它的坐标（折行时取鼠标底下那一块） */
async function highlightSpot(selector) {
	return evaluate(`(() => {
		const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
		const el = els.find((item) => {
			const r = Array.from(item.getClientRects())[0] ?? item.getBoundingClientRect();
			return r.width > 8 && r.height > 8;
		}) ?? els[0];
		if (!el) return null;
		el.scrollIntoView({ block: "center" });
		const rects = Array.from(el.getClientRects());
		const r = rects[0] ?? el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return {
			x: r.left + Math.min(r.width / 2, 20),
			y: r.top + r.height / 2,
			text: el.textContent ?? "",
			segments: rects.length,
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

// 万一 Obsidian 那份 styles.css 没生效（或不是最新的），高亮也必须看得见：
// 插件加载时会自己注入一份样式，这里就把其它样式摘掉验一次
console.log("\n【1b】样式表不生效时也看得见");
const styleFallback = await evaluate(`(() => {
	const pick = () => document.querySelector(".cm-content .lildog-ann");
	const read = () => {
		const el = pick();
		const cs = el ? getComputedStyle(el) : null;
		return { color: cs?.color, background: cs?.backgroundColor };
	};
	const injected = document.getElementById("lildog-annotate-runtime-style");
	const injectedText = injected?.textContent ?? "";
	const others = Array.from(document.querySelectorAll("style")).filter(
		(el) => el !== injected && (el.textContent ?? "").includes(".lildog-ann"),
	);
	others.forEach((el) => el.remove());
	const withInjected = read();
	injected?.remove();
	const withoutAnything = read();
	const restored = document.createElement("style");
	restored.id = "lildog-annotate-runtime-style";
	restored.textContent = injectedText;
	document.head.appendChild(restored);
	const afterRestore = read();
	return {
		hasInjected: !!injected && injectedText.includes(".lildog-ann"),
		removedOthers: others.length,
		withInjected,
		withoutAnything,
		afterRestore
	};
})()`);
check(
	"插件自己注入了一份样式（不再完全依赖 Obsidian 加载 styles.css）",
	styleFallback.hasInjected,
	`顺手摘掉了 ${styleFallback.removedOthers} 份其它样式`,
);
check(
	"只剩插件注入的样式时，高亮照样有色",
	styleFallback.withInjected.color === "rgb(217, 130, 43)" &&
		styleFallback.withInjected.background === "rgba(126, 122, 245, 0.32)",
	`color=${styleFallback.withInjected.color} bg=${styleFallback.withInjected.background}`,
);
check(
	"样式全摘掉时高亮确实会失色（说明上一条不是假阳性）",
	styleFallback.withoutAnything.color !== "rgb(217, 130, 43)",
	`color=${styleFallback.withoutAnything.color}`,
);
check(
	"样式恢复后高亮又回来了",
	styleFallback.afterRestore.color === "rgb(217, 130, 43)",
	styleFallback.afterRestore.color,
);

// ---------------------------------------------------------------- 1c. 标记什么时候露出来

console.log("\n【1c】原始标记的露出规则");
const revealRule = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const doc = editor.getValue();
	const start = doc.indexOf("<!--lildog:");
	const openEnd = doc.indexOf("-->", start) + 3;
	const closeStart = doc.indexOf("<!--/lildog-->", openEnd);
	const leaked = () =>
		Array.from(view.containerEl.querySelectorAll(".cm-line"))
			.filter((el) => (el.textContent ?? "").includes("lildog")).length;

	// 1）选区只碰到批注起点（旧版会误判成「要露出」）
	editor.setSelection(editor.offsetToPos(start - 4), editor.offsetToPos(start));
	await sleep(400);
	const touching = leaked();

	// 2）真的选中被批注的原文 → 应该露出来，方便直接改标记
	editor.setSelection(editor.offsetToPos(openEnd), editor.offsetToPos(closeStart));
	await sleep(400);
	const selectingText = leaked();

	// 3）光标挪走 → 立刻收回去
	editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
	await sleep(400);
	const away = leaked();

	return { touching, selectingText, away };
})()`);
check(
	"选区只是碰到批注边界时，不再把 <!--lildog: …--> 露出来",
	revealRule.touching === 0,
	`露出 ${revealRule.touching} 行`,
);
check(
	"真的选中被批注的原文时，标记会露出来（方便直接改）",
	revealRule.selectingText > 0,
	`露出 ${revealRule.selectingText} 行`,
);
check("光标挪开后标记立刻收回去", revealRule.away === 0, `露出 ${revealRule.away} 行`);

// 复现用户现场：重载 Obsidian 会把上次的光标恢复回来，它可能正好落在
// 藏起来的标记内部 —— 旧版这时会把整条批注的标记亮出来，而且怎么点都不消停
const stuckCursor = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const doc = editor.getValue();
	const start = doc.indexOf("<!--lildog:");
	const openEnd = doc.indexOf("-->", start) + 3;
	editor.setSelection(editor.offsetToPos(start + 3), editor.offsetToPos(start + 3));
	await sleep(600);
	const after = editor.posToOffset(editor.getCursor());
	return {
		hidden: [start, openEnd],
		cursor: after,
		inside: after > start && after < openEnd,
		leaked: Array.from(view.containerEl.querySelectorAll(".cm-line")).filter((el) =>
			(el.textContent ?? "").includes("lildog")
		).length
	};
})()`);
check(
	"光标被塞进藏起来的标记里时，会被自动挪出来",
	!stuckCursor.inside,
	`光标 ${stuckCursor.cursor}，标记区间 ${JSON.stringify(stuckCursor.hidden)}`,
);
check(
	"这种情况下标记也不会露出来（正文里不会出现 <!--lildog: …-->）",
	stuckCursor.leaked === 0,
	`露出 ${stuckCursor.leaked} 行`,
);

// 点在「被藏起来的标记」那一小段空白上：光标不能进到标记内部，
// 否则插件会以为用户要改标记，把整条批注的原始标记亮出来
console.log("\n【1d】点在藏起来的标记上");
const markerSpot = await evaluate(`(() => {
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
	const el = document.querySelector(".cm-content .lildog-ann");
	if (!el) return null;
	const rect = Array.from(el.getClientRects())[0] ?? el.getBoundingClientRect();
	const doc = editor.getValue();
	const from = doc.indexOf("<!--lildog:");
	const openEnd = doc.indexOf("-->", from) + 3;
	const closeStart = doc.indexOf("<!--/lildog-->", openEnd);
	return {
		x: Math.round(rect.left - 1),
		y: Math.round(rect.top + rect.height / 2),
		hidden: [
			[from, openEnd],
			[closeStart, closeStart + "<!--/lildog-->".length]
		],
		textFrom: openEnd
	};
})()`);
if (markerSpot) {
	await cdp.click(markerSpot.x, markerSpot.y);
	await sleep(600);
	const afterClick = await evaluate(`(() => {
		const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
		const editor = view.editor;
		return {
			cursor: editor.posToOffset(editor.getCursor()),
			leaked: Array.from(view.containerEl.querySelectorAll(".cm-line")).filter((el) =>
				(el.textContent ?? "").includes("lildog")
			).length
		};
	})()`);
	const insideMarker = markerSpot.hidden.some(
		([start, end]) => afterClick.cursor > start && afterClick.cursor < end,
	);
	check(
		"点在藏起来的标记上时，光标不会掉进标记里面（标记也就不会弹开）",
		!insideMarker,
		`光标在 ${afterClick.cursor}，标记区间 ${JSON.stringify(markerSpot.hidden)}`,
	);
	check("点完标记仍然藏着", afterClick.leaked === 0, `露出 ${afterClick.leaked} 行`);
}

// ---------------------------------------------------------------- 1e. 高亮连成一条

console.log("\n【1e】高亮要连成一条（行内代码 / 公式不能各画各的底）");
const band = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	// 夹着公式/行内代码的那几条在笔记靠后的位置，先滚过去（实时预览是懒渲染的）
	const lines = editor.getValue().split(String.fromCharCode(10));
	const line = lines.findIndex((item) => item.includes("$" + String.fromCharCode(92) + "omega_c$"));
	if (line >= 0) {
		editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: line + 1, ch: 0 } }, false);
		await sleep(700);
	}
	const all = Array.from(view.containerEl.querySelectorAll(".cm-content .lildog-ann"));
	const withKids = all.filter((el) => el.querySelector("*"));
	const ann = withKids[0];
	if (!ann) return { ok: false, candidates: all.length, line };
	const annBg = getComputedStyle(ann).backgroundColor;
	const children = Array.from(ann.querySelectorAll("*"));
	const different = children
		.map((el) => ({
			tag: el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0],
			bg: getComputedStyle(el).backgroundColor
		}))
		.filter(
			(item) =>
				item.bg &&
				item.bg !== "rgba(0, 0, 0, 0)" &&
				item.bg !== "transparent" &&
				item.bg !== annBg
		);
	return {
		ok: true,
		annBg,
		text: (ann.textContent ?? "").slice(0, 30),
		childCount: children.length,
		candidates: withKids.length,
		different
	};
})()`);
check(
	"批注里的行内代码 / 公式不会画出另一种底色（紫带连成一条）",
	band.ok && band.different.length === 0,
	band.ok
		? `「${band.text}」里 ${band.childCount} 个子元素（共 ${band.candidates} 条夹着东西的批注），底色不同的 ${band.different.length} 个${band.different.length ? `：${JSON.stringify(band.different)}` : ""}`
		: "样例笔记里没有夹着公式/行内代码的批注，这条检查没意义",
);
await shoot("04-公式与代码夹在批注里");

// 批注以公式开头时，公式是 CM6 盖不到的 widget（还是高亮的兄弟节点），
// 得靠插件后处理补类，否则紫带中间缺一块 —— 用户报的「断断续续」
const widgetBand = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const lines = editor.getValue().split(String.fromCharCode(10));
	const line = lines.findIndex((item) => item.includes("omega_c"));
	if (line >= 0) {
		editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: line + 1, ch: 0 } }, false);
		await sleep(800);
	}
	const widgets = Array.from(
		view.containerEl.querySelectorAll(".cm-content .math, .cm-content .cm-inline-math"),
	);
	const rows = widgets.map((el) => ({
		cls: String(el.className),
		bg: getComputedStyle(el).backgroundColor,
		text: (el.textContent ?? "").slice(0, 8)
	}));
	const painted = rows.filter((row) => row.cls.includes("lildog-ann-widget"));
	return {
		total: rows.length,
		painted: painted.length,
		rows,
		bandBg: painted[0]?.bg ?? null,
		wrongBg: painted.filter((row) => row.bg !== painted[0]?.bg).length
	};
})()`);
check(
	"批注里的公式 widget 也被补上同一层底色（紫带不断）",
	widgetBand.painted > 0 && widgetBand.wrongBg === 0,
	widgetBand.painted > 0
		? `命中 ${widgetBand.painted}/${widgetBand.total} 个公式/部件，底色 ${widgetBand.bandBg}，不一致的 ${widgetBand.wrongBg} 个`
		: `这一屏没渲染出公式 widget（共 ${widgetBand.total} 个），滚到第 7 节再看`,
);

// ---------------------------------------------------------------- 2. 悬停浮窗

console.log("\n【2】悬停浮窗（直接改批注 + 回车即收）");
// 上面的检查滚动过编辑器，坐标要重新量（用当时那一刻的高亮位置）
const cardSpot = (await highlightSpot(".cm-content .lildog-ann")) ?? marker;
await cdp.hover(cardSpot.x, cardSpot.y);
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

// 每一条高亮都要能悬停出浮窗 —— 文字折行时一个高亮横跨两行，
// 只按包围盒中心去悬停会落在两行之间的空隙上，这条就是防这个的
console.log("\n【2b】逐条悬停都要能弹出浮窗");
await evaluate(`(() => {
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
	return true;
})()`);
const highlightCount = await evaluate(
	`(() => document.querySelectorAll(".cm-content .lildog-ann").length)()`,
);
const hoverFailures = [];
for (let i = 0; i < highlightCount; i++) {
	// 每轮现取坐标：文档在这一段里被改过，而且实时预览是懒渲染的，
	// 滚动之后 DOM 要过一会儿才稳；没弹出来就重试一次
	let ok = false;
	let lastText = "";
	let segments = 1;
	for (let attempt = 0; attempt < 2 && !ok; attempt++) {
		await evaluate(`(() => {
			const el = document.querySelectorAll(".cm-content .lildog-ann")[${i}];
			el?.scrollIntoView({ block: "center" });
			return true;
		})()`);
		await sleep(attempt === 0 ? 350 : 600);
		const spot = await evaluate(`(() => {
			const el = document.querySelectorAll(".cm-content .lildog-ann")[${i}];
			if (!el) return null;
			const rect = Array.from(el.getClientRects())[0] ?? el.getBoundingClientRect();
			return {
				text: el.textContent,
				segments: el.getClientRects().length,
				x: Math.round(rect.left + Math.min(rect.width / 2, 20)),
				y: Math.round(rect.top + rect.height / 2)
			};
		})()`);
		if (!spot) break;
		lastText = spot.text;
		segments = spot.segments;
		await cdp.mouse("mouseMoved", 5, 5);
		await sleep(150);
		await cdp.hover(spot.x, spot.y);
		await sleep(500);
		const cardText = await evaluate(`(() => {
			const el = document.querySelector(".lildog-card");
			if (!el || el.style.display === "none") return "";
			return el.querySelector(".lildog-card-body")?.textContent ?? "";
		})()`);
		ok = cardText.trim().length > 0;
	}
	if (!ok) hoverFailures.push(`${lastText}${segments > 1 ? "(折行)" : ""}`);
}
check(
	"每一条高亮都能悬停弹出浮窗（含折行的）",
	highlightCount > 0 && hoverFailures.length === 0,
	`共 ${highlightCount} 条${hoverFailures.length ? `，没弹出来的：${hoverFailures.join("、")}` : ""}`,
);

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
	const root = view.containerEl.querySelector(".markdown-reading-view");
	if (!root) return { error: "没有阅读视图" };
	// 阅读视图是懒渲染的：一点点往下滚，直到那几段真的出现在 DOM 里
	const preview = view.containerEl.querySelector(".markdown-preview-view");
	const hasText = () => (root.textContent ?? "").includes("梯度消失");
	if (preview) {
		preview.scrollTop = 0;
		for (let i = 0; i < 60 && !hasText(); i++) {
			preview.scrollTop += 260;
			await sleep(120);
		}
	}
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
	await sleep(400);
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

		// 阅读视图里批注完，这一段必须当场补上高亮（不重画的话就是「批注了却看不见」）
		const refreshed = await evaluate(`(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
			if (view.getMode() !== "preview") return { skipped: true };
			view.previewMode.applyScroll?.(0);
			const preview = view.containerEl.querySelector(".markdown-preview-view");
			if (preview) preview.scrollTop = 0;
			await sleep(900);
			const marks = Array.from(view.containerEl.querySelectorAll(".markdown-reading-view .lildog-ann"));
			return {
				skipped: false,
				total: marks.length,
				hit: marks.some((el) => (el.dataset.lildogFrom ?? "").length > 0 && (el.textContent ?? "").includes("梯度消失"))
			};
		})()`);
		check(
			"阅读视图里批注完当场就有高亮（不用切模式或重开笔记）",
			refreshed.skipped || refreshed.hit,
			refreshed.skipped ? "当前不在阅读视图" : `高亮 ${refreshed.total} 个`,
		);
	}
}

// ---------------------------------------------------------------- 6. 删除批注
// 用户反馈：改批注时把内容删光，点保存没法保存，也找不到删除的地方。
// 现在：清空内容后主按钮变「删除批注」，弹窗和浮窗里也各有一个删除按钮。

console.log("\n【6】删除批注");
const TEMP_LINE = "\n临时删除测试：<!--lildog: 待删除-->这段文字会被删掉<!--/lildog-->\n";
await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	const view = app.workspace.getLeavesOfType("markdown")[0].view;
	if (view.getMode() !== "source") {
		app.commands.executeCommandById("markdown:toggle-preview");
		await sleep(1400);
	}
	const text = await app.vault.read(file);
	await app.vault.modify(file, text + ${JSON.stringify(TEMP_LINE)});
	await sleep(700);
	view.editor.setValue(await app.vault.read(file));
	await sleep(500);
	// 光标放进这条临时批注里，然后用「编辑光标处的批注」命令打开弹窗
	const doc = view.editor.getValue();
	const at = doc.indexOf("这段文字会被删掉");
	view.editor.setSelection(view.editor.offsetToPos(at), view.editor.offsetToPos(at + 3));
	await sleep(300);
	app.commands.executeCommandById("lildog-annotate:edit-annotation");
	await sleep(700);
	return true;
})()`);

const editModal = await evaluate(`(() => {
	const modal = document.querySelector(".lildog-modal");
	if (!modal) return { open: false };
	const buttons = Array.from(modal.querySelectorAll(".lildog-modal-buttons button"));
	const submit = modal.querySelector(".lildog-modal-submit");
	return {
		open: true,
		hasDelete: buttons.some((b) => (b.textContent ?? "").includes("删除这条批注")),
		primary: submit?.textContent ?? "",
		buttons: buttons.map((b) => b.textContent ?? "")
	};
})()`);
check("编辑批注的弹窗打开了", editModal.open, editModal.buttons?.join(" / "));
check("弹窗里有明确的「删除这条批注」按钮", editModal.hasDelete);
check("内容没删光时主按钮还是「保存」", editModal.primary === "保存", editModal.primary);

// 把内容删光：主按钮应该变成「删除批注」，不再卡在「内容不能为空」
await evaluate(`(() => {
	const ta = document.querySelector(".lildog-modal textarea.lildog-textarea");
	ta.value = "";
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
await sleep(300);
const emptied = await evaluate(`(() => {
	const modal = document.querySelector(".lildog-modal");
	const submit = modal.querySelector(".lildog-modal-submit");
	const r = submit.getBoundingClientRect();
	return {
		label: submit.textContent ?? "",
		warning: submit.classList.contains("mod-warning"),
		x: r.left + r.width / 2,
		y: r.top + r.height / 2
	};
})()`);
check(
	"把内容删光后，主按钮自己变成「删除批注」",
	emptied.label === "删除批注" && emptied.warning,
	emptied.label,
);

await cdp.click(emptied.x, emptied.y);
await sleep(900);
const deleted = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	let text = "";
	// 编辑器里改完到落盘有一小段延迟，轮询等一下
	for (let i = 0; i < 16; i++) {
		text = await app.vault.read(file);
		if (!text.includes("待删除")) break;
		await sleep(250);
	}
	const view = app.workspace.getLeavesOfType("markdown")[0].view;
	return {
		onDisk: !text.includes("待删除"),
		keptText: text.includes("这段文字会被删掉"),
		modalGone: !document.querySelector(".lildog-modal"),
		inEditor: !view.editor.getValue().includes("待删除")
	};
})()`);
check(
	"点「删除批注」后批注从笔记里消失了",
	deleted.onDisk && deleted.inEditor && deleted.modalGone,
	`文件里没了=${deleted.onDisk}、编辑器里没了=${deleted.inEditor}、弹窗关闭=${deleted.modalGone}`,
);
check("被批注的原文留下来了（只删批注，不删原文）", deleted.keptText);

// 浮窗里的删除入口：再放一条临时批注，用悬停浮窗删掉
console.log("\n【6b】浮窗里也能删");
await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	const view = app.workspace.getLeavesOfType("markdown")[0].view;
	const text = await app.vault.read(file);
	await app.vault.modify(file, text + ${JSON.stringify(
		"\n浮窗删除测试：<!--lildog: 浮窗里删掉-->这段用浮窗删<!--/lildog-->\n",
	)});
	await sleep(700);
	view.editor.setValue(await app.vault.read(file));
	await sleep(600);
	const el = Array.from(view.containerEl.querySelectorAll(".cm-content .lildog-ann")).find((item) =>
		(item.textContent ?? "").includes("这段用浮窗删")
	);
	el?.scrollIntoView({ block: "center" });
	await sleep(400);
	const rect = Array.from(el.getClientRects())[0];
	return JSON.stringify({ x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 });
})()`);
const floatSpot = JSON.parse(
	await evaluate(`(() => {
		const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
		const el = Array.from(view.containerEl.querySelectorAll(".cm-content .lildog-ann")).find((item) =>
			(item.textContent ?? "").includes("这段用浮窗删")
		);
		if (!el) return JSON.stringify(null);
		const rect = Array.from(el.getClientRects())[0];
		return JSON.stringify({ x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 });
	})()`),
);
if (floatSpot) {
	await cdp.hover(floatSpot.x, floatSpot.y);
	await sleep(600);
	const editBtn = await evaluate(`(() => {
		const el = document.querySelector(".lildog-card-btn");
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (editBtn) {
		await cdp.click(editBtn.x, editBtn.y);
		await sleep(400);
		const cardDelete = await evaluate(`(() => {
			const el = document.querySelector(".lildog-card-delete");
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: el.textContent ?? "" };
		})()`);
		check("浮窗的编辑态里有删除按钮", !!cardDelete, cardDelete?.label);
		if (cardDelete) {
			await cdp.click(cardDelete.x, cardDelete.y);
			await sleep(900);
			const gone = await evaluate(`(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const app = window.app;
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
				let text = "";
				for (let i = 0; i < 16; i++) {
					text = await app.vault.read(file);
					if (!text.includes("浮窗里删掉")) break;
					await sleep(250);
				}
				const view = app.workspace.getLeavesOfType("markdown")[0].view;
				return {
					onDisk: !text.includes("浮窗里删掉"),
					inEditor: !view.editor.getValue().includes("浮窗里删掉"),
					kept: text.includes("这段用浮窗删")
				};
			})()`);
			check(
				"浮窗里点删除也能删掉这条批注",
				gone.onDisk && gone.inEditor,
				`文件里没了=${gone.onDisk}、编辑器里没了=${gone.inEditor}`,
			);
			check("浮窗删除同样只删批注、留下原文", gone.kept);
		}
	} else {
		check("浮窗里能进入编辑态", false, "没找到「编辑批注」按钮");
	}
} else {
	check("临时批注的高亮找得到", false);
}

// ---------------------------------------------------------------- 7. 取消弹窗不跳走

console.log("\n【7】关掉批注弹窗后不跳回顶部");
const scrollBefore = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	editor.scrollIntoView({ from: { line: 30, ch: 0 }, to: { line: 36, ch: 0 } }, false);
	await sleep(500);
	// 选中第 32 行的一小段 —— 注意 setSelection 会把视图滚到光标那里，
	// 所以「弹窗前的滚动位置」要在选完之后再取
	const line = Math.min(32, editor.lineCount() - 1);
	editor.setSelection({ line, ch: 0 }, { line, ch: 4 });
	await sleep(400);
	const before = editor.getScrollInfo().top;
	window.app.commands.executeCommandById("lildog-annotate:add-annotation");
	await sleep(700);
	return {
		before,
		modalUp: !!document.querySelector(".lildog-modal textarea.lildog-textarea")
	};
})()`);
check("滚动到中段后能打开批注弹窗", scrollBefore.modalUp, `弹窗前的滚动位置 ${Math.round(scrollBefore.before)}`);

await cdp.key("Escape", { keyCode: 27 });
await sleep(900);
const scrollAfter = await evaluate(`(() => {
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	return {
		modalGone: !document.querySelector(".lildog-modal"),
		after: view.editor.getScrollInfo().top
	};
})()`);
check("按 Esc 关掉弹窗", scrollAfter.modalGone);
check(
	"关掉弹窗后滚动位置基本没变（不会跳回笔记开头）",
	Math.abs(scrollAfter.after - scrollBefore.before) < 30,
	`关窗前 ${Math.round(scrollBefore.before)} → 关窗后 ${Math.round(scrollAfter.after)}`,
);

// ---------------------------------------------------------------- 还原

await evaluate(`(async () => {
	const app = window.app;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
	await app.vault.modify(file, ${JSON.stringify(original)});
	// 编辑器的缓冲区也要跟着回去：否则文件是干净的、内存里还是改过的内容，
	// 下一轮检查会拿到一份「文件和视图不一致」的笔记
	const view = app.workspace.getLeavesOfType("markdown")[0]?.view;
	if (view?.editor && view.editor.getValue() !== ${JSON.stringify(original)}) {
		view.editor.setValue(${JSON.stringify(original)});
		await sleep(400);
	}
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
