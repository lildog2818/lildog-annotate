import { MarkdownView, setIcon } from "obsidian";

/**
 * 选中文字后浮在选区上方的「批注」小按钮。
 *
 * 锚点用**源码偏移**而不是编辑器位置：阅读视图、编辑器里的表格（块级 widget）
 * 都拿不到编辑器选区，只能靠 DOM 里的文字反查源码，偏移是唯一通用的坐标。
 */
export interface SelectionSnapshot {
	view: MarkdownView;
	/** 选中的文字 */
	text: string;
	fromOffset: number;
	toOffset: number;
}

export class FloatingAnnotateButton {
	private el: HTMLElement | null = null;
	private snapshot: SelectionSnapshot | null = null;

	constructor(private onAction: (snapshot: SelectionSnapshot) => void) {}

	/** 点击事件是否发生在这个按钮上 */
	contains(target: EventTarget | null): boolean {
		return !!this.el && !!target && this.el.contains(target as Node);
	}

	show(snapshot: SelectionSnapshot, rect: DOMRect): void {
		this.snapshot = snapshot;
		if (!this.el) {
			const el = document.body.createDiv({ cls: "lildog-float-btn" });
			el.setAttribute("aria-label", "添加批注");
			const icon = el.createSpan({ cls: "lildog-float-icon" });
			setIcon(icon, "message-square-plus");
			el.createSpan({ cls: "lildog-float-text", text: "批注" });
			// 按下时不让编辑器/阅读视图失去选区
			el.addEventListener("mousedown", (evt) => evt.preventDefault());
			el.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				const pending = this.snapshot;
				this.hide();
				if (pending) this.onAction(pending);
			});
			this.el = el;
		}

		const el = this.el;
		el.style.display = "flex";
		const half = 44;
		const left = Math.min(
			Math.max(8, rect.left + rect.width / 2 - half),
			Math.max(8, window.innerWidth - half * 2 - 8),
		);
		const top = rect.top - 40 < 8 ? rect.bottom + 8 : rect.top - 40;
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	hide(): void {
		this.snapshot = null;
		if (this.el) this.el.style.display = "none";
	}

	destroy(): void {
		this.snapshot = null;
		this.el?.remove();
		this.el = null;
	}
}
