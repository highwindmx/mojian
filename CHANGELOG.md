# 墨笺 · 更新说明

> **版本**：0.3.0（`tauri.conf.json` 中 `version`；本说明汇总自「上一版 / 墨笺初始版」以来的全部新增、改进与修复）
> **平台**：Windows 10 / 11（需 WebView2 Runtime）；单文件 `html-editor.exe` 自包含，双击即跑
> **二进制**：`src-tauri/target/release/html-editor.exe`

---

## 🆕 0.3.0 更新摘要（相对 0.2.0）

> 0.2.0 已新增「文件关联 / 双击打开」功能，但其 `tauri.conf.json` 里的 `fileAssociations` 含一个当前 Tauri 版本不合法的 `icon` 字段，导致编译不通过；0.3.0 在 0.2.0 基础上补齐实现与编译修复，具体如下。

- **新增：工具栏「增加缩进 / 减少缩进」按钮**：位于「有序列表」之后，点击调用 `document.execCommand("indent" / "outdent")`（与列表内 `Tab` / `Shift+Tab` 缩进同源）。需先选中列表项（`li`）或引用块（`blockquote`）才生效；纯文本块下为安全空操作。两按钮非固定项，可在定制弹窗显隐 / 用 `↑` `↓` 排序。
- **修复：文件关联编译错误**：移除 `tauri.conf.json` → `bundle.fileAssociations` 中每条非法的 `"icon"` 字段（Tauri 2 的 `FileAssociation` 结构体带 `deny_unknown_fields`，仅允许 `ext` / `name` / `role` 等，无 `icon`）。修复后 0.2.0 引入的「双击 .md/.html 直接打开文件」功能终于可正常编译并生效。Windows 上关联图标自动取 exe 内嵌主图标，无需单独声明。
- **版本号**：`0.2.0 → 0.3.0`（`tauri.conf.json` 中 `version`）。

---

## ✨ 新增功能

### 编辑器能力
- **配置持久化**：窗口尺寸、主题、默认编码、工具栏布局统一写入 exe 同目录 `mojian.config.json`，不再依赖浏览器 `localStorage`（换机 / 重装可随 exe 携带）。
- **主题切换**：新增护眼（sepia）、黄底（yellow）、暗色（dark）三套主题，一键切换并记忆。
- **列表缩进**：在 `li` 内按 `Tab` / `Shift+Tab` 缩进 / 反缩进；工具栏另提供「增加缩进 / 减少缩进」按钮（见上方摘要）。
- **视频嵌入**：工具栏「视频」按钮支持本地视频（mp4/webm/ogg/mov/avi，base64 内嵌）、外链直链（`<video>`）与其它外链（`<iframe>`）。
- **字符编码**：支持 UTF-8 / GBK 自动识别与手动指定（全局默认编码），打开与保存时按编码编解码（见「已知问题」）。
- **查找替换**：顶部浮动工具条，支持上一个 / 下一个、替换、全部替换、区分大小写（遍历文本节点，保持富文本格式）。

### 工具栏与布局
- **工具栏自定义**：齿轮按钮打开定制弹窗，可勾选显隐按钮；用 `↑` / `↓` 调整顺序（不跨越分隔符与固定项，如缩放 / 分栏），布局持久化。
- **源码分栏**：新增「分栏」视图，左为所见即所得渲染、右为源码，双向实时同步（300ms 防抖）；HTML 经 sanitize、Markdown 经 turndown / marked 互转，状态可记忆。

---

## 🔧 改进
- **查找替换浮条位置**：从底部状态栏上方移至**顶部工具栏正下方**，更顺手（位置随工具栏真实高度动态计算，不写死）。
- **工具栏排序交互**：由「工具栏拖拽」改为**定制弹窗内上下移动**（更精确、不会误拖）。
- **工具栏光标**：按钮默认箭头（`:hover` 背景提示可点），告别整条工具栏都是手型。
- **图标（logo）**：重建 `icon.ico`，剔除此前两个结构损坏的 512 / 1024 伪条目，保留原生 16 / 32 / 48 / 256；并按需求将目录项排为**从大到小**。

---

## 🐞 修复
- **编译错误**：移除 `capabilities/default.json` 中 Tauri 2 不存在的权限 `core:window:allow-on-resized`（此前误加），窗口尺寸读写保留 `allow-inner-size` / `allow-set-size`，resized 监听由 `core:event:default` 覆盖。
- **弹窗「取消」无反应**：修复定制与视频弹窗的取消键、以及视频弹窗遮罩点击关闭失效（原 `data-close` 逻辑写死只关链接 / 图片两个弹窗，漏掉了这两个）。
- **双击关联文件不打开**：修复「把程序设为 .md/.html 默认打开应用后，双击只启动程序、不打开文件」。Windows 双击关联文件时会把路径作为**命令行参数**传给 exe，而 Tauri 2 在 Windows 上不会自动打开（仅 macOS 有 `RunEvent::Opened`）。新增 `get_initial_file` 命令读取启动参数中的文件路径，`init()` 启动后自动 `openFileWithPath` 加载；并在 `tauri.conf.json` 登记 `fileAssociations`（.md/.markdown/.html/.htm），安装包可自动注册文件关联。
  - 注：该功能的 `fileAssociations` 初版误带了非法的 `icon` 字段导致编译失败，已在 0.3.0 移除（见上方摘要）。

---

## 📌 说明（内部尝试与回退）
- **DPI 感知清单**：曾尝试在 Windows 应用清单显式声明 `dpiAwareness=PerMonitorV2`，但在当前 `tauri-winres 0.3.6` 的内联嵌入机制下会触发 SxS「并行配置不正确」启动失败，已回退为 Tauri 默认清单。高分屏清晰度由 Tauri `tao` 运行时 `SetProcessDpiAwareness(PerMonitorV2)` 保证，**功能与清晰度均无影响**。

---

## ⚠️ 已知问题
- **GBK 保存不同步 `<meta charset>`**：若将 HTML 以 GBK 保存，文件头 `<meta charset>` 不会自动改为 GBK，浏览器可能按 UTF-8 解析而乱码。可后续补「保存时同步 meta charset」或「另存为时可选编码」。
- **Markdown 保真度**：复杂嵌套 Markdown 经 turndown 往返可能不完美。
- **拖放 / 另存为**：一次拖放仅加载首个文件；另存为需手动输入扩展名。

---

## 🛠 构建 / 升级注意（给构建者）
- 前端（`app.js` / `styles.css` / `index.html`）在编译期嵌入 exe，改动后必须重编：
  ```powershell
  cd D:\Share\Scripts\Explore\htmlEditor\src-tauri
  cargo build --release
  ```
- **改 `icon.ico` 后需刷新 `tauri.conf.json` 修改时间**，否则 `tauri-build` 不会重嵌图标（它只追踪 `tauri.conf.json` 与 build 脚本，不追踪 ICO 文件变化）：
  ```powershell
  powershell -Command "(Get-Item tauri.conf.json).LastWriteTime = Get-Date"
  cargo build --release
  ```
  （或 `cargo clean -p html-editor` 后重建。）
- **文件关联（双击打开）说明**：`tauri.conf.json` 中的 `fileAssociations` 只在打包安装器（`cargo tauri build` 出 .msi/.exe 安装包）时写入系统注册表自动注册；若只是 `cargo build` 出**松散布署的 exe**，需手动「打开方式」关联——两种方式都能生效，因为双击时系统会把文件路径作为命令行参数传给 exe，由 `get_initial_file` 读取并打开。
