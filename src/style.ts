/**
 * 运行期样式注入。
 *
 * 正常情况下 Obsidian 会加载插件目录里的 styles.css；但这个「正常」并不总成立
 * （重载插件、更新插件文件、主题/片段干扰都可能让样式表不生效），一旦不生效：
 *   - 高亮拿不到颜色和底色 → 看起来「批注了但什么都没发生」
 *   - 悬停浮窗拿不到 `position: fixed` → 被塞到页面最底下，看起来「没有浮窗」
 * 排查这种问题很费劲，所以样式表的内容由构建时打进 main.js，插件加载时直接
 * 注入一份（比 Obsidian 加载的那份晚、又有 !important，冲突时以它为准）。
 */
import cssText from "../styles.css";

const STYLE_ID = "lildog-annotate-runtime-style";

export function injectStyles(): void {
	const head = document.head ?? document.body;
	if (!head) return;
	let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
	if (!el) {
		el = document.createElement("style");
		el.id = STYLE_ID;
		head.appendChild(el);
	}
	el.textContent = cssText;
}

export function removeStyles(): void {
	document.getElementById(STYLE_ID)?.remove();
}

/** 给自检报告用：界面里到底有没有这份样式 */
export function hasInjectedStyles(): boolean {
	return !!document.getElementById(STYLE_ID)?.textContent?.includes(".lildog-ann");
}

/** 当前样式表里跟 lildog 有关的规则条数（判断 Obsidian 那份加载了没） */
export function countLildogRules(): number {
	let count = 0;
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList | null = null;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		if (!rules) continue;
		for (const rule of Array.from(rules)) {
			if (rule.cssText?.includes("lildog")) count++;
		}
	}
	return count;
}
