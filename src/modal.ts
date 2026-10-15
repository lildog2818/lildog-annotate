import { App, Modal, Notice, Setting, TextAreaComponent } from "obsidian";

export interface AnnotateModalOptions {
	/** 弹窗标题 */
	title: string;
	/** 被批注的原文，仅作展示 */
	quote: string;
	/** 已有批注内容（编辑时传入） */
	value?: string;
	/** 点击保存 */
	onSubmit: (body: string) => void;
}

/** 一个极简的批注输入框：看得到原文、写得下批注、Ctrl+Enter 保存。 */
export class AnnotateModal extends Modal {
	private options: AnnotateModalOptions;
	private value: string;
	private textarea: TextAreaComponent | null = null;
	private submitted = false;

	constructor(app: App, options: AnnotateModalOptions) {
		super(app);
		this.options = options;
		this.value = options.value ?? "";
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.options.title);
		contentEl.addClass("lildog-modal");

		if (this.options.quote.trim()) {
			const quote = this.options.quote.replace(/\s+/g, " ").trim();
			const shown = quote.length > 160 ? `${quote.slice(0, 160)}…` : quote;
			contentEl.createDiv({ cls: "lildog-modal-quote", text: `原文：${shown}` });
		}

		new Setting(contentEl)
			.setName("批注内容")
			.setClass("lildog-modal-field")
			.addTextArea((ta) => {
				this.textarea = ta;
				ta.setPlaceholder("写下你的疑问或备注…（Ctrl/Cmd + Enter 保存）")
					.setValue(this.value)
					.onChange((value) => {
						this.value = value;
					});
				ta.inputEl.rows = 5;
				ta.inputEl.addClass("lildog-textarea");
				ta.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
						evt.preventDefault();
						this.submit();
					}
				});
				window.setTimeout(() => ta.inputEl.focus(), 0);
			});

		const buttons = contentEl.createDiv({ cls: "lildog-modal-buttons" });
		const saveBtn = buttons.createEl("button", { text: "保存", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => this.submit());
		const cancelBtn = buttons.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	private submit(): void {
		const body = this.value.trim();
		if (!body) {
			new Notice("批注内容不能为空");
			this.textarea?.inputEl.focus();
			return;
		}
		this.submitted = true;
		this.close();
		this.options.onSubmit(body);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
