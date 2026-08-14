"use strict";
/* =====================================================================
 * 墨笺 · PDF 模块（查看 / 旋转 / 合并 / 拆分 / 备注 / 高亮划线 / 查找 /
 *   打印 / 导出图 / 转Word / 文字水印 / 签章）
 * 依赖（已在 index.html 中先于本文件加载）：
 *   - pdf.js  v3 UMD 全局 `pdfjsLib`
 *   - pdf-lib UMD 全局 `PDFLib`
 * 所有字节读写走 Rust 命令（read_file_base64 / save_file_bytes /
 * save_files_bytes），前端只持有一份原始字节做预览与改写。
 * ===================================================================== */
window.PDFApp = (function () {
  const TAURI = window.__TAURI__ || {};
  const TAURI_CORE = TAURI.core || TAURI.tauri || null;

  function invoke(cmd, args) {
    if (TAURI_CORE && typeof TAURI_CORE.invoke === "function") return TAURI_CORE.invoke(cmd, args);
    if (TAURI && typeof TAURI.invoke === "function") return TAURI.invoke(cmd, args);
    return Promise.reject(new Error("Tauri 运行时不可用"));
  }
  function tauriOpen(opts) {
    if (TAURI.dialog && typeof TAURI.dialog.open === "function") return TAURI.dialog.open(opts);
    return invoke("plugin:dialog|open", { options: opts });
  }
  function tauriSave(opts) {
    if (TAURI.dialog && typeof TAURI.dialog.save === "function") return TAURI.dialog.save(opts);
    return invoke("plugin:dialog|save", { options: opts });
  }
  function uiAlert(msg) {
    if (TAURI.dialog && TAURI.dialog.message) return TAURI.dialog.message(msg, { title: "提示" });
    window.alert(msg); return Promise.resolve();
  }
  function uiConfirm(msg) {
    if (TAURI.dialog && TAURI.dialog.ask) return TAURI.dialog.ask(msg, { title: "确认" });
    return Promise.resolve(window.confirm(msg));
  }

  /* ---------- 工具：base64 <-> Uint8Array ---------- */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function bytesToB64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function dataURLToBytes(url) { return b64ToBytes(url.split(",")[1]); }

  /* 异步版 base64 解码：分块拷贝并在每块之间让出主线程，避免大文件同步解码时
   * 主线程被长时间占用导致窗口"未响应"。用于打开/合并本地 PDF 文件。 */
  async function b64ToBytesAsync(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    const step = 1 << 16; // 64K 一块
    for (let i = 0; i < len; i += step) {
      const end = Math.min(len, i + step);
      for (let j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
      if (i + step < len) await new Promise(function (r) { setTimeout(r, 0); });
    }
    return bytes;
  }

  /* 将文本编码为 PDF Unicode（UTF-16BE + FEFF BOM）十六进制串，
   * 使中文等备注在其它 PDF 阅读器中也正确显示（pdf-lib 默认 PDFString 仅 Latin-1）。 */
  function toPdfUnicodeHex(s) {
    let hex = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      const units = [];
      if (cp > 0xffff) {
        const e = cp - 0x10000;
        units.push(0xd800 + (e >> 10), 0xdc00 + (e & 0x3ff));
      } else {
        units.push(cp);
      }
      for (const u of units) hex += u.toString(16).padStart(4, "0");
    }
    return hex;
  }
  function pdfText(s) {
    const hex = "FEFF" + toPdfUnicodeHex(s || "");
    if (PDFLib.PDFHexString && PDFLib.PDFHexString.of) return PDFLib.PDFHexString.of(hex);
    return PDFLib.PDFString.of(s || "");
  }
  function escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ---------- 状态 ---------- */
  let pdfDoc = null;
  let pdfBytes = null;
  let pdfLibDoc = null;
  let currentPath = null;
  let numPages = 0;
  let currentPage = 1;
  let scale = 1;
  let dirty = false;
  let noteMode = false;
  let pendingNote = null;
  let notes = [];
  let highlights = [];     // [{ page, quads:[[8 numbers]...], type:'highlight'|'underline' }]
  let signatures = [];     // [{ id, page, x, y, w, h, dataUrl, bytes }]  (x,y 为 PDF 坐标，左上)
  let sigScale = 1;        // 签章放置时的整体缩放（弹窗「大小」滑块，1 = 原始画板尺寸）
  let sigWhiteBg = true;   // 导出时把签名合成到白底（去掉 alpha/SMask，避免 Adobe 报"页面错误"）
  let sigSeq = 0;          // 签章自增 id（前端交互/编辑定位用）
  let pendingSig = null;   // { dataUrl, bytes, w, h }  待放置的签章
  let sigReplaceId = null; // 替换模式：正在被替换的签章 id（非 null 时选图直接替换，不进放置态）
  let sigSuppressClick = false; // 签章交互后抑制 pagesEl 的 click（避免误触发备注/放置）
  let watermarkCfg = null; // { text, size, opacity, color, diagonal }
  let pageRotations = {};
  let pageViewports = {};
  let thumbsBuilt = false;
  let searchQuery = "";
  let searchMatchPages = [];
  let searchIdx = 0;
  let searchSeq = 0;     // 每次查找自增；旧查找若还在跑，靠它放弃自己的结果（避免"无匹配"假阴性）
  let searching = false; // 查找进行中（用于拦截 findNext 串页 + 显示加载态）
  let pageTextCache = {};
  let mouseMode = "select"; // 'select' | 'hand'
  let pendingSel = null;    // { page, rects, vp, sel }
  // 懒渲染状态：已渲染的页/缩略图集合 + IntersectionObserver 句柄
  let renderedPages = new Set();
  let renderedThumbs = new Set();
  let pageObserver = null;
  let thumbObserver = null;
  let curEncoding = "";
  // 撤回栈：每次"会改动文档"的操作前压入一份快照（水印/签章/备注/高亮/旋转）
  let history = [];
  const HISTORY_MAX = 20;

  /* ---------- DOM ---------- */
  let pdfRoot, pdfToolbar, sidebar, thumbsEl, outlineEl, mainEl, pagesEl;
  let noteDialog, noteTextInput, splitDialog, findBar, findInput, findCount, loadingEl, annoBar;

  function $(id) { return document.getElementById(id); }
  function setStatus(msg, err) {
    const el = $("pdf-sb-left");
    if (el) { el.textContent = msg || ""; el.classList.toggle("status-error", !!err); }
  }
  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, 2600);
  }
  function setFilePath(path) {
    const el = $("file-path");
    if (el) { el.textContent = path || "未打开文件"; el.title = path || ""; }
    const fb = $("open-folder");
    if (fb) fb.disabled = !path;
  }
  function showLoading(text) {
    if (!loadingEl) return;
    const t = $("pdf-loading-text");
    if (t && text) t.textContent = text;
    loadingEl.classList.remove("hidden");
  }
  function hideLoading() { if (loadingEl) loadingEl.classList.add("hidden"); }

  /* 同步"未保存修改"指示：高亮保存按钮 + 窗口标题加/去 * 脏标记。
   * 之前此函数未定义，导致每次打开/修改 PDF 都抛 ReferenceError（打开即失败）。 */
  function updateSaveState() {
    const saveBtn = document.querySelector('[data-pdf-action="save"]');
    if ( saveBtn ) saveBtn.classList.toggle("dirty", !!dirty);
    try {
      let t = document.title
        .replace(/\s*\*\s*$/, "")          // 去旧 *
        .replace(/\s*·\s*墨笺\s*$/, "");   // 去旧的 "· 墨笺" 后缀，重新拼
      document.title = t + (dirty ? " * · 墨笺" : " · 墨笺");
    } catch (e) {}
  }

  /* =====================================================================
   * 撤回（水印 / 签章 / 备注 / 高亮划线 / 旋转）
   * 快照保存"未写盘的改动集合 + 当前字节引用"。水印是直接烤进 pdfBytes 的，
   * 因此把 pdfBytes 的引用一并存下（替换而非原地修改，故存引用即可，无额外内存拷贝）。
   * ===================================================================== */
  function snapshot() {
    return {
      bytes: pdfBytes,
      notes: notes.slice(),
      highlights: highlights.slice(),
      signatures: signatures.slice(),
      rotations: Object.assign({}, pageRotations),
      dirty: dirty,
    };
  }
  function pushHistory() {
    history.push(snapshot());
    if (history.length > HISTORY_MAX) history.shift();
    updateUndoState();
  }
  function clearHistory() { history = []; updateUndoState(); }
  function updateUndoState() {
    const b = document.querySelector('[data-pdf-action="undo"]');
    if (b) b.disabled = history.length === 0;
  }
  async function undo() {
    if (!history.length) { toast("没有可撤回的操作"); return; }
    const snap = history.pop();
    const bytesChanged = snap.bytes !== pdfBytes;
    notes = snap.notes;
    highlights = snap.highlights;
    signatures = snap.signatures;
    pageRotations = snap.rotations;
    dirty = snap.dirty;
    updateSaveState();
    updateUndoState();
    if (bytesChanged) {
      // 水印这类"已烤进字节"的操作：回滚字节并整体重载
      pdfBytes = snap.bytes;
      pdfLibDoc = null;
      showLoading("正在撤回…");
      try { await reloadAfterSave(pdfBytes); } finally { hideLoading(); }
    } else {
      reRenderAll();
      renderedThumbs.forEach(function (n) { renderThumb(n, true); });
    }
    toast("已撤回");
    setStatus("已撤回上一步操作");
  }

  /* 取视口内"可见面积最大"的页码，作为"当前页"（比 IntersectionObserver 更稳，
   * 彻底解决"本页旋转只作用到首页"的错页问题） */
  function getCurrentVisiblePage() {
    if (!mainEl || !pagesEl) return currentPage;
    const cr = mainEl.getBoundingClientRect();
    let best = currentPage, bestOv = 0;
    pagesEl.querySelectorAll(".pdf-page").forEach(function (p) {
      const pr = p.getBoundingClientRect();
      const ov = Math.max(0, Math.min(cr.bottom, pr.bottom) - Math.max(cr.top, pr.top));
      if (ov > bestOv) { bestOv = ov; best = Number(p.dataset.num); }
    });
    return best;
  }

  /* =====================================================================
   * PDF 工具栏（数据驱动：与编辑器工具栏一致，支持显隐 + ↑↓ 排序，持久化到
   * mojian.config.json 的 pdfToolbar 字段）
   *  - keep:true 的核心控件（页码框 / 缩放 / 保存 / 关闭）始终显示、不可隐藏排序
   *  - "__divider__" 为分组分隔符
   * ===================================================================== */
  /* 单个按钮项：{ name, action, label, title, cls?, keep? }
   * 分组项：    { name, kind:"group", label, title, children:[token...] }
   *   - children 必须是本表里存在的 token（通常是普通按钮项）
   *   - 分组在工具栏里渲染成一个带下拉箭头的按钮，点开后是 children 子菜单
   *   - 分组本身作为整体显隐 / 排序；children 不参与独立排序
   */
  const PDF_TOOLBAR_ITEMS = {
    open:           { name: "打开",      action: "open",         label: "打开",     title: "打开 PDF" },
    "mouse-mode":   { name: "选择/手型", action: "mouse-mode",   label: "选择",     title: "切换 选择/手型（手型可拖拽平移）" },
    prev:           { name: "上一页",    action: "prev",         label: "‹",        title: "上一页" },
    PAGEBOX:        { kind: "pagebox", keep: true },
    next:           { name: "下一页",    action: "next",         label: "›",        title: "下一页" },
    "zoom-out":     { name: "缩小",      action: "zoom-out",     label: "−",        title: "缩小 5%", keep: true },
    ZOOMLABEL:      { kind: "zoomlabel", keep: true },
    "zoom-in":      { name: "放大",      action: "zoom-in",      label: "＋",       title: "放大 5%", keep: true },
    "zoom-100":     { name: "100%",      action: "zoom-100",     label: "100%",     title: "重置为 100%" },
    fit:            { name: "适合宽度",  action: "fit",          label: "适合宽度", title: "适合宽度" },
    "rotate-left":  { name: "左转本页",  action: "rotate-left",  label: "↺本页",    title: "左转当前可见页 90°" },
    "rotate-right": { name: "右转本页",  action: "rotate-right", label: "↻本页",    title: "右转当前可见页 90°" },
    "rotate-all":   { name: "旋转全部",  action: "rotate-all",   label: "旋转全部", title: "旋转全部页面" },
    undo:           { name: "撤回",      action: "undo",         label: "撤回",     title: "撤回上一步（水印 / 签章 / 备注 / 高亮 / 旋转）" },
    merge:          { name: "合并",      action: "merge",        label: "合并",     title: "合并多个 PDF" },
    split:          { name: "拆分",      action: "split",        label: "拆分",     title: "拆分 PDF" },
    find:           { name: "查找",      action: "find",         label: "查找",     title: "在 PDF 中查找" },
    "export-img":   { name: "导出图",    action: "export-img",   label: "导出图",   title: "导出为图片（PNG/JPEG，可选目录）" },
    "export-word":  { name: "转Word",    action: "export-word",  label: "转Word",   title: "转为 Word（文本版，图/表处留占位）" },
    "save-as-pdf":  { name: "另存为新PDF", action: "save-as",    label: "另存为新PDF", title: "把修改后的 PDF 另存为新文件" },
    watermark:      { name: "水印",      action: "watermark",    label: "水印",     title: "添加文字水印（应用后可撤回）" },
    signature:      { name: "签章",      action: "signature",    label: "签章",     title: "插入图片 / 手绘签章" },
    print:          { name: "打印",      action: "print",        label: "打印",     title: "打印" },
    save:           { name: "保存",      action: "save",         label: "保存",     title: "保存修改回原文件", cls: "primary", keep: true },
    close:          { name: "关闭",      action: "close",        label: "关闭",     title: "关闭 PDF，返回编辑器", keep: true },

    /* —— 分组（下拉） —— 箭头只用 CSS ::after 绘制，label 不再带字面 ▾（否则会显示两个箭头） */
    "save-as-group": { name: "另存为", kind: "group", label: "另存为", title: "另存为 / 导出",
                       children: ["save-as-pdf", "export-img", "export-word"] },
    "tools-group":    { name: "其他工具", kind: "group", label: "其他工具", title: "水印 / 合并 / 拆分",
                       children: ["watermark", "merge", "split"] },
  };
  /* 用户指定的初始顺序（备注按钮已移除；100% / 适合宽度 / 选择手型 默认隐藏，可在定制里开启；
   * 旋转展开为三个内联按钮；页码的上一页/下一页与页码输入框放在底部状态栏，不进工具栏） */
  const PDF_DEFAULT_ORDER = [
    "open", "save", "save-as-group", "print", "close",
    "__divider__",
    "undo",
    "__divider__",
    "find",
    "__divider__",
    "zoom-out", "ZOOMLABEL", "zoom-in",
    "__divider__",
    "rotate-left", "rotate-right", "rotate-all",
    "__divider__",
    "signature",
    "tools-group",
    "__divider__",
    "zoom-100", "fit", "mouse-mode",   // 默认隐藏，但保留在列表里可一键开启
  ];
  /* 默认隐藏的按钮（仍是合法项，定制弹窗里以未勾选形式出现） */
  const PDF_DEFAULT_HIDDEN = { "zoom-100": true, "fit": true, "mouse-mode": true };

  function cfgBridge() { return window.MojianConfig || null; }
  /* 读取配置；首次（无已存配置）用内置默认（含默认隐藏项）；
   * 旧配置若缺新增按钮（如 undo / 分组）自动补到默认位置附近；失效 token 直接丢弃 */
  function getPdfToolbarConfig() {
    const br = cfgBridge();
    const all = (br && br.get && br.get()) || {};
    const t = all.pdfToolbar;
    if (!t || !Array.isArray(t.order) || !t.order.length) {
      return { order: PDF_DEFAULT_ORDER.slice(), hidden: Object.assign({}, PDF_DEFAULT_HIDDEN) };
    }
    let order = t.order.slice().filter(function (tok) {
      return tok === "__divider__" || !!PDF_TOOLBAR_ITEMS[tok];
    });
    PDF_DEFAULT_ORDER.forEach(function (tok, i) {
      if (tok === "__divider__") return;
      if (order.indexOf(tok) >= 0) return;
      // 新增按钮：插到它在默认顺序里的前一个已存在项之后，尽量贴近原位
      let at = order.length;
      for (let j = i - 1; j >= 0; j--) {
        const p = order.indexOf(PDF_DEFAULT_ORDER[j]);
        if (p >= 0) { at = p + 1; break; }
      }
      order.splice(at, 0, tok);
    });
    const hidden = (t.hidden && typeof t.hidden === "object") ? Object.assign({}, t.hidden) : {};
    return { order: order, hidden: hidden };
  }
  function savePdfToolbarConfig(order, hidden) {
    const br = cfgBridge();
    if (br && br.save) br.save({ pdfToolbar: order ? { order: order, hidden: hidden || {} } : null });
  }

  function renderPdfToolbar() {
    if (!pdfToolbar) return;
    const cfg = getPdfToolbarConfig();
    pdfToolbar.innerHTML = "";
    let lastWasDivider = true;
    cfg.order.forEach(function (token) {
      if (token === "__divider__") {
        if (lastWasDivider) return;
        const d = document.createElement("span");
        d.className = "divider";
        pdfToolbar.appendChild(d);
        lastWasDivider = true;
        return;
      }
      const item = PDF_TOOLBAR_ITEMS[token];
      if (!item) return;
      if (cfg.hidden[token] && !item.keep) return;
      lastWasDivider = false;
      if (item.kind === "pagebox") {
        const sp = document.createElement("span");
        sp.className = "pdf-page-box";
        sp.innerHTML = '<span id="pdf-page-info">— / —</span><input type="number" id="pdf-page-jump" min="1" title="跳转到页">';
        pdfToolbar.appendChild(sp);
        return;
      }
      if (item.kind === "zoomlabel") {
        const sp = document.createElement("span");
        sp.className = "zoom-label";
        sp.id = "pdf-zoom-label";
        sp.textContent = Math.round(scale * 100) + "%";
        pdfToolbar.appendChild(sp);
        return;
      }
      if (item.kind === "group") {
        pdfToolbar.appendChild(buildGroup(token, item));
        return;
      }
      const b = document.createElement("button");
      b.dataset.pdfAction = item.action;
      b.title = item.title || item.name;
      b.textContent = item.label || item.name;
      if (item.cls) b.className = item.cls;
      pdfToolbar.appendChild(b);
    });
    // 尾部残留的分隔符去掉
    const last = pdfToolbar.lastElementChild;
    if (last && last.classList.contains("divider")) last.remove();
    syncToolbarState();
  }
  /* 构建一个分组下拉：按钮（带箭头）+ 隐藏的子菜单 */
  function buildGroup(token, item) {
    const g = document.createElement("div");
    g.className = "pdf-group";
    g.dataset.pdfGroup = token;
    const tg = document.createElement("button");
    tg.type = "button";
    tg.className = "pdf-group-toggle";
    tg.dataset.pdfGroupToggle = token;
    tg.title = item.title || item.name;
    tg.textContent = item.label || item.name;
    g.appendChild(tg);
    const menu = document.createElement("div");
    menu.className = "pdf-group-menu hidden";
    menu.dataset.pdfGroupMenu = token;
    (item.children || []).forEach(function (childToken) {
      const ci = PDF_TOOLBAR_ITEMS[childToken];
      if (!ci) return;
      const cb = document.createElement("button");
      cb.type = "button";
      cb.dataset.pdfAction = ci.action;
      cb.textContent = ci.label || ci.name;
      cb.title = ci.title || ci.name;
      menu.appendChild(cb);
    });
    g.appendChild(menu);
    return g;
  }
  function togglePdfGroup(toggleBtn) {
    const token = toggleBtn.dataset.pdfGroupToggle;
    const menu = pdfToolbar.querySelector('.pdf-group-menu[data-pdf-group-menu="' + token + '"]');
    if (!menu) return;
    const willOpen = menu.classList.contains("hidden");
    closePdfGroups();
    if (willOpen) menu.classList.remove("hidden");
  }
  function closePdfGroups() {
    if (!pdfToolbar) return;
    pdfToolbar.querySelectorAll(".pdf-group-menu:not(.hidden)").forEach(function (m) { m.classList.add("hidden"); });
  }
  /* 工具栏重建后，把依赖 DOM 的状态（页码 / 缩放 / 模式 / 脏标记 / 撤回可用）同步回去 */
  function syncToolbarState() {
    updatePageInfo();
    const zl = $("pdf-zoom-label");
    if (zl) zl.textContent = Math.round(scale * 100) + "%";
    const mm = pdfToolbar.querySelector('[data-pdf-action="mouse-mode"]');
    if (mm) { mm.textContent = mouseMode === "select" ? "选择" : "手型"; mm.classList.toggle("active", mouseMode === "hand"); }
    const nb = pdfToolbar.querySelector('[data-pdf-action="note"]');
    if (nb) nb.classList.toggle("active", noteMode);
    updateSaveState();
    updateUndoState();
  }
  function bindPageJump() {
    const jump = $("pdf-page-jump");
    if (!jump) return;
    jump.addEventListener("change", function () {
      const n = parseInt(jump.value, 10);
      if (!isNaN(n)) goToPage(n);
    });
    jump.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); const n = parseInt(jump.value, 10); if (!isNaN(n)) goToPage(n); }
    });
  }

  /* 复用编辑器那套「自定义工具栏」弹窗（#toolbar-settings），列表内容换成 PDF 按钮 */
  function openPdfToolbarSettings() {
    const modal = $("toolbar-settings");
    const list = $("toolbar-settings-list");
    if (!modal || !list) return;
    const cfg = getPdfToolbarConfig();
    const title = modal.querySelector("h3");
    if (title) title.textContent = "自定义 PDF 工具栏";
    list.innerHTML = "";
    cfg.order.forEach(function (token) {
      if (token === "__divider__") {
        const hr = document.createElement("div");
        hr.className = "tb-set-divider";
        list.appendChild(hr);
        return;
      }
      const item = PDF_TOOLBAR_ITEMS[token];
      if (!item || item.keep) return;
      const idx = cfg.order.indexOf(token);
      let upEnabled = idx > 0, downEnabled = idx < cfg.order.length - 1;
      if (upEnabled) {
        const prev = cfg.order[idx - 1];
        const pi = PDF_TOOLBAR_ITEMS[prev];
        if (prev === "__divider__" || (pi && pi.keep)) upEnabled = false;
      }
      if (downEnabled) {
        const next = cfg.order[idx + 1];
        const ni = PDF_TOOLBAR_ITEMS[next];
        if (next === "__divider__" || (ni && ni.keep)) downEnabled = false;
      }
      const row = document.createElement("div");
      row.className = "tb-set-row";
      if (item.kind === "group") row.classList.add("tb-set-group");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !cfg.hidden[token];
      cb.addEventListener("change", function () {
        const c = getPdfToolbarConfig();
        if (cb.checked) delete c.hidden[token]; else c.hidden[token] = true;
        savePdfToolbarConfig(c.order, c.hidden);
        renderPdfToolbar();
      });
      const span = document.createElement("span");
      span.textContent = item.name + (item.kind === "group" ? " ▾" : "");
      row.appendChild(cb); row.appendChild(span);
      if (item.kind === "group") {
        const kids = document.createElement("div");
        kids.className = "tb-set-children";
        kids.textContent = (item.children || []).map(function (c) { return (PDF_TOOLBAR_ITEMS[c] || {}).name || c; }).join("、");
        row.appendChild(kids);
      }
      const up = document.createElement("button");
      up.type = "button"; up.className = "tb-move"; up.textContent = "↑"; up.title = "上移";
      up.disabled = !upEnabled;
      up.addEventListener("click", function (e) { e.preventDefault(); movePdfToolbarItem(token, -1); });
      const down = document.createElement("button");
      down.type = "button"; down.className = "tb-move"; down.textContent = "↓"; down.title = "下移";
      down.disabled = !downEnabled;
      down.addEventListener("click", function (e) { e.preventDefault(); movePdfToolbarItem(token, 1); });
      row.appendChild(up); row.appendChild(down);
      list.appendChild(row);
    });
    modal.classList.remove("hidden");
  }
  function movePdfToolbarItem(token, dir) {
    const cfg = getPdfToolbarConfig();
    const order = cfg.order.slice();
    const idx = order.indexOf(token);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= order.length) return;
    const other = order[swap];
    if (other === "__divider__") return;
    const oi = PDF_TOOLBAR_ITEMS[other];
    if (oi && oi.keep) return;
    order[idx] = other; order[swap] = token;
    savePdfToolbarConfig(order, cfg.hidden);
    renderPdfToolbar();
    openPdfToolbarSettings();
  }
  function resetPdfToolbar() {
    savePdfToolbarConfig(null, null);
    renderPdfToolbar();
    openPdfToolbarSettings();
  }

  /* =====================================================================
   * 初始化
   * ===================================================================== */
  function init() {
    if (!window.pdfjsLib) { console.warn("pdf.js 未加载"); return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";

    pdfRoot = $("pdf-root");
    pdfToolbar = $("pdf-toolbar");
    sidebar = $("pdf-sidebar");
    thumbsEl = $("pdf-thumbs");
    outlineEl = $("pdf-outline");
    mainEl = $("pdf-main");
    pagesEl = $("pdf-pages");
    noteDialog = $("pdf-note-dialog");
    noteTextInput = $("pdf-note-text");
    splitDialog = $("pdf-split-dialog");
    findBar = $("pdf-find-bar");
    findInput = $("pdf-find-input");
    findCount = $("pdf-find-count");
    loadingEl = $("pdf-loading");
    annoBar = $("anno-bar");

    if (!pdfRoot || !pdfToolbar) return;

    pdfToolbar.addEventListener("click", function (e) {
      const toggle = e.target.closest(".pdf-group-toggle");
      if (toggle) { e.stopPropagation(); togglePdfGroup(toggle); return; }
      const btn = e.target.closest("button");
      if (!btn) return;
      const act = btn.dataset.pdfAction;
      if (act) { handlePdfAction(act); closePdfGroups(); }
    });
    // 点击工具栏之外的地方关闭所有下拉菜单
    document.addEventListener("click", function (e) {
      if (!e.target.closest || e.target.closest(".pdf-group")) return;
      closePdfGroups();
    });

    renderPdfToolbar();   // 依配置动态生成（含页码框 / 缩放标签，内部会绑定跳页输入）

    // 置底状态栏（静态 HTML）：页码跳转 + 上一页 / 下一页（仅绑定一次）
    const pj = $("pdf-page-jump");
    if (pj) {
      pj.addEventListener("change", function () { const n = parseInt(pj.value, 10); if (!isNaN(n)) goToPage(n); });
      pj.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); const n = parseInt(pj.value, 10); if (!isNaN(n)) goToPage(n); } });
    }
    const pv = $("pdf-prev"), nx = $("pdf-next");
    if (pv) pv.addEventListener("click", function () { goToPage(currentPage - 1); });
    if (nx) nx.addEventListener("click", function () { goToPage(currentPage + 1); });

    sidebar.querySelectorAll("[data-pdf-tab]").forEach(function (t) {
      t.addEventListener("click", function () {
        sidebar.querySelectorAll("[data-pdf-tab]").forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        const tab = t.dataset.pdfTab;
        thumbsEl.classList.toggle("hidden", tab !== "thumbs");
        outlineEl.classList.toggle("hidden", tab !== "outline");
      });
    });

    // 页面点击：备注模式 / 签章放置
    pagesEl.addEventListener("click", function (e) {
      if (sigSuppressClick) { sigSuppressClick = false; return; }
      // 签章放置：文字层会盖在 canvas 之上，必须用 .pdf-page 定位
      if (pendingSig) {
        e.preventDefault();
        e.stopPropagation();
        const sigPage = e.target.closest(".pdf-page");
        if (!sigPage) return;
        const sigNum = Number(sigPage.dataset.num);
        const sigCanvas = sigPage.querySelector(".pdf-canvas");
        if (!sigCanvas) return;
        const r = sigCanvas.getBoundingClientRect();
        const vp = pageViewports[sigNum];
        if (!vp) return;
        const p = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
        const sw = 120, sh = 120 * (pendingSig.h / pendingSig.w || 1);
        pushHistory();
        // 约定：x,y 为签章"左上角"的 PDF 坐标（renderSignaturesForPage / save 均按此解释）
        signatures.push({
          id: ++sigSeq, page: sigNum, x: p[0], y: p[1], w: sw, h: sh,
          dataUrl: pendingSig.dataUrl, bytes: pendingSig.bytes
        });
        pendingSig = null;
        pagesEl.classList.remove("sig-placing");
        dirty = true; updateSaveState();
        renderPage(sigNum, true);
        setStatus("已放置签章，点「保存」写回文件");
        return;
      }
      if (!noteMode) return;
      const canvas = e.target.closest(".pdf-canvas");
      if (!canvas) return;
      const pageEl = canvas.closest(".pdf-page");
      const num = Number(pageEl.dataset.num);
      const rect = canvas.getBoundingClientRect();
      pendingNote = { page: num, clientX: e.clientX - rect.left, clientY: e.clientY - rect.top };
      noteTextInput.value = "";
      openModal(noteDialog);
      noteTextInput.focus();
    });

    // 已放置签章：拖动移动 / 拖角缩放 / 单击弹编辑菜单
    pagesEl.addEventListener("pointerdown", onSigPointerDown);

    // 点击签章菜单 / 签章以外区域时收起菜单
    document.addEventListener("click", function (e) {
      if (sigMenuEl && !sigMenuEl.classList.contains("hidden") &&
          !sigMenuEl.contains(e.target) && !e.target.closest(".pdf-sig-overlay")) {
        hideSigMenu();
      }
    });

    // 选中文字 → 显示批注浮条
    pagesEl.addEventListener("mouseup", function () {
      if (mouseMode !== "select" || pendingSig) return;
      setTimeout(processSelection, 0);
    });

    const noteOk = $("pdf-note-ok");
    if (noteOk) noteOk.addEventListener("click", onNoteOk);
    const splitOk = $("pdf-split-ok");
    if (splitOk) splitOk.addEventListener("click", onSplitOk);
    const rotateOk = $("pdf-rotate-ok");
    if (rotateOk) rotateOk.addEventListener("click", onRotateOk);

    if (findInput) {
      findInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runSearch(findInput.value); } });
      // 输入即查（防抖）：新输入会让 searchSeq 自增，旧查找在循环里自动放弃，避免卡顿/串结果
      let _t = null;
      findInput.addEventListener("input", function () {
        clearTimeout(_t);
        const v = findInput.value;
        _t = setTimeout(function () { runSearch(v); }, 400);
      });
    }
    const fprev = $("pdf-find-prev"), fnext = $("pdf-find-next"), fcls = $("pdf-find-close");
    if (fprev) fprev.addEventListener("click", function () { findNext(-1); });
    if (fnext) fnext.addEventListener("click", function () { findNext(1); });
    if (fcls) fcls.addEventListener("click", function () { findBar.classList.add("hidden"); clearSearchHighlights(); searchQuery = ""; });

    // 批注浮条按钮
    if (annoBar) annoBar.querySelectorAll("[data-anno]").forEach(function (b) {
      b.addEventListener("click", function () { applyAnnotation(b.dataset.anno); });
    });

    // 导出图片 / 转Word / 水印 / 签章 弹窗按钮
    const eiOk = $("pdf-export-img-ok"); if (eiOk) eiOk.addEventListener("click", onExportImgOk);
    const ewOk = $("pdf-export-word-ok"); if (ewOk) ewOk.addEventListener("click", onExportWordOk);
    const wmOk = $("pdf-wm-ok"); if (wmOk) wmOk.addEventListener("click", function () { onWatermarkOk(); });
    const eiDir = $("pdf-img-dir-pick"); if (eiDir) eiDir.addEventListener("click", pickExportImgDir);
    setupSignatureDialog();

    [noteDialog, splitDialog].forEach(function (m) {
      if (!m) return;
      m.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { closeModal(m); }); });
      m.addEventListener("click", function (e) { if (e.target === m) closeModal(m); });
    });
    // 导出 / 水印 / 签章 弹窗关闭
    ["pdf-export-img-dialog", "pdf-export-word-dialog", "pdf-watermark-dialog", "pdf-signature-dialog", "pdf-rotate-dialog"].forEach(function (id) {
      const m = $(id); if (!m) return;
      m.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { closeModal(m); }); });
      m.addEventListener("click", function (e) { if (e.target === m) closeModal(m); });
    });

    setupScrollTracking();
    setupSidebarResizer();

    // 快捷键：Esc 取消签章放置 / 关闭备注气泡；Ctrl+Z 撤回（仅 PDF 激活时）
    document.addEventListener("keydown", function (e) {
      if (!isActive()) return;
      if (e.key === "Escape") {
        if (pendingSig) { cancelPendingSig(); e.preventDefault(); }
        hideNotePopup();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
      }
    });
    // 点击别处关掉备注气泡
    document.addEventListener("mousedown", function (e) {
      const p = document.getElementById("pdf-note-popup");
      if (p && !p.contains(e.target) && !(e.target.classList && e.target.classList.contains("pdf-note-marker"))) hideNotePopup();
    });
  }

  function cancelPendingSig() {
    pendingSig = null;
    if (pagesEl) pagesEl.classList.remove("sig-placing");
    setStatus("已取消签章放置");
  }

  /* 侧栏（缩略图 / 大纲）鼠标拖拽调宽，宽度记到 localStorage */
  function setupSidebarResizer() {
    const rz = $("pdf-sidebar-resizer");
    if (!rz || !sidebar) return;
    try {
      const saved = parseInt(localStorage.getItem("pdfSidebarWidth"), 10);
      if (!isNaN(saved)) sidebar.style.flexBasis = clamp(saved, 120, 560) + "px";
    } catch (e) {}
    let dragging = false;
    rz.addEventListener("mousedown", function (e) {
      dragging = true;
      document.body.classList.add("col-resizing");
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      const left = pdfRoot.getBoundingClientRect().left;
      const w = clamp(e.clientX - left, 120, 560);
      sidebar.style.flexBasis = w + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("col-resizing");
      try { localStorage.setItem("pdfSidebarWidth", parseInt(sidebar.style.flexBasis, 10) || 210); } catch (e) {}
    });
    // 双击分隔条恢复默认宽度
    rz.addEventListener("dblclick", function () {
      sidebar.style.flexBasis = "210px";
      try { localStorage.setItem("pdfSidebarWidth", "210"); } catch (e) {}
    });
  }

  function openModal(m) { if (m) m.classList.remove("hidden"); }
  function closeModal(m) { if (m) m.classList.add("hidden"); }
  function hideAnnoBar() { if (annoBar) annoBar.classList.add("hidden"); }

  function setupScrollTracking() {
    if (!mainEl) return;
    let t = null;
    mainEl.addEventListener("scroll", function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        const n = getCurrentVisiblePage();
        if (n !== currentPage) { currentPage = n; updatePageInfo(); }
      }, 120);
    });
    // 手型模式拖拽平移
    let dragging = false, lastX = 0, lastY = 0;
    mainEl.addEventListener("mousedown", function (e) {
      if (mouseMode !== "hand") return;
      dragging = true; lastX = e.clientX; lastY = e.clientY; mainEl.classList.add("hand-grabbing");
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      mainEl.scrollLeft -= (e.clientX - lastX); mainEl.scrollTop -= (e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener("mouseup", function () { dragging = false; if (mainEl) mainEl.classList.remove("hand-grabbing"); });
  }

  /* =====================================================================
   * 打开 / 关闭
   * ===================================================================== */
  async function open(path) {
    if (!path || !window.pdfjsLib) return;
    currentPath = path;
    window.__pdfPath = path;
    // 先露出 PDF 根容器并隐藏编辑器 / 全局状态栏，否则 #pdf-loading 遮罩（pdf-root 的子元素）
    // 在 pdf-root 仍 hidden 时不会显示，用户只会看到"秒开"却没有加载提示。
    const ew = $("editor-wrap"); if (ew) ew.style.display = "none";
    const tb = $("toolbar"); if (tb) tb.classList.add("hidden");
    const st = $("status"); if (st) st.style.display = "none";
    const sb = $("pdf-status-bar"); if (sb) sb.classList.remove("hidden");
    if (pdfRoot) pdfRoot.classList.remove("hidden");
    if (pdfToolbar) pdfToolbar.classList.remove("hidden");
    showLoading("正在加载 PDF…");
    try {
      const blob = await invoke("read_file_base64", { path });
      if (blob.kind !== "pdf") { uiAlert("该文件不是 PDF：" + path); hideLoading(); return; }
      pdfBytes = await b64ToBytesAsync(blob.data);
      await loadPdf(pdfBytes);
      showPdfUI();   // 再次同步显隐 / 重建工具栏 / 状态（幂等）
      setFilePath(path);
      setStatus("已打开 PDF：" + path);
    } catch (e) {
      setStatus("打开 PDF 失败：" + e, true);
    } finally {
      hideLoading();
    }
  }

  async function loadPdf(bytes) {
    pdfDoc = null; pdfLibDoc = null; notes = []; highlights = []; signatures = []; pageRotations = {};
    pageViewports = {}; pageTextCache = {}; dirty = false; currentPage = 1; scale = 1;
    watermarkCfg = null; pendingSig = null; clearHistory(); hideNotePopup();
    if (pagesEl) pagesEl.classList.remove("sig-placing");
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    numPages = pdfDoc.numPages;
    await computeFitScale();       // 先算好缩放，首屏第 1 页才能按正确比例渲染
    await mountShellsAndRender();  // 建空壳 + 渲染首屏，其余随滚动懒渲染（防卡死）
    updateSaveState();
  }

  /* 仅计算"适合宽度"的缩放比例，不做渲染（供 loadPdf / fitWidth 复用） */
  async function computeFitScale() {
    if (!pdfDoc) return;
    const page = await pdfDoc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const avail = (mainEl.clientWidth || 800) - 48;
    scale = clamp(avail / base.width, 0.25, 4);
    const zl = $("pdf-zoom-label");
    if (zl) zl.textContent = Math.round(scale * 100) + "%";
  }

  function makePageShell(num) {
    const d = document.createElement("div");
    d.className = "pdf-page";
    d.dataset.num = num;
    return d;
  }
  function makeThumbShell(num) {
    const d = document.createElement("div");
    d.className = "pdf-thumb";
    d.dataset.num = num;
    d.innerHTML = '<span class="pdf-thumb-num">' + num + "</span>";
    return d;
  }

  /* 建所有页/缩略图空壳（占位 + 供 IntersectionObserver 监听），再渲染首屏，
   * 其余页面与缩略图在滚动进入视口时由 ensureLazyObservers 懒渲染。 */
  async function mountShellsAndRender() {
    pagesEl.innerHTML = ""; thumbsEl.innerHTML = ""; outlineEl.innerHTML = "";
    renderedPages = new Set(); renderedThumbs = new Set();
    for (let i = 1; i <= numPages; i++) {
      pagesEl.appendChild(makePageShell(i));
      thumbsEl.appendChild(makeThumbShell(i));
    }
    updatePageInfo();
    await buildOutline();
    await renderPage(1);                       // 首屏立即可见
    const initialThumbs = Math.min(numPages, 15);
    for (let i = 1; i <= initialThumbs; i++) { await renderThumb(i); }
    ensureLazyObservers();
  }

  /* 懒渲染：页面/缩略图进入视口（含预读边距）时才真正渲染，避免一次性渲染全部页卡死。 */
  function ensureLazyObservers() {
    if (typeof IntersectionObserver === "undefined") {
      // 兜底：老旧环境不支持 observer 时一次性渲染全部（与原行为一致）
      for (let i = 1; i <= numPages; i++) { renderPage(i); renderThumb(i); }
      return;
    }
    if (pageObserver) pageObserver.disconnect();
    pageObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          const n = Number(en.target.dataset.num);
          renderPage(n);   // 已渲染则自动跳过
        }
      });
    }, { root: mainEl, rootMargin: "400px 0px" });
    pagesEl.querySelectorAll(".pdf-page").forEach(function (el) { pageObserver.observe(el); });

    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          const n = Number(en.target.dataset.num);
          renderThumb(n);
        }
      });
    }, { root: thumbsEl, rootMargin: "300px 0px" });
    thumbsEl.querySelectorAll(".pdf-thumb").forEach(function (el) { thumbObserver.observe(el); });
  }

  function showPdfUI() {
    const ew = $("editor-wrap"); if (ew) ew.style.display = "none";
    const tb = $("toolbar"); if (tb) tb.classList.add("hidden");
    const st = $("status"); if (st) st.style.display = "none";        // PDF 模式隐藏全局状态栏
    const sb = $("pdf-status-bar"); if (sb) sb.classList.remove("hidden");  // 改用 PDF 专用置底状态栏
    if (pdfRoot) pdfRoot.classList.remove("hidden");
    if (pdfToolbar) pdfToolbar.classList.remove("hidden");
    window.__pdfActive = true;
    renderPdfToolbar();   // 此时 app.js 的配置已加载完，按用户定制重建一次
    updatePageInfo();
  }

  function close() {
    if (pdfRoot) pdfRoot.classList.add("hidden");
    if (pdfToolbar) pdfToolbar.classList.add("hidden");
    const ew = $("editor-wrap"); if (ew) ew.style.display = "";
    const tb = $("toolbar"); if (tb) tb.classList.remove("hidden");
    window.__pdfActive = false;
    window.__pdfPath = null;
    pdfDoc = null; pdfBytes = null; pdfLibDoc = null;
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    pagesEl.innerHTML = ""; thumbsEl.innerHTML = ""; outlineEl.innerHTML = "";
    pagesEl.classList.remove("sig-placing");
    sigReplaceId = null; hideSigMenu();
    pendingSig = null; clearHistory(); hideNotePopup();
    if (mainEl) mainEl.classList.remove("hand-mode", "hand-grabbing");
    // 还原全局状态栏（取消隐藏），隐藏 PDF 专用置底状态栏
    const st = $("status");
    if (st) { st.style.display = ""; st.innerHTML = ""; st.classList.remove("status-error"); }
    const sb = $("pdf-status-bar");
    if (sb) { sb.classList.add("hidden"); const l = $("pdf-sb-left"); if (l) l.textContent = ""; }
  }

  /* =====================================================================
   * 渲染：每页 canvas + 文本层 + 备注 / 高亮 / 签章 overlay
   * ===================================================================== */
  async function renderPage(num, force) {
    if (!pdfDoc) return;
    if (!force && renderedPages.has(num)) return;  // 懒渲染：已渲染过则跳过
    const page = await pdfDoc.getPage(num);
    const rotation = pageRotations[num] || 0;
    const viewport = page.getViewport({ scale: scale, rotation });
    pageViewports[num] = viewport;

    let pageEl = pagesEl.querySelector('.pdf-page[data-num="' + num + '"]');
    if (!pageEl) {
      pageEl = document.createElement("div");
      pageEl.className = "pdf-page";
      pageEl.dataset.num = num;
      pagesEl.appendChild(pageEl);
    }
    pageEl.innerHTML = "";

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    pageEl.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    await page.render({ canvasContext: ctx, viewport: viewport, transform: transform }).promise;

    // 文本层（支持选中复制）
    try {
      const textContent = await page.getTextContent();
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      // pdf.js 3.x 文本层定位依赖该 CSS 变量（renderTextLayer 内部也会设，这里显式兜底，规避个别环境下 scale 错位）
      textLayer.style.setProperty("--scale-factor", String(viewport.scale));
      textLayer.style.width = Math.floor(viewport.width) + "px";
      textLayer.style.height = Math.floor(viewport.height) + "px";
      pageEl.appendChild(textLayer);
      const tlTask = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport: viewport,
        enhanceTextSelection: true,
      });
      // 兼容不同 pdf.js 构建里 promise 的暴露方式
      const tlPromise = (tlTask && tlTask.promise) || (tlTask && tlTask._capability && tlTask._capability.promise);
      if (tlPromise) await tlPromise;
      // 修正"复制出来是 Fi n al"的经典错误：按 item 几何重建每个 span 文本，去掉字距伪空格
      alignAndCleanTextLayer(pageEl, textContent.items);
    } catch (e) { console.warn("文本层渲染失败：", e); }

    renderNotesForPage(num, pageEl);
    renderHighlightsForPage(num, pageEl, viewport);
    renderSignaturesForPage(num, pageEl, viewport);
    if (searchQuery) highlightOnPage(num, searchQuery);
    renderedPages.add(num);
  }

  function renderNotesForPage(num, pageEl) {
    notes.forEach(function (note) {
      if (note.page !== num) return;
      const p = pageViewports[num].convertToViewportPoint(note.x, note.y);
      const el = document.createElement("div");
      el.className = "pdf-note-marker";
      el.style.left = p[0] + "px";
      el.style.top = p[1] + "px";
      el.title = note.text;
      el.textContent = "📝";
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        showNotePopup(note, el);
      });
      pageEl.appendChild(el);
    });
  }

  /* 备注气泡：查看内容 + 删除（仅能删除"尚未保存写入 PDF"的备注） */
  function hideNotePopup() {
    const old = document.getElementById("pdf-note-popup");
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  function showNotePopup(note, anchorEl) {
    hideNotePopup();
    const box = document.createElement("div");
    box.id = "pdf-note-popup";
    box.className = "pdf-note-popup";
    const body = document.createElement("div");
    body.className = "pdf-note-popup-text";
    body.textContent = note.text;
    const bar = document.createElement("div");
    bar.className = "pdf-note-popup-bar";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "删除";
    del.addEventListener("click", function () {
      const i = notes.indexOf(note);
      if (i >= 0) {
        pushHistory();
        notes.splice(i, 1);
        dirty = notes.length > 0 || highlights.length > 0 || signatures.length > 0 || Object.keys(pageRotations).length > 0;
        updateSaveState();
        renderPage(note.page, true);
        toast("已删除备注");
      }
      hideNotePopup();
    });
    const cls = document.createElement("button");
    cls.type = "button";
    cls.textContent = "关闭";
    cls.addEventListener("click", hideNotePopup);
    bar.appendChild(del);
    bar.appendChild(cls);
    box.appendChild(body);
    box.appendChild(bar);
    document.body.appendChild(box);
    const r = anchorEl.getBoundingClientRect();
    const bw = box.offsetWidth || 220, bh = box.offsetHeight || 90;
    box.style.left = clamp(r.left, 8, window.innerWidth - bw - 8) + "px";
    box.style.top = clamp(r.bottom + 6, 8, window.innerHeight - bh - 8) + "px";
  }

  function renderHighlightsForPage(num, pageEl, viewport) {
    highlights.filter(function (h) { return h.page === num; }).forEach(function (h) {
      h.quads.forEach(function (q) {
        const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
        const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        const tl = viewport.convertToViewportPoint(minX, maxY);
        const br = viewport.convertToViewportPoint(maxX, minY);
        const d = document.createElement("div");
        d.className = "pdf-hl" + (h.type === "underline" ? " pdf-ul" : "");
        d.style.left = Math.min(tl[0], br[0]) + "px";
        d.style.top = Math.min(tl[1], br[1]) + "px";
        d.style.width = Math.abs(br[0] - tl[0]) + "px";
        d.style.height = Math.abs(br[1] - tl[1]) + "px";
        pageEl.appendChild(d);
      });
    });
  }

  function renderSignaturesForPage(num, pageEl, viewport) {
    signatures.filter(function (s) { return s.page === num; }).forEach(function (s) {
      const tl = viewport.convertToViewportPoint(s.x, s.y);
      const br = viewport.convertToViewportPoint(s.x + s.w, s.y - s.h);
      const wrap = document.createElement("div");
      wrap.className = "pdf-sig-overlay";
      wrap.dataset.sigId = s.id;
      wrap.style.left = Math.min(tl[0], br[0]) + "px";
      wrap.style.top = Math.min(tl[1], br[1]) + "px";
      wrap.style.width = Math.abs(br[0] - tl[0]) + "px";
      wrap.style.height = Math.abs(br[1] - tl[1]) + "px";
      const img = document.createElement("img");
      img.src = s.dataUrl;
      img.className = "pdf-sig-img";
      img.draggable = false;
      if (sigWhiteBg) img.style.background = "#ffffff";   // 白底模式下与导出一致（WYSIWYG）
      wrap.appendChild(img);
      const h = document.createElement("div");
      h.className = "pdf-sig-resize";
      wrap.appendChild(h);
      pageEl.appendChild(wrap);
    });
  }

  /* 已放置签章的交互：拖动移动 / 拖角缩放 / 单击弹「删除 / 替换」菜单 */
  function onSigPointerDown(e) {
    if (pendingSig) return;                 // 放置态：交给 .sig-placing 规则，让点击落到页面
    const overlay = e.target.closest(".pdf-sig-overlay");
    if (!overlay) return;
    const sigId = Number(overlay.dataset.sigId);
    const sig = signatures.find(function (s) { return s.id === sigId; });
    if (!sig) return;
    hideSigMenu();
    e.preventDefault();
    e.stopPropagation();
    const pageEl = overlay.closest(".pdf-page");
    const num = Number(pageEl.dataset.num);
    const vp = pageViewports[num];
    if (!vp) return;
    const handle = e.target.closest(".pdf-sig-resize");
    const mode = handle ? "resize" : "move";
    const startX = e.clientX, startY = e.clientY;
    const startLeft = parseFloat(overlay.style.left) || 0;
    const startTop = parseFloat(overlay.style.top) || 0;
    const startW = parseFloat(overlay.style.width) || 0;
    const startH = parseFloat(overlay.style.height) || 0;
    let moved = false;
    overlay.classList.add("selected");
    try { overlay.setPointerCapture(e.pointerId); } catch (err) {}

    function onMove(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      if (mode === "move") {
        overlay.style.left = (startLeft + dx) + "px";
        overlay.style.top = (startTop + dy) + "px";
      } else {
        overlay.style.width = Math.max(20, startW + dx) + "px";
        overlay.style.height = Math.max(20, startH + dy) + "px";
      }
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { overlay.releasePointerCapture(e.pointerId); } catch (err) {}
      overlay.classList.remove("selected");
      sigSuppressClick = true;              // 阻止随后冒泡的 pagesEl click 误触发备注/放置
      if (!moved) { showSigMenu(sig, overlay); return; }
      // 提交最终 PDF 坐标（按当前缩放/旋转换算，保证与画布一致、缩放后不错位）
      const nl = parseFloat(overlay.style.left) || 0;
      const nt = parseFloat(overlay.style.top) || 0;
      const nw = parseFloat(overlay.style.width) || 0;
      const nh = parseFloat(overlay.style.height) || 0;
      const tl = vp.convertToPdfPoint(nl, nt);
      const br = vp.convertToPdfPoint(nl + nw, nt + nh);
      sig.x = tl[0]; sig.y = tl[1];
      sig.w = Math.abs(br[0] - tl[0]); sig.h = Math.abs(br[1] - tl[1]);
      pushHistory(); dirty = true; updateSaveState();
      setStatus("已更新签章位置/大小，点「保存」写回文件");
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* 签章编辑菜单（删除 / 替换） */
  let sigMenuEl = null;
  function ensureSigMenu() {
    if (sigMenuEl) return sigMenuEl;
    sigMenuEl = document.createElement("div");
    sigMenuEl.className = "pdf-sig-menu hidden";
    sigMenuEl.innerHTML =
      '<button type="button" data-sig-act="replace">替换</button>' +
      '<button type="button" data-sig-act="delete" class="danger">删除</button>';
    const root = $("pdf-root");
    (root || document.body).appendChild(sigMenuEl);
    sigMenuEl.addEventListener("click", function (e) {
      const b = e.target.closest("[data-sig-act]"); if (!b) return;
      const act = b.dataset.sigAct;
      const id = Number(sigMenuEl.dataset.sigId);
      const sig = signatures.find(function (s) { return s.id === id; });
      if (!sig) { hideSigMenu(); return; }
      if (act === "delete") {
        const i = signatures.findIndex(function (s) { return s.id === id; });
        if (i >= 0) signatures.splice(i, 1);
        pushHistory(); dirty = true; updateSaveState();
        const ov = pagesEl.querySelector('.pdf-sig-overlay[data-sig-id="' + id + '"]');
        if (ov) ov.remove();
        setStatus("已删除签章");
      } else if (act === "replace") {
        sigReplaceId = id;                  // 进入替换模式：选图后直接替换该签章字节
        const fi = $("pdf-sign-file");
        if (fi) fi.click();
      }
      hideSigMenu();
    });
    return sigMenuEl;
  }
  function showSigMenu(sig, overlay) {
    const menu = ensureSigMenu();
    menu.dataset.sigId = sig.id;
    const r = overlay.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = (r.bottom + 6) + "px";
    menu.classList.remove("hidden");
    sigSuppressClick = true;                // 本次点击不触发 pagesEl（菜单本身是独立元素）
  }
  function hideSigMenu() { if (sigMenuEl) sigMenuEl.classList.add("hidden"); }

  async function renderThumb(num, force) {
    if (!pdfDoc) return;
    if (!force && renderedThumbs.has(num)) return;  // 懒渲染：已渲染过则跳过
    const wrap = thumbsEl.querySelector('.pdf-thumb[data-num="' + num + '"]');
    if (!wrap) return;                              // 空壳尚未建立（理论上不会发生）
    const old = wrap.querySelector("canvas");
    if (old) old.remove();                          // 重渲染前清掉旧画布，避免叠加
    const page = await pdfDoc.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const tScale = 130 / base.width;
    const vp = page.getViewport({ scale: tScale, rotation: pageRotations[num] || 0 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    wrap.insertBefore(canvas, wrap.firstChild);
    wrap.onclick = function () { goToPage(num); };  // 用 onclick 覆盖，避免重复绑定
    renderedThumbs.add(num);
  }

  async function buildOutline() {
    let outline = null;
    try { outline = await pdfDoc.getOutline(); } catch (e) { outline = null; }
    if (!outline || !outline.length) {
      outlineEl.innerHTML = '<div class="pdf-outline-empty">（文档无大纲）</div>';
      return;
    }
    outlineEl.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "pdf-outline-list";
    outlineEl.appendChild(ul);
    outline.forEach(function (item) { ul.appendChild(buildOutlineItem(item)); });
  }
  function buildOutlineItem(item) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = item.title || "(无标题)";
    a.href = "#";
    a.addEventListener("click", function (e) { e.preventDefault(); jumpToOutline(item); });
    li.appendChild(a);
    if (item.items && item.items.length) {
      const sub = document.createElement("ul");
      item.items.forEach(function (s) { sub.appendChild(buildOutlineItem(s)); });
      li.appendChild(sub);
    }
    return li;
  }
  async function jumpToOutline(item) {
    try {
      const dest = item && item.dest;
      if (!dest) return;
      let pageIndex = null; // 0-based
      if (typeof dest === "string") {
        // 命名目标：解析为显式目标数组
        const explicit = await pdfDoc.getDestination(dest);
        if (explicit && explicit.length) pageIndex = await resolveDestRef(explicit[0]);
      } else if (Array.isArray(dest)) {
        // 显式目标：首元素是页码(数字)或页码引用
        pageIndex = await resolveDestRef(dest[0]);
      }
      if (pageIndex != null) goToPage(pageIndex + 1);
    } catch (e) { console.warn("大纲跳转失败：", e); }
  }
  // 把目标首元素（数字页码 / 引用对象）解析为 0-based 页码索引
  async function resolveDestRef(ref) {
    if (ref == null) return null;
    if (typeof ref === "number") return ref;            // 已是 0-based 页码
    try { return await pdfDoc.getPageIndex(ref); }       // 引用对象
    catch (e) { return null; }
  }

  /* =====================================================================
   * 导航 / 缩放 / 旋转
   * ===================================================================== */
  async function goToPage(n) {
    n = Math.max(1, Math.min(numPages, n | 0));
    currentPage = n;
    // 懒渲染下：目标页可能还是 0 高度空壳，先渲染再滚动，否则 scrollIntoView 失效
    if (!renderedPages.has(n)) await renderPage(n, true);
    const target = pagesEl.querySelector('.pdf-page[data-num="' + n + '"]');
    if (target) target.scrollIntoView({ block: "start" });
    updatePageInfo();
  }
  function updatePageInfo() {
    const info = $("pdf-page-info");
    if (info) info.textContent = numPages ? (currentPage + " / " + numPages) : "— / —";
    const jump = $("pdf-page-jump");
    if (jump) jump.value = currentPage;
  }
  function applyScale(s) {
    scale = clamp(s, 0.25, 4);
    const zl = $("pdf-zoom-label");
    if (zl) zl.textContent = Math.round(scale * 100) + "%";
    reRenderAll();
  }
  function reRenderAll() {
    // 懒渲染下：只重渲染"已渲染（即可见）"的页，并清空集合，
    // 让未渲染的页在滚动到时按新比例重新渲染，避免一次性重渲染全部。
    const list = [];
    renderedPages.forEach(function (n) { list.push(n); });
    renderedPages.clear();
    list.forEach(function (n) { renderPage(n, true); });
  }
  async function fitWidth() {
    await computeFitScale();
    reRenderAll();
  }
  function rotatePage(num, dir, noHistory) {
    if (!noHistory) pushHistory();
    pageRotations[num] = (((pageRotations[num] || 0) + (dir > 0 ? 90 : -90)) % 360 + 360) % 360;
    dirty = true; updateSaveState();
    if (renderedPages.has(num)) renderPage(num, true);   // 仅重渲染当前可见页
    const th = thumbsEl.querySelector('.pdf-thumb[data-num="' + num + '"]');
    if (th && renderedThumbs.has(num)) renderThumb(num, true);
  }
  function rotateAll(dir) {
    const cur = getCurrentVisiblePage();
    pushHistory();                                    // 整体旋转只记一步，撤回一次全部还原
    for (let i = 1; i <= numPages; i++) rotatePage(i, dir, true);
    currentPage = cur;
  }
  /* 旋转指定页码（留空=全部）+ 方向：弹窗收集参数后执行 */
  function openRotate() {
    if (!pdfBytes) { uiAlert("请先打开一个 PDF 再旋转。"); return; }
    const rg = $("pdf-rotate-range"); if (rg) rg.value = "";
    openModal($("pdf-rotate-dialog"));
  }
  function onRotateOk() {
    closeModal($("pdf-rotate-dialog"));
    if (!numPages) return;
    const spec = ($("pdf-rotate-range") ? $("pdf-rotate-range").value : "").trim();
    const dirEl = document.querySelector('input[name="pdf-rotate-dir"]:checked');
    const dir = dirEl ? (parseInt(dirEl.value, 10) || 1) : 1;
    let pages;
    if (!spec) {
      pages = [];
      for (let i = 1; i <= numPages; i++) pages.push(i);
    } else {
      pages = resolvePageList(spec);
      if (!pages.length) { uiAlert("没有匹配的页码：" + spec); return; }
    }
    pushHistory();
    pages.forEach(function (n) { rotatePage(n, dir, true); });
    setStatus("已旋转 " + pages.length + " 页（" + (dir > 0 ? "顺时针" : "逆时针") + "）");
  }

  /* =====================================================================
   * 备注（粘滞注释，写入 PDF 可移植）
   * ===================================================================== */
  function toggleNoteMode() {
    noteMode = !noteMode;
    if (mainEl) mainEl.classList.toggle("note-mode", noteMode);
    const btn = pdfToolbar.querySelector('[data-pdf-action="note"]');
    if (btn) btn.classList.toggle("active", noteMode);
  }
  function onNoteOk() {
    const text = (noteTextInput.value || "").trim();
    closeModal(noteDialog);
    if (!text || !pendingNote) { pendingNote = null; return; }
    const p = pendingNote; pendingNote = null;
    const vp = pageViewports[p.page];
    if (!vp) return;
    const pt = vp.convertToPdfPoint(p.clientX, p.clientY);
    pushHistory();
    notes.push({ page: p.page, x: pt[0], y: pt[1], text: text });
    dirty = true; updateSaveState();
    renderPage(p.page, true);
  }

  /* =====================================================================
   * 选中文字批注（高亮 / 划线 / 气泡）
   * ===================================================================== */
  function processSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideAnnoBar(); return; }
    const text = sel.toString().trim();
    if (!text) { hideAnnoBar(); return; }
    let pageEl = null;
    try {
      let node = sel.anchorNode;
      while (node && node !== pagesEl) { if (node.classList && node.classList.contains("pdf-page")) { pageEl = node; break; } node = node.parentNode; }
    } catch (e) {}
    if (!pageEl) {
      // 退而求其次：从 focusNode 找
      try {
        let node = sel.focusNode;
        while (node && node !== pagesEl) { if (node.classList && node.classList.contains("pdf-page")) { pageEl = node; break; } node = node.parentNode; }
      } catch (e) {}
    }
    if (!pageEl || pageEl.dataset.num == null) { hideAnnoBar(); return; }
    const num = Number(pageEl.dataset.num);
    const vp = pageViewports[num];
    const rects = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const list = sel.getRangeAt(i).getClientRects();
      for (let j = 0; j < list.length; j++) rects.push(list[j]);
    }
    if (!rects.length) { hideAnnoBar(); return; }
    pendingSel = { page: num, rects: rects, vp: vp, sel: sel };
    const last = rects[rects.length - 1];
    showAnnoBar(last.right + 6, last.bottom + 6);
  }
  function showAnnoBar(x, y) {
    if (!annoBar) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = 180, h = 40;
    annoBar.style.left = clamp(x, 8, vw - w - 8) + "px";
    annoBar.style.top = clamp(y, 8, vh - h - 8) + "px";
    annoBar.classList.remove("hidden");
  }
  function rectToPdfQuad(rc, pageEl, vp) {
    const pr = pageEl.getBoundingClientRect();
    const x1 = rc.left - pr.left, y1 = rc.top - pr.top, x2 = rc.right - pr.left, y2 = rc.bottom - pr.top;
    const tl = vp.convertToPdfPoint(x1, y1);
    const tr = vp.convertToPdfPoint(x2, y1);
    const bl = vp.convertToPdfPoint(x1, y2);
    const br = vp.convertToPdfPoint(x2, y2);
    return [tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1]];
  }
  function applyAnnotation(type) {
    if (!pendingSel) return;
    const pageEl = pagesEl.querySelector('.pdf-page[data-num="' + pendingSel.page + '"]');
    if (type === "note") {
      const rc = pendingSel.rects[0];
      const pr = pageEl.getBoundingClientRect();
      pendingNote = { page: pendingSel.page, clientX: (rc.left + rc.right) / 2 - pr.left, clientY: (rc.top + rc.bottom) / 2 - pr.top };
      noteTextInput.value = "";
      hideAnnoBar(); pendingSel = null;
      openModal(noteDialog); noteTextInput.focus();
      return;
    }
    const quads = [];
    pendingSel.rects.forEach(function (rc) { quads.push(rectToPdfQuad(rc, pageEl, pendingSel.vp)); });
    pushHistory();
    highlights.push({ page: pendingSel.page, quads: quads, type: type });
    dirty = true; updateSaveState();
    renderPage(pendingSel.page, true);
    hideAnnoBar(); pendingSel = null;
    if (window.getSelection && window.getSelection().removeAllRanges) window.getSelection().removeAllRanges();
  }

  /* =====================================================================
   * 保存：旋转 + 备注 + 高亮/划线 + 签章 写回原文件
   * ===================================================================== */
  /* 把内存中的改动（旋转/备注/高亮/签章/水印）烤成最终字节，供 save / saveAs 复用 */
  async function buildOutputBytes() {
    {
      pdfLibDoc = await PDFLib.PDFDocument.load(pdfBytes);
      // 旋转
      Object.keys(pageRotations).forEach(function (k) {
        const idx = Number(k) - 1;
        const pg = pdfLibDoc.getPages()[idx];
        if (!pg) return;
        const cur = pg.getRotation().angle || 0;
        pg.setRotation(PDFLib.degrees((cur + pageRotations[k]) % 360));
      });
      // 备注（Text 注释）
      notes.forEach(function (note) {
        const idx = note.page - 1;
        const pg = pdfLibDoc.getPages()[idx];
        if (!pg) return;
        const existing = pg.node.Annots();
        const arr = existing ? existing.asArray().slice() : [];
        const dict = pdfLibDoc.context.obj({
          Type: "Annot", Subtype: "Text", Rect: [note.x, note.y, note.x + 24, note.y + 24],
          Contents: pdfText(note.text), T: pdfText("墨笺"), C: pdfLibDoc.context.obj([1, 0.85, 0]), Open: false, F: 4, Name: "Comment",
        });
        arr.push(dict);
        pg.node.set(PDFLib.PDFName.of("Annots"), pdfLibDoc.context.obj(arr));
      });
      // 高亮 / 划线（QuadPoints）
      highlights.forEach(function (h) {
        const idx = h.page - 1;
        const pg = pdfLibDoc.getPages()[idx];
        if (!pg) return;
        const flat = [];
        h.quads.forEach(function (q) { q.forEach(function (v) { flat.push(v); }); });
        const xs = [], ys = [];
        h.quads.forEach(function (q) { xs.push(q[0], q[2], q[4], q[6]); ys.push(q[1], q[3], q[5], q[7]); });
        const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        const dict = pdfLibDoc.context.obj({
          Type: "Annot", Subtype: h.type === "underline" ? "Underline" : "Highlight",
          Rect: [minX, minY, maxX, maxY], QuadPoints: flat,
          C: h.type === "underline" ? pdfLibDoc.context.obj([0, 0, 0.8]) : pdfLibDoc.context.obj([1, 0.85, 0]), F: 4,
        });
        const existing = pg.node.Annots();
        const arr = existing ? existing.asArray().slice() : [];
        arr.push(dict);
        pg.node.set(PDFLib.PDFName.of("Annots"), pdfLibDoc.context.obj(arr));
      });
      // 签章：作为 PDF Stamp 注释写入（位于注释层之上，不会被内容流 / 置顶 OCG 图层盖住）
      for (const s of signatures) {
        const idx = s.page - 1;
        const pg = pdfLibDoc.getPages()[idx];
        if (!pg) continue;
        const bytesToEmbed = sigWhiteBg ? await flattenSigToWhite(s.bytes) : s.bytes;
        const img = await pdfLibDoc.embedPng(bytesToEmbed);
        // 外观流必须是 Form XObject（直接引用 Image XObject 为 /AP/N 不符合规范，多数阅读器不渲染 → 看似"没保存"）
        const w = s.w, h = s.h;
        const formContent = "q " + w + " 0 0 " + h + " 0 0 cm /Im0 Do Q";
        const formDict = pdfLibDoc.context.obj({
          Type: "XObject", Subtype: "Form", FormType: 1,
          BBox: [0, 0, w, h],
          Resources: { XObject: { Im0: img.ref } },
        });
        const formStream = pdfLibDoc.context.stream(new TextEncoder().encode(formContent), formDict);
        const formRef = pdfLibDoc.context.register(formStream);
        const dict = pdfLibDoc.context.obj({
          Type: "Annot", Subtype: "Stamp",
          Rect: [s.x, s.y - s.h, s.x + s.w, s.y],
          AP: { N: formRef },
          F: 4, Border: [0, 0, 0],
        });
        const existing = pg.node.Annots();
        const arr = existing ? existing.asArray().slice() : [];
        arr.push(dict);
        pg.node.set(PDFLib.PDFName.of("Annots"), pdfLibDoc.context.obj(arr));
      }
      // 水印（文字渲染为图片平铺，支持中文）
      if (watermarkCfg) {
        await applyWatermarkToDoc(pdfLibDoc, watermarkCfg);
      }
      // 关闭对象流（object streams）/ 交叉引用流，输出经典 xref 表结构。
      // pdf-lib 默认会升级为 %PDF-1.7 + 对象流 + /XRef 流，常常是 Acrobat 报
      // "本页面存在错误" 的诱因；关闭后兼容性最佳（仍保留全部页面/注释/签章）。
      const newBytes = await pdfLibDoc.save({ useObjectStreams: false });
      pdfLibDoc = null;
      return newBytes;
    }
  }

  /* 保存：写回原文件 */
  async function save() {
    if (!dirty) { toast("没有需要保存的修改"); return; }
    if (!currentPath || !pdfBytes) return;
    showLoading("正在保存…");
    try {
      const newBytes = await buildOutputBytes();
      await invoke("save_file_bytes", { path: currentPath, data: bytesToB64(newBytes) });
      await afterWriteTo(currentPath, newBytes);
      toast("已保存：" + currentPath);
      setStatus("已保存 PDF：" + currentPath);
    } catch (e) {
      setStatus("保存失败：" + e, true);
      toast("保存失败：" + e);
    } finally {
      hideLoading();
    }
  }

  /* 另存为：写到新路径，并把"当前文件"切到新路径（与编辑器侧行为一致） */
  async function saveAs() {
    if (!pdfBytes) { uiAlert("请先打开一个 PDF。"); return; }
    let path;
    try {
      path = await tauriSave({
        defaultPath: currentPath || undefined,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
    } catch (e) { return; }
    if (!path) return;
    if (!/\.pdf$/i.test(path)) path += ".pdf";
    showLoading("正在另存为…");
    try {
      const newBytes = await buildOutputBytes();
      await invoke("save_file_bytes", { path: path, data: bytesToB64(newBytes) });
      currentPath = path;
      window.__pdfPath = path;
      setFilePath(path);
      await afterWriteTo(path, newBytes);
      toast("已另存为：" + path);
      setStatus("已另存为 PDF：" + path);
    } catch (e) {
      setStatus("另存为失败：" + e, true);
      toast("另存为失败：" + e);
    } finally {
      hideLoading();
    }
  }

  /* 写盘成功后的统一收尾：清空待写改动 + 用新字节重载视图 */
  async function afterWriteTo(path, newBytes) {
    pdfBytes = newBytes;
    pdfLibDoc = null;
    pageRotations = {}; notes = []; highlights = []; signatures = []; watermarkCfg = null;
    dirty = false;
    clearHistory();                 // 已落盘，之前的撤回步骤不再适用
    updateSaveState();
    await reloadAfterSave(pdfBytes);
  }
  async function reloadAfterSave(bytes) {
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    numPages = pdfDoc.numPages;
    await mountShellsAndRender();  // 复用懒渲染：仅首屏立即渲染，其余滚动时补
  }

  /* =====================================================================
   * 合并 / 拆分
   * ===================================================================== */
  async function merge() {
    let paths;
    try {
      paths = await tauriOpen({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    } catch (e) { return; }
    if (!paths || !paths.length) return;
    showLoading("正在合并…");
    try {
      const docs = [];
      for (const p of paths) {
        const blob = await invoke("read_file_base64", { path: p });
        docs.push(await PDFLib.PDFDocument.load(await b64ToBytesAsync(blob.data)));
      }
      const out = await PDFLib.PDFDocument.create();
      for (const d of docs) {
        const pages = await out.copyPages(d, d.getPageIndices());
        pages.forEach(function (pg) { out.addPage(pg); });
      }
      const outBytes = await out.save({ useObjectStreams: false });
      let savePath = await tauriSave({ filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!savePath) { hideLoading(); return; }
      if (!/\.pdf$/i.test(savePath)) savePath += ".pdf";
      await invoke("save_file_bytes", { path: savePath, data: bytesToB64(outBytes) });
      toast("已合并保存：" + savePath);
    } catch (e) {
      setStatus("合并失败：" + e, true); toast("合并失败：" + e);
    } finally { hideLoading(); }
  }

  function openSplit() {
    if (!currentPath || !pdfBytes) { uiAlert("请先打开一个 PDF 再拆分。"); return; }
    openModal(splitDialog);
  }

  function resolvePageList(spec) {
    const groups = parseRange(spec, numPages);
    const out = [];
    groups.forEach(function (g) { g.forEach(function (i) { out.push(i + 1); }); });
    return out;
  }
  function parseRange(spec, total) {
    const groups = [];
    spec.split(",").forEach(function (part) {
      part = part.trim();
      if (!part) return;
      if (part.indexOf("-") >= 0) {
        const segs = part.split("-").map(function (x) { return parseInt(x, 10); });
        if (segs.length === 2 && !isNaN(segs[0]) && !isNaN(segs[1])) {
          let a = segs[0], b = segs[1];
          if (b < a) { const t = a; a = b; b = t; }
          const arr = []; for (let i = a; i <= b; i++) arr.push(i);
          groups.push(arr);
        }
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n)) groups.push([n]);
      }
    });
    return groups
      .map(function (g) { return g.filter(function (n) { return n >= 1 && n <= total; }).map(function (n) { return n - 1; }); })
      .filter(function (g) { return g.length; });
  }

  async function onSplitOk() {
    closeModal(splitDialog);
    if (!currentPath || !pdfBytes) return;
    showLoading("正在拆分…");
    try {
      const mode = document.querySelector('input[name="pdf-split-mode"]:checked').value;
      const srcDoc = await PDFLib.PDFDocument.load(pdfBytes);
      const total = srcDoc.getPageCount();
      const base = currentPath.replace(/\.pdf$/i, "");
      const files = [];
      if (mode === "each") {
        for (let i = 0; i < total; i++) {
          const d = await PDFLib.PDFDocument.create();
          const [pg] = await d.copyPages(srcDoc, [i]);
          d.addPage(pg);
          files.push({ path: base + "_第" + (i + 1) + "页.pdf", data: bytesToB64(await d.save({ useObjectStreams: false })) });
        }
      } else {
        const range = ($("pdf-split-range") ? $("pdf-split-range").value : "").trim();
        const groups = parseRange(range, total);
        if (!groups.length) { uiAlert("页码区间无效，示例：1-3,5,7-9"); hideLoading(); return; }
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          const d = await PDFLib.PDFDocument.create();
          const pages = await d.copyPages(srcDoc, g);
          pages.forEach(function (pg) { d.addPage(pg); });
          files.push({ path: base + "_part" + (gi + 1) + ".pdf", data: bytesToB64(await d.save({ useObjectStreams: false })) });
        }
      }
      await invoke("save_files_bytes", { files });
      toast("已拆分 " + files.length + " 个文件到原目录");
      setStatus("已拆分 " + files.length + " 个文件：" + base);
    } catch (e) {
      setStatus("拆分失败：" + e, true); toast("拆分失败：" + e);
    } finally { hideLoading(); }
  }

  /* =====================================================================
   * 导出图片
   * ===================================================================== */
  /* 路径小工具：同时兼容 Windows 反斜杠与正斜杠 */
  function dirnameOf(p) {
    if (!p) return "";
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i > 0 ? p.slice(0, i) : "";
  }
  function basenameOf(p) {
    if (!p) return "";
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i >= 0 ? p.slice(i + 1) : p;
  }
  function joinPath(dir, name) {
    if (!dir) return name;
    const sep = dir.indexOf("\\") >= 0 ? "\\" : "/";
    return dir.replace(/[\\/]+$/, "") + sep + name;
  }

  function openExportImg() {
    if (!pdfDoc) return;
    const di = $("pdf-img-dir");
    if (di && !di.value) di.value = dirnameOf(currentPath) || "";
    openModal($("pdf-export-img-dialog"));
  }
  /* 选择导出目录（Tauri 目录选择对话框） */
  async function pickExportImgDir() {
    let d;
    try {
      d = await tauriOpen({ directory: true, multiple: false, defaultPath: dirnameOf(currentPath) || undefined });
    } catch (e) { return; }
    if (!d) return;
    if (Array.isArray(d)) d = d[0];
    const di = $("pdf-img-dir");
    if (di) di.value = d;
  }
  async function onExportImgOk() {
    closeModal($("pdf-export-img-dialog"));
    if (!pdfDoc) return;
    const fmt = $("pdf-img-format") ? $("pdf-img-format").value : "png";
    const range = $("pdf-img-range") ? $("pdf-img-range").value.trim() : "";
    const sc = parseFloat($("pdf-img-scale") ? $("pdf-img-scale").value : "2") || 2;
    const pages = range ? resolvePageList(range) : (function () { const a = []; for (let i = 1; i <= numPages; i++) a.push(i); return a; })();
    if (!pages.length) { uiAlert("页码区间无效"); return; }
    // 输出目录：优先用弹窗里选的；留空则回退到原文件所在目录
    const dirInput = $("pdf-img-dir");
    const outDir = (dirInput && dirInput.value.trim()) || dirnameOf(currentPath);
    if (!outDir) { uiAlert("请先选择导出目录。"); return; }
    showLoading("正在导出图片…");
    try {
      const stem = (basenameOf(currentPath) || "export").replace(/\.pdf$/i, "");
      const base = joinPath(outDir, stem);
      const files = [];
      for (const n of pages) {
        const page = await pdfDoc.getPage(n);
        const vp = page.getViewport({ scale: sc });
        const c = document.createElement("canvas");
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        const url = c.toDataURL(fmt === "jpeg" ? "image/jpeg" : "image/png", 0.92);
        files.push({ path: base + "_第" + n + "页." + (fmt === "jpeg" ? "jpg" : "png"), data: bytesToB64(dataURLToBytes(url)) });
      }
      await invoke("save_files_bytes", { files });
      toast("已导出 " + files.length + " 张图片到：" + outDir);
      setStatus("已导出 " + files.length + " 张图片到：" + outDir);
    } catch (e) {
      setStatus("导出图片失败：" + e, true); toast("导出图片失败：" + e);
    } finally { hideLoading(); }
  }

  /* =====================================================================
   * 转 Word（文本版 + 图/表占位）
   * ===================================================================== */
  function openExportWord() {
    if (!pdfDoc) return;
    openModal($("pdf-export-word-dialog"));
  }
  async function onExportWordOk() {
    closeModal($("pdf-export-word-dialog"));
    if (!pdfDoc) return;
    const range = $("pdf-word-range") ? $("pdf-word-range").value.trim() : "";
    const pages = range ? resolvePageList(range) : (function () { const a = []; for (let i = 1; i <= numPages; i++) a.push(i); return a; })();
    if (!pages.length) { uiAlert("页码区间无效"); return; }
    showLoading("正在转为 Word…");
    try {
      let body = "";
      for (const n of pages) {
        const page = await pdfDoc.getPage(n);
        const info = await analyzePageForWord(page);
        body += '<h2 style="page-break-before:always">第 ' + n + ' 页</h2>';
        body += info.html;
      }
      const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>墨笺导出</title></head><body>' + body + "</body></html>";
      const bytes = new TextEncoder().encode(html);
      let path = await tauriSave({ filters: [{ name: "Word 文档", extensions: ["doc"] }] });
      if (!path) { hideLoading(); return; }
      if (!/\.doc$/i.test(path)) path += ".doc";
      await invoke("save_file_bytes", { path: path, data: bytesToB64(bytes) });
      toast("已生成 Word：" + path);
    } catch (e) {
      setStatus("转 Word 失败：" + e, true); toast("转 Word 失败：" + e);
    } finally { hideLoading(); }
  }
  async function analyzePageForWord(page) {
    const tc = await page.getTextContent();
    const items = tc.items.filter(function (it) { return it.str; });
    const lines = [];
    items.forEach(function (it) {
      const y = it.transform[5], x = it.transform[4], str = it.str;
      let line = null;
      for (const l of lines) { if (Math.abs(l.y - y) < 2) { line = l; break; } }
      if (!line) { lines.push({ y: y, x: x, text: str }); }
      else if (x < line.x) { line.text = str + line.text; line.x = x; }
      else { line.text = line.text + str; }
    });
    lines.sort(function (a, b) { return b.y - a.y; });

    // 图/表检测（启发式，仅用于占位提示，不实际提取）
    let imageYs = [];
    let tableLike = false;
    try {
      const op = await page.getOperatorList();
      const OPS = pdfjsLib.OPS;
      let ctm = [1, 0, 0, 1, 0, 0];
      let hLineCount = 0;
      for (let i = 0; i < op.fnArray.length; i++) {
        const fn = op.fnArray[i];
        const a = op.argsArray[i];
        if (fn === OPS.setTransform) ctm = a.slice();
        else if (fn === OPS.transform) ctm = mulMatrix(ctm, a);
        else if (fn === OPS.paintImageXObject || fn === OPS.paintXObject) imageYs.push(ctm[5]);
        else if (OPS.horizontalLineTo !== undefined && fn === OPS.horizontalLineTo) hLineCount++;
      }
      if (hLineCount >= 3) tableLike = true;
    } catch (e) {}

    let html = "";
    if (tableLike) html += "<p><b>[表格]</b></p>";
    lines.forEach(function (l) {
      imageYs.forEach(function (iy) {
        if (!l._used && Math.abs(iy - l.y) < 12) { html += "<p><b>[图片]</b></p>"; l._used = true; }
      });
      html += "<p>" + escapeHtml(l.text) + "</p>";
    });
    if (imageYs.length === 0 && !tableLike && lines.length === 0) html += "<p>（本页无可提取文字）</p>";
    return { html: html };
  }
  function mulMatrix(m, n) {
    // 2x3 矩阵相乘（CTM）
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  /* =====================================================================
   * 文字水印
   * ===================================================================== */
  function openWatermark() {
    if (!pdfDoc) return;
    openModal($("pdf-watermark-dialog"));
  }
  /* 「应用」＝只改内存中的 PDF 字节并立即重渲染，不写盘。
   * 是否落盘由用户自己决定（点「保存」/「另存为」）；不满意可点「撤回」。 */
  async function onWatermarkOk() {
    const text = ($("pdf-wm-text") ? $("pdf-wm-text").value : "").trim();
    if (!text) { uiAlert("请填写水印文字"); return; }
    if (!pdfBytes) { uiAlert("请先打开一个 PDF。"); return; }
    const size = parseInt($("pdf-wm-size").value, 10) || 48;
    const opacity = parseFloat($("pdf-wm-opacity").value) || 0.25;
    const color = ($("pdf-wm-color") ? $("pdf-wm-color").value : "#888888") || "#888888";
    const diagonal = $("pdf-wm-diagonal") ? $("pdf-wm-diagonal").checked : true;
    const cfg = { text: text, size: size, opacity: opacity, color: color, diagonal: diagonal };
    showLoading("正在添加水印…");
    try {
      pushHistory();
      const doc = await PDFLib.PDFDocument.load(pdfBytes);
      const newBytes = await applyWatermarkToDoc(doc, cfg, true);
      pdfBytes = newBytes;
      pdfLibDoc = null;
      watermarkCfg = null;              // 已烤进字节，保存时不要再叠一层
      await reloadAfterSave(pdfBytes);
      dirty = true; updateSaveState();
      closeModal($("pdf-watermark-dialog"));
      setStatus("水印已应用（尚未写盘）：点「保存」写回文件，或点「撤回」还原");
      toast("水印已应用，记得点「保存」");
    } catch (e) {
      setStatus("水印失败：" + e, true); toast("水印失败：" + e);
    } finally { hideLoading(); }
  }
  async function applyWatermarkToDoc(doc, cfg, returnBytes) {
    const rgb = hexToRgb(cfg.color);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = cfg.size + "px sans-serif";
    const tw = Math.ceil(ctx.measureText(cfg.text).width);
    canvas.width = tw + 24; canvas.height = cfg.size + 24;
    ctx.font = cfg.size + "px sans-serif";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = cfg.color; ctx.globalAlpha = cfg.opacity;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.translate(canvas.width / 2, canvas.height / 2);
    if (cfg.diagonal) ctx.rotate(-Math.PI / 4);
    ctx.fillText(cfg.text, 0, 0);
    const pngBytes = dataURLToBytes(canvas.toDataURL("image/png"));
    const img = await doc.embedPng(pngBytes);
    const pages = doc.getPages();
    const tileW = canvas.width, tileH = canvas.height;
    const stepX = tileW * 1.6, stepY = tileH * 1.6;
    pages.forEach(function (pg) {
      const w = pg.getWidth(), h = pg.getHeight();
      for (let y = 0; y < h + stepY; y += stepY) {
        for (let x = 0; x < w + stepX; x += stepX) {
          pg.drawImage(img, { x: x, y: h - y - tileH, width: tileW, height: tileH, opacity: cfg.opacity });
        }
      }
    });
    return returnBytes ? await doc.save({ useObjectStreams: false }) : null;
  }
  function hexToRgb(hex) {
    hex = (hex || "#888888").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join("");
    const n = parseInt(hex, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  /* =====================================================================
   * 签章（图片 / 手绘）
   * ===================================================================== */
  function setupSignatureDialog() {
    const dlg = $("pdf-signature-dialog");
    if (!dlg) return;
    const pad = $("pdf-sign-pad");
    const fileInput = $("pdf-sign-file");
    const loadBtn = $("pdf-sign-load");
    const clearBtn = $("pdf-sign-clear");
    const okBtn = $("pdf-sign-ok");
    const penEl = $("pdf-sign-pen"), penValEl = $("pdf-sign-pen-val");
    const scaleEl = $("pdf-sign-scale"), scaleValEl = $("pdf-sign-scale-val");
    const whiteEl = $("pdf-sign-white");
    let penWidth = penEl ? Number(penEl.value) || 2 : 2;
    if (penEl) penEl.addEventListener("input", function () { penWidth = Number(penEl.value) || 2; if (penValEl) penValEl.textContent = penEl.value; });
    if (scaleEl) scaleEl.addEventListener("input", function () { sigScale = (Number(scaleEl.value) || 100) / 100; if (scaleValEl) scaleValEl.textContent = scaleEl.value + "%"; });
    if (whiteEl) whiteEl.addEventListener("change", function () { sigWhiteBg = !!whiteEl.checked; });
    if (loadBtn && fileInput) loadBtn.addEventListener("click", function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener("change", function () {
      const f = fileInput.files && fileInput.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = function () {
        if (sigReplaceId != null) {
          const sig = signatures.find(function (s) { return s.id === sigReplaceId; });
          if (sig) {
            sig.dataUrl = r.result;
            sig.bytes = dataURLToBytes(r.result);
            pushHistory(); dirty = true; updateSaveState();
            const pe = pagesEl.querySelector('.pdf-page[data-num="' + sig.page + '"]');
            if (pe) renderPage(sig.page, true);
          }
          sigReplaceId = null;
          return;
        }
        drawToPad(r.result);
      };
      r.readAsDataURL(f);
    });
    if (clearBtn) clearBtn.addEventListener("click", function () { if (pad) { const c = pad.getContext("2d"); c.clearRect(0, 0, pad.width, pad.height); } });
    if (okBtn) okBtn.addEventListener("click", function () {
      closeModal(dlg);
      if (!pad) return;
      const dataUrl = pad.toDataURL("image/png");
      const bytes = dataURLToBytes(dataUrl);
      pendingSig = { dataUrl: dataUrl, bytes: bytes, w: Math.round(pad.width * sigScale), h: Math.round(pad.height * sigScale) };
      // 关键：进入"放置态"，让文字层不再拦截点击（否则点在文字上收不到 click）
      if (pagesEl) pagesEl.classList.add("sig-placing");
      setStatus("请在 PDF 页面上点击要放置签章的位置（Esc 取消）");
      toast("点击 PDF 页面放置签章");
    });
    // —— 我的签章：localStorage 持久化，便于下次直接使用 ——
    const savedListEl = $("pdf-sign-saved");
    const SAVED_KEY = "mojian.savedSignatures";  // localStorage 兜底（exe 目录不可写时）
    // 优先从 exe 同目录的 mojian_signatures.json 读取（随程序携带 / 备份）；
    // 读不到（文件不存在或命令不可用）则回落 localStorage。
    async function loadSavedSignatures() {
      try {
        const txt = await invoke("load_signatures");
        const arr = JSON.parse(txt || "[]");
        if (Array.isArray(arr)) {
          try { localStorage.setItem(SAVED_KEY, JSON.stringify(arr)); } catch (e) {}
          return arr;
        }
      } catch (e) { /* 回落 localStorage */ }
      try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]") || []; }
      catch (e) { return []; }
    }
    // 写入：先写 exe 旁 JSON，再同步一份到 localStorage 兜底；返回是否成功写入 exe 文件。
    async function persistSaved(list) {
      const txt = JSON.stringify(list);
      let ok = false;
      try { await invoke("save_signatures", { content: txt }); ok = true; } catch (e) { ok = false; }
      try { localStorage.setItem(SAVED_KEY, txt); } catch (e) {}
      return ok;
    }
    function padHasInk(p) {
      if (!p) return false;
      const c = p.getContext("2d");
      const d = c.getImageData(0, 0, p.width, p.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) return true; }
      return false;
    }
    async function renderSavedSignatures() {
      if (!savedListEl) return;
      const list = await loadSavedSignatures();
      savedListEl.innerHTML = "";
      if (!list.length) {
        const tip = document.createElement("div");
        tip.className = "sign-saved-item empty";
        tip.textContent = "暂无（手绘或选图后点「存为常用」）";
        savedListEl.appendChild(tip);
        return;
      }
      list.forEach(function (item) {
        const cell = document.createElement("div");
        cell.className = "sign-saved-item";
        cell.title = "点击使用 · 右键删除";
        const im = document.createElement("img");
        im.src = item.dataUrl;
        cell.appendChild(im);
        cell.addEventListener("click", function () {
          const bytes = dataURLToBytes(item.dataUrl);
          pendingSig = { dataUrl: item.dataUrl, bytes: bytes, w: Math.round((item.w || 320) * sigScale), h: Math.round((item.h || 140) * sigScale) };
          closeModal(dlg);
          if (pagesEl) pagesEl.classList.add("sig-placing");
          setStatus("请在 PDF 页面上点击要放置签章的位置（Esc 取消）");
          toast("点击 PDF 页面放置签章");
        });
        cell.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          loadSavedSignatures().then(function (all) {
            const l = all.filter(function (x) { return x.id !== item.id; });
            persistSaved(l).then(renderSavedSignatures);
          });
        });
        savedListEl.appendChild(cell);
      });
    }
    if (savedListEl) renderSavedSignatures();
    const saveSigBtn = $("pdf-sign-save");
    if (saveSigBtn) saveSigBtn.addEventListener("click", async function () {
      if (!pad) return;
      if (!padHasInk(pad)) { toast("画板上还是空的，先手绘或选张图"); return; }
      const dataUrl = pad.toDataURL("image/png");
      const list = await loadSavedSignatures();
      list.push({ id: "sig_" + Date.now(), dataUrl: dataUrl, w: pad.width, h: pad.height });
      await persistSaved(list);
      renderSavedSignatures();
      toast("已存入我的签章，下次可直接点击使用");
    });
      if (pad) {
        const c = pad.getContext("2d");
        c.lineWidth = penWidth; c.lineCap = "round"; c.strokeStyle = "#111";
        let drawing = false, lx = 0, ly = 0;
        pad.addEventListener("mousedown", function (e) { drawing = true; c.lineWidth = penWidth; const r = pad.getBoundingClientRect(); lx = e.clientX - r.left; ly = e.clientY - r.top; });
      pad.addEventListener("mousemove", function (e) {
        if (!drawing) return; const r = pad.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
        c.beginPath(); c.moveTo(lx, ly); c.lineTo(x, y); c.stroke(); lx = x; ly = y;
      });
      window.addEventListener("mouseup", function () { drawing = false; });
    }
  }
  function drawToPad(dataUrl) {
    const pad = $("pdf-sign-pad"); if (!pad) return;
    const img = new Image();
    img.onload = function () {
      const c = pad.getContext("2d"); c.clearRect(0, 0, pad.width, pad.height);
      const scale = Math.min(pad.width / img.width, pad.height / img.height);
      const w = img.width * scale, h = img.height * scale;
      c.drawImage(img, (pad.width - w) / 2, (pad.height - h) / 2, w, h);
    };
    img.src = dataUrl;
  }

  /* 把签名 PNG 合成到白底，去掉透明通道（alpha/SMask）。
     透明签名经 pdf-lib embedPng 会写入 /SMask，作为 Stamp 注释外观流时
     Adobe 常报"本页面存在错误"。白底不透明图无 SMask，Acrobat 最稳。 */
  function flattenSigToWhite(pngBytes) {
    return new Promise(function (resolve) {
      let url;
      try {
        const blob = new Blob([pngBytes], { type: "image/png" });
        url = URL.createObjectURL(blob);
      } catch (e) { resolve(pngBytes); return; }
      const img = new Image();
      img.onload = function () {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0);
          c.toBlob(function (b) {
            if (!b) { URL.revokeObjectURL(url); resolve(pngBytes); return; }
            const fr = new FileReader();
            fr.onload = function () { URL.revokeObjectURL(url); resolve(new Uint8Array(fr.result)); };
            fr.onerror = function () { URL.revokeObjectURL(url); resolve(pngBytes); };
            fr.readAsArrayBuffer(b);
          }, "image/png");
        } catch (e) { URL.revokeObjectURL(url); resolve(pngBytes); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(pngBytes); };
      img.src = url;
    });
  }

  /* =====================================================================
   * 查找（跨页文本搜索 + 高亮）
   * ===================================================================== */
  async function getPageText(num) {
    if (pageTextCache[num] != null) return pageTextCache[num];
    const page = await pdfDoc.getPage(num);
    const tc = await page.getTextContent();
    let s = "";
    let prevX = null, prevW = 0, prevY = null;
    tc.items.forEach(function (it) {
      if (!it.str) return;
      const x = it.transform ? it.transform[4] : null;
      const y = it.transform ? it.transform[5] : null;
      const w = it.width || 0;
      const h = it.height || (it.transform ? Math.hypot(it.transform[2], it.transform[3]) : 8);
      if (prevX != null && x != null) {
        const gap = x - (prevX + prevW);
        // 仅当换行（y 明显变化）或水平间隙超过字高一定比例时才插入空格；
        // 否则（PDF 自带字距 kern）直接连上，规避 "F i n a l" 这类把字距解析成空格的经典错误。
        if (y != null && prevY != null && Math.abs(y - prevY) > (h || 8) * 0.5) {
          s += " ";
        } else if (gap > (h || w || 8) * 0.2) {
          s += " ";
        }
      }
      s += it.str;
      if (it.hasEOL) s += " ";   // 行尾通常也是词边界
      if (x != null) { prevX = x; prevW = w; }
      if (y != null) prevY = y;
    });
    pageTextCache[num] = s;
    return s;
  }
  /* 清洗单个 text item 内部被 pdf.js 提取间距误拆成的伪空格（经典 "F i n a l" 错误）。
   * 规则：仅当空格两侧都是"正常词"（长度 >= 2）时才保留，视为真实词边界；
   * 若任一侧只是单字母（字距 kern），则丢弃该空格，把字母连回成词。 */
  function cleanKernedStr(raw) {
    if (typeof raw !== "string" || !/\s/.test(raw)) return raw;
    const parts = raw.split(/(\s+)/);
    let out = "";
    let prevToken = "";
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (k % 2 === 1) {                       // 分隔符（空白）
        const nextToken = parts[k + 1] || "";
        const prevWord = prevToken.length >= 2;
        const nextWord = nextToken.length >= 2;
        // 只有至少一侧是正常词才保留空格；否则当作字距伪空格丢弃
        if ((prevWord || nextWord) && prevToken && nextToken) out += " ";
      } else {
        out += p;
        if (p) prevToken = p;
      }
    }
    return out;
  }
  /* 文本层渲染完成后，按原始 text item 的几何位置重建每个 span 的 textContent：
   *  - 清洗 item 内部的字距伪空格（cleanKernedStr）；
   *  - 仅在"真实词边界"（水平间隙 > 字高约 0.2 倍）或换行处，于 item 之间插入空格/换行。
   * 这样"选中复制"得到干净文本（Final Protocol 而非 Fi n al Pr ot o c ol）。
   * 文本层本身透明（可见的是 canvas），改写 textContent 不影响显示；搜索高亮在其后执行，照常工作。 */
  function alignAndCleanTextLayer(pageEl, items) {
    if (!pageEl || !items || !items.length) return;
    const textLayer = pageEl.querySelector(".textLayer");
    if (!textLayer) return;
    // 只取直接子节点里的 <span>（item 级），避开 enhanceTextSelection 可能生成的嵌套字符 span
    const spans = [];
    const kids = textLayer.children;
    for (let c = 0; c < kids.length; c++) {
      if (kids[c].tagName === "SPAN") spans.push(kids[c]);
    }
    let prev = null;
    for (let i = 0; i < items.length && i < spans.length; i++) {
      const it = items[i];
      const span = spans[i];
      if (!it || typeof it.str !== "string" || !it.str.trim()) { span.textContent = ""; continue; }
      const tx = it.transform || [1, 0, 0, 1, 0, 0];
      const x = tx[4], y = tx[5];
      const w = it.width || 0;
      const h = (tx[3] && Math.abs(tx[3])) || it.height || 8;
      let sep = "";
      if (prev) {
        const dy = Math.abs(y - prev.y);
        const dx = x - (prev.x + prev.w);
        if (it.hasEOL || dy > (prev.h * 0.5 || 6)) sep = "\n";
        else if (dx > (prev.w + prev.h * 0.2)) sep = " ";
      }
      span.textContent = (sep || "") + cleanKernedStr(it.str);
      prev = { x: x, y: y, w: w, h: h };
    }
  }
  /* 空格不敏感的命中判断：优先精确（含真实空格）；否则忽略全部空白再比，
   * 兜底某些 PDF 把字距拆成空格（文本层里是 "Fi n al"）的情况。 */
  function pageMatch(text, ql) {
    if (text.indexOf(ql) >= 0) return true;
    const q2 = ql.replace(/\s+/g, "");
    if (!q2) return false;
    return text.replace(/\s+/g, "").indexOf(q2) >= 0;
  }
  async function runSearch(q) {
    q = (q || "").trim();
    const mySeq = ++searchSeq;          // 本次查找的代号
    searchQuery = q;
    searching = true;
    clearSearchHighlights();
    if (findCount) { findCount.classList.add("is-searching"); findCount.textContent = ""; }
    if (!q) {
      searchMatchPages = []; searching = false;
      if (findCount) { findCount.classList.remove("is-searching"); findCount.textContent = ""; }
      return;
    }
    const ql = q.toLowerCase();
    const matchPages = [];
    if (findCount) findCount.textContent = "查找中 0/" + numPages;
    for (let i = 1; i <= numPages; i++) {
      if (mySeq !== searchSeq) return;   // 被更新的查找取代 → 放弃本次（旧查找还没结束时的假"无匹配"根源）
      const t = (await getPageText(i)).toLowerCase();
      if (pageMatch(t, ql)) matchPages.push(i);
      if (mySeq !== searchSeq) return;
      if (findCount) findCount.textContent = "查找中 " + i + "/" + numPages + (matchPages.length ? "（命中 " + matchPages.length + "）" : "");
      await new Promise(function (r) { setTimeout(r, 0); });   // 让出事件循环：大文件不卡死 + 进度可见
    }
    if (mySeq !== searchSeq) return;
    searchMatchPages = matchPages;
    searchIdx = 0;
    searching = false;
    if (findCount) findCount.classList.remove("is-searching");
    if (!matchPages.length) { if (findCount) findCount.textContent = "无匹配"; return; }
    if (findCount) findCount.textContent = "命中 " + matchPages.length + " 页";
    // 必须 await：goToPage 在懒渲染下会先渲染目标页，渲染完成前文字层还不存在。
    await goToPage(matchPages[0]);
    if (mySeq !== searchSeq) return;
    highlightOnPage(matchPages[0], q);
    if (findCount) findCount.textContent = "第 " + matchPages[0] + " 页（1/" + matchPages.length + "）";
  }
  async function findNext(dir) {
    if (searching) return;                         // 查找进行中先不跳转，避免串页
    if (!searchMatchPages.length) return;
    searchIdx = (searchIdx + dir + searchMatchPages.length) % searchMatchPages.length;
    const n = searchMatchPages[searchIdx];
    await goToPage(n);
    highlightOnPage(n, searchQuery);
    if (findCount) findCount.textContent = "第 " + n + " 页（" + (searchIdx + 1) + "/" + searchMatchPages.length + "）";
  }
  function wrapMatches(span, ql) {
    let found = false;
    Array.prototype.slice.call(span.childNodes).forEach(function (node) {
      if (node.nodeType !== 3) return;
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(ql);
      if (idx < 0) {
        // 退路：忽略空白再匹配（文本层里是 "Fi n al" 的情况），并把规范化区间映射回原始字符位置
        const qns = ql.replace(/\s+/g, "");
        if (!qns) return;
        const ni = text.replace(/\s+/g, "").toLowerCase().indexOf(qns);
        if (ni < 0) return;
        const range = mapNormRange(text, ni, ni + qns.length);
        if (!range) return;
        wrapRange(span, node, range[0], range[1]);
        found = true;
        return;
      }
      wrapRange(span, node, idx, idx + ql.length);
      found = true;
    });
    return found;
  }
  function wrapRange(span, node, start, end) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(document.createTextNode(text.slice(0, start)));
    const m = document.createElement("span");
    m.className = "search-hit";
    m.textContent = text.slice(start, end);
    frag.appendChild(m);
    if (end < text.length) frag.appendChild(document.createTextNode(text.slice(end)));
    span.replaceChild(frag, node);
  }
  /* 把"忽略空白后的字符区间 [na, nb)"映射回原始字符串中对应"非空白字符"的起止索引 */
  function mapNormRange(text, na, nb) {
    let count = 0, start = -1, end = -1;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      if (start < 0 && count === na) start = i;
      if (count === nb - 1) { end = i + 1; break; }
      count++;
    }
    if (start < 0 || end < 0) return null;
    return [start, end];
  }
  function highlightOnPage(num, q) {
    clearSearchHighlights();
    const pageEl = pagesEl.querySelector('.pdf-page[data-num="' + num + '"]');
    if (!pageEl) return;
    const ql = (q || "").trim().toLowerCase();
    if (!ql) return;
    const spans = pageEl.querySelectorAll(".textLayer span");
    let first = null;
    spans.forEach(function (s) {
      if (wrapMatches(s, ql) && !first) first = s.querySelector(".search-hit") || s;
    });
    if (first) first.scrollIntoView({ block: "center" });
  }
  function clearSearchHighlights() {
    pagesEl.querySelectorAll(".textLayer .search-hit").forEach(function (h) {
      const parent = h.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(h.textContent), h);
      if (parent.normalize) parent.normalize();
    });
  }

  /* =====================================================================
   * 打印
   * ===================================================================== */
  async function printPdf() {
    if (!pdfDoc) return;
    const container = document.createElement("div");
    container.id = "pdf-print";
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = "100%"; canvas.style.maxWidth = vp.width + "px";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/png");
      img.style.width = "100%"; img.style.pageBreakAfter = "always";
      container.appendChild(img);
    }
    document.body.appendChild(container);
    setTimeout(function () {
      window.print();
      setTimeout(function () { if (container.parentNode) container.parentNode.removeChild(container); }, 500);
    }, 100);
  }

  /* =====================================================================
   * 工具栏动作分发
   * ===================================================================== */
  function handlePdfAction(a) {
    switch (a) {
      case "open": openFileDialog(); break;
      case "mouse-mode": toggleMouseMode(); break;
      case "prev": goToPage(currentPage - 1); break;
      case "next": goToPage(currentPage + 1); break;
      case "zoom-in": applyScale(scale + 0.05); break;
      case "zoom-out": applyScale(scale - 0.05); break;
      case "zoom-100": applyScale(1); break;
      case "fit": fitWidth(); break;
      case "rotate-left": rotatePage(getCurrentVisiblePage(), -1); break;
      case "rotate-right": rotatePage(getCurrentVisiblePage(), 1); break;
      case "rotate-all": openRotate(); break;
      case "note": toggleNoteMode(); break;
      case "undo": undo(); break;
      case "merge": merge(); break;
      case "split": openSplit(); break;
      case "find": if (findBar) { findBar.classList.remove("hidden"); if (findInput) findInput.focus(); } break;
      case "export-img": openExportImg(); break;
      case "export-word": openExportWord(); break;
      case "watermark": openWatermark(); break;
      case "signature": openModal($("pdf-signature-dialog")); break;
      case "print": printPdf(); break;
      case "save": save(); break;
      case "save-as": saveAs(); break;
      case "close": close(); break;
    }
  }
  function toggleMouseMode() {
    mouseMode = mouseMode === "select" ? "hand" : "select";
    if (mainEl) mainEl.classList.toggle("hand-mode", mouseMode === "hand");
    const btn = pdfToolbar.querySelector('[data-pdf-action="mouse-mode"]');
    if (btn) { btn.textContent = mouseMode === "select" ? "选择" : "手型"; btn.classList.toggle("active", mouseMode === "hand"); }
  }
  async function openFileDialog() {
    let p;
    try { p = await tauriOpen({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] }); } catch (e) { return; }
    if (p) open(p);
  }

  function isActive() { return !!(pdfRoot && !pdfRoot.classList.contains("hidden")); }

  init();

  return {
    open: open, close: close, save: save, saveAs: saveAs, undo: undo,
    isActive: isActive, init: init,
    openToolbarSettings: openPdfToolbarSettings,
    resetToolbar: resetPdfToolbar,
    renderToolbar: renderPdfToolbar,
  };
})();
