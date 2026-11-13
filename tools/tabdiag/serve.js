/* 多标签无头验证：把真实 src/index.html + src/app.js + src/pdf.js 装进 Edge，
 * mock 掉 Tauri 后端，用「会话恢复」一次打开 3 个不同类型文件，然后按脚本
 * 模拟切标签 / 改内容 / 关闭脏标签 / 新建标签，把断言结果写进 <html data-diag>。
 *
 *   node tools/tabdiag/serve.js
 *   msedge --headless=new --disable-gpu --virtual-time-budget=9000 \
 *          --dump-dom "http://127.0.0.1:8899/tabdiag.html" | grep data-diag
 *
 * 覆盖：标签栏 DOM 顺序、快照切换（markdown ↔ text ↔ html）、脏标记隔离、
 *       丢弃时写临时副本、新建标签、关闭确认弹窗。
 * 另可加 ?mode=single 只恢复 1 个文件，作为「单文件零回归」对照组。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const PORT = 8899;

const TYPES = {
  ".html": "text/html;charset=utf-8", ".js": "text/javascript",
  ".css": "text/css;charset=utf-8", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};

const FILES = {
  "D:/文档/甲.md": {
    path: "D:/文档/甲.md", kind: "markdown",
    content: "# 甲文档\n\n这是甲的第一段。\n",
    encoding: "utf-8", bom: "", line_ending: "lf", read_only: false,
  },
  "D:/文档/乙.txt": {
    path: "D:/文档/乙.txt", kind: "text",
    content: "乙第一行\n乙第二行\n",
    encoding: "gbk", bom: "", line_ending: "crlf", read_only: false,
  },
  "D:/文档/丙.html": {
    path: "D:/文档/丙.html", kind: "html",
    content: "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>丙</title><style>p{color:#123456}</style></head><body><p>丙段落</p></body></html>",
    encoding: "utf-8", bom: "", line_ending: "lf", read_only: false,
  },
};
const OPEN_TABS = Object.keys(FILES);

/* PDF 标签验证只测 app.js 的标签管理（切换重建 / 脏确认 / 标签栏可见性），
   用 stub 顶掉 pdf.js，避免把第三方 PDF 解析的复杂度混进来。 */
const PDF_STUB = `<script>
(function () {
  window.__PDF_DIRTY__ = false;
  var root = function () { return document.getElementById("pdf-root"); };
  var tb = function () { return document.getElementById("toolbar"); };
  window.PDFApp = {
    open: function (p) {
      window.__PDF_OPEN__ = p;
      if (root()) root().classList.remove("hidden");
      if (tb()) tb().classList.add("hidden");
      window.__pdfActive = true;
      window.__PDF_DIRTY__ = false;
    },
    close: function () {
      if (root()) root().classList.add("hidden");
      if (tb()) tb().classList.remove("hidden");
      window.__pdfActive = false;
      window.__PDF_DIRTY__ = false;
    },
    isDirty: function () { return window.__PDF_DIRTY__ === true; },
    save: function () { window.__PDF_DIRTY__ = false; return Promise.resolve(); },
    saveAs: function () { return Promise.resolve(); },
    undo: function () {}, merge: function () {}, init: function () {},
    isActive: function () { return window.__pdfActive === true; },
    getToolbarCtx: function () { return {}; },
    resetToolbar: function () {}, renderToolbar: function () {}
  };
})();
</script>`;

