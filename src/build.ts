/**
 * 构建指纹。
 *
 * esbuild 打包时会把 __LILDOG_BUILD__ 替换成构建时间。界面上显示它，
 * 就能一眼看出「Obsidian 现在跑的到底是哪一次构建」——排查插件问题时
 * 最常见的坑就是改了代码但应用没重载。
 */
declare const __LILDOG_BUILD__: string;

export const BUILD_ID: string =
	typeof __LILDOG_BUILD__ === "string" ? __LILDOG_BUILD__ : "未注入";
