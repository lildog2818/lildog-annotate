/**
 * 表格批注的界面级检查：连到隔离测试实例，用**真实鼠标**在表格里拖选、批注，
 * 然后核对三件事 —— 这正是一路出问题的那三件事：
 *
 *   1. **写进去了没有**：单元格里选一段 → 批注落在那格里（老版本会「批注不起」）
 *   2. **写在哪儿**：重复值（`同一个词`/`✅`）时批注和高亮都只在选中的那一格
 *      （老版本会「跳到别的位置」）
 *   3. **表格结构没被改坏**：每一行的管道数与表头一致、行列数不变；
 *      跨单元格选区降级成**整张表之后**的段落批注，不把表格劈开
 *
 * 另外附一个「探针」：把「整行被批注标记包起来」的样子交给 Obsidian 自己渲染，
 * 看它到底把表断掉还是错列 —— 这是我们自己实现里唯一还靠规格推断的地方。
 *
 * 跑法：npm run test:vault 起实例，再 npm run test:tables:ui。
 * 检查会改测试库里的表格笔记，跑完自动还原。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createChecker, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const NOTE = "表格批注测试.md";
const PROBE = "表格结构探针.md";
const notePath = join(here, "vault", NOTE);

/** 规范的笔记内容：跑之前铺一遍，跑完再铺回来 */
const PRISTINE = readFileSync(notePath, "utf8");

const { check, report } = createChecker();
const cdp = await connect();
const { evaluate } = cdp;

// ---------------------------------------------------------------- 小工具

/** 把笔记内容写回（用 Obsidian 自己的 api，缓存也一起更新） */
async function writeNote(path, text) {
	return evaluate(`(async () => {
		const app = window.app;
		const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
		if (existing) await app.vault.modify(existing, ${JSON.stringify(text)});
		else await app.vault.create(${JSON.stringify(path)}, ${JSON.stringify(text)});
		return true;
	})()`);
}

async function readNote(path) {
	return evaluate(`(async () => {
		const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(path)});
		return file ? await window.app.vault.read(file) : null;
	})()`);
}

/**
 * 编辑器**内存里**的正文。
 * 插件是改编辑器缓冲区，落盘由 Obsidian 稍后异步做（几百毫秒到两秒不等），
 * 所以断言写没写进去要看内存；磁盘只用来做收尾核对。
 */
async function readEditorText() {
	return evaluate(
		`(() => window.app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue())()`,
	);
}

/** 把上一轮的提示清掉，免得旧提示干扰判断 */
async function clearNotices() {
	await evaluate(
		`(() => { document.querySelectorAll(".notice").forEach((n) => n.remove()); return true; })()`,
	);
}

/** 当前屏幕上的提示 */
async function readNotices() {
	return evaluate(
		`(() => Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""))()`,
	);
}

/** 把正文里所有 lildog 标记打出来（这一轮写了什么、写在哪，一眼能看到） */
async function dumpMarks(label) {
	const text = await readEditorText();
	const lines = text
		.split("\n")
		.filter((line) => line.includes("lildog"))
		.map((line) => `      ${line}`);
	console.log(`  · ${label} 文件里的标记：\n${lines.join("\n") || "      （一条都没有）"}`);
}

/** 拖选之后浏览器里的选区状态（跨格拖选为什么没触发，看这里） */
async function selectionState() {
	return evaluate(`(() => {
		const sel = window.getSelection();
		const btn = document.querySelector(".lildog-float-btn");
		if (!sel || sel.rangeCount === 0) return { text: null, button: btn ? btn.style.display : "无" };
		const range = sel.getRangeAt(0);
		return {
			text: sel.toString().slice(0, 60),
			collapsed: sel.isCollapsed,
			startCell: !!range.startContainer.parentElement?.closest("td, th"),
			endCell: !!range.endContainer.parentElement?.closest("td, th"),
			rect: (() => { const r = range.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
			button: btn ? btn.style.display : "无"
		};
	})()`);
}

/** main.js 变了 Obsidian 不会自己重载插件，跑之前先重载一次 */
async function reloadPlugin() {
	return evaluate(`(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		for (let i = 0; i < 80 && !window.app?.workspace?.layoutReady; i++) await sleep(250);
		await window.app.plugins.disablePlugin("lildog-annotate");
		await sleep(700);
		await window.app.plugins.enablePlugin("lildog-annotate");
		await sleep(700);
		return true;
	})()`);
}

