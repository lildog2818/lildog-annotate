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
	/**
	 * 编辑已有批注时传入。有了它：
	 *   - 弹窗左下角多一个「删除这条批注」按钮
	 *   - 把内容删光时主按钮自己变成「删除批注」，不会卡在「内容不能为空」
	 */
	onDelete?: () => void;
	/** 弹窗关闭时调用。saved 为 false 表示没写入（取消 / 直接关掉），可以借机恢复现场 */
	onClose?: (saved: boolean) => void;
}

/** 一个极简的批注输入框：看得到原文、写得下批注、Ctrl+Enter 保存。 */
export class AnnotateModal extends Modal {
	private options: AnnotateModalOptions;
	private value: string;
	private textarea: TextAreaComponent | null = null;
	private submitted = false;
	private saveBtn: HTMLButtonElement | null = null;

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
						this.refreshSubmitButton();
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
		if (this.options.onDelete) {
			const deleteBtn = buttons.createEl("button", {
				text: "删除这条批注",
				cls: "lildog-modal-delete mod-warning",
			});
			deleteBtn.addEventListener("click", () => this.remove());
		}
		const saveBtn = buttons.createEl("button", {
			cls: "mod-cta lildog-modal-submit",
		});
		this.saveBtn = saveBtn;
		saveBtn.addEventListener("click", () => this.submit());
		this.refreshSubmitButton();

		const cancelBtn = buttons.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	/** 编辑已有批注时把内容删光 = 想删掉它：主按钮换成「删除批注」，别卡在「不能为空」 */
	private refreshSubmitButton(): void {
		if (!this.saveBtn) return;
		const deleting = !this.value.trim() && !!this.options.onDelete;
		this.saveBtn.setText(deleting ? "删除批注" : "保存");
		this.saveBtn.toggleClass("mod-warning", deleting);
		this.saveBtn.toggleClass("mod-cta", !deleting);
	}

	private submit(): void {
		const body = this.value.trim();
		if (!body) {
			if (this.options.onDelete) {
				this.remove();
				return;
			}
			new Notice("批注内容不能为空");
			this.textarea?.inputEl.focus();
			return;
		}
		this.submitted = true;
		this.close();
		this.options.onSubmit(body);
	}

	private remove(): void {
		this.submitted = true;
		this.close();
		this.options.onDelete?.();
	}

	onClose(): void {
		this.contentEl.empty();
		this.options.onClose?.(this.submitted);
	}
}
