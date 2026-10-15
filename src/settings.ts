import { App, PluginSettingTab, Setting } from "obsidian";
import type LildogAnnotatePlugin from "./main";

export type AnnotationMode = "inline" | "block";

export interface LildogSettings {
	/** 新批注的默认形式 */
	mode: AnnotationMode;
	/** 选中文字后是否浮出「批注」小按钮 */
	showFloatingButton: boolean;
	/** 鼠标悬停时是否显示批注内容 */
	hoverPreview: boolean;
}

export const DEFAULT_SETTINGS: LildogSettings = {
	mode: "inline",
	showFloatingButton: true,
	hoverPreview: true,
};

export class LildogSettingTab extends PluginSettingTab {
	plugin: LildogAnnotatePlugin;

	constructor(app: App, plugin: LildogAnnotatePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("lildog-settings");

		new Setting(containerEl)
			.setName("批注形式")
			.setDesc(
				"行内：选中文字变成 ==高亮==，批注藏在后面的隐藏注记里，正文干净；" +
					"段落：在段落后面插入一个「批注」块，打开笔记就能看到疑问。",
			)
			.addDropdown((dd) =>
				dd
					.addOption("inline", "行内批注（高亮 + 隐藏注记）")
					.addOption("block", "段落批注（原文后插入批注块）")
					.setValue(this.plugin.settings.mode)
					.onChange(async (value) => {
						this.plugin.settings.mode = value as AnnotationMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("选中文字后浮出批注按钮")
			.setDesc("在编辑器里选中文字后，选区上方会出现一个「批注」小按钮，点它即可写批注。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showFloatingButton).onChange(async (value) => {
					this.plugin.settings.showFloatingButton = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("悬停显示批注内容")
			.setDesc("鼠标停在带批注的文字上时，弹出批注内容（行内批注在编辑器和阅读视图都支持）。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hoverPreview).onChange(async (value) => {
					this.plugin.settings.hoverPreview = value;
					await this.plugin.saveSettings();
				}),
			);

		const info = containerEl.createDiv({ cls: "lildog-settings-info" });
		info.createEl("h4", { text: "写在笔记里的格式" });
		info.createEl("p", {
			text: "批注是笔记正文里的纯文本，不依赖插件的数据库，所以人或 AI 都能直接读到：",
		});
		const pre = info.createEl("pre", { cls: "lildog-settings-pre" });
		pre.setText(
			"行内：==被批注的文字==<!-- lildog: 批注内容 -->\n\n" +
				"段落：> [!lildog] 批注\n> 原文：被批注的文字\n>\n> 批注内容",
		);
		info.createEl("p", {
			text: "在任何工具里执行 grep \"lildog\" 就能一键捞出全库批注。",
		});

		info.createEl("h4", { text: "快捷键" });
		info.createEl("p", {
			text:
				"添加批注：Ctrl/Cmd + Shift + A；也可以右键菜单，或用浮动按钮。" +
				"快捷键可在「设置 → 快捷键」里搜索「批注」自行修改。",
		});
	}
}
