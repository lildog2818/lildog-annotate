/**
 * 用 esbuild 把 CodeMirror 装饰测试打包再跑。
 * Node 的 ESM 解析器不认无扩展名导入，直接 node xxx.mts 会找不到模块。
 */
import esbuild from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

// @codemirror/view 在 Node 里需要一个最小的 DOM 环境
globalThis.navigator ??= { userAgent: "node", platform: "node" };
globalThis.window ??= {
	addEventListener() {},
	removeEventListener() {},
	getSelection: () => null,
	devicePixelRatio: 1,
	navigator: globalThis.navigator,
};
globalThis.document ??= {
	addEventListener() {},
	removeEventListener() {},
	createElement: () => ({
		style: {},
		setAttribute() {},
		appendChild() {},
	}),
	documentElement: { style: {} },
	body: { appendChild() {} },
};

const outdir = "test/.tmp";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

esbuild.buildSync({
	entryPoints: ["test/decorations.cm.test.mts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2022",
	outfile: `${outdir}/decorations.cjs`,
	logLevel: "warning",
});

await import(pathToFileURL(`${outdir}/decorations.cjs`).href);
