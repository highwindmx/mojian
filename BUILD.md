# 构建与运行 (BUILD)

墨笺前端为零构建的纯静态资源，编译时由 Tauri 直接嵌入二进制，**日常开发 / 运行无需 npm 或 Node**。

## 环境准备

-   **Rust 工具链**：安装 [rustup](https://rustup.rs/)，使用 MSVC 目标（`stable-x86_64-pc-windows-msvc`）。
-   **C++ 构建工具**：Visual Studio 2022「使用 C++ 的桌面开发」工作负载（提供 MSVC 编译器与 Windows SDK）。
-   **WebView2 运行时**：Windows 11 已内置；Windows 10 若缺失，请安装 [Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
-   **（仅打包安装器时需要）Node.js + npm**：用于调用 `@tauri-apps/cli` 生成 `.msi` / `.appimage` 等安装包。

## 运行与调试构建

```bash
cd src-tauri
cargo build            # 调试构建，产物：target/debug/mojian.exe
cargo build --release  # 发布构建，产物：target/release/mojian.exe
```

直接双击生成的 `mojian.exe` 即可运行。前端资源在编译期已嵌入，无需单独启动前端服务。

> 前端（`src/` 下 HTML / CSS / JS、`vendor/` 第三方库）改动后，必须重新执行 `cargo build` 才能让改动生效——资源是被编译进 exe 的，而非运行时读取源文件。

## 打包安装器（可选）

仅在需要分发 `.msi` / `.appimage` 等安装包时执行：

```bash
npm install @tauri-apps/cli
cd src-tauri
cargo tauri build      # 生成对应平台安装器
```

## 版本号同步

发版时请同时修改以下两处，并保持一致（`get_app_version()` 读取 `CARGO_PKG_VERSION`）：

-   `src-tauri/Cargo.toml` 的 `version`
-   `src-tauri/tauri.conf.json` 的 `"version"`