function buildPage(mode) {
  let html = fs.readFileSync(path.join(root, "src/index.html"), "utf8");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<head>/i, '<head>\n<base href="/src/">');
  const paths = mode === "single" ? [OPEN_TABS[0]]
    : (mode === "pdf" ? [OPEN_TABS[0], "D:/文档/丁.pdf"] : OPEN_TABS);

  const inject = `
<script>
(function () {
  window.__PAGE_ERRORS__ = [];
  window.addEventListener("error", function (e) {
    window.__PAGE_ERRORS__.push(String(e.message));
    document.documentElement.setAttribute("data-err", String(e.message));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    document.documentElement.setAttribute("data-reject", String((r && r.stack) || r));
  });
  var FILES = ${JSON.stringify(FILES)};
  var CONFIG = ${JSON.stringify(JSON.stringify({ openTabs: paths }))};
  window.MODE = ${JSON.stringify(mode)};
  window.__SAVES__ = [];
  window.__BACKUPS__ = [];
  window.__CONFIGS__ = [];
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
    setTitle: function () { return Promise.resolve(); },
    destroy: function () { return Promise.resolve(); }
  };
  window.__TAURI__ = {
    core: {
      invoke: function (cmd, args) {
        args = args || {};
        if (cmd === "get_initial_file") return Promise.resolve(null);
        if (cmd === "read_config") return Promise.resolve(CONFIG);
        if (cmd === "write_config") { window.__CONFIGS__.push(args.content); return Promise.resolve(null); }
        if (cmd === "open_file") {
          var f = FILES[args.path];
          return f ? Promise.resolve(f) : Promise.reject(new Error("no such file: " + args.path));
        }
        if (cmd === "save_file") { window.__SAVES__.push(args); return Promise.resolve(null); }
        if (cmd === "save_unsaved_backup") {
          window.__BACKUPS__.push(args);
          return Promise.resolve("C:/Temp/mojian/unsaved/backup.txt");
        }
        if (cmd === "list_supported_files") return Promise.resolve([]);
        if (cmd === "get_file_association_state") return Promise.resolve({});
        if (cmd === "load_signatures") return Promise.resolve("[]");
        if (cmd === "get_app_version") return Promise.resolve("1.0.8");
        if (cmd === "open_containing_folder") return Promise.resolve(null);
        if (cmd === "open_new_instance") return Promise.resolve(null);
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
${mode === "pdf" ? PDF_STUB : ""}
<script src="vendor/reveal/reveal.js"></script>
<script src="app.js"></script>
<script>
(function () {
  var R = { steps: [] };
  function $(id) { return document.getElementById(id); }
  function tabEls() { return Array.prototype.slice.call(document.querySelectorAll("#tab-list .tab")); }
  function snap(label, extra) {
    var e = $("editor"), sv = $("source-view"), bar = $("tab-bar");
    var s = {
      label: label,
      tabs: tabEls().map(function (el) {
        return {
          id: el.dataset.tabId,
          title: (el.querySelector(".tab-label") || {}).textContent,
          active: el.classList.contains("active"),
          dirty: !el.querySelector(".tab-dot").classList.contains("hidden")
        };
      }),
      editorHtml: e ? e.innerHTML : null,
      sourceValue: sv ? sv.value : null,
      filePath: ($("file-path") || {}).textContent,
      encoding: ($("encoding-select") || {}).value,
      wrapSource: $("editor-wrap").classList.contains("source"),
      toolbarTextMode: $("toolbar").classList.contains("text-mode"),
      fileStyle: !!document.getElementById("file-style"),
      tabBarHidden: bar.classList.contains("hidden"),
      pdfRootShown: !$("pdf-root").classList.contains("hidden")
    };
    if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
    R.steps.push(s);
    return s;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clickTab(i) { var els = tabEls(); if (els[i]) els[i].click(); }

  // 标签栏必须位于 #toolbar 之后、#editor-wrap 之前（且是 body 的兄弟级子节点）
  function layoutOk() {
    var tb = $("toolbar"), bar = $("tab-bar"), ew = $("editor-wrap");
    if (!tb || !bar || !ew) return false;
    var after = Node.DOCUMENT_POSITION_FOLLOWING;
    return !!(tb.compareDocumentPosition(bar) & after) &&
           !!(bar.compareDocumentPosition(ew) & after) &&
           tb.parentNode === bar.parentNode && bar.parentNode === ew.parentNode;
  }

  setTimeout(async function () {
    R.layoutOk = layoutOk();
    R.errors = [];
    snap("initial", { backups: window.__BACKUPS__.length });

    if (MODE === "single") {
      // 对照组：只恢复 1 个 Markdown，确认单文件行为没有被多标签改造破坏
      R.assert = {
        oneTab: tabEls().length === 1,
        mdRendered: /甲文档/.test($("editor").innerHTML),
        noSourceMode: !$("editor-wrap").classList.contains("source")
      };
      document.documentElement.setAttribute("data-diag", JSON.stringify(R));
      return;
    }

    if (MODE === "pdf") {
      var pdfTag = tabEls().filter(function (el) {
        return /丁\.pdf/.test((el.querySelector(".tab-label") || {}).textContent || "");
      })[0];
      R.pdf = { count: tabEls().length, initial: snap("pdfInitial") };
      clickTab(0); await wait(450); snap("pdfToMd");
      clickTab(1); await wait(450);
      window.__PDF_DIRTY__ = true;
      clickTab(0); await wait(350);
      R.pdf.promptShown = !$("tab-close-dialog").classList.contains("hidden");
      R.pdf.stillOnPdf = tabEls()[1].classList.contains("active");
      snap("pdfLeavePrompt");
      $("tab-close-save").click(); await wait(550);
      R.pdf.savedAndSwitched = tabEls()[0].classList.contains("active");
      R.pdf.dirtyCleared = window.__PDF_DIRTY__ === false;
      snap("pdfSavedAndSwitched");
      R.assert = {
        layoutOk: R.layoutOk,
        twoTabs: R.pdf.count === 2,
        pdfTabExists: !!pdfTag,
        pdfActiveInitially: R.pdf.initial.tabs[1].active,
        tabBarVisibleOnPdf: R.pdf.initial.tabBarHidden === false,
        pdfRootShown: R.pdf.initial.pdfRootShown === true,
        mdRestored: /甲文档/.test($("editor").innerHTML),
        promptShown: R.pdf.promptShown,
        cancelStaysOnPdf: R.pdf.stillOnPdf,
        savedAndSwitched: R.pdf.savedAndSwitched,
        dirtyCleared: R.pdf.dirtyCleared,
        noJsErrors: (window.__PAGE_ERRORS__ || []).length === 0
      };
      document.documentElement.setAttribute("data-diag", JSON.stringify(R));
      return;
    }

    // 1) 切到第 1 个标签（Markdown），验证内容与编码
    clickTab(0); await wait(450);
    snap("switchToMd");

    // 2) 改内容制造脏标记，再切到第 2 个标签（纯文本）
    var e = $("editor");
    e.innerHTML += "<p>临时改动XYZ</p>";
    e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "X" }));
    await wait(180);
    snap("editedMd");
    clickTab(1); await wait(450);
    snap("switchToTxt", { mdDirtyKept: R.steps.filter(function (s) { return s.label === "editedMd"; })[0].tabs[0].dirty });

    // 3) 切回 Markdown，验证快照恢复（改动还在、脏点还在）
    clickTab(0); await wait(450);
    snap("backToMd");

    // 4) 切到 HTML，验证 #file-style 按标签恢复
    clickTab(2); await wait(450);
    snap("switchToHtml");

    // 5) 切回 Markdown 并关闭它 → 脏标签应弹确认
    clickTab(0); await wait(400);
    var closeBtn = document.querySelector('#tab-list .tab [data-tab-close]');
    if (closeBtn) closeBtn.click();
    await wait(250);
    R.closeDialogShown = !$("tab-close-dialog").classList.contains("hidden");
    snap("closePrompt");

    // 6) 点「不保存，留副本」→ 应调用 save_unsaved_backup 且标签数 -1
    var discard = $("tab-close-discard");
    if (discard) discard.click();
    await wait(600);
    R.backups = window.__BACKUPS__.map(function (b) {
      return { path: b.path, encoding: b.encoding, bom: b.bom,
               lineEnding: b.lineEnding, content: String(b.content).slice(0, 80) };
    });
    snap("afterDiscard");

    // 7) 新建标签
    $("tab-new").click(); await wait(120);
    R.newDialogShown = !$("new-dialog").classList.contains("hidden");
    $("new-md").click(); await wait(450);
    snap("afterNew");

    // 8) 最终断言
    var byLabel = function (l) { return R.steps.filter(function (s) { return s.label === l; })[0]; };
    var ini = byLabel("initial"), md = byLabel("switchToMd"), ed = byLabel("editedMd"),
        tx = byLabel("switchToTxt"), back = byLabel("backToMd"), hm = byLabel("switchToHtml"),
        af = byLabel("afterDiscard"), nw = byLabel("afterNew");
    R.assert = {
      threeTabs: ini.tabs.length === 3,
      layoutOk: R.layoutOk,
      initialActive: ini.tabs.filter(function (t) { return t.active; }).length === 1,
      mdLoaded: /甲文档/.test(md.editorHtml) && md.tabs[0].active,
      txtLoaded: /乙第一行/.test(tx.sourceValue) && tx.wrapSource && tx.toolbarTextMode && tx.encoding === "gbk",
      mdSnapshotKept: /临时改动XYZ/.test(back.editorHtml) && back.tabs[0].dirty,
      htmlStyleIsolated: /丙段落/.test(hm.editorHtml) && hm.fileStyle === true,
      dirtyIsolated: tx.tabs[0].dirty === true && tx.tabs[1].dirty === false,
      closePromptShown: R.closeDialogShown,
      backupWritten: R.backups.length === 1 && R.backups[0].lineEnding === "lf",
      tabClosed: af.tabs.length === 2,
      newTabAdded: nw.tabs.length === 3 && R.newDialogShown,
      noJsErrors: (window.__PAGE_ERRORS__ || []).length === 0
    };
    document.documentElement.setAttribute("data-diag", JSON.stringify(R));
  }, 1900);
})();
</script>
`;
  return html.replace(/<\/body>/i, inject + "\n</body>");
}

http.createServer(function (req, res) {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/tabdiag.html") {
    const mm = req.url.match(/[?&]mode=(\w+)/);
    res.writeHead(200, { "Content-Type": TYPES[".html"] });
    res.end(buildPage(mm ? mm[1] : "multi"));
    return;
  }
  const file = path.join(root, url);
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end("404 " + url); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", function () {
  console.log("tabdiag server on http://127.0.0.1:" + PORT + "/tabdiag.html");
});
