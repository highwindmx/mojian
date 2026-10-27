![墨笺 logo](src-tauri/icons/icon.png)

# 墨笺 (Mojian)

> 本地多格式文档编辑器 —— 基于 Tauri 2 的轻量桌面应用，打开即编、覆盖写回。

**当前版本：1.0.6**

墨笺是一款面向本地文件的 **HTML / Markdown / PDF / SVG / EPUB 多格式编辑器**，基于 **Tauri 2（Rust + 系统 WebView）** 构建，安装包小、启动快、完全离线可用。

打开本地的 `.html` / `.md` / `.pdf` / `.svg` / `.epub` 文件，即可就地编辑或查看，并直接覆盖写回原文件——不生成副本、不依赖云端：

-   `.md` 为真·WYSIWYG：加载时由 `marked` 渲染进编辑区，保存时由 `turndown` 转回 Markdown 源格式；
-   `.html` 在 `contenteditable` 中编辑，第三方样式经前缀限定注入，不污染应用界面；
-   `.svg` 以「左侧预览 + 右侧源码」分栏编辑，实时同步、保存写回原 SVG；
-   `.pdf` 由 pdf.js 渲染，支持批注、签章、水印、合并与拆分；
-   `.epub` 为沉浸式只读阅读，借助 Shadow DOM 样式隔离，出版社排版 100% 保真。

## 目录