/** 打开笔记，停在实时预览（源码模式） */
async function openNote(path) {
	return evaluate(`(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const app = window.app;
		for (let i = 0; i < 80 && !app?.workspace?.layoutReady; i++) await sleep(250);
		for (const leaf of app.workspace.getLeavesOfType("markdown")) {
			if (leaf !== app.workspace.activeLeaf) leaf.detach();
		}
		const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
		const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(true);
		await leaf.openFile(file);
		await sleep(900);
		const view = leaf.view;
		if (view.getMode() !== "source") {
			app.commands.executeCommandById("markdown:toggle-preview");
			await sleep(1200);
		}
		return view.getMode();
	})()`);
}

/** 把表格滚到视口里，等它渲染出来 */
async function scrollToTable(index = 0) {
	return evaluate(`(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
		const editor = view.editor;
		editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
		await sleep(300);
		const tables = () => document.querySelectorAll(".cm-editor table");
		for (let i = 0; i < 40 && tables().length <= ${index}; i++) {
			view.containerEl.querySelector(".cm-scroller").scrollTop += 220;
			await sleep(120);
		}
		const table = tables()[${index}];
		if (!table) return null;
		table.scrollIntoView({ block: "center" });
		await sleep(400);
		return tables().length;
	})()`);
}

/**
 * 在某个单元格里找一段文字，返回它的坐标和它在表里的位置。
 * nth 用来区分「第几个含这段文字的格子」，重复值的用例靠它。
 */
async function textSpot(needle, nth = 0) {
	return evaluate(`(() => {
		const cells = Array.from(document.querySelectorAll(".cm-editor td, .cm-editor th"));
		const hits = cells.filter((cell) => (cell.textContent ?? "").includes(${JSON.stringify(needle)}));
		const cell = hits[${nth}];
		if (!cell) return { error: "没找到含「" + ${JSON.stringify(needle)} + "」的格子，共 " + hits.length + " 个" };
		cell.scrollIntoView({ block: "center" });
		const table = cell.closest("table");
		const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			const text = node.textContent ?? "";
			const index = text.indexOf(${JSON.stringify(needle)});
			if (index === -1) continue;
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + ${JSON.stringify(needle)}.length);
			const r = range.getBoundingClientRect();
			if (r.width <= 0) continue;
			return {
				left: r.left,
				right: r.right,
				top: r.top,
				height: r.height,
				tableIndex: Array.from(document.querySelectorAll(".cm-editor table")).indexOf(table),
				rowIndex: Array.from(table.rows).indexOf(cell.closest("tr")),
				cellIndex: Array.from(cell.closest("tr").cells).indexOf(cell),
				cellText: cell.textContent
			};
		}
		return { error: "格子「" + (cell.textContent ?? "") + "」里没找到文字节点" };
	})()`);
}

/** 真实鼠标拖选：从一个 x 拖到另一个 x */
async function dragSelect(left, right, y) {
	await cdp.mouse("mouseMoved", left - 8, y);
	await sleep(80);
	await cdp.mouse("mousePressed", left + 1, y);
	await sleep(80);
	await cdp.mouse("mouseMoved", left + 4, y, { button: "left", buttons: 1 });
	await sleep(80);
	await cdp.mouse("mouseMoved", (left + right) / 2, y, { button: "left", buttons: 1 });
	await sleep(80);
	await cdp.mouse("mouseMoved", right - 1, y, { button: "left", buttons: 1 });
	await sleep(60);
	await cdp.mouse("mouseReleased", right - 1, y);
	await sleep(700);
}

/** 弹窗里输入 + Ctrl+Enter 保存 */
async function submitModal(body) {
	const opened = await evaluate(
		`(() => !!document.querySelector(".lildog-modal textarea.lildog-textarea"))()`,
	);
	if (!opened) return { opened: false, notices: await readNotices() };
	await cdp.type(body);
	await sleep(200);
	await cdp.key("Enter", { keyCode: 13, modifiers: 2 });
	await sleep(900);
	return { opened: true, notices: await readNotices() };
}

