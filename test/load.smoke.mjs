/**
 * 冒烟测试：用桩模块把打包产物 main.js 真的加载一遍，跑一次 onload。
 *
 * 目的不是测行为，而是确认「插件能被 Obsidian 加载起来」：
 *   - 打包产物是合法的 CommonJS，导出的是插件类
 *   - 用到的 obsidian / @codemirror 接口都存在（桩里少一个就会抛错）
 *   - onload 不抛异常，三条命令都注册上了
 *
 * 需要先 npm run build；main.js 不存在时自动跳过。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "main.js");

if (!existsSync(bundlePath)) {
	console.log("… 跳过加载冒烟测试：还没有 main.js，先跑 npm run build");
	process.exit(0);
}

const failures = [];
function check(name, condition) {
	if (!condition) failures.push(name);
}

// ---------------------------------------------------------------- 桩模块

const commands = [];
const editorExtensions = [];
const postProcessors = [];
const settingTabs = [];
const notices = [];

class PluginStub {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
	}
	async loadData() {
		return {};
	}
	async saveData() {}
	addSettingTab(tab) {
		settingTabs.push(tab);
	}
	registerEditorExtension(ext) {
		editorExtensions.push(ext);
	}
	registerMarkdownPostProcessor(fn) {
		postProcessors.push(fn);
	}
	addCommand(cmd) {
		commands.push(cmd);
	}
	register() {}
	registerEvent() {}
	registerDomEvent() {}
}

const obsidianStub = {
	Plugin: PluginStub,
	PluginSettingTab: class {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
		}
	},
	Setting: class {},
	Modal: class {},
	TFile: class {
		constructor(path) {
			this.path = path;
		}
	},
	MarkdownView: class {},
	normalizePath: (path) => path,
	Notice: class {
		constructor(message) {
			notices.push(message);
		}
	},
	setIcon() {},
	setTooltip() {},
};

const cmViewStub = {
	hoverTooltip: (source, options) => ({ kind: "hoverTooltip", source, options }),
	EditorView: {
		decorations: {
			compute: (deps, get) => ({ kind: "EditorView.decorations", deps, get }),
		},
	},
	ViewPlugin: {
		fromClass: (cls, spec) => ({ kind: "ViewPlugin", cls, spec }),
	},
	Decoration: {
		mark: (spec) => ({ kind: "mark", spec }),
		replace: (spec) => ({ kind: "replace", spec }),
	},
	WidgetType: class {
		constructor() {}
		toDOM() {
			return {};
		}
	},
};

const cmStateStub = {
	RangeSetBuilder: class {
		add() {}
		finish() {
			return { kind: "RangeSet" };
		}
	},
};

// ---------------------------------------------------------------- 加载

// Obsidian 跑在浏览器环境里，Node 里得自己补上这些全局对象
globalThis.document = {
	addEventListener() {},
	removeEventListener() {},
	createElement: () => ({}),
	querySelectorAll: () => [],
	body: { createDiv: () => ({}), createEl: () => ({}) },
};
globalThis.window = {
	addEventListener() {},
	removeEventListener() {},
	getSelection: () => null,
	innerWidth: 1200,
	setTimeout: (fn) => fn(),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	if (request === "@codemirror/view") return cmViewStub;
	if (request === "@codemirror/state") return cmStateStub;
	return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
let PluginClass;
try {
	const bundle = require(bundlePath);
	PluginClass = bundle.default ?? bundle;
} catch (error) {
	console.error(`\n✗ 加载 main.js 失败：${error?.message}\n`);
	process.exit(1);
}

check("导出的是插件类", typeof PluginClass === "function");

const app = {
	workspace: {
		on: () => ({ unsubscribe: () => {} }),
		getActiveViewOfType: () => null,
		getLeavesOfType: () => [],
	},
	vault: {
		__files: new Map(),
		getAbstractFileByPath(path) {
			return this.__files.has(path)
				? new obsidianStub.TFile(path)
				: undefined;
		},
		async createFolder(path) {
			this.__files.set(path, { path, __folder: true });
		},
		async create(path, content) {
			this.__files.set(path, { path, content });
		},
		async modify(file, content) {
			this.__files.set(file.path, { path: file.path, content });
		},
		async read(file) {
			return this.__files.get(file.path)?.content ?? "";
		},
	},
};

const plugin = new PluginClass(app, { id: "lildog-annotate", version: "1.0.0" });

try {
	await plugin.onload();
} catch (error) {
	console.error(`\n✗ onload 抛异常：${error?.stack ?? error}\n`);
	Module._load = originalLoad;
	process.exit(1);
}

// ---------------------------------------------------------------- 断言

check(
	"注册了 5 条命令",
	commands.length === 5 &&
		[
			"add-annotation",
			"edit-annotation",
			"delete-annotation",
			"migrate-legacy",
			"run-self-check",
		].every((id) => commands.some((c) => c.id === id)),
);
check(
	"添加批注带默认快捷键",
	commands.some(
		(c) =>
			c.id === "add-annotation" &&
			Array.isArray(c.hotkeys) &&
			c.hotkeys.length === 1,
	),
);
check(
	"每条命令都有中文名",
	commands.every((c) => typeof c.name === "string" && c.name.length > 0),
);
check("注册了编辑器扩展（下划线 / 图标 / 悬停）", editorExtensions.length === 1);
check("注册了阅读视图后处理器", postProcessors.length === 1);
check("注册了设置页", settingTabs.length === 1);
check(
	"默认设置被读进来",
	plugin.settings &&
		plugin.settings.mode === "inline" &&
		plugin.settings.showFloatingButton === true &&
		plugin.settings.hoverPreview === true,
);

// 真跑一次自检命令，确认报告能生成（界面里的诊断通道不能是坏的）
const selfCheck = commands.find((c) => c.id === "run-self-check");
let report = "";
try {
	await selfCheck.callback();
	const written = app.vault.__files.get("DSH/lildog-自检报告.md");
	report = written?.content ?? "";
} catch (error) {
	failures.push(`自检命令抛异常：${error?.message ?? error}`);
}

check("自检报告写进了 DSH 目录", report.length > 0);
check("报告包含逐窗格探针", report.includes("## 逐窗格探针"));
check(
	"报告统计了界面里的批注高亮元素",
	report.includes(".lildog-ann（批注高亮）元素"),
);
check("报告记录了最近一次选中探测", report.includes("最近一次选中文字探测"));
check("报告记录了插件版本", report.includes("插件版本："));
check("报告会提示 getSectionInfo 状态", report.includes("getSectionInfo"));
check("报告带构建指纹", report.includes("加载的构建："));

// 再跑一次：报告要能累积，这样才能编辑视图跑一次、阅读视图再跑一次
try {
	await selfCheck.callback();
} catch (error) {
	failures.push(`第二次自检抛异常：${error?.message ?? error}`);
}
const report2 = app.vault.__files.get("DSH/lildog-自检报告.md")?.content ?? "";
check("多次自检会累积到同一份报告里", report2.includes("<!-- lildog:run -->"));
check(
	"累积后仍然保留最新一次的内容",
	report2.startsWith(report.split("\n").slice(0, 3).join("\n").slice(0, 20)),
);

Module._load = originalLoad;

// ---------------------------------------------------------------- 结果

if (failures.length) {
	console.error(`\n✗ 加载冒烟测试失败 ${failures.length} 项：`);
	for (const f of failures) console.error(`  - ${f}`);
	console.error("");
	process.exit(1);
}
console.log(`\n✓ 加载冒烟测试通过（${commands.length} 条命令，插件可被 Obsidian 加载）\n`);
