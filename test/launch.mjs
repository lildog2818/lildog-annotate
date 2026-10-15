/**
 * 用**隔离的 Obsidian 实例**打开测试库（test/vault），并留出 9222 调试端口，
 * 供 test/ui-check.mjs 做界面级检查。
 *
 * 你自己日常用的那个 Obsidian 完全不受影响：user-data-dir 不一样，
 * Electron 会当成两个互不相干的实例（也就能同时开着）。
 *
 *   npm run test:vault             启动（已经在跑就直接复用）
 *   npm run test:vault -- --close  关掉隔离实例
 *
 * 想换位置：环境变量 LILDOG_OBSIDIAN（主程序）、LILDOG_TEST_PROFILE（配置目录）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const testVault = join(repo, "test", "vault");

const EXE = process.env.LILDOG_OBSIDIAN ?? "D:\\software\\Obsidian\\Obsidian.exe";
const PROFILE = process.env.LILDOG_TEST_PROFILE ?? "D:\\document\\lildog-obsidian-profile";
const PORT = Number(process.env.LILDOG_DEBUG_PORT ?? 9222);

async function debuggerReady() {
	try {
		const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
		return response.ok;
	} catch {
		return false;
	}
}

async function closeInstance() {
	const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	const ws = new WebSocket(info.webSocketDebuggerUrl);
	await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
	ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
	await sleep(2000);
	console.log("✓ 已请求关闭隔离实例");
}

if (process.argv.includes("--close")) {
	if (!(await debuggerReady())) {
		console.log("… 隔离实例没在跑，无需关闭");
		process.exit(0);
	}
	await closeInstance();
	process.exit(0);
}

// ---------------------------------------------------------------- 启动

if (!existsSync(EXE)) {
	console.error(`✗ 没找到 Obsidian：${EXE}\n  可以用环境变量 LILDOG_OBSIDIAN 指定路径`);
	process.exit(1);
}
if (!existsSync(testVault)) {
	console.error(`✗ 测试库不存在：${testVault}`);
	process.exit(1);
}

if (await debuggerReady()) {
	console.log(`… 隔离实例已经在跑（调试端口 ${PORT}），直接用它`);
} else {
	mkdirSync(PROFILE, { recursive: true });
	// 让这个实例一启动就打开测试库
	writeFileSync(
		join(PROFILE, "obsidian.json"),
		`${JSON.stringify(
			{
				vaults: { lildogtest: { path: testVault, ts: Date.now(), open: true } },
				updateDisabled: true,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const child = spawn(
		EXE,
		[
			`--user-data-dir=${PROFILE}`,
			`--remote-debugging-port=${PORT}`,
			"--remote-allow-origins=*",
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	console.log(`… 已启动隔离实例（配置目录 ${PROFILE}）`);

	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline && !(await debuggerReady())) {
		await sleep(700);
	}
	if (!(await debuggerReady())) {
		console.error("✗ 等了 90 秒，调试端口还没起来。手动打开 Obsidian 看看有没有报错窗口。");
		process.exit(1);
	}
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const pages = targets.filter((t) => t.type === "page").map((t) => t.url);
console.log(`✓ 隔离实例就绪：http://127.0.0.1:${PORT}`);
console.log(`  打开的页面：${pages.join(" | ") || "（还没有）"}`);
console.log(`  测试库：${testVault}`);
console.log("\n下一步：npm run test:ui（界面检查）或 npm run test:accept（格式验收）\n");
