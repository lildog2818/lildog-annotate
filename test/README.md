# 检查与测试

改完代码从这里开始，不用去动真库。

```
npm run deploy        构建 + 铺到测试库 test/vault
npm test              纯逻辑测试：格式解析、颜色/设置收口、装饰、加载冒烟、测试库验收
npm run test:vault    用隔离实例打开测试库（带 9222 调试端口）
npm run test:ui       连上隔离实例，用真实鼠标键盘走一遍界面（跑完自动还原笔记）
npm run deploy:real   顺手把构建铺到真库，日常使用立刻生效
```

## 目录里有什么

| 路径 | 作用 |
| --- | --- |
| `vault/` | 测试库本体（`npm run test:vault` 打开它）。`.obsidian` 由 `sync.mjs` 生成，不入库 |
| `vault/批注测试.md` | 样例笔记：重复文字、公式、代码块、表格、列表、引用块、旧格式、段落批注、对照段落 |
| `format.test.mts` | 格式层纯函数（解析 / 生成 / 定位 / 装饰规划） |
| `colors.test.mts` | 颜色与数字设置的收口（非法值不能把插件带崩） |
| `decorations.cm.test.mts` | 真的 CodeMirror 里构建装饰（`run-cm-tests.mjs` 负责打包后跑） |
| `load.smoke.mjs` | 用桩模块加载打包产物，跑一次 `onload`，顺带跑一次自检命令 |
| `acceptance.mts` | 拿真实正则读样例笔记：条数、半截标记、就近命中 |
| `ui-check.mjs` | 界面级检查（下面细说） |
| `cdp.mjs` | 极简 CDP 客户端（Node 22 自带 WebSocket，无额外依赖） |
| `launch.mjs` | 启动 / 关闭隔离实例 |

## 隔离实例

`npm run test:vault` 用的是**另一个 user-data-dir**（默认 `D:\document\lildog-obsidian-profile`），
和日常那个 Obsidian 互不干扰，可以同时开着。换路径用环境变量：

```
LILDOG_OBSIDIAN=D:\software\Obsidian\Obsidian.exe
LILDOG_TEST_PROFILE=D:\document\lildog-obsidian-profile
LILDOG_DEBUG_PORT=9222
```

## 界面检查 (`npm run test:ui`) 覆盖什么

1. 编辑器里的高亮：另一种文字颜色、强调色底、同色下划线
2. 悬停浮窗：显示批注、字号跟设置走、点「编辑」直接改、**回车保存并立刻收起**、
   保存后正文不露标记
3. 阅读视图：同样高亮、同样能悬停改、鼠标移开自动收起
4. 设置：改颜色 / 改字号立刻生效，改回来也立刻生效
5. **在哪选就在哪批注**：同一段文字出现三次时，选中第三处拖选 → 浮出按钮 →
   写批注 → 落到第三处，且不再提示「会加在第一处」

跑完会把样例笔记还原，可以反复跑。

想留几张截图存档：`npm run test:ui -- --shots`，图落在 `test/.shots/`（不入库）。

## 自检报告

界面里出问题、又看不到控制台时，在测试库里跑命令
「Lildog Annotate: 运行自检」，报告写到 `vault/DSH/lildog-自检报告.md`：
装饰有没有建成功、阅读视图配对上几条、悬停浮窗弹了几次、当前外观设置是什么，都在里面。
