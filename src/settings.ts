import { App, PluginSettingTab, Setting } from "obsidian";
import { BUILD_ID } from "./build";
import {
	clampNumber,
	DEFAULT_HIGHLIGHT_COLOR,
	DEFAULT_TEXT_COLOR,
	normalizeHex,
} from "./colors";
import type LildogAnnotatePlugin from "./main";

export type AnnotationMode = "inline" | "block";

export interface LildogSettings {
	/** 新批注的默认形式 */
	mode: AnnotationMode;
	/** 选中文字后是否浮出「批注」小按钮 */
	showFloatingButton: boolean;
	/** 鼠标悬停时是否显示批注浮窗 */
	hoverPreview: boolean;
	/** 被批注文字的颜色（#rrggbb） */
	annotatedTextColor: string;
	/** 被批注文字的底色（#rrggbb） */
	highlightColor: string;
	/** 底色深浅 0.05 ~ 1 */
	highlightOpacity: number;
	/** 悬停浮窗的字号（px） */
	cardFontSize: number;
}

export const DEFAULT_SETTINGS: LildogSettings = {
	mode: "inline",
	showFloatingButton: true,
	hoverPreview: true,
	annotatedTextColor: DEFAULT_TEXT_COLOR,
	highlightColor: DEFAULT_HIGHLIGHT_COLOR,
	highlightOpacity: 0.32,
	cardFontSize: 14,
};

/**
 * 收口所有设置项。
 * data.json 是用户手可改的文本文件，颜色写错、字号写成字符串都不该让插件崩掉，
 * 所以读设置时统一过一遍这里。
 */
export function sanitizeSettings(
	raw: Partial<LildogSettings> | null | undefined,
): LildogSettings {
	const merged: LildogSettings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
	if (merged.mode !== "inline" && merged.mode !== "block") {
		merged.mode = DEFAULT_SETTINGS.mode;
	}
	merged.annotatedTextColor = normalizeHex(
		merged.annotatedTextColor,
		DEFAULT_SETTINGS.annotatedTextColor,
	);
	merged.highlightColor = normalizeHex(
		merged.highlightColor,
		DEFAULT_SETTINGS.highlightColor,
	);
	merged.highlightOpacity = clampNumber(
		merged.highlightOpacity,
		0.05,
		1,
		DEFAULT_SETTINGS.highlightOpacity,
	);
	merged.cardFontSize = clampNumber(
		merged.cardFontSize,
		11,
		24,
		DEFAULT_SETTINGS.cardFontSize,
	);
	merged.showFloatingButton = merged.showFloatingButton !== false;
	merged.hoverPreview = merged.hoverPreview !== false;
	return merged;
}

export class LildogSettingTab extends PluginSettingTab {
	plugin: LildogAnnotatePlugin;

