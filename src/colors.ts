/**
 * 外观相关的颜色工具。
 *
 * 设置里存的是 `#rrggbb`（颜色选择器给什么就存什么），界面里要的是
 * 带透明度的 `rgba()`：底色太实会把正文盖住，太淡又看不清，
 * 所以颜色和深浅分成两个设置项。
 */

/** 批注文字默认色：和正文拉开距离，浅色主题、深色主题下都读得清 */
export const DEFAULT_TEXT_COLOR = "#d9822b";

/** 高亮底色默认色：偏紫的强调色，不会像灰底那样和正文糊在一起 */
export const DEFAULT_HIGHLIGHT_COLOR = "#7e7af5";

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** 把颜色规整成 `#rrggbb`；认不出来就退回 fallback（用户可能手填了非法值） */
export function normalizeHex(value: unknown, fallback: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	const short = /^#([0-9a-f]{3})$/i.exec(text);
	if (short) {
		const [r, g, b] = short[1].split("");
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	const full = /^#([0-9a-f]{6})$/i.exec(text);
	if (full) return `#${full[1].toLowerCase()}`;
	return fallback;
}

export function hexToRgb(hex: string): Rgb | null {
	const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return null;
	const value = parseInt(match[1], 16);
	return {
		r: (value >> 16) & 0xff,
		g: (value >> 8) & 0xff,
		b: value & 0xff,
	};
}

/** 把 `#rrggbb` 按透明度摊成 `rgba()` */
export function hexToRgba(hex: string, alpha: number): string {
	const rgb = hexToRgb(normalizeHex(hex, DEFAULT_HIGHLIGHT_COLOR)) ?? {
		r: 126,
		g: 122,
		b: 245,
	};
	const a = Math.min(1, Math.max(0, alpha));
	const text = Number.isFinite(a) ? a.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : "1";
	return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${text || "0"})`;
}

/** 数字设置项的兜底：非数字、越界都拉回合法区间 */
export function clampNumber(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}
