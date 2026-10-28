# PDF 无头验证工具

沙箱/无本机 Rust 工具链时，用来验证 `src/pdf.js` 的几何与保存行为。不参与打包。

## 1. 矩阵验证（不用浏览器，最快）

```bash
node tools/pdfdbg/t4_matrix.js
```

用 pdf-lib 写一份带签章的内容流 PDF，解析 `cm` 栈把图块四角换算到页面坐标，再套 pdf.js 的
`PageViewport` 公式（`/Rotate` 顺时针）得到屏幕包围盒，逐案断言：

- `/Rotate` 0 / 90 / 180 / 270 下，签章包围盒都等于 `w×h`（正立）、中心等于点击点投影；
- 对照组（不加旋转补偿）应呈横躺 —— 用来证明补偿角方向不是"碰巧对"。

## 2. 端到端（真实 PDF 模块 + Edge 无头）

```bash
node tools/pdfdbg/t5_gen.js     # 生成 e2e.pdf 与 e2e_pdf.js（base64 注入用）
node tools/pdfdbg/serve.js      # 127.0.0.1:8898，同时提供 /__report、/__saved 收集端点
# 另开一个终端：
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu \
  --no-sandbox --user-data-dir=/tmp/edge-e2e --window-size=1280,900 \
  "http://127.0.0.1:8898/tools/pdfdbg/e2e.html"
# 十余秒后看结果：
cat tools/pdfdbg/report.txt
```

`/tools/pdfdbg/e2e.html` 由 `serve.js` 现场拼装：以真实 `src/index.html` 为骨架（剥掉全部
`<script>`、插入 `<base href="/src/">`），再注入 mock `window.__TAURI__`、pdf.js / pdf-lib /
`src/pdf.js` / `driver.js`。因此测的是**真实模块**，不是副本。

`driver.js` 走的流程：打开 → 旋转本页 → 手绘签章 → 点击画布放置 → 保存 → 重载，
逐步骤把 JSON 结果 POST 到 `/__report`，保存字节 POST 到 `/__saved`（落盘 `saved.b64`）。

## 踩过的坑

-   **`--dump-dom` 拿不到异步结果**：pdf.js 的 worker 走真实线程，`--virtual-time-budget`
    会提前结束，DOM 里永远是初始文本。改成页内 `fetch` POST 到本地端点、外面轮询文件。
-   **worker 路径**：`src/pdf.js` 里 `GlobalWorkerOptions.workerSrc = "vendor/pdfjs/..."` 是相对
    文档的，探针页在子目录下会 404。`driver.js` 里显式改成绝对路径（正式应用 index.html 在
    根目录，相对路径本就正确，不必改产品代码）。
-   **CSS MIME**：静态服务器要给 `.css` 回 `text/css`，否则浏览器在标准模式下拒绝应用样式表，
    表现为"样式全丢、画布量出奇怪尺寸"。
