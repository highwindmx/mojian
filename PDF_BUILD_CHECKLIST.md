# 墨笺 · PDF 功能构建验证清单（第二轮）

> 功能（PDF 查看/旋转/合并/拆分/备注/**高亮划线**/查找/打印/导出图/转Word/水印/签章 + 选择手型/加载遮罩/缩放步进 + 主程序状态栏；Markdown **幻灯片演示/导出**；起始窗口 800×600；编译名/库名统一为 `mojian`）
> 代码已全部写完，但沙箱**没有 Rust 工具链**，无法在这里跑 `cargo build`。请在本机执行下面唯一一步构建后逐项验收。

## 一、构建命令（本机执行）

```bat
cd D:\Share\Scripts\Explore\mojian\src-tauri
cargo build --release
```

构建产物：`src-tauri\target\release\mojian.exe`（编译名 `mojian`；窗口标题/安装器显示名仍为“墨笺”），双击运行。
（环境铁律：只用 `cargo build --release`，**不要**跑 npm / `tauri build`。旧的 `html-editor.exe` 可忽略/删除。）

## 二、已落盘的关键修正（无需你再改）

1. `Cargo.toml` 的 `[features]`：`default = ["custom-protocol"]`（否则 release exe 不内嵌前端→“拒绝连接”）。
2. `tauri.conf.json` 的 `bundle` **已移除** `mainBinaryName`（tauri-build 2.11.5 不支持该字段，会报 unknown field 直接 build 失败）。改名只靠 `Cargo.toml` 的 `name = "mojian"`。
3. pdf-lib UMD 包**没有** `PDFArray.fromArray`（grep 为 0），运行时若走到会抛错 → 已全部改用 `pdfLibDoc.context.obj([...])` 生成 PDFArray。
4. 文本层换成 pdf.js 官方 textLayer CSS（修复“文字不可选 + 查找无高亮”同源问题）。

## 三、功能验收清单（双击 exe 后逐项点）

| # | 验证项 | 操作 | 预期 |
|---|--------|------|------|
| 1 | PDF 打开 | 拖入或「打开」选 `.pdf` | 出现 PDF 工具栏 + 缩略图/大纲 + 正文；大文件有“正在加载”遮罩 |
| 2 | 文字可选复制 | 框选正文文字 | 可选中并 Ctrl+C 复制；选区有蓝色高亮 |
| 3 | 搜索高亮 | 「查找」输入词回车 | 跨页高亮命中词，可“上一个/下一个” |
| 4 | 本页旋转（任意页） | 滚到第 5 页点「↻本页」→ 保存 → 重开 | **第 5 页**被旋转写回（不再只作用首页） |
| 5 | 旋转全部 | 「旋转全部」 | 所有页同向旋转 |
| 6 | 选择/手型 | 点「选择/手型」切换 | 手型下可拖拽平移；选择下可框选文字 |
| 7 | 缩放 | ±按钮、点「100%」、适应宽度 | 以 100% 为中心、±5% 步进 |
| 8 | 高亮/划线 | 框选文字 → 浮条「高亮」/「划线」→ 保存 | 在其它阅读器可见高亮/下划线 |
| 9 | 气泡备注 | 框选文字 → 浮条「气泡」或「备注」点页 | 便签注释写入 PDF（中文可移植） |
| 10 | 合并 | 「合并」选多个 PDF | 输出一个合并文件 |
| 11 | 拆分 | 「拆分」每页 / 区间 | 输出多个 PDF |
| 12 | 导出图片 | 「导出图」选 PNG/JPEG/区间 | 另存 `原文件_第N页.*` |
| 13 | 转 Word | 「转Word」选区间 | 生成 `.doc`，文字可编辑；图/表处标 `[图片]`/`[表格]` 占位 |
| 14 | 文字水印 | 「水印」设文字/字号/透明度/颜色 → 应用并保存 | 每页平铺水印 |
| 15 | 签章 | 「签章」加载 PNG 或手绘 → 点页面放置 → 保存 | 印章/签名烤进页面 |
| 16 | 打印 | 「打印」 | 调起系统打印 |
| 17 | 主程序状态栏 | 打开 HTML/MD，输入文字 | 底部显示 字数/词数/编码/光标 |
| 18 | emoji 输入 | HTML/MD 工具栏点 emoji | 表情面板可插入 |
| 19 | 禁用右键 | 主界面右键 | 无菜单弹出 |
| 20 | 起始窗口大小 | 直接双击 exe | 起始窗口约 800×600（不再是 900×640） |
| 21 | 编译名/库名 | 看任务管理器/进程名、产物名 | 二进制 `mojian.exe`；库产物 `mojian.*`（无 `html_editor` 残留） |
| 22 | Markdown 幻灯片 | 打开 `.md` → 工具栏「幻灯片」 | 全屏播放；←/→/空格翻页，Esc 退出；底栏显页码 |
| 23 | 幻灯片分隔 | 在 md 中写独行 `---` 再演示 | 每个 `---` 之间成为一页 |
| 24 | 幻灯片导出 | 演示中或工具栏点「导出」 | 生成自包含 `.html`（内联 reveal），浏览器可双击播放 |

