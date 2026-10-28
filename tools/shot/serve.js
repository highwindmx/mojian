/* README 截图用：把真实 src/index.html 装进无头 Edge，mock 掉 Tauri 后端打开示例文件。
 * 用法：node tools/shot/serve.js  然后
 *   msedge --headless=new --force-device-scale-factor=2 --window-size=1132,700 \
 *          --hide-scrollbars --virtual-time-budget=8000 \
 *          --screenshot=docs/screenshot.png "http://127.0.0.1:8897/shot.html?md"
 * 参数：?md 打开 Markdown 示例；?json 打开 JSON 表格示例。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const PORT = 8897;

const TYPES = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
};

const MD_SAMPLE = `# 墨笺：本地文档，打开即编

基于 Tauri 2 的离线多格式编辑器，**不生成副本、不依赖云端**。

## 支持格式

| 格式 | 打开后 | 保存 |
| --- | --- | --- |
| Markdown | 所见即所得排版 | 无损转回 .md 源文 |
| HTML | 直接编辑正文 | 写回原文件 |
| SVG | 左预览 + 右源码 | 写回原 SVG |
| PDF | 批注 / 签章 / 水印 | 另存或导出 |
| JSON | 表格展示，双击改值 | 严格保留原类型 |

> 另有 EPUB 沉浸式阅读；草稿自动保存，关闭前会提醒未保存的修改。
`;

function buildPage(kind, winSize) {
  let html = fs.readFileSync(path.join(root, "src/index.html"), "utf8");
  // 剥掉原有脚本（改为按需注入，并保证 mock 先于 app.js 就位）
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<head>/i, '<head>\n<base href="/src/">');

  let payload;
  if (kind === "json") {
    const raw = fs.readFileSync(path.join(root, "examples/patient-visits.json"), "utf8");
    payload = { path: "D:/文档/受试者随访.json", kind: "json", content: raw };
  } else {
    payload = { path: "D:/文档/墨笺功能一览.md", kind: "markdown", content: MD_SAMPLE };
  }

  // ?win=WxH：模拟"上次记住的窗口尺寸"，用于验证启动时的黄金比例校正
  const cfg = winSize ? { windowSize: { w: winSize[0], h: winSize[1] } } : {};

  const inject = `
<script>
(function () {
  var FILE = ${JSON.stringify(payload)};
  var CONFIG = ${JSON.stringify(JSON.stringify(cfg))};
  // 模拟当前窗口：setSize 把结果写进 document.title，方便无头模式断言
  var winProxy = {
    innerSize: function () { return Promise.resolve({ width: 1132, height: 700 }); },
    outerSize: function () { return Promise.resolve({ width: 1132, height: 700 }); },
    scaleFactor: function () { return Promise.resolve(1); },
    isMaximized: function () { return Promise.resolve(false); },
    setSize: function (s) {
      // 记在 <html data-winsize>：title 会被 app 的"文件名 · 墨笺"覆盖，不能用 title 断言
      document.documentElement.setAttribute("data-winsize", s.width + "x" + s.height);
      return Promise.resolve();
    },
    onResized: function () { return function () {}; },
    onCloseRequested: function () { return function () {}; },
    onMoved: function () { return function () {}; },
    setTitle: function () { return Promise.resolve(); }
  };
  window.__TAURI__ = {
    core: {
      invoke: function (cmd, args) {
        if (cmd === "get_initial_file") return Promise.resolve(null);
        if (cmd === "read_config") return Promise.resolve(CONFIG);
        if (cmd === "write_config") return Promise.resolve(null);
        if (cmd === "open_file") return Promise.resolve(FILE);
        if (cmd === "list_supported_files") return Promise.resolve([]);
        if (cmd === "get_file_association_state") return Promise.resolve({});
        if (cmd === "load_signatures") return Promise.resolve("[]");
        if (cmd === "get_app_version") return Promise.resolve("1.0.7");
        if (cmd === "save_file" || cmd === "save_file_bytes") return Promise.resolve(null);
        return Promise.resolve(null);
      },
      convertFileSrc: function (p) { return p; }
    },
    event: { listen: function () { return Promise.resolve(function () {}); }, emit: function () { return Promise.resolve(); } },
    dialog: {
      open: function () { return Promise.resolve(null); },
      save: function () { return Promise.resolve(null); },
      message: function () { return Promise.resolve(null); },
      ask: function () { return Promise.resolve(false); }
    },
    window: {
      getCurrentWindow: function () { return winProxy; },
      PhysicalSize: function (w, h) { this.width = w; this.height = h; }
    }
  };
  window.__OPEN_PATH__ = FILE.path;
})();
</script>
<script src="vendor/pdfjs/pdf.min.js"></script>
<script src="vendor/pdf-lib/pdf-lib.min.js"></script>
<script src="vendor/highlight.min.js"></script>
<script src="vendor/marked.min.js"></script>
<script src="vendor/turndown.js"></script>
<script src="vendor/mermaid.min.js"></script>
<script src="vendor/katex/katex.min.js"></script>
<script src="tooltip.js"></script>
<script src="pdf.js"></script>
<script src="vendor/reveal/reveal.js"></script>
<script src="app.js"></script>
`;
  html = html.replace(/<\/body>/i, inject + "\n</body>");
  return html;
}

http
  .createServer(function (req, res) {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/shot.html") {
      const kind = /[?&]json\b/.test(req.url) ? "json" : "md";
      const m = req.url.match(/[?&]win=(\d+)x(\d+)/);
      const winSize = m ? [Number(m[1]), Number(m[2])] : null;
      res.writeHead(200, { "Content-Type": TYPES[".html"] });
      res.end(buildPage(kind, winSize));
      return;
    }
    const file = path.join(root, url);
    fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404);
        res.end("404 " + url);
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  .listen(PORT, "127.0.0.1", function () {
    console.log("shot server on http://127.0.0.1:" + PORT + "/shot.html");
  });
