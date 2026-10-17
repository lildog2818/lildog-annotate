import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorPosition } from "obsidian";
import { hexToRgba } from "./colors";
import {
	blockInsertLine,
	canUseInlineInTable,
	explainInlineRefusal,
	extendToBalanceBackticks,
	findBlockAtLine,
	findInlineAnnotations,
	isAnnotationInTable,
	MARKER,
	planLegacyMigration,
	serializeBlock,
	serializeBlockWithQuote,
	serializeInline,
} from "./format";
import { AnnotateModal } from "./modal";
import { BUILD_ID } from "./build";
import { diag } from "./diagnostics";
import { FloatingAnnotateButton } from "./floating";
import type { SelectionSnapshot } from "./floating";
import {
	currentDomRange,
	isCellSelection,
	reanchorInCell,
	resolveCursorCell,
	resolveDomSelection,
	resolveEditorSelection,
} from "./anchor";
import type { ResolvedAnchor } from "./anchor";
import {
	createAtomicRanges,
	createCursorGuard,
	createWidgetHighlighter,
} from "./decorations";
import { createEditorDecorations, decorateReadingView, redecorateTableCells } from "./hover";
import { HoverCard } from "./hovercard";
import type { HoverTarget } from "./hovercard";
import { rectUnderPointer, resolveHighlight } from "./resolve";
import { isOffsetOnDelimiterRow } from "./tablemap";
import { writeSelfCheckReport } from "./selfcheck";
import { DEFAULT_SETTINGS, LildogSettingTab, sanitizeSettings } from "./settings";
import type { AnnotationMode, LildogSettings } from "./settings";
import { injectStyles, removeStyles } from "./style";

/** 光标位置处找到的一条批注 */
interface FoundAnnotation {
	kind: AnnotationMode;
	from: EditorPosition;
	to: EditorPosition;
	/** 被批注的原文 */
	text: string;
	/** 批注内容 */
	body: string;
}

/** 落盘时要知道改动写在哪个视图里（阅读视图得自己写文件） */
interface PersistContext {
	view?: MarkdownView;
}

function describeTarget(target: HTMLElement | null): string {
	if (!target) return "null";
	const cls =
		target.className && typeof target.className === "string"
			? `.${target.className.trim().split(/\s+/).slice(0, 3).join(".")}`
			: "";
	return `${target.tagName.toLowerCase()}${cls}`;
}

export default class LildogAnnotatePlugin extends Plugin {
	settings: LildogSettings = { ...DEFAULT_SETTINGS };
	private floating: FloatingAnnotateButton | null = null;
	private hoverCard: HoverCard | null = null;
	/** 刚写完批注的一小段时间里不弹浮窗（见 persist） */
	private hoverSuppressedUntil = 0;
	/** 表格高亮补画的定时器（见 scheduleTableRedecorate） */
	private tableRedecorateTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		// 样式自己注入一份：不依赖 Obsidian 有没有（或者是不是最新的）加载 styles.css
		injectStyles();
		this.addSettingTab(new LildogSettingTab(this.app, this));
		this.applyAppearance();

