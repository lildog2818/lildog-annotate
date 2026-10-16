import { MarkdownView, setIcon } from "obsidian";

/**
 * 鼠标停在带批注的文字上时弹出的浮窗。
 *
 * 和旧版（Obsidian 原生 tooltip / CodeMirror hoverTooltip）的区别：
 *   1. 浮窗里**直接就能改批注**：点「编辑」或点正文进入编辑态，回车保存并收起；
 *   2. 字号由设置决定（`--lildog-card-font-size`），不受主题的小字号拖累；
 *   3. 显示/隐藏的时机完全由插件掌握 —— 按回车、滚动、点别处、正文一变
 *      都会立刻收起，不用再去点一下别的地方。
 */
export interface HoverTarget {
	/** 批注所在的视图，保存时用它把改动落盘 */
	view: MarkdownView;
	/** 批注在源码里的绝对范围（含标记） */
	from: number;
	to: number;
	/** 被批注的原文（源码形式） */
	text: string;
	/** 批注内容 */
	body: string;
}

export interface HoverCardOptions {
	/** 浮窗字号（px），每次显示时现取，设置改了立刻生效 */
	fontSize: () => number;
	/** 点保存：把新的批注内容写回去 */
	onSave: (target: HoverTarget, body: string) => void;
}

/** 鼠标从高亮移到浮窗上的间隙，小于这个时间不收起 */
const HIDE_DELAY = 220;

export class HoverCard {
	private el: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private quoteEl: HTMLElement | null = null;
	private editWrap: HTMLElement | null = null;
	private textarea: HTMLTextAreaElement | null = null;
	private editButton: HTMLButtonElement | null = null;
	private target: HoverTarget | null = null;
	private editing = false;
	private hideTimer: number | null = null;
	/** 编辑到一半被收起来时，草稿留着，重新悬停还能接着改 */
	private draft: { key: string; text: string } | null = null;

	constructor(private options: HoverCardOptions) {}

	// ---------------------------------------------------------------- 状态

	get visible(): boolean {
		return !!this.el && this.el.style.display !== "none";
	}

	get isEditing(): boolean {
		return this.editing;
	}

	/** 事件目标是否落在浮窗里（浮窗内的点击、回车不能算「点别处」） */
	contains(node: Node | null | undefined): boolean {
		return !!this.el && !!node && this.el.contains(node);
	}

	// ---------------------------------------------------------------- 显示

	show(target: HoverTarget, rect: DOMRect): void {
		const same = this.target && this.keyOf(this.target) === this.keyOf(target);
		if (same && this.visible) {
			// 同一条批注：只挪位置，别把用户正在写的内容冲掉
			this.cancelHide();
			this.place(rect);
			return;
		}

		this.target = target;
		this.editing = false;
		this.cancelHide();
		this.build();
		const el = this.el!;
		el.style.fontSize = `${this.options.fontSize()}px`;
		this.render(target);
		el.style.display = "block";
		this.place(rect);
	}

	/** 设置里改了字号：浮窗开着也要立刻变 */
	refreshStyle(): void {
		if (!this.el) return;
		this.el.style.fontSize = `${this.options.fontSize()}px`;
	}

	// ---------------------------------------------------------------- 收起

