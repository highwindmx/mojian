/* 纯文本模式无头验证：把真实 src/index.html + src/app.js 装进 Edge，
 * mock 掉 Tauri 后端，断言 textMode 的 DOM 状态与保存参数。
 *
 *   node tools/textdiag/serve.js
 *   msedge --headless=new --disable-gpu --virtual-time-budget=9000 \
 *          --dump-dom "http://127.0.0.1:8898/textdiag.html?mode=text" | grep data-diag
 *
 * mode=text      可编辑纯文本（UTF-8 BOM + CRLF 元数据）
 * mode=readonly  未知后缀只读预览
 * mode=html      对照组：确认 HTML 文档没被本次改动影响
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const PORT = 8898;

const TYPES = {
  ".html": "text/html;charset=utf-8", ".js": "text/javascript",
  ".css": "text/css;charset=utf-8", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};

const PAYLOADS = {
  text: {
    path: "D:/文档/实验记录.txt", kind: "text",
    content: "第一行\n第二行\n第三行\n",
    encoding: "utf-8", bom: "utf-8", line_ending: "crlf", read_only: false,
  },
  readonly: {
    path: "D:/文档/未知后缀.weird", kind: "text",
    content: "只读内容 A\n只读内容 B\n",
    encoding: "utf-8", bom: "", line_ending: "lf", read_only: true,
  },
  html: {
    path: "D:/文档/对照.html", kind: "html",
    content: "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"></head><body><p>对照文档</p></body></html>",
    encoding: "utf-8", bom: "", line_ending: "lf", read_only: false,
  },
};

function buildPage(mode) {
  let html = fs.readFileSync(path.join(root, "src/index.html"), "utf8");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<head>/i, '<head>\n<base href="/src/">');
  const FILE = PAYLOADS[mode] || PAYLOADS.text;

  const inject = `
<script>
(function () {
  var FILE = ${JSON.stringify(FILE)};
  var CONFIG = "{}";
  window.__SAVES__ = [];
  var winProxy = {
    innerSize: function () { return Promise.resolve({ width: 1132, height: 700 }); },
    outerSize: function () { return Promise.resolve({ width: 1132, height: 700 }); },
    scaleFactor: function () { return Promise.resolve(1); },
    isMaximized: function () { return Promise.resolve(false); },
    setSize: function () { return Promise.resolve(); },
    center: function () { return Promise.resolve(); },
    show: function () { return Promise.resolve(); },
    setFocus: function () { return Promise.resolve(); },
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
        if (cmd === "save_file") { window.__SAVES__.push(args || {}); return Promise.resolve(null); }
        if (cmd === "list_supported_files") return Promise.resolve([]);
        if (cmd === "get_file_association_state") return Promise.resolve({});
        if (cmd === "load_signatures") return Promise.resolve("[]");
        if (cmd === "get_app_version") return Promise.resolve("1.0.8");
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
<script>
/* 探针：等 init() 异步打开完文件后，把状态写进 <html data-diag>（dump-dom 可读）。
   不能写 document.title —— app.js 会把它覆写成「文件名 · 墨笺」。 */
(function () {
  function collect() {
    var wrap = document.getElementById("editor-wrap");
    var toolbar = document.getElementById("toolbar");
    var sv = document.getElementById("source-view");
    var saveBtn = toolbar ? toolbar.querySelector('[data-action="save"]') : null;
    var buttons = toolbar ? Array.prototype.map.call(toolbar.querySelectorAll("button"),
      function (b) { return b.dataset.action || b.dataset.cmd || b.dataset.block || "?"; }) : [];
    var d = {
      wrapSource: !!(wrap && wrap.classList.contains("source")),
      toolbarTextMode: !!(toolbar && toolbar.classList.contains("text-mode")),
      sourceDisplay: sv ? sv.style.display : null,
      sourceLen: sv ? sv.value.length : -1,
      sourceFirstLine: sv ? sv.value.split("\\n")[0] : null,
      sourceReadOnly: sv ? sv.readOnly : null,
      hasSaveButton: !!saveBtn,
      buttons: buttons,
      status: (document.getElementById("status") || {}).textContent || ""
    };
    document.documentElement.setAttribute("data-diag", JSON.stringify(d));
    return d;
  }
  setTimeout(function () {
    var before = collect();
    // 点击「保存」触发一次写回，检查 save_file 参数（纯文本不该被包成 HTML 文档）
    var btn = document.querySelector('[data-action="save"]');
    if (btn) btn.click();
    setTimeout(function () {
      var s = window.__SAVES__ || [];
      document.documentElement.setAttribute("data-saves", JSON.stringify(s.map(function (x) {
        return { kind: x.kind, content: x.content, encoding: x.encoding,
                 bom: x.bom, lineEnding: x.lineEnding, path: x.path };
      })));
      document.documentElement.setAttribute("data-diag2", JSON.stringify({
        before: before, saveCount: s.length,
        saveContent: s.length ? s[0].content : null,
        saveStartsWithDoctype: s.length ? /^\\s*<!DOCTYPE/i.test(s[0].content || "") : null
      }));
    }, 600);
  }, 1800);
})();
</script>
`;
  return html.replace(/<\/body>/i, inject + "\n</body>");
}

http.createServer(function (req, res) {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/textdiag.html") {
    const m = req.url.match(/[?&]mode=(\w+)/);
    res.writeHead(200, { "Content-Type": TYPES[".html"] });
    res.end(buildPage(m ? m[1] : "text"));
    return;
  }
  const file = path.join(root, url);
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end("404 " + url); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", function () {
  console.log("textdiag server on http://127.0.0.1:" + PORT + "/textdiag.html");
});