		// 批注记号（编辑器）：标记藏起来 + 被批注的文字上色。
		// 原子区间 + 光标守门员：光标进不到（也不会留在）藏起来的标记里，
		// 否则标记会整条露在正文里
		this.registerEditorExtension([
			createEditorDecorations(),
			createAtomicRanges(),
			createCursorGuard(),
			createWidgetHighlighter(),
		]);
		// 阅读视图：给每个段落打上行号范围（阅读视图里按文字反查源码要用），
		// 并把批注对应的文字找出来上色、记下源码偏移
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const info = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
			if (info) {
				el.dataset.lildogStart = String(info.lineStart);
				el.dataset.lildogEnd = String(info.lineEnd);
			}
			await decorateReadingView(el, ctx, this.app);
		});

		this.addCommand({
			id: "add-annotation",
			name: "添加批注",
			icon: "message-square-plus",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "A" }],
			editorCallback: (editor) => this.addAnnotation(editor),
		});
		this.addCommand({
			id: "edit-annotation",
			name: "编辑光标处的批注",
			icon: "pencil",
			editorCallback: (editor) => this.editAnnotation(editor),
		});
		this.addCommand({
			id: "delete-annotation",
			name: "删除光标处的批注",
			icon: "trash",
			editorCallback: (editor) => this.deleteAnnotation(editor),
		});
		this.addCommand({
			id: "migrate-legacy",
			name: "把旧格式批注转成新格式",
			icon: "wand-2",
			editorCallback: (editor) => this.migrateLegacy(editor),
		});
		this.addCommand({
			id: "run-self-check",
			name: "运行自检（把诊断报告写进库里的 DSH 目录）",
			icon: "stethoscope",
			callback: async () => {
				// 写报告本身也可能失败（库被别的进程占着、DSH 目录建不出来）：
				// 那样至少要说一声，别让命令看起来「点了没反应」
				try {
					const path = await writeSelfCheckReport(
						this.app,
						this.manifest.version,
						this.settings,
					);
					new Notice(`自检报告已写入：${path}\n构建：${BUILD_ID}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error("[lildog-annotate] 写自检报告失败", error);
					new Notice(`自检报告没有写成：${message}`);
				}
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {

				if (editor.somethingSelected()) {
					menu.addItem((item) =>
						item
							.setTitle("添加批注")
							.setIcon("message-square-plus")
							.onClick(() => this.addAnnotation(editor)),
					);
				}
				const target = this.findAnnotation(editor);
				if (target) {
					menu.addItem((item) =>
						item
							.setTitle("编辑这条批注")
							.setIcon("pencil")
							.onClick(() => this.editAnnotation(editor, target)),
					);
					menu.addItem((item) =>
						item
							.setTitle("删除这条批注")
							.setIcon("trash")
							.onClick(() => this.deleteAnnotation(editor, target)),
					);
				}
			}),
		);

		// 悬停浮窗：内容直接可改，回车即收
		this.hoverCard = new HoverCard({
			fontSize: () => this.settings.cardFontSize,
			onSave: (target, body) => this.saveFromCard(target, body),
			onDelete: (target) => this.deleteFromCard(target),
		});
		this.register(() => this.hoverCard?.destroy());

		// 选中文字后的浮动按钮
		this.floating = new FloatingAnnotateButton((snapshot) =>
			this.annotateSnapshot(snapshot),
		);
		this.register(() => this.floating?.destroy());
		this.registerDomEvent(document, "mouseup", (evt) => this.handleMouseUp(evt));

		this.registerDomEvent(document, "mouseover", (evt) => this.handleHoverStart(evt), true);
		this.registerDomEvent(document, "mouseout", (evt) => this.handleHoverEnd(evt), true);
		this.registerDomEvent(
			document,
			"keydown",
			(evt) => {
				// 回车 / Esc 之后浮窗立刻收起来，不用再去点别的地方
				if (evt.key !== "Enter" && evt.key !== "Escape") return;
				if (this.hoverCard?.contains(evt.target as Node)) return;
				this.hoverCard?.hide();
				this.scheduleTableRedecorate();
			},
			true,
		);
		this.registerDomEvent(document, "mousedown", (evt) => {
			if (!this.floating?.contains(evt.target)) this.floating?.hide();
			if (!this.hoverCard?.contains(evt.target as Node)) this.hoverCard?.hide();
		});
		this.registerDomEvent(
			window,
			"scroll",
			() => {
				this.floating?.hide();
				this.hoverCard?.hide();
			},
			{ capture: true },
		);
		// 正文一变（打字、撤销、别的插件改动），浮窗里的偏移就失效了，直接收起
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				this.hoverCard?.hide();
				this.scheduleTableRedecorate();
			}),
		);
	}

	onunload(): void {
		if (this.tableRedecorateTimer !== null) window.clearTimeout(this.tableRedecorateTimer);
		this.clearAppearance();
		removeStyles();
	}

	// ---------------------------------------------------------------- 外观

	/** 把设置里的颜色 / 字号写进 CSS 变量：样式表只管用变量，不再有硬编码颜色 */
	applyAppearance(): void {
		const style = document.body.style;
		const { annotatedTextColor, highlightColor, highlightOpacity } = this.settings;
		style.setProperty("--lildog-annotate-fg", annotatedTextColor);
		style.setProperty(
			"--lildog-annotate-bg",
			hexToRgba(highlightColor, highlightOpacity),
		);
		style.setProperty(
			"--lildog-annotate-line",
			hexToRgba(highlightColor, Math.min(1, highlightOpacity + 0.45)),
		);
		style.setProperty("--lildog-card-font-size", `${this.settings.cardFontSize}px`);
		this.hoverCard?.refreshStyle();
	}

	private clearAppearance(): void {
		const style = document.body.style;
		for (const name of [
			"--lildog-annotate-fg",
			"--lildog-annotate-bg",
			"--lildog-annotate-line",
			"--lildog-card-font-size",
		]) {
			style.removeProperty(name);
		}
	}

	/** 设置页改了东西后让它立刻生效（也顺手把浮窗收掉，免得看到旧样式） */
	hideHoverCard(): void {
		this.hoverCard?.hide();
	}

	// ---------------------------------------------------------------- 悬停浮窗

	private handleHoverStart(evt: MouseEvent): void {
		const card = this.hoverCard;
		if (!card) return;
		const node = evt.target;
		if (!(node instanceof Element)) return;
		if (card.contains(node)) {
			card.cancelHide();
			return;
		}
		if (!this.settings.hoverPreview) return;
		// 刚保存/刚删完的一小段时间里不弹：否则卡片一消失，鼠标底下那条高亮
		// 会立刻把浮窗又唤回来，看起来就像「回车没能关掉浮窗」
		if (Date.now() < this.hoverSuppressedUntil) return;

		const el = node.closest(".lildog-ann") as HTMLElement | null;
		if (!el) return;

		const target = this.resolveHoverTarget(el, evt);
		if (!target) {
			diag.hoverMisses++;
			return;
		}
		diag.hoverShows++;
		diag.lastHover = `${target.view.getMode() === "preview" ? "阅读视图" : "编辑器"} · 原文「${target.text.slice(0, 20)}」 · 批注「${target.body.slice(0, 20)}」`;
		// 用鼠标底下那一块的矩形定位：高亮折行时 getBoundingClientRect 会是一个跨行大盒子
		card.show(target, rectUnderPointer(el, evt.clientX, evt.clientY));
	}

	private handleHoverEnd(evt: MouseEvent): void {
		const node = evt.target;
		if (!(node instanceof Element)) return;
		const el = node.closest(".lildog-ann");
		if (!el) return;
		const to = evt.relatedTarget as Node | null;
		if (to && (el.contains(to) || this.hoverCard?.contains(to))) return;
		this.hoverCard?.scheduleHide();
	}

	/**
	 * 从悬停到的高亮元素倒推出是哪一条批注。
	 *
	 * 解析过程交给 resolveHighlight（它会把「为什么没解析出来」记进 diag，
	 * 自检报告里能直接看到）。
	 */
	private resolveHoverTarget(
		el: HTMLElement,
		evt?: MouseEvent,
	): HoverTarget | null {
		const view = this.markdownViewFor(el);
		if (!view) {
			diag.lastHover = `悬停到高亮，但没找到它属于哪个 Markdown 窗格（${describeTarget(el)}）`;
			return null;
		}
		const doc = view.editor.getValue();
		const resolved = resolveHighlight(el, doc);
		diag.lastHoverResolve = resolved.reason;
		if (!resolved.annotation) {
			diag.lastHover = `悬停到高亮但认不出是哪条批注：${resolved.reason}`;
			return null;
		}
		const ann = resolved.annotation;
		return { view, from: ann.from, to: ann.to, text: ann.text, body: ann.body };
	}

	/** 浮窗里点了保存：把新的批注内容写回笔记 */
	private saveFromCard(target: HoverTarget, body: string): void {
		const editor = target.view.editor;
		const doc = editor.getValue();
		const ann = findInlineAnnotations(doc).find(
			(item) => item.from === target.from && item.to === target.to,
		);
		if (!ann) {
			new Notice("这条批注已经变化，请重新悬停后再改");
			return;
		}
		const replacement = serializeInline(ann.text, body, {
			inTable: isAnnotationInTable(doc, ann.from),
		});
		editor.replaceRange(
			replacement,
			editor.offsetToPos(ann.from),
			editor.offsetToPos(ann.to),
		);
		// 光标落在整条批注之后：标记立刻收起，不用再点别处
		editor.setCursor(editor.offsetToPos(ann.from + replacement.length));
		this.persist(editor, { view: target.view });
		diag.hoverEdits++;
	}

	/** 浮窗里点了删除（或把内容清空后回车）：去掉这条批注，原文留下 */
	private deleteFromCard(target: HoverTarget): void {
		const editor = target.view.editor;
		const found = this.findAnnotationAt(editor, target);
		if (!found) {
			new Notice("这条批注已经变化，请重新悬停后再删");
			return;
		}
		this.deleteAnnotation(editor, found, target.view);
		new Notice("已删除这条批注");
	}

	/** 按源码区间在编辑器里找回这条批注（浮窗上的偏移可能已经过期） */
	private findAnnotationAt(
		editor: Editor,
		target: { from: number; to: number },
	): FoundAnnotation | null {
		const doc = editor.getValue();
		const ann = findInlineAnnotations(doc).find(
			(item) => item.from === target.from && item.to === target.to,
		);
		if (!ann) return null;
		return {
			kind: "inline",
			from: editor.offsetToPos(ann.from),
			to: editor.offsetToPos(ann.to),
			text: ann.text,
			body: ann.body,
		};
	}

	/** 高亮元素属于哪个 Markdown 窗格（编辑器可能被拖到别的叶子里） */
	private markdownViewFor(el: Element): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(el)) {
				return view;
			}
		}
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	// ---------------------------------------------------------------- 入口

	/** 选区上方的小按钮被点击：这一刻才把 DOM 选区翻译成源码偏移 */
	private annotateSnapshot(snapshot: SelectionSnapshot): void {
		const editor = snapshot.view.editor;
		let anchor = snapshot.anchor;
		if (!anchor) {
			if (!snapshot.range) return;
			// 不去动编辑器焦点、也不预先设置编辑器选区：
			// 那一步会主动把光标推进表格，反而让 Obsidian 去重建表格
			const resolved = resolveDomSelection(snapshot.view, editor, snapshot.range);
			if (!resolved.ok) {
				new Notice(`${resolved.reason}\n${resolved.hint}`);
				diag.lastSelection = `拒绝写入：${resolved.reason}`;
				return;
			}
			anchor = resolved.anchor;
		}
		diag.lastSelection = `定位成功：${anchor.how}`;
		this.openComposer(editor, anchor);
	}

	private addAnnotation(editor: Editor): void {
		this.floating?.hide();
		this.hoverCard?.hide();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("当前没有 Markdown 视图");
			return;
		}

		const domRange = currentDomRange();
		// 浏览器里正选着格子里的字（表格是块级 widget，这时编辑器选区可能还停在别处）：
		// 那条路交给 DOM 定位。浏览器里没有选区时，编辑器选区就是唯一可信的来源 ——
		// 别因为它「在表格行里」就拒绝：整行选区走的正是这条路。
		const direct = isCellSelection(domRange)
			? null
			: resolveEditorSelection(view, editor, editor.getSelection());
		if (direct?.ok) {
			this.openComposer(editor, direct.anchor);
			return;
		}

		if (domRange) {
			const resolved = resolveDomSelection(view, editor, domRange);
			if (resolved.ok) {
				this.openComposer(editor, resolved.anchor);
				return;
			}
			new Notice(`${resolved.reason}\n${resolved.hint}`);
			diag.lastSelection = `拒绝写入：${resolved.reason}`;
			return;
		}

		// 什么都没选：光标停在表格单元格里就批注整格
		// （实时预览里跨格拖选会被 Obsidian 的格子编辑器接管，这条入口不看鼠标）
		const byCell = resolveCursorCell(view, editor);
		if (byCell?.ok) {
			this.openComposer(editor, byCell.anchor);
			return;
		}
		if (byCell && !byCell.ok) {
			new Notice(`${byCell.reason}\n${byCell.hint}`);
			return;
		}

		new Notice("请先选中要批注的文字（光标停在表格单元格里也行：会批注整格）");
	}

	/**
	 * 选中文字后决定要不要浮出按钮。
	 *
	 * 编辑器里的普通选区偏移本来就是准的，当场定下来；表格（块级 widget）和阅读视图里
	 * 编辑器选区拿不到，就只记下 DOM 选区，等点按钮那一刻再算 —— 这中间表格可能刚被
	 * Obsidian 重建过，早算的偏移会过期。算不准的时候按钮点下去会明确告诉你为什么，
	 * 而**不会**写到别的位置去。
	 */
	private handleMouseUp(evt: MouseEvent): void {
		if (!this.settings.showFloatingButton) {
			diag.lastSelection = "设置里关掉了「选中文字后浮出批注按钮」";
			return;
		}

		const selection = window.getSelection();
		const collapsed =
			!selection || selection.rangeCount === 0 || selection.isCollapsed;
		const domText = collapsed ? "" : selection!.toString();
		const range = collapsed ? null : selection!.getRangeAt(0);
		const rect = range ? range.getBoundingClientRect() : null;

		const target = evt.target as HTMLElement | null;
		const inEditor = !!target?.closest(".cm-editor");
		const inCell = !!target?.closest("td, th");
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor ?? null;

		let action: string;
		let snapshot: SelectionSnapshot | null = null;

		if (collapsed || !domText.trim()) {
			action = "浏览器里没有选区";
		} else if (!view || !editor) {
			action = "当前没有 Markdown 视图";
		} else if (!rect) {
			action = "拿不到选区矩形";
		} else if (inEditor && !inCell) {
			const direct = resolveEditorSelection(view, editor, domText);
			if (direct?.ok) {
				snapshot = { view, text: direct.anchor.text, anchor: direct.anchor, range: null };
				action = `浮出按钮（${direct.anchor.how}）`;
			} else {
				// 编辑器选区是旧的（跟 DOM 里选中的对不上）：改用 DOM 选区，点按钮时再算
				snapshot = {
					view,
					text: domText,
					anchor: null,
					range: range!.cloneRange(),
				};
				action = "浮出按钮（编辑器选区对不上，改按 DOM 选区定位）";
			}
		} else {
			snapshot = { view, text: domText, anchor: null, range: range!.cloneRange() };
			action = inCell
				? "浮出按钮（表格单元格：点按钮时再定位）"
				: "浮出按钮（阅读视图：点按钮时再定位）";
		}

		diag.lastSelection =
			`target=${describeTarget(target)} | 在编辑器内=${inEditor} | 在单元格内=${inCell} | ` +
			`浏览器选区折叠=${collapsed} | 矩形=${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "无"} | ` +
			`模式=${view ? view.getMode() : "无"} | 动作=${action}`;

		// 点开表格外面时，Obsidian 会把格子的缓存渲染顶上来：这里排队补画一次高亮
		// （拖选中（选区没塌）先不打扰，免得插节点影响正在进行的选区）
		const live = window.getSelection();
		if (!live || live.isCollapsed) this.scheduleTableRedecorate();

		if (!snapshot || !rect) return;
		this.floating?.show(snapshot, rect);
	}

	// ---------------------------------------------------------------- 写入

	private openComposer(editor: Editor, anchor: ResolvedAnchor): void {
		// 分隔行是整张表的地基（`| --- | --- |` 里那一格必须长这样），批注它没有意义，
		// 写进去还会让**整张表立刻不成表**。四种入口都从这里过，所以在这里一口回绝。
		if (isOffsetOnDelimiterRow(editor.getValue(), anchor.fromOffset)) {
			new Notice("这里是表格的分隔行（`| --- | --- |`），不能批注。请选中表格里的内容。");
			return;
		}

		let mode = this.settings.mode;
		if (mode === "inline") {
			// 表格里、或者文字本身就不适合行内时，改用段落批注 —— 判据只有 explainInlineRefusal 一处
			const refusal = explainInlineRefusal(
				editor.getValue(),
				anchor.fromOffset,
				anchor.text,
			);
			if (refusal) {
				mode = "block";
				new Notice(
					`${refusal}，已改用段落批注${anchor.crossCell ? "（会插在整张表之后）" : ""}`,
				);
			}
		}

		// 表格格子被点开时里面有个嵌套编辑器，它会跟弹窗抢焦点（字会打进格子里）。
		// 先让它失焦：Obsidian 会顺势把那一格提交、把表格重排 —— 偏移过期由
		// insertAnnotation 里的「同一格里重新对位」兜住。
		const active = document.activeElement as HTMLElement | null;
		if (active && active.closest?.("td, th")) active.blur();

		// 记下当前看到哪儿了：弹窗关掉（尤其是没保存那次）以后要还回去，
		// 否则焦点回到编辑器时会滚到光标那儿去 —— 看着就像「光标跳到笔记开头」
		const view = anchor.view;
		const scroll = view ? view.editor.getScrollInfo() : null;
		const previewScroller =
			view && view.getMode() === "preview"
				? (view.containerEl.querySelector(".markdown-preview-view") as HTMLElement | null)
				: null;
		const previewTop = previewScroller?.scrollTop ?? null;

		new AnnotateModal(this.app, {
			title: mode === "inline" ? "添加行内批注" : "添加段落批注",
			quote: anchor.text,
			// 写入过程别把异常吞掉：吞掉的后果正是「点了保存，什么都没发生」
			onSubmit: (body) => {
				try {
					this.insertAnnotation(editor, mode, anchor, body);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error("[lildog-annotate] 写入批注失败", error);
					new Notice(`批注没有写入：${message}`);
				}
			},
			onClose: (saved) => {
				if (saved) return;
				this.restoreScroll(view ?? null, scroll, previewScroller, previewTop);
			},
		}).open();
	}

	/** 把取消弹窗前的滚动位置还回去（推迟一点，等 Obsidian 把焦点还完再摆） */
	private restoreScroll(
		view: MarkdownView | null,
		scroll: { top: number; left: number } | null,
		previewScroller: HTMLElement | null,
		previewTop: number | null,
	): void {
		const restore = () => {
			try {
				if (view && scroll) view.editor.scrollTo(scroll.left, scroll.top);
				if (previewScroller && previewTop !== null) {
					previewScroller.scrollTop = previewTop;
				}
			} catch {
				// 视图可能已经被关掉了，忽略
			}
		};
		// 摆几次：Obsidian 把焦点还给编辑器时会「滚到光标那儿」，
		// 只摆一次会被它盖掉（笔记越长越明显）
		for (const delay of [30, 160, 420]) window.setTimeout(restore, delay);
	}

	/**
	 * 取锚点当前的偏移。
	 *
	 * 锚点是在点「批注」按钮那一刻算的，弹窗期间正文可能已经变了：表格格子被点开时
	 * Obsidian 会在格子里开嵌套编辑器，弹窗一抢焦点它就提交那一格、顺手把整张表重排，
	 * 偏移整体平移 —— 这时候直接用旧偏移就会「批注不起」。
	 * 表格锚点记着格号，能在**同一格**里重新对位；对不上就返回 null（拒绝写入，不猜）。
	 */
	private freshOffsets(
		editor: Editor,
		anchor: ResolvedAnchor,
	): { fromOffset: number; toOffset: number } | null {
		const doc = editor.getValue();
		if (doc.slice(anchor.fromOffset, anchor.toOffset) === anchor.text) {
			return { fromOffset: anchor.fromOffset, toOffset: anchor.toOffset };
		}
		if (!anchor.cell) return null;
		const fixed = reanchorInCell(doc, anchor.cell, anchor.text);
		if (!fixed) return null;
		diag.lastSelection = `偏移过期，已在同一格里重新对位：${fixed.from}-${fixed.to}`;
		return { fromOffset: fixed.from, toOffset: fixed.to };
	}

	private insertAnnotation(
		editor: Editor,
		mode: AnnotationMode,
		anchor: ResolvedAnchor,
		body: string,
	): void {
		const doc = editor.getValue();

		this.hoverCard?.hide();

		// 先按锚点取当前偏移：弹窗开着的时候表格可能被 Obsidian 重排过，
		// 偏移会整体平移（下面「已经是某条批注的一部分」的判定也得用新偏移，否则
		// 拿旧偏移去比会误判成嵌套、或者漏判）
		const offsets = this.freshOffsets(editor, anchor);
		if (!offsets) {
			new Notice("原文已经变化，批注没有写入，请重新选中");
			return;
		}

		// 已经是某条批注的一部分，就别再套一层（嵌套标记会把解析搞乱）
		const nested = findInlineAnnotations(doc).find(
			(ann) => offsets.fromOffset < ann.to && offsets.toOffset > ann.from,
		);
		if (nested) {
			new Notice("这段文字已经在一条批注里了");
			return;
		}

		if (mode === "inline") {
			// 选区带反引号但没配对时，把结尾补上，别把代码块劈开
			const toOffset = extendToBalanceBackticks(doc, offsets.fromOffset, offsets.toOffset);
			// 表格行里：正文里的 `|` 必须转义，否则会把那一行多切一格
			const replacement = serializeInline(doc.slice(offsets.fromOffset, toOffset), body, {
				inTable: anchor.inTable,
			});
			editor.replaceRange(
				replacement,
				editor.offsetToPos(offsets.fromOffset),
				editor.offsetToPos(toOffset),
			);
			// 光标停在整条批注之后：标记马上就藏起来，不用再点一下别的地方
			editor.setCursor(editor.offsetToPos(offsets.fromOffset + replacement.length));
			this.persist(editor, anchor);
			return;
		}

		const lines = editor.getValue().split("\n");
		const insertAt = blockInsertLine(lines, editor.offsetToPos(offsets.toOffset).line);
		const block = serializeBlock(anchor.text, body);
		const blockLines = block.split("\n");
		const tail = blockLines[blockLines.length - 1];

		if (insertAt >= lines.length) {
			const last = lines.length - 1;
			editor.replaceRange("\n" + block, {
				line: last,
				ch: lines[last].length,
			});
			editor.setCursor({ line: last + blockLines.length, ch: tail.length });
		} else {
			editor.replaceRange(block + "\n", { line: insertAt, ch: 0 });
			editor.setCursor({
				line: insertAt + blockLines.length - 1,
				ch: tail.length,
			});
		}
		this.persist(editor, anchor);
	}

	/**
	 * 把改动落盘。
	 * 编辑器里 requestSave 就够了；阅读视图里编辑器不是当前显示的视图，
	 * Obsidian 不会自动保存，得直接写一遍文件（内容和编辑器内存一致）。
	 */
	private persist(editor: Editor, context: PersistContext): void {
		// 刚写完/删完的这一刻别再弹浮窗：卡片一消失，鼠标底下往往正好是
		// 另一条高亮，浮窗会「啪」地又冒出来，看着就像没关掉
		this.hoverSuppressedUntil = Date.now() + 450;
		const view = context.view;
		if (!view) return;
		if (view.getMode() === "preview" && view.file) {
			void this.app.vault
				.modify(view.file, editor.getValue())
				.then(() => this.refreshReadingView(view));
			return;
		}
		view.requestSave?.();
		this.scheduleTableRedecorate(60);
	}

	/**
	 * 表格高亮的「补画」。
	 *
	 * Obsidian 的表格 widget 会缓存每个格子渲染出来的 DOM。你进过某一格（它开嵌套编辑器、
	 * 把渲染态藏起来），离开时它把**编辑前那份缓存**显示回来 —— 那份是批注存在之前渲染的，
	 * 后处理器不会再跑，表现就是「批注过了，点开表格外面格子里就没有高亮」。
	 *
	 * 所以几个「缓存可能刚被顶上来」的时刻都排一次补画：鼠标点完、回车/Esc、正文变动、
	 * 写完批注。补画是幂等的，重复跑不会套两层。
	 */
	private scheduleTableRedecorate(delay = 200): void {
		if (this.tableRedecorateTimer !== null) window.clearTimeout(this.tableRedecorateTimer);
		this.tableRedecorateTimer = window.setTimeout(() => {
			this.tableRedecorateTimer = null;
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) continue;
				if (view.getMode() === "preview") continue;
				const doc = view.editor.getValue();
				if (!doc.includes(MARKER)) continue;
				// 界面上没有渲染出来的表格就没什么可补的（正文一变就会走到这儿）
				if (!view.containerEl.querySelector("td, th")) continue;
				redecorateTableCells(view.containerEl, doc);
			}
		}, delay);
	}

	/**
	 * 阅读视图里改写文件后，让它按新内容重画一遍。
	 *
	 * 批注高亮是渲染时由插件加上去的：不重画，这一段就一直是旧样子 ——
	 * 表现正是「批注明明写进去了，却看不到高亮、也悬停不出浮窗」。
	 */
	private refreshReadingView(view: MarkdownView): void {
		const preview = view.previewMode as unknown as {
			rerender?: (full?: boolean) => void;
			renderer?: { rerender?: () => void };
		} | null;
		try {
			if (typeof preview?.rerender === "function") preview.rerender(true);
			else if (typeof preview?.renderer?.rerender === "function") {
				preview.renderer.rerender();
			}
		} catch {
			// 内部接口：拿不到就算了，下次重画时高亮照样会出现
		}
	}

	// ---------------------------------------------------------------- 查找

	private findAnnotation(editor: Editor): FoundAnnotation | null {
		const doc = editor.getValue();
		const cursor = editor.posToOffset(editor.getCursor());

		for (const ann of findInlineAnnotations(doc)) {
			if (cursor >= ann.from && cursor <= ann.to) {
				return {
					kind: "inline",
					from: editor.offsetToPos(ann.from),
					to: editor.offsetToPos(ann.to),
					text: ann.text,
					body: ann.body,
				};
			}
		}

		const lines = doc.split("\n");
		const block = findBlockAtLine(lines, editor.getCursor().line);
		if (block) {
			return {
				kind: "block",
				from: { line: block.startLine, ch: 0 },
				to: { line: block.endLine, ch: lines[block.endLine].length },
				text: block.quote,
				body: block.body,
			};
		}
		return null;
	}

	// ---------------------------------------------------------------- 改写

	private editAnnotation(editor: Editor, target?: FoundAnnotation): void {
		const found = target ?? this.findAnnotation(editor);
		if (!found) {
			new Notice("光标所在位置没有批注");
			return;
		}

		new AnnotateModal(this.app, {
			title: found.kind === "inline" ? "编辑行内批注" : "编辑段落批注",
			quote: found.text,
			value: found.body,
			// 空内容 = 想删掉它；弹窗里也有明确的「删除这条批注」按钮
			onDelete: () => this.deleteAnnotation(editor, found),
			onSubmit: (body) => {
				const current = editor.getRange(found.from, found.to);
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
				const fromOffset = editor.posToOffset(found.from);
				const toOffset = editor.posToOffset(found.to);
				if (found.kind === "inline") {
					if (!current.includes("lildog")) {
						new Notice("这条批注已经变化，请重试");
						return;
					}
					const replacement = serializeInline(found.text, body, {
						inTable: isAnnotationInTable(editor.getValue(), fromOffset),
					});
					editor.replaceRange(replacement, found.from, found.to);
					// 光标挪到批注之后：标记立刻收起，不用再点别的地方
					editor.setCursor(editor.offsetToPos(fromOffset + replacement.length));
				} else {
					if (!current.includes("[!lildog]")) {
						new Notice("这条批注已经变化，请重试");
						return;
					}
					editor.replaceRange(
						serializeBlockWithQuote(found.text, body),
						found.from,
						found.to,
					);
				}
				// 阅读视图里必须自己写一遍文件（编辑器不是当前显示的视图）
				this.persist(editor, { view });
			},
		}).open();
	}

	private deleteAnnotation(
		editor: Editor,
		target?: FoundAnnotation,
		view?: MarkdownView,
	): void {
		const found = target ?? this.findAnnotation(editor);
		if (!found) {
			new Notice("光标所在位置没有批注");
			return;
		}
		// 阅读视图里编辑器不是当前显示的视图，Obsidian 不会自动保存，
		// 得自己写一遍文件 —— 否则「删了但文件里还在」，下次打开又冒出来
		const fileView = view ?? this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;

		if (found.kind === "inline") {
			const current = editor.getRange(found.from, found.to);
			if (!current.includes("lildog")) {
				new Notice("这条批注已经变化，请重试");
				return;
			}
			const fromOffset = editor.posToOffset(found.from);
			const toOffset = editor.posToOffset(found.to);
			// 只去掉批注，原文留下
			editor.replaceRange(found.text, found.from, found.to);
			editor.setCursor(editor.offsetToPos(fromOffset + found.text.length));
			this.persist(editor, { view: fileView });
			return;
		}

		const lines = editor.getValue().split("\n");
		if (found.to.line + 1 < lines.length) {
			editor.replaceRange("", found.from, {
				line: found.to.line + 1,
				ch: 0,
			});
		} else {
			editor.replaceRange("", found.from, found.to);
		}
		this.persist(editor, { view: fileView });
	}

	// ---------------------------------------------------------------- 迁移

	/** 把早期版本写下的 ==原文==<!-- lildog: … --> 转成现行格式 */
	private migrateLegacy(editor: Editor): void {
		const doc = editor.getValue();
		const legacy = findInlineAnnotations(doc).filter(
			(ann) => ann.format === "legacy",
		);
		if (!legacy.length) {
			new Notice("这篇笔记里没有旧格式批注");
			return;
		}

		// 从后往前替换，前面的偏移才不会被搅乱
		let migrated = 0;
		let skipped = 0;
		for (const ann of legacy.slice().reverse()) {
			const plan = planLegacyMigration(doc, ann);
			// 转成新格式会把标记搬到原文**前面**：落在表格行首 / 分隔行上时那一行
			// 就不再是表格行（实测 Obsidian 会把表断开）。这种就留着不动，最后报给用户。
			if (!canUseInlineInTable(doc, plan.from, plan.text)) {
				skipped++;
				continue;
			}
			editor.replaceRange(
				plan.replacement,
				editor.offsetToPos(plan.from),
				editor.offsetToPos(plan.to),
			);
			migrated++;
		}
		new Notice(
			skipped
				? `已转换 ${migrated} 条旧格式批注；${skipped} 条在表格行首（转换会把表格断开），已跳过`
				: `已把 ${migrated} 条旧格式批注转成新格式`,
		);
	}

	// ---------------------------------------------------------------- 设置

	async loadSettings(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