/** 点浮出的「批注」按钮 → 输入 → Ctrl+Enter 保存 */
async function annotateViaButton(body) {
	const floated = await evaluate(`(() => {
		const el = document.querySelector(".lildog-float-btn");
		if (!el || el.style.display === "none") return { shown: false };
		const r = el.getBoundingClientRect();
		return { shown: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (!floated.shown) return { shown: false, opened: false, notices: await readNotices() };

	await cdp.click(floated.x, floated.y);
	await sleep(500);
	const result = await submitModal(body);
	return { shown: true, ...result };
}

/** 把光标挪开，让表格重新渲染（不然格子还停在编辑态，看不到高亮） */
async function parkCursor() {
	await evaluate(`(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
		window.getSelection()?.removeAllRanges();
		view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
		await sleep(700);
		return true;
	})()`);
	await sleep(400);
}

/** 表格数据行的判定（跟插件里的规则一致：`>`、`#`、`<!--` 这类块级开头会打断表格） */
function isRow(line) {
	const trimmed = line.trim();
	if (!trimmed) return false;
	if (/^(>|#{1,6}\s|```|~~~|<!--|<[A-Za-z/!])/.test(trimmed)) return false;
	return trimmed.includes("|");
}

/** 一行里未转义的管道数 */
function pipesOf(line) {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "|") continue;
		let back = 0;
		for (let k = i - 1; k >= 0 && line[k] === "\\"; k--) back++;
		if (back % 2 === 0) count++;
	}
	return count;
}

/** 找出某张表在文件里的行范围（表头 + 分隔行 + 数据行） */
function tableBlock(text, headerNeedle) {
	const lines = text.split("\n");
	const header = lines.findIndex((line) => line.includes(headerNeedle) && line.includes("|"));
	if (header < 0) return null;
	if (!/^\s*\|?\s*:?-+:?\s*(\|.*)?$/.test(lines[header + 1] ?? "")) return null;
	let end = header + 1;
	while (end + 1 < lines.length && isRow(lines[end + 1])) end++;
	return { header, delimiter: header + 1, end, lines: lines.slice(header, end + 1) };
}

/** 这张表每一行的管道数（结构没被改坏 = 全都相等） */
function tablePipes(text, headerNeedle) {
	const table = tableBlock(text, headerNeedle);
	return (table?.lines ?? []).map(pipesOf);
}

// ---------------------------------------------------------------- 准备

console.log("\n【0】准备：铺一份干净的表格笔记");

const diskLookedClean = existsSync(notePath);
await writeNote(NOTE, PRISTINE);
await reloadPlugin();
const mode = await openNote(NOTE);
check("打开测试笔记（实时预览）", mode === "source", String(mode));

const tableCount = await scrollToTable(0);
check("笔记里渲染出表格", typeof tableCount === "number" && tableCount >= 2, `${tableCount} 张`);
check(
	"（自检）磁盘上的表格笔记与脚本里的规范内容一致",
	diskLookedClean && readFileSync(notePath, "utf8") === PRISTINE,
	"不一致说明上次跑完没还原干净，本次已覆盖",
);

// ---------------------------------------------------------------- 1. 单元格内批注

console.log("\n【1】单元格里拖选：批注要落在那格里");

await clearNotices();
const boldSpot = await textSpot("粗体");
check(
	"找到「用**粗体**写的说明」那一格",
	!boldSpot.error,
	boldSpot.error ?? `第 ${boldSpot.rowIndex} 行第 ${boldSpot.cellIndex} 格：${boldSpot.cellText}`,
);

let cellBody = "第一次检查：粗体格子";
if (!boldSpot.error) {
	const y = boldSpot.top + boldSpot.height / 2;
	await dragSelect(boldSpot.left, boldSpot.right, y);
	const result = await annotateViaButton(cellBody);
	check("拖选单元格文字后浮出「批注」按钮", result.shown);
	check("点按钮后弹出输入框", result.opened);

	const text = await readEditorText();
	// 格子被点开时里面显示的是源码（`**粗体**`），渲染态是 `粗体`：两种都算对
	const wrapped =
		text.includes(`<!--lildog: ${cellBody}-->粗体<!--/lildog-->`) ||
		text.includes(`<!--lildog: ${cellBody}-->**粗体**<!--/lildog-->`);
	check("批注写进了笔记", wrapped);
	await dumpMarks("【1】");

	const table = tableBlock(text, "名称");
	const pipes = tablePipes(text, "名称");
	check(
		"表格每一行的管道数与表头一致（没有多出/少掉单元格）",
		pipes.length > 0 && pipes.every((count) => count === pipes[0]),
		`每行管道数 ${pipes.join("/")}`,
	);
	check(
		"标记确实落在那一格里面（同一行里有「用」和「写的说明」）",
		(table?.lines ?? []).some(
			(line) => line.includes("lildog") && line.includes("用") && line.includes("写的说明"),
		),
	);
}

// ---------------------------------------------------------------- 1b. 点开表格外之后高亮还在不在

console.log("\n【1b】进格子看一眼、再点表格外面：已经批注过的格子还得有高亮");

const outsideSpot = await evaluate(`(() => {
	const line = Array.from(document.querySelectorAll(".cm-editor .cm-line")).find((el) =>
		(el.textContent ?? "").includes("表格后面的一段话")
	);
	if (!line) return { error: "没找到表格后面那段话" };
	line.scrollIntoView({ block: "center" });
	const r = line.getBoundingClientRect();
	return { x: r.left + 30, y: r.top + r.height / 2, text: line.textContent };
})()`);
check("找到表格外面的一段话", !outsideSpot.error, outsideSpot.error ?? outsideSpot.text);

// 先真的点进那一格（Obsidian 会开嵌套编辑器、把渲染态藏起来），再点出去 ——
// 这正是用户报的场景：离开格子之后，缓存的旧渲染被顶上来，高亮就没了
const viewedCell = await textSpot("粗体");
if (!outsideSpot.error && !viewedCell.error) {
	await cdp.click(viewedCell.left + 2, viewedCell.top + viewedCell.height / 2);
	await sleep(600);
	const editing = await evaluate(
		`(() => !!document.querySelector(".cm-editor .cm-editor"))()`,
	);
	console.log("  · 点进格子之后有嵌套编辑器：", editing);

	// 再点**另一个**格子：上一個格子这才退出编辑态、把渲染态显示回来
	const otherSpot = await textSpot("就绪");
	if (!otherSpot.error) {
		await cdp.click(otherSpot.left + 2, otherSpot.top + otherSpot.height / 2);
		await sleep(600);
	}
	// 最后点表格外面
	await cdp.click(outsideSpot.x, outsideSpot.y);
	await sleep(1000);

	const marks = await evaluate(`(() => {
		const table = document.querySelector(".cm-editor table");
		if (!table) return { error: "表格不在界面上" };
		return {
			marks: Array.from(table.querySelectorAll(".lildog-ann"))
				.filter((el) => el.getClientRects().length > 0 && !el.closest(".cm-editor .cm-editor"))
				.map((el) => el.textContent),
			rendered: Array.from(table.rows).map((row) => (row.textContent ?? "").trim()),
			cellStructure: Array.from(table.rows[1]?.cells ?? []).map((td) =>
				Array.from(td.children).map((child) => ({
					tag: child.tagName,
					cls: String(child.className),
					visible: child.getClientRects().length > 0
				}))
			)
		};
	})()`);
	check(
		"点开表格外面之后，被批注的格子里仍然有高亮",
		(marks.marks ?? []).includes("粗体"),
		JSON.stringify(marks),
	);
}

// ---------------------------------------------------------------- 2. 重复值

console.log("\n【2】重复值：批注和高亮都只能落在选中的那一格");

await parkCursor();
const dupSpot = await textSpot("同一个词", 1);
check(
	"找到第二张表里第二行的「同一个词」",
	!dupSpot.error,
	dupSpot.error ?? `第 ${dupSpot.rowIndex} 行第 ${dupSpot.cellIndex} 格`,
);

await clearNotices();
const dupBody = "第二次检查：重复值";
if (!dupSpot.error) {
	const y = dupSpot.top + dupSpot.height / 2;
	await dragSelect(dupSpot.left, dupSpot.right, y);
	const result = await annotateViaButton(dupBody);
	check("重复值也能批注上", result.shown && result.opened);

	const text = await readEditorText();
	const marker = `<!--lildog: ${dupBody}-->同一个词<!--/lildog-->`;
	const at = text.indexOf(marker);
	check("批注写进了笔记", at !== -1);
	const line = at === -1 ? "" : text.slice(0, at).split("\n").pop() ?? "";
	check("批注落在「另一行」，不是第一行", line.includes("另一行"), line.trim());

	const tables = tableBlock(text, "重复列");
	const pipes = tablePipes(text, "重复列");
	void tables;
	check(
		"重复值这张表的结构也没变",
		pipes.length > 0 && pipes.every((count) => count === pipes[0]),
		`每行管道数 ${pipes.join("/")}`,
	);
}

await parkCursor();
// 把「另一行」那一格滚进视口（实时预览是懒渲染的，没渲染出来就查不到高亮）
await textSpot("同一个词", 1);
await sleep(400);
const highlights = await evaluate(`(() => {
	const tables = Array.from(document.querySelectorAll(".cm-editor table"));
	// 按内容找表，不按序号：样例笔记里有几张表，序号会随笔记改动而变
	const second = tables.find((table) =>
		Array.from(table.rows).some((row) => (row.textContent ?? "").includes("同一个词"))
	);
	if (!second) return { error: "重复值那张表不在视口里" };
	const marks = Array.from(second.querySelectorAll(".lildog-ann"));
	return marks.map((mark) => ({
		row: Array.from(second.rows).indexOf(mark.closest("tr")),
		cell: Array.from(mark.closest("tr").cells).indexOf(mark.closest("td, th")),
		text: mark.textContent
	}));
})()`);
const markList = Array.isArray(highlights) ? highlights : [];
// 一个格子里可能留着好几份渲染副本（进过编辑态就会多一份），所以看「哪些格子带高亮」，
// 不看 mark 的个数；真正要守的是「高亮没有跑到别的格子去」
const cellsWithMark = Array.from(new Set(markList.map((m) => `${m.row}:${m.cell}`)));
check(
	"重复值那张表里，只有被批注的那一格有高亮（没有跑到别的格子）",
	cellsWithMark.length === 1 && cellsWithMark[0] === "2:1",
	JSON.stringify(markList),
);
check(
	"高亮的文字就是被批注的那一段",
	markList.length > 0 && markList.every((m) => m.text === "同一个词"),
	JSON.stringify(markList),
);

// ---------------------------------------------------------------- 3. 跨单元格

console.log("\n【3】跨单元格的整行选区：降级成段落批注，而且落到整张表之后");

await parkCursor();
const rowSpot = await textSpot("就绪");
const rowEnd = await textSpot("公式");
await clearNotices();
let crossBody = "第三次检查：跨格";

// 先说清楚一件事：在实时预览里，鼠标**跨格**拖选会被 Obsidian 的格子编辑器接管
// （拖进哪一格就切哪一格的编辑态），浏览器选区最后往往只剩一格。这一段只做记录。
if (!rowSpot.error && !rowEnd.error) {
	const y = rowSpot.top + rowSpot.height / 2;
	await cdp.mouse("mouseMoved", rowSpot.left - 6, y);
	await sleep(80);
	await cdp.mouse("mousePressed", rowSpot.left + 1, y);
	await sleep(120);
	await cdp.mouse("mouseMoved", rowSpot.right - 2, y, { button: "left", buttons: 1 });
	await sleep(120);
	await cdp.mouse("mouseMoved", (rowSpot.left + rowEnd.right) / 2, y, { button: "left", buttons: 1 });
	await sleep(120);
	await cdp.mouse("mouseMoved", rowEnd.right - 1, y, { button: "left", buttons: 1 });
	await sleep(120);
	await cdp.mouse("mouseReleased", rowEnd.right - 1, y);
	await sleep(700);
	console.log("  · （记录）鼠标跨格拖选之后浏览器选区：", JSON.stringify(await selectionState()));
}

// 真正要守的是：**整行选区**（编辑器里选一整行源码，或者按快捷键）必须降级成
// 段落批注、并且插在整张表之后，绝不能把表格劈开。
const rowScope = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const lines = editor.getValue().split("\\n");
	const row = lines.findIndex((line) => line.includes("乙") && line.includes("|"));
	if (row < 0) return { error: "没找到「乙」那一行" };
	// 真实场景：光标在编辑器里，浏览器里没有残留选区（上面那段拖选是额外记录，先清掉）
	window.getSelection()?.removeAllRanges();
	editor.setSelection({ line: row, ch: 0 }, { line: row, ch: lines[row].length });
	editor.focus();
	await sleep(300);
	window.app.commands.executeCommandById("lildog-annotate:add-annotation");
	await sleep(700);
	return { row, text: lines[row] };
})()`);
check("编辑器里能选中表格的一整行", !rowScope.error, rowScope.error ?? rowScope.text);

if (!rowScope.error) {
	const result = await submitModal(crossBody);
	check("整行选区弹出批注输入框", result.opened);
	check(
		"明确提示已经改成段落批注",
		(result.notices ?? []).some((text) => text.includes("跨了单元格") || text.includes("段落批注")),
		(result.notices ?? []).join(" | ") || "（没有提示）",
	);

	const text = await readEditorText();
	await dumpMarks("【3】");
	const callout = `> [!lildog] 批注`;
	const blockAt = text.indexOf(callout);
	check("段落批注写在文件里", blockAt !== -1);

	const table = tableBlock(text, "名称");
	const lines = text.split("\n");
	const afterTable = table ? lines[table.end + 1] ?? "" : "";
	check(
		"段落批注落在整张表之后（没有插进表格中间）",
		afterTable.trim() === callout || afterTable.includes(callout),
		`表格末行是「${table ? lines[table.end].trim() : "?"}」，它后面一行是「${afterTable.trim()}」`,
	);

	const pipes = tablePipes(text, "名称");
	check(
		"表格没被劈开：每行管道数仍然一致",
		pipes.length >= 5 && pipes.every((count) => count === pipes[0]),
		`每行管道数 ${pipes.join("/")}`,
	);
}

// ---------------------------------------------------------------- 4. 正文里的管道

console.log("\n【4】批注正文里带 `|`：表格结构不能被它改掉");

await parkCursor();
const pipeCell = await textSpot("待定", 1);
await clearNotices();
let pipeBody = "第四次检查：a | b 是什么";
if (!pipeCell.error) {
	const y = pipeCell.top + pipeCell.height / 2;
	await dragSelect(pipeCell.left, pipeCell.right, y);
	const result = await annotateViaButton(pipeBody);

	const text = await readEditorText();
	await dumpMarks("【4】");
	check(
		"正文带管道的批注也能写进去",
		text.includes(`<!--lildog: 第四次检查：a \\| b 是什么-->待定<!--/lildog-->`),
		(result.notices ?? []).join(" | ") ||
			text.split("\n").filter((line) => line.includes("第四次检查")).join(" | ") ||
			"（没写进去）",
	);
	check("正文里的管道被转义成 `\\|`", text.includes("a \\| b 是什么"));
	const pipes = tablePipes(text, "名称");
	check(
		"带管道的批注没有把表格多切一格",
		pipes.length > 0 && pipes.every((count) => count === pipes[0]),
		`每行管道数 ${pipes.join("/")}`,
	);
}

// ---------------------------------------------------------------- 5. 定位失败要说话

console.log("\n【5】选区一半在表里一半在表外：拒绝写入 + 明确提示");

await parkCursor();
const before5 = await readEditorText();
const outside = await evaluate(`(() => {
	const line = Array.from(document.querySelectorAll(".cm-editor .cm-line"))
		.find((el) => (el.textContent ?? "").includes("这一段在表格前面"));
	if (!line) return { error: "没找到表格前面那段话" };
	line.scrollIntoView({ block: "center" });
	const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
	let node;
	while ((node = walker.nextNode())) {
		const text = node.textContent ?? "";
		const index = text.indexOf("这一段在表格前面");
		if (index === -1) continue;
		const range = document.createRange();
		range.setStart(node, index);
		range.setEnd(node, index + 4);
		const r = range.getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, height: r.height };
	}
	return { error: "那一段里没找到文字节点" };
})()`);
await clearNotices();
const insideCell = await textSpot("就绪");

if (!outside.error && !insideCell.error) {
	const y = outside.top + outside.height / 2;
	await cdp.mouse("mouseMoved", outside.left + 1, y);
	await sleep(80);
	await cdp.mouse("mousePressed", outside.left + 1, y);
	await sleep(80);
	// 一路拖进表格的格子里
	await cdp.mouse("mouseMoved", insideCell.left + 2, insideCell.top + insideCell.height / 2, {
		button: "left",
		buttons: 1,
	});
	await sleep(120);
	await cdp.mouse("mouseReleased", insideCell.right - 1, insideCell.top + insideCell.height / 2);
	await sleep(700);

	const result = await annotateViaButton("第五次检查：不该写进去");
	const after5 = await readEditorText();
	const notices = result.notices ?? [];
	check(
		"给了明确的提示（而不是默默写到别处）",
		notices.length > 0,
		notices.join(" | ") || "（没有提示）",
	);
	check("文件一个字都没改", after5 === before5);
}

// ---------------------------------------------------------------- 5b. 光标在格子里批注整格

console.log("\n【5b】光标停在格子里 + 快捷键：批注整格（不依赖鼠标拖选）");

await parkCursor();
await clearNotices();
const cursorCell = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const lines = editor.getValue().split("\\n");
	const row = lines.findIndex((line) => line.includes("甲") && line.includes("|"));
	if (row < 0) return { error: "没找到「甲」那一行" };
	window.getSelection()?.removeAllRanges();
	// 光标放在「待定」这一格里（不选中任何文字）
	const ch = lines[row].indexOf("就绪") + 1;
	editor.setSelection({ line: row, ch }, { line: row, ch });
	editor.focus();
	await sleep(300);
	window.app.commands.executeCommandById("lildog-annotate:add-annotation");
	await sleep(700);
	return { row, ch, line: lines[row] };
})()`);
check("能定位到表格那一行", !cursorCell.error, cursorCell.error ?? cursorCell.line);