	/** 鼠标移开：给一点宽限时间，方便把鼠标挪到浮窗上接着看 */
	scheduleHide(): void {
		if (this.editing || this.hasFocus()) return;
		this.cancelHide();
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			if (!this.editing && !this.hasFocus()) this.hide();
		}, HIDE_DELAY);
	}

	cancelHide(): void {
		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
	}

	hide(): void {
		this.cancelHide();
		if (this.editing) this.rememberDraft();
		this.editing = false;
		this.target = null;
		if (this.el) this.el.style.display = "none";
	}

	destroy(): void {
		this.cancelHide();
		this.el?.remove();
		this.el = null;
		this.target = null;
		this.editing = false;
	}

	// ---------------------------------------------------------------- 内部

	private keyOf(target: HoverTarget): string {
		return `${target.from}-${target.to}`;
	}

	private hasFocus(): boolean {
		if (!this.el) return false;
		const active = document.activeElement;
		return !!active && this.el.contains(active);
	}

	private rememberDraft(): void {
		if (!this.target || !this.textarea) return;
		const text = this.textarea.value;
		const key = this.keyOf(this.target);
		this.draft = text === this.target.body ? null : { key, text };
	}

	/** 首次显示时把 DOM 搭出来（只搭一次，之后只改内容） */
	private build(): void {
		if (this.el) return;

		const el = document.body.createDiv({ cls: "lildog-card" });
		// 定位相关的两条直接写在元素上：万一样式表没生效，浮窗也不至于被塞到页面最底下
		el.style.position = "fixed";
		el.style.zIndex = "var(--layer-popover, 30)";
		// 鼠标在浮窗上时不能收起来，否则没法点「编辑」、也没法选中文字
		el.addEventListener("mouseenter", () => this.cancelHide());
		el.addEventListener("mouseleave", () => this.scheduleHide());
		// 浮窗内的回车由 textarea 自己处理，别让它冒到编辑器的快捷键上
		el.addEventListener("keydown", (evt) => evt.stopPropagation());
		el.addEventListener("mousedown", (evt) => evt.stopPropagation());

		this.quoteEl = el.createDiv({ cls: "lildog-card-quote" });
		this.bodyEl = el.createDiv({ cls: "lildog-card-body" });
		this.bodyEl.addEventListener("click", () => this.startEditing());

		this.editWrap = el.createDiv({ cls: "lildog-card-edit" });
		const textarea = this.editWrap.createEl("textarea", { cls: "lildog-card-textarea" });
		textarea.rows = 4;
		textarea.addEventListener("keydown", (evt) => this.onTextareaKey(evt));
		this.textarea = textarea;

		const hint = this.editWrap.createDiv({ cls: "lildog-card-hint" });
		hint.setText("回车保存 · Shift + 回车换行 · Esc 取消");

		const buttons = this.editWrap.createDiv({ cls: "lildog-card-buttons" });
		const save = buttons.createEl("button", { text: "保存", cls: "mod-cta" });
		save.addEventListener("click", () => this.save());
		const cancel = buttons.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => this.cancelEditing());

		const actions = el.createDiv({ cls: "lildog-card-actions" });
		const edit = actions.createEl("button", {
			cls: "lildog-card-btn",
			attr: { type: "button" },
		});
		setIcon(edit.createSpan({ cls: "lildog-card-btn-icon" }), "pencil");
		edit.createSpan({ text: "编辑批注" });
		edit.addEventListener("click", () => this.startEditing());
		this.editButton = edit;

		this.el = el;
	}

	private render(target: HoverTarget): void {
		const quote = target.text.replace(/\s+/g, " ").trim();
		const shown = quote.length > 60 ? `${quote.slice(0, 60)}…` : quote;
		this.quoteEl?.setText(shown ? `原文：${shown}` : "");
		this.bodyEl?.setText(target.body);

		const draftText =
			this.draft && this.draft.key === this.keyOf(target) ? this.draft.text : null;
		if (this.textarea) this.textarea.value = draftText ?? target.body;
		this.setEditing(false);
	}

	private setEditing(on: boolean): void {
		this.editing = on;
		if (this.editWrap) this.editWrap.style.display = on ? "block" : "none";
		if (this.bodyEl) this.bodyEl.style.display = on ? "none" : "block";
		if (this.editButton) this.editButton.style.display = on ? "none" : "flex";
	}

	private startEditing(): void {
		if (!this.target || !this.textarea) return;
		this.cancelHide();
		this.setEditing(true);
		const textarea = this.textarea;
		window.setTimeout(() => {
			textarea.focus();
			textarea.select();
		}, 0);
	}

	private cancelEditing(): void {
		this.rememberDraft();
		this.setEditing(false);
		this.editing = false;
	}

	private onTextareaKey(evt: KeyboardEvent): void {
		if (evt.key === "Escape") {
			evt.preventDefault();
			this.cancelEditing();
			return;
		}
		if (evt.key !== "Enter") return;
		// 回车 = 保存并立刻收起（Shift + 回车才是换行）
		if (evt.shiftKey) return;
		evt.preventDefault();
		this.save();
	}

	private save(): void {
		const target = this.target;
		const body = this.textarea?.value.trim() ?? "";
		if (!target) return;
		if (!body) {
			this.textarea?.focus();
			this.textarea?.addClass("lildog-card-textarea-error");
			return;
		}
		this.textarea?.removeClass("lildog-card-textarea-error");
		this.draft = null;
		// 先收起再写回：省得写回时 DOM 变了、浮窗却还挂在那儿。
		// 这里先把 editing 落掉，否则 hide() 会把刚保存的内容又当成草稿留一份。
		this.editing = false;
		this.hide();
		this.options.onSave(target, body);
	}

	/** 贴着高亮显示：上面放不下就放下面，左右不越出窗口 */
	private place(rect: DOMRect): void {
		const el = this.el;
		if (!el) return;
		const width = el.offsetWidth || 280;
		const height = el.offsetHeight || 120;
		const gap = 8;

		const left = Math.min(
			Math.max(gap, rect.left + rect.width / 2 - width / 2),
			Math.max(gap, window.innerWidth - width - gap),
		);
		const above = rect.top - height - gap;
		const top = above >= gap ? above : Math.min(rect.bottom + gap, window.innerHeight - height - gap);

		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(Math.max(gap, top))}px`;
	}
}
