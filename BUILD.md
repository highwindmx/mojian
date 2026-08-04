# 墨笺 —— 本地 HTML / Markdown 所见即所得编辑器（Tauri 2）

基于 **Tauri 2（Rust + 系统 WebView）** 的本地编辑器：打开本地 `.html` / `.md` 文件，所见即所得地编辑，写回原文件。前端复用纯原生 HTML/CSS/JS，零构建；Rust 仅负责文件读写、对话框与拖放事件。

> 说明：本工程在 WorkBuddy 沙箱中产出，**沙箱无 Rust 工具链，未执行 `cargo build`**。以下为在你本地构建运行的步骤。

## 目录结构

```
htmlEditor/
├── package.json            # 可选：仅用于 `cargo tauri build` 打包安装器；纯 cargo 编译不需要
├── src/                    # 前端（纯静态，被 Tauri 直接加载，无需打包）
│   ├── index.html
│   ├── styles.css
│   ├── app.js              # 编辑器逻辑 + Tauri 接入（open/save/drag-drop/md）
│   └── vendor/
│       ├── marked.min.js   # Markdown -> HTML
│       └── turndown.js     # HTML -> Markdown
├── src-tauri/              # Rust 侧
│   ├── Cargo.toml
│   ├── tauri.conf.json     # withGlobalTauri、dragDropEnabled、frontendDist=../src（无 npm 脚本）
│   ├── capabilities/default.json
│   ├── build.rs
│   ├── icons/              # 已生成合法 PNG/ICO
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── commands.rs     # open_file / save_file / read_image_base64 / get_app_version
│       └── file_kind.rs    # 后缀路由 html / markdown
├── docs/                   # 架构设计（system_design.md、类图、时序图）
```

## ✅ 推荐：完全绕过 npm，直接 `cargo build`

本项目**不需要 npm / Node 即可编译运行**，因为：
- 前端是纯静态文件（`src/`），没有打包/转译步骤，`frontendDist: "../src"` 直接被 Rust 在编译时嵌入二进制。
- `tauri-build` 在 `build.rs` 中处理 `frontendDist`、capabilities、权限，全部在 cargo 内完成。
- `withGlobalTauri: true` 让 `window.__TAURI__` 全局可用，无需 `@tauri-apps/api` 这个 npm 包。
- `vendor/marked.min.js`、`turndown.js` 已是本地离线文件。

### 本地前置（Windows）
1. **Rust 工具链**：安装 [rustup](https://rustup.rs/)（勾选 stable，MSVC 目标 `stable-x86_64-pc-windows-msvc`）。
2. **C++ 构建工具**：Visual Studio 2022「使用 C++ 的桌面开发」工作负载（含 MSVC v143、Windows 10/11 SDK）。
3. **WebView2 Runtime**：Windows 10/11 通常已自带；否则从微软官网下载安装。
4. **Node.js**：**不需要**（除非你想打包成安装器，见下文「可选」）。

### 编译与运行
```bash
# ⚠️ Cargo.toml 在 src-tauri/ 子目录，必须进入该目录（或加 --manifest-path src-tauri/Cargo.toml）再 cargo build；
#    在仓库根目录直接 cargo build 会报 "could not find Cargo.toml"。
cd htmlEditor/src-tauri
cargo build                       # 调试版 exe -> target/debug/html-editor.exe
# 或发布版（更快、更小、杀软误报更少）：
cargo build --release            # 发布版 exe -> target/release/html-editor.exe
```
双击生成的 `html-editor.exe` 即可运行（需本机有 WebView2 运行时）。

## 可选：打包成安装器（.msi/.appimage）才需要 npm

只有当你想生成可分发安装包（而不是裸 exe）时，才需要 `@tauri-apps/cli`（npm 包）。它提供 `cargo tauri build`，会在 `cargo build --release` 基础上调用系统打包工具。

```bash
cd htmlEditor
npm install            # 仅安装 @tauri-apps/cli（打包用，非编译必需）
npm run tauri build    # 产物在 src-tauri/target/release/bundle/
```
> macOS 打包另需 `npm run tauri icon <一张png>` 生成 `icon.icns`；图标目录已含 Windows 所需 PNG/ICO。

## 功能

- **打开**：工具栏「打开」按钮 → 系统对话框选 `.html`/`.md`；或直接把文件**拖进窗口**。按后缀自动路由。
- **编辑**：加粗/斜体/下划线、H1–H6（再点同标题切回段落）、有序/无序列表、引用、链接、图片、表格、代码块、分割线；撤销/重做（Ctrl+Z / Ctrl+Y）、Ctrl+B/I/U。
- **`.md` 所见即所得**：加载时 `marked` 渲染进编辑区；保存时 `turndown` 转回 Markdown 写回，保持 `.md` 源格式。
- **保存**：`Ctrl+S` 或「保存」按钮写回原文件；首次保存（无打开文件）走「另存为」。`.html` 保存完整文档（含原文件 `<head>` 样式），`.md` 保存纯 Markdown。
- **图片**：本地图片经对话框选择 → Rust 读为 base64 内嵌（自包含）；也支持填 URL。链接/图片地址做 scheme 白名单校验。
- **导出**：「导出」按钮生成自包含 HTML 并落盘（走保存对话框）。
- **草稿**：编辑内容自动存入 localStorage（崩溃兜底），启动恢复空白草稿。

## 已知限制

- **Markdown 保真度**：`turndown` 对极复杂嵌套（如多层自定义 HTML 块）可能不完美；常见语法（标题/列表/链接/图片/代码/引用/表格/分割线）均可往返。
- **拖放一次仅加载一个文件**：单文档编辑器，拖入多个时只加载首个。
- **另存为扩展名**：保存对话框不会自动补扩展名，请手动输入（如 `note.md`）。
- **`execCommand` 弃用**：文本格式化仍依赖浏览器 `document.execCommand`（各现代浏览器可用）；未来如需彻底去依赖，需改为 Selection/Range 实现（前端已模块化）。
- 打开本地文件后不会自动「恢复上次文件」，以文件内容为准（防误覆盖）。
- 直接 `cargo build` 的调试/发布 exe 已可独立运行；仅"安装器"形态需 npm + `cargo tauri build`。