if (!cursorCell.error) {
	const result = await submitModal("第五次检查：整格批注");
	check("光标在格子里按快捷键能弹出输入框", result.opened, (result.notices ?? []).join(" | "));
	const text = await readEditorText();
	await dumpMarks("【5b】");
	check(
		"整格内容被批注上（原文一个字没动）",
		text.includes("<!--lildog: 第五次检查：整格批注-->就绪<!--/lildog-->"),
		text.split("\n").filter((line) => line.includes("整格批注")).join(" | ") || "（没写进去）",
	);
	const pipes = tablePipes(text, "名称");
	check(
		"批注整格也没改坏表格结构",
		pipes.length > 0 && pipes.every((count) => count === pipes[0]),
		`每行管道数 ${pipes.join("/")}`,
	);
	check(
		"（记录）Obsidian 右键表格格子给的是它自己的菜单",
		true,
		"实测：右键菜单只有「行 / 列 / 按列排序」，插件的 editor-menu 不会触发，所以入口改走快捷键",
	);
}

// ---------------------------------------------------------------- 6. 会断表的两处位置

console.log("\n【6】没有前导管道的表格：批注第一格不能写成行内（那一行会以 `<!--` 开头）");

// 实时预览里点进格子时，Obsidian 自己会把整张表重排（补上首尾管道、按列补齐空格），
// 行首那个危机就被它顺手解除了；真正会踩上的是**源码模式**：表格就是纯文本，
// 选区完全由用户决定。所以这一段切到源码模式测，测完切回来。
await parkCursor();
await clearNotices();
const toSource = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	await view.setState({ ...view.getState(), mode: "source", source: true }, { history: false });
	await sleep(1200);
	return { mode: view.getMode(), source: view.getState().source === true };
})()`);
check("切到源码模式（表格是纯文本，选区说了算）", toSource.source, JSON.stringify(toSource));

const pipelessSource = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const lines = editor.getValue().split("\\n");
	const row = lines.findIndex((line) => line.includes("首格文字") && line.includes("|"));
	if (row < 0) return { error: "没找到「首格文字」那一行" };
	const ch = lines[row].indexOf("首格文字");
	window.getSelection()?.removeAllRanges();
	editor.setSelection({ line: row, ch }, { line: row, ch: ch + "首格文字".length });
	editor.focus();
	await sleep(300);
	window.app.commands.executeCommandById("lildog-annotate:add-annotation");
	await sleep(700);
	return {
		row,
		ch,
		text: lines[row],
		modal: !!document.querySelector(".lildog-modal"),
		notices: Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	};
})()`);
check("选中了没有前导管道那张表的第一格", !pipelessSource.error, pipelessSource.error ?? pipelessSource.text);
if (!pipelessSource.error) {
	check("照样弹出了批注输入框（改成段落批注）", pipelessSource.modal === true);
	check(
		"明确说了为什么不用行内批注",
		(pipelessSource.notices ?? []).some((text) => text.includes("行首")),
		(pipelessSource.notices ?? []).join(" | ") || "（没有提示）",
	);

	const result = await submitModal("第六次检查：行首那格");
	check("段落批注提交成功", result.opened, (result.notices ?? []).join(" | "));

	const pipelessText = await readEditorText();
	await dumpMarks("【6】");
	const firstCellLine =
		pipelessText.split("\n").find((line) => line.includes("首格文字")) ?? "";
	check(
		"没有把行内标记写到那一行（那一行以 `<!--` 开头就会断表）",
		!firstCellLine.includes("<!--lildog"),
		firstCellLine.slice(0, 48) || "（没找到那一行）",
	);
	check(
		"改用段落批注写下来了（不是行内标记）",
		pipelessText.includes("> 第六次检查：行首那格"),
		pipelessText.split("\n").filter((line) => line.includes("第六次检查")).join(" | ") || "（没写进去）",
	);
	const pipes = tablePipes(pipelessText, "无前导管道");
	check(
		"这张表还是表（每一行的管道数一致）",
		pipes.length >= 2 && pipes.every((count) => count === pipes[0]),
		`每行管道数 ${pipes.join("/")}`,
	);

	// 切回实时预览：那一格还得是表格格子（不是掉出来的纯文本）
	const backToLive = await evaluate(`(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
		await view.setState({ ...view.getState(), mode: "source", source: false }, { history: false });
		await sleep(1300);
		return { source: view.getState().source === true };
	})()`);
	check("切回实时预览", backToLive.source === false, JSON.stringify(backToLive));
	const pipelessCell = await textSpot("首格文字");
	check(
		"那一格还是表格格子（表格没被降级成纯文本）",
		!pipelessCell.error && pipelessCell.cellIndex === 0,
		pipelessCell.error ?? `第 ${pipelessCell.rowIndex} 行第 ${pipelessCell.cellIndex} 格`,
	);
}