	constructor(app: App, plugin: LildogAnnotatePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** 改完立刻存盘 + 立刻把新样式刷到界面上（不用重载 Obsidian） */
	private async applyAndSave(apply: () => void): Promise<void> {
		apply();
		this.plugin.applyAppearance();
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("lildog-settings");

		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("批注形式")
			.setDesc(
				"行内：被批注的文字在正文里高亮，批注藏在旁边的隐藏标记里，正文干净；" +
					"段落：在段落后面插入一个「批注」块，打开笔记就能看到疑问。",
			)
			.addDropdown((dd) =>
				dd
					.addOption("inline", "行内批注（高亮 + 隐藏标记）")
					.addOption("block", "段落批注（原文后插入批注块）")
					.setValue(settings.mode)
					.onChange((value) => {
						void this.applyAndSave(() => {
							settings.mode = value as AnnotationMode;
						});
					}),
			);

		new Setting(containerEl)
			.setName("选中文字后浮出批注按钮")
			.setDesc("选中文字后，选区上方出现一个「批注」小按钮，点它即可写批注。")
			.addToggle((t) =>
				t.setValue(settings.showFloatingButton).onChange((value) => {
					void this.applyAndSave(() => {
						settings.showFloatingButton = value;
					});
				}),
			);

		new Setting(containerEl).setName("外观").setHeading();

		new Setting(containerEl)
			.setName("批注文字颜色")
			.setDesc("被批注的文字用另一种颜色显示，和正文一眼分得开。")
			.addColorPicker((cb) =>
				cb.setValue(settings.annotatedTextColor).onChange((value) => {
					void this.applyAndSave(() => {
						settings.annotatedTextColor = normalizeHex(
							value,
							DEFAULT_TEXT_COLOR,
						);
					});
				}),
			);

		new Setting(containerEl)
			.setName("批注底色")
			.setDesc("被批注文字的背景色，编辑器（实时预览 / 源码）和阅读视图都生效。")
			.addColorPicker((cb) =>
				cb.setValue(settings.highlightColor).onChange((value) => {
					void this.applyAndSave(() => {
						settings.highlightColor = normalizeHex(
							value,
							DEFAULT_HIGHLIGHT_COLOR,
						);
					});
				}),
			);

		new Setting(containerEl)
			.setName("底色深浅")
			.setDesc("太浅看不清、太深盖住正文；默认 32% 并配一条同色下划线。")
			.addSlider((sl) =>
				sl
					.setLimits(5, 100, 1)
					.setValue(Math.round(settings.highlightOpacity * 100))
					.setDynamicTooltip()
					.onChange((value) => {
						void this.applyAndSave(() => {
							settings.highlightOpacity = value / 100;
						});
					}),
			);

		new Setting(containerEl).setName("悬停浮窗").setHeading();

		new Setting(containerEl)
			.setName("悬停显示批注浮窗")
			.setDesc(
				"鼠标停在带批注的文字上弹出浮窗，浮窗里点「编辑」（或直接点正文）就能改批注：" +
					"回车保存、Shift + 回车换行、Esc 取消。关掉后批注照样高亮，只是不弹浮窗。",
			)
			.addToggle((t) =>
				t.setValue(settings.hoverPreview).onChange((value) => {
					void this.applyAndSave(() => {
						settings.hoverPreview = value;
						if (!value) this.plugin.hideHoverCard();
					});
				}),
			);

		new Setting(containerEl)
			.setName("浮窗字号")
			.setDesc("悬停浮窗里文字的字号（像素）。")
			.addSlider((sl) =>
				sl
					.setLimits(11, 24, 1)
					.setValue(settings.cardFontSize)
					.setDynamicTooltip()
					.onChange((value) => {
						void this.applyAndSave(() => {
							settings.cardFontSize = value;
						});
					}),
			);

		new Setting(containerEl)
			.setName("恢复默认外观")
			.setDesc("把批注文字颜色、底色、深浅、浮窗字号都恢复成默认值。")
			.addButton((btn) =>
				btn.setButtonText("恢复默认").onClick(() => {
					void this.applyAndSave(() => {
						settings.annotatedTextColor = DEFAULT_SETTINGS.annotatedTextColor;
						settings.highlightColor = DEFAULT_SETTINGS.highlightColor;
						settings.highlightOpacity = DEFAULT_SETTINGS.highlightOpacity;
						settings.cardFontSize = DEFAULT_SETTINGS.cardFontSize;
					});
					this.display();
				}),
			);

		const info = containerEl.createDiv({ cls: "lildog-settings-info" });
		info.createEl("h4", { text: "写在笔记里的格式" });
		info.createEl("p", {
			text: "批注是笔记正文里的纯文本，不依赖插件的数据库，所以人或 AI 都能直接读到：",
		});
		const pre = info.createEl("pre", { cls: "lildog-settings-pre" });
		pre.setText(
			"行内：<!--lildog: 批注内容-->被批注的文字<!--/lildog-->\n\n" +
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

		info.createEl("h4", { text: "当前构建" });
		info.createEl("p", {
			text: `${BUILD_ID}（版本 ${this.plugin.manifest.version}）。` +
				"如果这里的时间不是你刚构建的那次，说明 Obsidian 还没重载，改的代码没生效。",
		});
	}
}