## 四、排障

- **“拒绝连接 / localhost”**：确认 `Cargo.toml` 的 `default = ["custom-protocol"]` 且 `tauri.conf.json` 的 `frontendDist = "../src"`。
- **PDF 空白 / worker 报错**：pdf.js 用相对路径 `vendor/pdfjs/pdf.worker.min.js` 加载 worker；若被 CSP `worker-src` 拦，后续可改 blob URL 内联（当前通常触发不到）。
- **转 Word 表格/图片为占位**：文本版本身不提取图/表，仅按 operator-list 启发式标注 `[图片]`/`[表格]`；多栏版面文字顺序可能交错（pdf 文字提取固有限制）。
- **高亮在其它阅读器不显示**：已写 `/Highlight`、`/Underline` + `QuadPoints`，主流阅读器（Acrobat/Sumatra/Foxit）均可显示；极个别阅读器需外观流时才不显示颜色，属阅读器差异。
- **幻灯片仅在 Markdown 可用**：「幻灯片」按钮对非 `.md` 文档会提示“仅适用于 Markdown”。分隔符为独行 `---`（与水平线区分：必须独自成行）。
- **幻灯片导出文件怎么用**：导出的是把 reveal.js 内联进去的**自包含 HTML**，双击用浏览器打开即是放映；需要 PDF 时在该 HTML 里 `Ctrl+P` → 另存为 PDF 即可（reveal 自带打印版式）。
- **旧 `html_editor_lib.*` 产物**：本机 `target/` 可能残留；无害（cargo 按 crate 名隔离）。想彻底干净可在本机 `cargo clean` 后重建，或手动删 `target/**/html_editor_*`。（沙箱大目录不可稳定访问，未自动删。）

## 五、改动文件一览

- 新增：`src/pdf.js`、`src/vendor/pdfjs/pdf.min.js`、`src/vendor/pdfjs/pdf.worker.min.js`、`src/vendor/pdf-lib/pdf-lib.min.js`、`src/vendor/reveal/reveal.js`、`src/vendor/reveal/reveal.css`、`src/vendor/reveal/theme/white.css`（+ `theme/black.css`）
- 修改：`src/index.html`（PDF 工具栏 + 加载遮罩 + 批注浮条 + 导出/水印/签章弹窗 + reveal 样式/脚本 + 幻灯片 overlay）、`src/app.js`（状态栏 `updateEditorStatus` + 幻灯片 `presentSlides`/`exportSlides` + 工具栏「幻灯片」按钮）、`src/styles.css`（textLayer/高亮/遮罩/光标/浮条/幻灯片 overlay）、`src-tauri/src/commands.rs`、`file_kind.rs`、`lib.rs`、`main.rs`、`tauri.conf.json`、`Cargo.toml`

## 六、未做 / 可选后续

- **单实例**：你已明确不要求，作废（不再加 `tauri-plugin-single-instance`）。
- **密码学数字签名（PKI）**：本轮做的是“图片/手绘签章（烤进页面）”；若要法律效力的数字签名，需证书 + 另行实现。
- **PDF→Word 真 .docx（图片版）**：当前文本版已满足“可改字+占位”；若要多页图片嵌成标准 .docx，可再 vendor 一个极小的 zip 写入器。