console.log("\n【6b】表格的分隔行：不给批注（动它整张表当场不成表）");

await parkCursor();
await clearNotices();
const beforeDelimiter = await readEditorText();
// 走**光标入口**：光标停在分隔行的格里，按快捷键。
// （分隔行在界面上根本不是一个格子，DOM 那条路到不了它；编辑器选区那条路在实时预览里
//   会被 Obsidian 的表格编辑器接管，落点不稳，所以这里用最稳的光标入口。）
const delimiterRow = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const lines = editor.getValue().split("\\n");
	const header = lines.findIndex((line) => line.includes("名称") && line.includes("|"));
	const row = header + 1;
	if (header < 0 || !/^\\s*\\|?\\s*:?-+:?/.test(lines[row] ?? "")) return { error: "没找到分隔行" };
	window.getSelection()?.removeAllRanges();
	const ch = lines[row].indexOf("---") + 1;
	editor.setSelection({ line: row, ch }, { line: row, ch });
	editor.focus();
	await sleep(300);
	window.app.commands.executeCommandById("lildog-annotate:add-annotation");
	await sleep(700);
	return {
		row,
		ch,
		text: lines[row],
		modal: !!document.querySelector(".lildog-modal"),
		notices: Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	};
})()`);
check("光标停在表格的分隔行里", !delimiterRow.error, delimiterRow.error ?? delimiterRow.text);
if (!delimiterRow.error) {
	check("不给写：批注输入框根本没弹出来", delimiterRow.modal === false);
	check(
		"提示说清了这是分隔行",
		(delimiterRow.notices ?? []).some((text) => text.includes("分隔行")),
		(delimiterRow.notices ?? []).join(" | ") || "（没有提示）",
	);
	check("文件一个字都没改", (await readEditorText()) === beforeDelimiter);
	check(
		"分隔行还是分隔行（表格还认得出自己）",
		/^\s*\|?\s*:?-+:?/.test((await readEditorText()).split("\n")[delimiterRow.row] ?? ""),
	);
}

// 编辑器里整行选中分隔行（源码模式下的真实场景）：一样不能写进去
await parkCursor();
await clearNotices();
const delimiterSelection = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const view = window.app.workspace.getLeavesOfType("markdown")[0].view;
	const editor = view.editor;
	const lines = editor.getValue().split("\\n");
	const header = lines.findIndex((line) => line.includes("名称") && line.includes("|"));
	const row = header + 1;
	if (header < 0) return { error: "没找到分隔行" };
	window.getSelection()?.removeAllRanges();
	editor.setSelection({ line: row, ch: 0 }, { line: row, ch: lines[row].length });
	editor.focus();
	await sleep(300);
	window.app.commands.executeCommandById("lildog-annotate:add-annotation");
	await sleep(700);
	return { row, modal: !!document.querySelector(".lildog-modal") };
})()`);
if (!delimiterSelection.error) {
	check("整行选中分隔行也不会弹输入框", delimiterSelection.modal === false);
	check("整行选中分隔行，文件同样一个字没改", (await readEditorText()) === beforeDelimiter);
}

