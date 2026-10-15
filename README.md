# Lildog Annotate

选中文字就能加批注的 Obsidian 插件。批注是**笔记正文里的纯文本**，不依赖插件的数据库 —— 卸载插件、换台电脑、用别的编辑器打开，批注都还在；AI 助手也能直接读到你的疑问。

界面全中文，功能只有三件事：**加批注、看批注、改或删批注**。

## 使用

1. 在编辑器**或阅读视图**里选中一段文字
2. 选区上方浮出「批注」按钮，点它（编辑器里也可以按 `Ctrl/Cmd + Shift + A`，或右键 → 添加批注）
3. 写内容，`Ctrl/Cmd + Enter` 保存

阅读视图里也能直接批注：插件用你选中的文字反查源码，再写进文件（实时预览里被渲染成表格、引用块的内容同样如此）。

改或删：把光标放进批注里，右键选「编辑这条批注 / 删除这条批注」。

鼠标停在带批注的文字上会弹出批注内容（编辑器和阅读视图都支持）。

## 批注在文件里长什么样

两种形式，设置里切换。

### 行内批注（默认）

```markdown
反向传播懂了，但<!--lildog: 为什么层数一深就衰减？-->梯度消失<!--/lildog-->没想通。
```

- 原文被两段标记包住，**一个字都没被改动**；被批注的文字由插件自己渲染成一层干净的底色高亮（想换颜色：覆盖 CSS 变量 `--lildog-annotate-bg`）
- 两段标记在编辑器和阅读视图里都看不见；光标碰到这条批注时才会露出来，方便直接改
- 高亮就是悬停的落点，鼠标停上去弹出批注内容

> [!IMPORTANT] 为什么不用 `==原文==` 包住
> Obsidian 自己解析不了跨等号的 `==a = b==`（实时预览里配不上对），落单的 `==` 还会跟文档后面别的 `==` 配对，把一大段文字错误地点亮。批注公式、代码时这个坑必踩，所以高亮由插件自己渲染，不再依赖 Obsidian 的行内语法。副作用是：含 `=`、反引号、甚至 `==` 的文字都能随便批注了。
>
> v1.0 / v1.1 写过旧格式，插件仍然能读、能编辑、能删除；命令面板里有「**把旧格式批注转成新格式**」一键迁移（会自动把选区漏掉的收尾反引号补回来，避免代码块被劈开）。

### 段落批注

```markdown
链式求导本身不难，难的是它和计算图的关系。

> [!lildog] 批注
> 原文：它和计算图的关系
>
> 计算图是「先建好整张图再反向」，还是「边前向边记录」？
```

- 原文一个字都不动，疑问直接显示在原文后面
- `[!lildog]` 是这个插件专属的 callout 类型，样式由插件提供

两种形式都用 `lildog` 作为标记，所以一条命令就能捞出全库批注：

```bash
grep -rn "lildog" .            # 全部批注
grep -rn "lildog:" .           # 只要行内批注
grep -rn "\[!lildog\]" .       # 只要段落批注
```

> [!note] 已知行为
> 代码块里的同样写法也会被当成批注 —— 这是有意的，方便直接给代码加批注。

## 安装

### 用 BRAT（推荐，能跟着更新）

1. 安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. BRAT 设置里 → `Add Beta plugin` → 填 `lildog2818/lildog-annotate`
3. `Add Plugin` → 回到「第三方插件」启用 **Lildog Annotate**

### 手动安装

从 [Releases](https://github.com/lildog2818/lildog-annotate/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放进
`<你的库>/.obsidian/plugins/lildog-annotate/`，重载 Obsidian 后启用。

## 从源码构建

```bash
git clone https://github.com/lildog2818/lildog-annotate.git
cd lildog-annotate
npm install
npm run build     # 类型检查 + 打包出 main.js
npm test          # 批注格式层单元测试 + 加载冒烟测试（先 build）
npm run dev       # 开发模式，改动自动重新打包
```

开发时把 `main.js`、`manifest.json`、`styles.css` 拷到库的 `.obsidian/plugins/lildog-annotate/` 即可（或把本仓库直接放在那个目录下）。

## 设置

| 设置项 | 说明 |
| --- | --- |
| 批注形式 | 行内批注 / 段落批注，决定新批注怎么写 |
| 选中文字后浮出批注按钮 | 关掉就只用快捷键和右键菜单 |
| 悬停显示批注内容 | 关掉则不弹预览 |

## 出问题时

命令面板里跑 **「Lildog Annotate: 运行自检」**，它会把插件的运行时状态写成一份报告：
`DSH/lildog-自检报告.md`。里面有编辑器装饰有没有建成功、阅读视图后处理器跑了没、
`getSectionInfo` 有没有返回、`<mark>` 配对上了几个等。把这份报告发给 AI，不用靠猜。

## 已知限制

- 行内批注不支持跨行选区（会自动改用段落批注）
- 阅读视图的悬停预览靠「按原文找 DOM 文字」实现：同一段落里有两条**文字完全相同**的批注时，第二条可能配不上
- 段落批注本来就是直接显示的，不需要悬停

## English

Lildog Annotate lets you select text in Obsidian and attach a note to it. Annotations are stored as **plain text in the markdown file itself**, so they survive without the plugin, are greppable, and any AI assistant can read them.

- Inline: `<!--lildog: your note-->selected text<!--/lildog-->` — the surrounding text is never modified; the highlight is drawn by the plugin, so formulas and code containing `=` are safe
- Block: a `> [!lildog] 批注` callout after the paragraph

Add an annotation with `Ctrl/Cmd + Shift + A`, the context menu, or the floating button that appears over a selection. Hover a highlighted passage to read the note. The user interface is in Chinese.

## License

MIT
