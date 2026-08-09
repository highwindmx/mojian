![墨笺 logo](src-tauri/icons/icon.png)

# 墨笺 (Mojian)

本地 **HTML / Markdown / PDF 多格式编辑器** —— 基于 **Tauri 2（Rust + 系统 WebView）** 的轻量桌面应用。

打开本地 `.html` / `.md` / `.pdf` 文件，就地编辑或查看，覆盖写回原文件。`.md` 为真·WYSIWYG：加载时 `marked` 渲染进编辑区，保存时 `turndown` 转回 Markdown 源格式；PDF 用 pdf.js 渲染，并支持批注、导出、合并与拆分。

## ✨ 特性

### 文档编辑（HTML / Markdown）

-   **多格式路由**：按文件后缀自动路由 `.html` / `.md` / `.pdf`；拖放文件即可加载。
-   **Markdown 所见即所得**：编辑时看到渲染效果，保存时无损转回 `.md` 源文。
-   **富文本排版**：加粗 / 斜体 / 下划线、H1–H6、有序 / 无序列表、引用、链接、图片、表格、代码块、分割线。
-   **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y`，以及 `Ctrl+B` / `Ctrl+I` / `Ctrl+U`。
-   **图片自包含**：本地图片内嵌为 base64，文档可独立分发；链接 / 图片地址做 scheme 白名单校验。
-   **Markdown 幻灯片**：工具栏「幻灯片」全屏演示（独行 `---` 分页），可导出自包含 reveal.js HTML。
-   **贴心细节**：导出自包含 HTML、`Ctrl+S` 保存、草稿自动本地保存、窗口尺寸记忆、页面缩放、源码视图切换、emoji 面板、底部状态栏（字数 / 词数 / 编码 / 光标）、禁用右键菜单。

### PDF 模块

-   **查看**：缩略图 + 大纲侧栏、懒渲染、大文件「正在加载」遮罩、选择 / 手型切换、缩放（以 100% 为中心步进）、页面跳转。
-   **文字**：跨页文字可选中复制（已修复字距伪空格「F i n al」问题）；跨页查找 + 高亮，「上一个 / 下一个」导航。
-   **批注**：高亮 / 划线（写入 `/Highlight` `/Underline` + `QuadPoints`，主流阅读器可见）、气泡 / 备注便签。
-   **变换**：单页 / 全部旋转（可指定页码区间与方向）。
-   **签章**：加载 PNG 或手绘，点页面放置，烤进页面（图片 / 手绘式，非 PKI 数字签名）。
-   **文字水印**：文字 / 字号 / 透明度 / 颜色，每页平铺（仅「应用」改内存，落盘由你决定）。
-   **导出 / 合并 / 拆分**：导出图片（PNG/JPEG、区间）；转 Word（文本版 `.doc`，图 / 表处标 `[图片]` / `[表格]` 占位）；合并多个 PDF；按页 / 区间拆分。
-   **打印**：调起系统打印。

## 🧱 技术栈

层

技术

说明

前端

纯原生 HTML / CSS / JS（零构建）

`marked` + `turndown` 处理 Markdown；`pdf.js` 渲染与查找 PDF；`pdf-lib` 做合并 / 拆分 / 水印 / 签章 / 旋转写回；`reveal.js` 做幻灯片。均离线自包含于 `src/vendor/`

后端

Rust（Tauri 2）

仅负责文件读写、系统对话框与拖放事件

## 🛠 构建与运行

详见 [BUILD.md](./BUILD.md)。核心命令（**无需 npm / Node**）：

```bash
cd src-tauri
cargo build --release      # 产物：target/release/mojian.exe
```

双击 `mojian.exe` 运行（需本机 WebView2 运行时）。仅打包安装器时才需要 npm（见 BUILD.md）。

## 📁 目录结构

```
mojian/
├── src/                    # 前端（纯静态，编译时被 Tauri 嵌入，无需打包）
│   ├── index.html
│   ├── styles.css
│   ├── app.js              # 编辑器 / 幻灯片 / 工具栏逻辑 + Tauri 接入
│   ├── pdf.js              # PDF 模块（查看 / 批注 / 导出 / 合并拆分 / 水印签章 / 查找）
│   └── vendor/             # 离线自包含第三方库
│       ├── marked.min.js / turndown.js
│       ├── pdfjs/          # pdf.min.js / pdf.worker.min.js
│       ├── pdf-lib/pdf-lib.min.js
│       └── reveal/         # reveal.js / reveal.css / theme/
├── src-tauri/              # Rust 侧（Tauri 2 标准结构）
│   ├── Cargo.toml          # name = "mojian"；default = ["custom-protocol"]
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
-   **拖放一次仅加载一个文件**；另存为需手动输入扩展名。
-   **`execCommand` 弃用**：文本格式化仍依赖浏览器 `document.execCommand`（各现代浏览器可用）。
-   直接 `cargo build` 的 exe 已可独立运行；仅「安装器」形态需 npm + `cargo tauri build`。

## 📄 许可证

MIT。

  

Powered By WorkBuddy