// ---------------------------------------------------------------- 7. 探针：Obsidian 自己怎么处理「整行被包住」

console.log("\n【7】探针：整行被批注标记包起来时，Obsidian 是把表断掉还是错列");

const probeText = [
	"| a | b |",
	"| --- | --- |",
	"<!--lildog: probe-->| c | d |<!--/lildog-->",
	"| e | f |",
	"",
	"| X | Y |",
	"| --- | --- |",
	"X| p | q |",
	"",
].join("\n");
await writeNote(PROBE, probeText);
const probeMode = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const app = window.app;
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(PROBE)});
	const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(true);
	// 用一个新叶子里直接以「阅读视图」打开，别去 toggle（toggle 的方向取决于当前状态）
	await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
	await sleep(1600);
	return leaf.view.getMode();
})()`);
const probe = await evaluate(`(() => {
	const root = document.querySelector(".markdown-preview-view") ?? document.body;
	const tables = Array.from(root.querySelectorAll("table")).map((table) => ({
		rows: Array.from(table.rows).map((row) =>
			Array.from(row.cells).map((cell) => (cell.textContent ?? "").trim())
		)
	}));
	return { mode: ${JSON.stringify(probeMode)}, tables, text: (root.textContent ?? "").slice(0, 300) };
})()`);
check(
	"（探针结论）把整行包进批注标记后，Obsidian 渲染出来是这些表",
	probe.tables.length > 0,
	`mode=${probe.mode} tables=${JSON.stringify(probe.tables)}`,
);
console.log(`  · 探针原文：\n${probeText.split("\n").map((l) => `      ${l}`).join("\n")}`);
console.log(`  · 探针渲染：${JSON.stringify(probe.tables)}`);
console.log(`  · 说明：第一张表只有 1 行 = 表格在那一行被断掉；某行格子数变多 = 内容错列`);
void probeMode;

// ---------------------------------------------------------------- 收尾

await writeNote(NOTE, PRISTINE);
await evaluate(`(async () => {
	const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(PROBE)});
	if (file) await window.app.vault.delete(file);
	return true;
})()`);
await openNote(NOTE);
check("收尾：测试笔记已还原", (await readNote(NOTE)) === PRISTINE);

const ok = report();
cdp.close();
process.exit(ok ? 0 : 1);
