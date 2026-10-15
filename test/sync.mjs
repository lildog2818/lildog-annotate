/**
 * 把构建产物铺进测试库（默认）和真库（--real）。
 *
 *   npm run deploy              构建 + 铺到 test/vault（检查、测试都在这个库里做）
 *   npm run deploy:real         上面那个，再铺一份到真库，日常使用立刻生效
 *   node test/sync.mjs --vault <库路径>     铺到指定库
 *
 * 测试库的 .obsidian 配置由这个脚本生成（插件目录、启用列表），
 * 所以仓库里不用提交任何 .obsidian 文件。
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const testVault = join(repo, "test", "vault");
const PLUGIN_ID = "lildog-annotate";
const FILES = ["main.js", "manifest.json", "styles.css"];
/** 真库位置：可以用环境变量换掉 */
const REAL_VAULT = process.env.LILDOG_REAL_VAULT ?? "D:\\document\\ObsidianNote";

const args = process.argv.slice(2);
const vaultFlag = args.indexOf("--vault");
const extraVaults = [];
if (vaultFlag >= 0) {
	const value = args[vaultFlag + 1];
	if (!value) {
		console.error("✗ --vault 后面要跟库的路径");
		process.exit(1);
	}
	extraVaults.push(resolve(value));
}
if (args.includes("--real")) extraVaults.push(REAL_VAULT);

// ---------------------------------------------------------------- 前置检查

const missing = FILES.filter((file) => !existsSync(join(repo, file)));
if (missing.length) {
	console.error(
		`✗ 仓库里缺少构建产物：${missing.join("、")}\n  先跑 npm run build（或直接 npm run deploy）`,
	);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));

// ---------------------------------------------------------------- 铺文件

function install(vault, { withConfig = false } = {}) {
	const target = join(vault, ".obsidian", "plugins", PLUGIN_ID);
	mkdirSync(target, { recursive: true });
	const copied = FILES.map((file) => {
		copyFileSync(join(repo, file), join(target, file));
		return `${file} ${(statSync(join(target, file)).size / 1024).toFixed(1)}KB`;
	});

	if (!withConfig) return { target, copied };

	// 测试库的配置：启用插件就够了。workspace / 主题这些交给 Obsidian 自己写。
	const obsidianDir = join(vault, ".obsidian");
	mkdirSync(obsidianDir, { recursive: true });
	const writeIfMissing = (name, content) => {
		const file = join(obsidianDir, name);
		if (!existsSync(file)) writeFileSync(file, content, "utf8");
	};
	writeIfMissing("app.json", "{}\n");
	writeIfMissing("appearance.json", "{}\n");
	writeFileSync(
		join(obsidianDir, "community-plugins.json"),
		`${JSON.stringify([PLUGIN_ID], null, 2)}\n`,
		"utf8",
	);
	return { target, copied };
}

const results = [install(testVault, { withConfig: true })];
for (const vault of extraVaults) {
	if (!existsSync(vault)) {
		console.error(`✗ 库不存在：${vault}`);
		process.exit(1);
	}
	results.push(install(vault));
}

console.log(`\n✓ Lildog Annotate ${manifest.version} 已铺好（${FILES.join(" / ")}）`);
for (const item of results) {
	console.log(`  ${item.target}`);
	console.log(`    ${item.copied.join("  ")}`);
}
console.log(
	"\n测试库：test/vault（npm run test:vault 用隔离实例打开它，npm run test:ui 做界面检查）\n",
);
