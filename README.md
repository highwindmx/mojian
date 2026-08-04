<div align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="墨笺 logo" />
</div>

# 墨笺 (Mojian)

本地 **HTML / Markdown 双格式所见即所得编辑器** —— 基于 **Tauri 2（Rust + 系统 WebView）** 的轻量桌面应用。

打开本地 `.html` / `.md` 文件，所见即所得地编辑，覆盖写回原文件。`.md` 为真·WYSIWYG：加载时 `marked` 渲染进编辑区，保存时 `turndown` 转回 Markdown 源格式。

## ✨ 特性

- **双格式编辑**：按文件后缀自动路由 `.html` / `.md`；拖放文件即可加载。
- **Markdown 所见即所得**：编辑时看到的是渲染后的效果，保存时无损转回 `.md` 源文。
- **富文本排版**：加粗 / 斜体 / 下划线、H1–H6、有序 / 无序列表、引用、链接、图片、表格、代码块、分割线。
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y`，以及 `Ctrl+B` / `Ctrl+I` / `Ctrl+U`。
- **图片自包含**：本地图片内嵌为 base64，文档可独立分发；链接 / 图片地址做 scheme 白名单校验。
- **贴心细节**：导出自包含 HTML、`Ctrl+S` 保存、草稿自动本地保存、窗口尺寸记忆、页面缩放、源码视图切换、文字 / 背景颜色。

## 🧱 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 前端 | 纯原生 HTML / CSS / JS（零构建） | `marked` + `turndown` 离线自包含于 `src/vendor/` |
| 后端 | Rust（Tauri 2） | 仅负责文件读写、系统对话框与拖放事件 |

## 🛠 构建与运行

详见 [BUILD.md](./BUILD.md)。核心命令：

```bash
cd src-tauri
cargo build --release      # 产物：target/release/html-editor.exe
```

**无需 npm / Node** 即可编译运行（仅打包安装器时才需要）。

## 📁 目录结构

```
htmlEditor/
├── src/                    # 前端（纯静态，被 Tauri 直接加载，无需打包）
│   ├── index.html
│   ├── styles.css
│   ├── app.js              # 编辑器逻辑 + Tauri 接入（open/save/drag-drop/md）
│   └── vendor/             # marked.min.js / turndown.js（离线自包含）
├── src-tauri/              # Rust 侧（Tauri 2 标准结构）
├── docs/                   # 架构设计（system_design.md + 类图 / 时序图）
├── BUILD.md                # 本地构建说明
└── package.json            # 仅打包安装器时需要
```

## 📄 许可证

当前未包含开源许可证。如需公开发布，请自行补充 `LICENSE`。
