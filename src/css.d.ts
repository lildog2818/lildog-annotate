/** esbuild 用 text loader 把 styles.css 读成字符串打进 main.js */
declare module "*.css" {
	const text: string;
	export default text;
}
