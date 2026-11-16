/* 浮层层级无头验证：用真实 styles.css 复刻「工具栏内嵌导出子菜单 + 兄弟标签栏」结构，
 * 通过 elementFromPoint 实证覆盖在标签栏区域的子菜单项能被命中（而不是被标签栏吃掉点击）。
 *
 * 背景：PDF 工具栏的「导出 / 另存为」子菜单 .pdf-group-menu 用 position:absolute 嵌在
 *       #pdf-toolbar（.toolbar，position:sticky; z-index:5 建立 stacking context）内。
 *       修复前标签栏 .tab-bar z6 > 工具栏 context z5，子菜单 z30 困在 context 里跳不出来，
 *       被标签栏压住；修复后 tab-bar 降到 z4 < 工具栏 z5，子菜单随工具栏整体盖过标签栏。
 *
 *   node tools/layerdiag/serve.js
 *   msedge --headless=new --disable-gpu --virtual-time-budget=4000 \
 *          --dump-dom "http://127.0.0.1:8901/layer.html" | grep -o 'data-diag="[^"]*"'
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const PORT = 8901;
const css = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");

function buildPage(oldCss) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<link rel="stylesheet" href="/styles.css">
<style>
  /* 只放大间距，确保菜单确实覆盖到标签栏；z-index 一律取真实 styles.css */
  #pdf-toolbar { position: sticky; }
  __OLD_CSS__
</style>
</head><body>
  <div class="toolbar pdf-toolbar" id="pdf-toolbar">
    <div class="pdf-group" id="grp">
      <button type="button" class="pdf-group-toggle" id="tgl">导出</button>
      <div class="pdf-group-menu" id="menu">
        <button type="button" data-pdf-action="save-as" id="mi-saveas">另存为</button>
        <button type="button" data-pdf-action="export-img">导出为图片</button>
      </div>
    </div>
  </div>
  <div class="tab-bar" id="tab-bar">
    <div class="tab-list" id="tab-list">
      <div class="tab active" id="tab-a"><span class="tab-label">甲.pdf</span><span class="tab-close">✕</span></div>
      <div class="tab" id="tab-b"><span class="tab-label">乙.md</span></div>
    </div>
    <button type="button" class="tab-new" id="tab-new">+</button>
  </div>
  <div class="editor-wrap" id="editor-wrap"><div class="editor" id="editor">正文</div></div>
<script>
(function () {
  function z(el) { return el ? getComputedStyle(el).zIndex : "none"; }
  function pos(el) { return el ? getComputedStyle(el).position : "none"; }
  var out = {};
  try {
    var toolbar = document.getElementById("pdf-toolbar");
    var menu = document.getElementById("menu");
    var item = document.getElementById("mi-saveas");
    var tabBar = document.getElementById("tab-bar");
    var tabA = document.getElementById("tab-a");

    // 让菜单展开，并显式移动到与标签栏重叠的位置（pdf-group-menu 默认 top:calc(100%+4px) 本就落在标签栏上）
    menu.classList.remove("hidden");
    menu.style.top = "calc(100% + 2px)";

    // 关键：菜单项中心点的命中元素。修复后应命中菜单项（或其后代），修复前会被标签栏命中。
    var r = item.getBoundingClientRect();
    var hx = Math.round(r.left + r.width / 2);
    var hy = Math.round(r.top + r.height / 2);
    var hit = document.elementFromPoint(hx, hy);
    var hitId = hit ? (hit.id || hit.className || hit.tagName) : "null";
    var hitInMenu = !!(hit && menu.contains(hit));
    var hitInTab = !!(hit && tabBar.contains(hit));

    out = {
      zToolbar: z(toolbar), posToolbar: pos(toolbar),
      zTabBar: z(tabBar), posTabBar: pos(tabBar),
      zMenu: z(menu),
      hitPoint: hx + "," + hy,
      hit: String(hitId),
      hitInMenu: hitInMenu,
      hitInTab: hitInTab,
      // 标签栏层级必须低于工具栏 context，子菜单才能随工具栏盖过标签栏
      orderOk: (parseInt(z(tabBar), 10) < parseInt(z(toolbar), 10)),
      menuClickable: hitInMenu && !hitInTab
    };
  } catch (e) {
    out = { error: String(e && e.stack || e) };
  }
  var ok = out.orderOk && out.menuClickable ? "PASS" : "FAIL";
  document.documentElement.setAttribute("data-diag", ok + "|" + JSON.stringify(out));
})();
</script>
</body></html>`.replace("__OLD_CSS__", oldCss || "");
}

const server = http.createServer(function (req, res) {
  const parts = req.url.split("?");
  const u = parts[0];
  const old = /old=1/.test(parts[1] || "");
  if (u === "/styles.css") {
    res.writeHead(200, { "Content-Type": "text/css;charset=utf-8" });
    res.end(css);
  } else if (u === "/layer.html" || u === "/") {
    res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
    // 对照组：把标签栏覆盖回修复前的 z6，验证测试确实能捕捉「被压住」
    res.end(buildPage(old ? ".tab-bar{z-index:6;}" : ""));
  } else {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("layerdiag listening on http://127.0.0.1:" + PORT + "/layer.html");
});