-   [特性](#%E7%89%B9%E6%80%A7)
-   [构建与运行](#%E6%9E%84%E5%BB%BA%E4%B8%8E%E8%BF%90%E8%A1%8C)
-   [使用说明对照表](#%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E5%AF%B9%E7%85%A7%E8%A1%A8)
-   [系统要求](#%E7%B3%BB%E7%BB%9F%E8%A6%81%E6%B1%82)
-   [技术栈](#%E6%8A%80%E6%9C%AF%E6%A0%88)
-   [目录结构](#%E7%9B%AE%E5%BD%95%E7%BB%93%E6%9E%84)
-   [已知限制](#%E5%B7%B2%E7%9F%A5%E9%99%90%E5%88%B6)
-   [许可证](#%E8%AE%B8%E5%8F%AF%E8%AF%81)

## ✨ 特性

### 文档编辑（HTML / Markdown）

-   **多格式路由**：按文件后缀自动路由 `.html` / `.md` / `.pdf` / `.svg` / `.epub`；拖放文件即可加载。
-   **SVG 源码 + 预览**：打开 `.svg` 默认进入分栏——左侧渲染预览（保留动画 / 渐变，已剔除 `<script>` 与 `on*` 以提升安全），右侧直接编辑 SVG 源码，输入即防抖刷新预览；`Ctrl+S` 写回原文件。
-   **Markdown 所见即所得**：编辑时看到渲染效果，保存时无损转回 `.md` 源文。
-   **富文本排版**：加粗 / 斜体 / 下划线、H1–H6、有序 / 无序列表、引用、链接、图片、表格、代码块、分割线。
-   **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y`，以及 `Ctrl+B` / `Ctrl+I` / `Ctrl+U`。
-   **图片自包含**：本地图片内嵌为 base64，文档可独立分发；链接 / 图片地址做 scheme 白名单校验。
-   **Markdown 演示**：工具栏「演示」全屏放映（独行 `---` 分页），可导出自包含 reveal.js HTML。
-   **查找替换浮条**：`Ctrl+F` 唤出，渲染区 / 源码区分栏查找、上一个 / 下一个、区分大小写、替换与全部替换。
-   **工具栏自定义**：Word「自定义快速访问工具栏」式双列表——左选可用命令、右排当前显示项，支持添加 / 删除 / 上移 / 下移 / 恢复默认；大纲、分栏、原文、换行等核心视图按钮亦可在列表中重排（分栏与原文始终相邻）。
-   **导出为网页 / 图片**：一键导出自包含 HTML；也可将当前文档栅格化为 PNG / JPEG 图片（弹窗内带限定大小预览）。
-   **数学与图表**：围栏块 ` ```math ` / ` ```mermaid ` 分别由 KaTeX、Mermaid 渲染为只读预览岛，保存时无损还原为源码（往返零损失）。
-   **贴心细节**：`Ctrl+S` 保存、草稿自动本地保存、窗口尺寸记忆、页面缩放、源码视图切换、emoji 面板、底部状态栏（字数 / 编码 / 光标）、禁用右键菜单、深浅主题切换、保存按钮脏标记角标。

### EPUB 阅读

-   **沉浸式阅读**：Shadow DOM 注入章节内容，出版社样式只作用于书内、结构上不污染应用界面。
-   **章节目录**：解析 OPF / NCX 目录侧栏，按章跳转。
-   **本书查找**：当前章节内查找高亮 + 上一个 / 下一个。

### PDF 模块

-   **查看**：缩略图 + 大纲侧栏、懒渲染、大文件「正在加载」遮罩、选择 / 手型切换、缩放（以 100% 为中心步进）、页面跳转。
-   **文字**：跨页文字可选中复制（已修复字距伪空格「F i n al」问题）；跨页查找 + 高亮，「上一个 / 下一个」导航。
-   **批注**：高亮 / 划线（写入 `/Highlight` `/Underline` + `QuadPoints`，主流阅读器可见）、气泡 / 备注便签。
-   **变换**：单页 / 全部旋转（可指定页码区间与方向）。
-   **签章**：加载 PNG 或手绘，点页面放置，烤进页面（图片 / 手绘式，非 PKI 数字签名）。
-   **文字水印**：文字 / 字号 / 透明度 / 颜色，每页平铺（仅「应用」改内存，落盘由你决定）。
-   **导出 / 合并 / 拆分**：导出图片（PNG / JPEG、区间）；转 Word（文本版 `.doc`，图 / 表处标 `[图片]` / `[表格]` 占位）；合并多个 PDF；按页 / 区间拆分。
-   **打印**：调起系统打印。

### Windows 文件关联

-   **勾选注册**：定制弹窗「文件关联」页勾选 `.md` / `.html` / `.svg` / `.pdf` / `.epub`，写入每用户注册表（`HKCU`，无需管理员），即刻刷新资源管理器图标。
-   **分类型彩色图标**：md 黑 / html 灰 / svg 蓝 / pdf 红 / epub 粉的墨字风格图标。
-   **正规默认应用候选**：登记系统「默认应用」设置候选（RegisteredApplications + Capabilities），默认打开由你在系统设置中选择。

## 🛠 构建与运行

详见 [BUILD.md](./BUILD.md)。核心命令（**无需 npm / Node**）：

```bash
cd src-tauri
cargo build --release      # 产物：target/release/mojian.exe
```

双击 `mojian.exe` 运行（需本机 WebView2 运行时）。仅打包安装器时才需要 npm（见 BUILD.md）。

## 📖 使用说明对照表

| 格式 | 打开方式 | 编辑 / 查看行为 | 保存 |
| --- | --- | --- | --- |
| .md | 双击 / 拖入 / 文件菜单 | 所见即所得编辑（marked 渲染 + turndown 转回） | Ctrl+S 写回原 .md |
| .html | 双击 / 拖入 / 文件菜单 | contenteditable 编辑；第三方样式经前缀限定注入，不污染界面 | Ctrl+S 写回原 .html |
| .svg | 双击 / 拖入 / 文件菜单 | 左预览 + 右源码分栏，输入即刷新 | Ctrl+S 写回原 .svg |
| .pdf | 双击 / 拖入 / 文件菜单 | pdf.js 只读渲染 + 批注 / 签章 / 水印 / 合并拆分 | 另存为 / 导出 |
| .epub | 双击 / 拖入 / 文件菜单 | Shadow DOM 沉浸式只读阅读，含目录与查找 | — |

## 💻 系统要求

-   Windows 10 / 11（需 WebView2 运行时，Win11 已内置；Win10 缺失时装「Edge WebView2 Runtime」即可）。
-   macOS / Linux 可正常构建运行（文件关联注册为 Windows 独有功能）。

## 🧱 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | 纯原生 HTML / CSS / JS（零构建） | marked + turndown 处理 Markdown；pdf.js 渲染与查找 PDF；pdf-lib 做合并 / 拆分 / 水印 / 签章 / 旋转写回；reveal.js 做演示。均离线自包含于 src/vendor/ |
| 后端 | Rust（Tauri 2） | 文件读写、系统对话框与拖放事件；Windows 侧另用 winreg 写文件关联、windows-sys 调 SHChangeNotify 刷新图标 |

## 📁 目录结构

```
mojian/
├── src/                    # 前端（纯静态，编译时被 Tauri 嵌入，无需打包）
│   ├── index.html
│   ├── styles.css
│   ├── app.js              # 编辑器 / 演示 / 工具栏逻辑 + Tauri 接入
│   ├── pdf.js              # PDF 模块（查看 / 批注 / 导出 / 合并拆分 / 水印签章 / 查找）
│   ├── tooltip.js          # 自实现按钮提示（替代原生 title）
│   └── vendor/             # 离线自包含第三方库
│       ├── marked.min.js / turndown.js
│       ├── pdfjs/          # pdf.min.js / pdf.worker.min.js
│       ├── pdf-lib/pdf-lib.min.js
│       └── reveal/         # reveal.js / reveal.css / theme/
├── src-tauri/              # Rust 侧（Tauri 2 标准结构）
│   ├── Cargo.toml          # name = "mojian"；version 与 tauri.conf.json 保持一致
│   ├── tauri.conf.json     # withGlobalTauri、dragDropEnabled、frontendDist=../src
│   ├── capabilities/default.json
│   ├── icons/              # 已生成合法 PNG/ICO
│   └── src/                # main.rs / lib.rs / commands.rs / file_kind.rs
├── docs/                   # 架构设计（system_design.md + 类图 / 时序图）
├── LICENSE
└── package.json            # 仅打包安装器时需要
```

## ⚠️ 已知限制

-   **Markdown 保真度**：`turndown` 对极复杂嵌套可能不完美；常见语法均可往返。
-   **PDF 文本提取**：依赖 pdf.js 的逐字提取，多栏版面文字顺序可能交错；转 Word 为文本版（图 / 表仅占位）。
-   **PDF 签章**：为图片 / 手绘「烤进页面」，非具法律效力的 PKI 数字签名。
-   **文件关联**：Windows「默认应用」的最终选择由系统 UserChoice（防篡改 Hash）决定，墨笺登记为候选后需在系统设置里点选；Win8 以前系统可直接接管。
-   **execCommand 弃用**：文本格式化仍依赖浏览器 `document.execCommand`（各现代浏览器可用）。
-   直接 `cargo build` 的 exe 已可独立运行；仅「安装器」形态需 npm + `cargo tauri build`。

## 📄 许可证

[MIT](LICENSE) © 2026 highwindmx

Powered by WorkBuddy