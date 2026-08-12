"use strict";
(function () {
  /* =====================================================================
   * Tauri 全局 API（withGlobalTauri: true）
   * ===================================================================== */
  const TAURI = window.__TAURI__ || {};
  const TAURI_CORE = TAURI.core || TAURI.tauri || null;

  /* Tauri API 桥接：自动适配 v1(__TAURI__.tauri) 与 v2(__TAURI__.core)；
   * 对话框插件默认非全局，改走 plugin:dialog 命令直接调用 Rust 插件。 */
  function tauriInvoke(cmd, args) {
    if (TAURI_CORE && typeof TAURI_CORE.invoke === "function") {
      return TAURI_CORE.invoke(cmd, args);
    }
    if (TAURI && typeof TAURI.invoke === "function") {
      return TAURI.invoke(cmd, args);
    }
    return Promise.reject(new Error("Tauri 运行时不可用（请通过 cargo build 产物运行）"));
  }
  function tauriOpen(opts) {
    if (TAURI.dialog && typeof TAURI.dialog.open === "function") {
      return TAURI.dialog.open(opts);
    }
    return tauriInvoke("plugin:dialog|open", { options: opts });
  }
  function tauriSave(opts) {
    if (TAURI.dialog && typeof TAURI.dialog.save === "function") {
      return TAURI.dialog.save(opts);
    }
    return tauriInvoke("plugin:dialog|save", { options: opts });
  }
  function tauriListen(name, cb) {
    if (TAURI.event && typeof TAURI.event.listen === "function") {
      return TAURI.event.listen(name, cb);
    }
    return Promise.reject(new Error("Tauri 事件 API 不可用"));
  }

  /* =====================================================================
   * 配置持久化（写入 exe 同目录 mojian.config.json）
   * ===================================================================== */
  const DEFAULT_CONFIG = {
    windowSize: null,      // { w, h } 物理像素；关闭前的窗格大小
    theme: "light",        // light | sepia(豆沙绿) | yellow(养眼黄) | dark
    toolbar: null,         // 工具栏自定义布局（按钮顺序/显隐），null=使用默认
    pdfToolbar: null,      // PDF 工具栏自定义布局（同上），null=使用默认
    defaultEncoding: "",   // ""=自动(UTF-8 优先, GBK 兜底) | "utf-8" | "gbk"
    sourceSplit: false,    // 源码分栏模式（左渲染右源码）
    toolbarVisible: true,
  };
  let appConfig = Object.assign({}, DEFAULT_CONFIG);

  /* =====================================================================
   * 工具栏定义（数据驱动：支持自定义显隐与拖拽排序）
   * 每个条目：{ name, kind:'action'|'cmd'|'block'|'zoomlabel', value, svg, label, title, keep }
   *  - action/cmd/block 对应 data-action/data-cmd/data-block（与既有 click 委托一致）
   *  - keep:true 表示核心控件（缩放/分栏/源码），始终显示、不参与显隐、不可隐藏
   * DEFAULT_ORDER 中的 "__divider__" 为分组分隔符；"ZOOMLABEL" 为缩放百分比标签。
   * ===================================================================== */
  const TOOLBAR_ITEMS = {
    new:        { name:"新建", kind:"action", value:"new", title:"新建文档（HTML 或 Markdown）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>' },
    open:       { name:"打开", kind:"action", value:"open", title:"打开 HTML / Markdown 文件", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>' },
    prevfile:   { name:"上一个文件", kind:"action", value:"prevfile", title:"打开同目录下上一个受支持的文件", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>', keep:true },
    nextfile:   { name:"下一个文件", kind:"action", value:"nextfile", title:"打开同目录下下一个受支持的文件", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>', keep:true },
    save:       { name:"保存", kind:"action", value:"save", title:"保存（写回原文件）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' },
    saveas:     { name:"另存为", kind:"action", value:"saveas", title:"另存为…", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="8 11 12 15 16 11"/><path d="M5 19h14"/></svg>' },
    export:     { name:"导出", kind:"action", value:"export", title:"导出为自包含 HTML 文件", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 21V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="16" x2="12" y2="9"/></svg>' },
    clear:      { name:"清空", kind:"action", value:"clear", title:"清空草稿", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' },
    undo:       { name:"撤销", kind:"action", value:"undo", title:"撤销 (Ctrl+Z)", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>' },
    redo:       { name:"重做", kind:"action", value:"redo", title:"重做 (Ctrl+Y)", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>' },
    bold:       { name:"加粗", kind:"cmd", value:"bold", title:"加粗 (Ctrl+B)", label:'<b>B</b>' },
    italic:     { name:"斜体", kind:"cmd", value:"italic", title:"斜体 (Ctrl+I)", label:'<i>I</i>' },
    underline:  { name:"下划线", kind:"cmd", value:"underline", title:"下划线 (Ctrl+U)", label:'<u>U</u>' },
    forecolor:  { name:"文字颜色", kind:"action", value:"forecolor", title:"文字颜色（选中文字后点击取色）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M12 4l-3.2 8h6.4L12 4z" fill="currentColor" stroke="none"/></svg>' },
    backcolor:  { name:"背景颜色", kind:"action", value:"backcolor", title:"背景颜色 / 高亮（选中文字后点击取色）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v4h6V3" fill="#fde68a" stroke="none"/></svg>' },
    H1:         { name:"标题 1", kind:"block", value:"H1", title:"标题 1", label:'H1' },
    H2:         { name:"标题 2", kind:"block", value:"H2", title:"标题 2", label:'H2' },
    H3:         { name:"标题 3", kind:"block", value:"H3", title:"标题 3", label:'H3' },
    H4:         { name:"标题 4", kind:"block", value:"H4", title:"标题 4", label:'H4' },
    H5:         { name:"标题 5", kind:"block", value:"H5", title:"标题 5", label:'H5' },
    H6:         { name:"标题 6", kind:"block", value:"H6", title:"标题 6", label:'H6' },
    insertUnorderedList: { name:"无序列表", kind:"cmd", value:"insertUnorderedList", title:"无序列表", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>' },
    insertOrderedList:   { name:"有序列表", kind:"cmd", value:"insertOrderedList", title:"有序列表", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg>' },
    indent:     { name:"增加缩进", kind:"cmd", value:"indent", title:"增加缩进（需先选中列表项或引用块）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/><polyline points="3 9 7 12 3 15"/></svg>' },
    outdent:    { name:"减少缩进", kind:"cmd", value:"outdent", title:"减少缩进（需先选中列表项或引用块）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/><polyline points="7 9 3 12 7 15"/></svg>' },
    BLOCKQUOTE: { name:"引用块", kind:"block", value:"BLOCKQUOTE", title:"引用块", svg:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h4v6H7v2H5V9a2 2 0 0 1 2-2zm8 0h4v6h-4v2h-2V9a2 2 0 0 1 2-2z" transform="scale(0.9) translate(1 1)"/></svg>' },
    link:       { name:"链接", kind:"action", value:"link", title:"插入/编辑链接", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>' },
    image:      { name:"图片", kind:"action", value:"image", title:"插入图片", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/></svg>' },
    video:      { name:"视频", kind:"action", value:"video", title:"插入视频 / 嵌入播放器", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15" fill="currentColor" stroke="none"/></svg>' },
    table:      { name:"表格", kind:"action", value:"table", title:"插入表格 (3×3)", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/></svg>' },
    code:       { name:"代码块", kind:"action", value:"code", title:"插入代码块", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 7 4 12 8 17"/><polyline points="16 7 20 12 16 17"/></svg>' },
    hr:         { name:"分割线", kind:"action", value:"hr", title:"插入分割线", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>' },
    emoji:      { name:"表情", kind:"action", value:"emoji", title:"插入表情（Emoji）", label:'😀' },
    slides:     { name:"幻灯片", kind:"action", value:"slides", title:"以幻灯片演示（仅 Markdown 文档）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none"/></svg>' },
    find:       { name:"查找替换", kind:"action", value:"find", title:"查找 / 替换", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' },
    zoomout:    { name:"缩小", kind:"action", value:"zoom-out", title:"缩小 (Ctrl+-)", label:'−', keep:true },
    zoomin:     { name:"放大", kind:"action", value:"zoom-in", title:"放大 (Ctrl+=)", label:'+', keep:true },
    split:      { name:"分栏", kind:"action", value:"split", title:"源码分栏（左渲染 / 右源码）", label:'分栏', keep:true },
    source:     { name:"源码", kind:"action", value:"source", title:"切换源码 / 可视化编辑", label:'源码', keep:true },
    softwrap:   { name:"自动换行", kind:"action", value:"softwrap", title:"切换源码栏自动换行（关闭后长行不换行、可横向滚动）", label:'换行', keep:true },
    ZOOMLABEL:  { kind:"zoomlabel", keep:true },
  };

  const DEFAULT_ORDER = [
    "new","open","prevfile","nextfile","save","saveas","export","slides","clear",
    "__divider__",
    "undo","redo",
    "__divider__",
    "bold","italic","underline","forecolor","backcolor",
    "__divider__",
    "H1","H2","H3","H4","H5","H6",
    "__divider__",
    "insertUnorderedList","insertOrderedList","indent","outdent","BLOCKQUOTE","link",
    "__divider__",
    "image","video","table","code","hr","emoji",
    "__divider__",
    "find",
    "__divider__",
    "zoomout","ZOOMLABEL","zoomin","split","source","softwrap",
  ];

  /** 解析工具栏配置（缺省回退默认顺序），返回 { order, hidden } */
  function getToolbarConfig() {
    const t = appConfig.toolbar || {};
    return {
      order: Array.isArray(t.order) && t.order.length ? t.order : DEFAULT_ORDER.slice(),
      hidden: (t.hidden && typeof t.hidden === "object") ? t.hidden : {},
    };
  }

  /** 依据配置动态渲染工具栏（分组 / 缩放标签 / 显隐 / 可拖拽） */
  function renderToolbar() {
    if (!toolbar) return;
    const cfg = getToolbarConfig();
    toolbar.innerHTML = "";
    let lastWasDivider = false;
    cfg.order.forEach(function (token) {
      if (token === "__divider__") {
        if (lastWasDivider) return;
        const d = document.createElement("div");
        d.className = "divider";
        toolbar.appendChild(d);
        lastWasDivider = true;
        return;
      }
      const item = TOOLBAR_ITEMS[token];
      if (!item) return;
      if (cfg.hidden[token] && !item.keep) { lastWasDivider = false; return; }
      lastWasDivider = false;
      if (item.kind === "zoomlabel") {
        const sp = document.createElement("span");
        sp.className = "zoom-label";
        sp.id = "zoom-label";
        sp.textContent = Math.round(currentZoom * 100) + "%";
        toolbar.appendChild(sp);
        return;
      }
      const btn = document.createElement("button");
      if (item.kind === "cmd") btn.dataset.cmd = item.value;
      else if (item.kind === "block") btn.dataset.block = item.value;
      else btn.dataset.action = item.value;
      btn.title = item.title || item.name;
      if (item.svg) btn.innerHTML = item.svg;
      else if (item.label) btn.innerHTML = item.label;
      if (item.keep) btn.classList.add("keep");
      if (item.value === "softwrap") btn.classList.toggle("active", softWrap);
      toolbar.appendChild(btn);
    });
    updateNavButtons();
  }

  /* 自定义弹窗：勾选显隐（核心 keep 控件与缩放标签不参与） */
  const toolbarSettingsModal = document.getElementById("toolbar-settings");
  const toolbarSettingsList = document.getElementById("toolbar-settings-list");
  const toolbarSettingsBtn = document.getElementById("toolbar-settings-btn");
  function openToolbarSettings() {
    if (!toolbarSettingsList) return;
    const cfg = getToolbarConfig();
    toolbarSettingsList.innerHTML = "";
    // 依据实际 order 渲染，保证列表顺序与工具栏一致；分隔符/固定项(keep、缩放标签)不可排序
    cfg.order.forEach(function (token) {
      if (token === "__divider__") {
        const hr = document.createElement("div");
        hr.className = "tb-set-divider";
        toolbarSettingsList.appendChild(hr);
        return;
      }
      const item = TOOLBAR_ITEMS[token];
      if (!item || item.keep || item.kind === "zoomlabel") return;
      const idx = cfg.order.indexOf(token);
      let upEnabled = idx > 0, downEnabled = idx < cfg.order.length - 1;
      if (upEnabled) {
        const prev = cfg.order[idx - 1];
        if (prev === "__divider__") upEnabled = false;
        else { const pi = TOOLBAR_ITEMS[prev]; if (pi && (pi.keep || pi.kind === "zoomlabel")) upEnabled = false; }
      }
      if (downEnabled) {
        const next = cfg.order[idx + 1];
        if (next === "__divider__") downEnabled = false;
        else { const ni = TOOLBAR_ITEMS[next]; if (ni && (ni.keep || ni.kind === "zoomlabel")) downEnabled = false; }
      }
      const row = document.createElement("div");
      row.className = "tb-set-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !cfg.hidden[token];
      cb.dataset.id = token;
      cb.addEventListener("change", function () {
        const c = getToolbarConfig();
        if (cb.checked) delete c.hidden[token];
        else c.hidden[token] = true;
        appConfig.toolbar = { order: c.order.slice(), hidden: c.hidden };
        renderToolbar();
        saveConfig({ toolbar: appConfig.toolbar });
      });
      const span = document.createElement("span");
      span.textContent = item.name;
      const up = document.createElement("button");
      up.type = "button";
      up.className = "tb-move";
      up.textContent = "↑";
      up.title = "上移";
      up.disabled = !upEnabled;
      up.addEventListener("click", function (e) { e.preventDefault(); moveToolbarItem(token, -1); });
      const down = document.createElement("button");
      down.type = "button";
      down.className = "tb-move";
      down.textContent = "↓";
      down.title = "下移";
      down.disabled = !downEnabled;
      down.addEventListener("click", function (e) { e.preventDefault(); moveToolbarItem(token, 1); });
      row.appendChild(cb);
      row.appendChild(span);
      row.appendChild(up);
      row.appendChild(down);
      toolbarSettingsList.appendChild(row);
    });
    if (toolbarSettingsModal) openModal(toolbarSettingsModal);
  }

  // 在定制界面内用 ↑/↓ 调整按钮顺序（不跨越分隔符与固定项）
  function moveToolbarItem(token, dir) {
    const cfg = getToolbarConfig();
    const order = cfg.order.slice();
    const idx = order.indexOf(token);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= order.length) return;
    const other = order[swap];
    if (other === "__divider__") return;
    const oItem = TOOLBAR_ITEMS[other];
    if (oItem && (oItem.keep || oItem.kind === "zoomlabel")) return;
    order[idx] = other;
    order[swap] = token;
    appConfig.toolbar = { order: order, hidden: cfg.hidden };
    renderToolbar();
    saveConfig({ toolbar: appConfig.toolbar });
    openToolbarSettings(); // 重渲染列表以刷新按钮可用状态
  }
  /* PDF 打开时，顶部「定制」改为定制 PDF 工具栏（复用同一个弹窗） */
  function pdfCustomizeActive() {
    return !!(window.__pdfActive && window.PDFApp && window.PDFApp.openToolbarSettings);
  }
  // 定制弹窗 Tab 切换（工具栏 / 文件关联）
  function showTbTab(name) {
    document.querySelectorAll("#tb-tabs .tb-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    const tb = document.getElementById("tb-panel-toolbar");
    const ac = document.getElementById("tb-panel-assoc");
    if (tb) tb.classList.toggle("hidden", name !== "toolbar");
    if (ac) ac.classList.toggle("hidden", name !== "assoc");
    // 仅在切到「文件关联」时才查询注册表状态，避免打开弹窗时被 4 次 reg query 拖慢
    if (name === "assoc") refreshAssocChecks();
  }
  document.querySelectorAll("#tb-tabs .tb-tab").forEach(function (t) {
    t.addEventListener("click", function () { showTbTab(t.dataset.tab); });
  });
  // 显隐整个 Tab 栏（PDF 模式复用弹窗时隐藏，仅保留工具栏列表）
  function setTbTabsVisible(visible) {
    const tabsEl = document.getElementById("tb-tabs");
    if (tabsEl) tabsEl.classList.toggle("hidden", !visible);
    if (!visible) {
      const tb = document.getElementById("tb-panel-toolbar");
      const ac = document.getElementById("tb-panel-assoc");
      if (tb) tb.classList.remove("hidden");
      if (ac) ac.classList.add("hidden");
    }
  }

  if (toolbarSettingsBtn) toolbarSettingsBtn.addEventListener("click", function () {
    if (pdfCustomizeActive()) {
      window.PDFApp.openToolbarSettings();   // PDF 模式：弹窗内容换成 PDF 按钮
      setTbTabsVisible(false);               // 隐藏 Tab 栏与「文件关联」面板
      return;
    }
    const title = toolbarSettingsModal && toolbarSettingsModal.querySelector("h3");
    if (title) title.textContent = "自定义工具栏";
    setTbTabsVisible(true);
    openToolbarSettings();
    showTbTab("toolbar");                    // 编辑器模式：默认停在「工具栏」Tab
  });
  if (toolbarSettingsModal) {
    const ok = document.getElementById("toolbar-settings-ok");
    const reset = document.getElementById("toolbar-reset");
    if (ok) ok.addEventListener("click", function () {
      if (toolbarSettingsModal) closeModal(toolbarSettingsModal);
    });
    if (reset) reset.addEventListener("click", function () {
      if (pdfCustomizeActive() && window.PDFApp.resetToolbar) { window.PDFApp.resetToolbar(); return; }
      appConfig.toolbar = null;
      renderToolbar();
      saveConfig({ toolbar: null });
    });
  }

  // 文件类型关联（分色图标）：按勾选状态注册/解除，写入 HKEY_CURRENT_USER（无需管理员）
  const regAssocBtn = document.getElementById("register-assoc-btn");
  const regAssocMsg = document.getElementById("register-assoc-msg");
  function getAssocChecks() {
    return Array.from(document.querySelectorAll("#toolbar-settings .tb-assoc-check input"))
      .filter(function (cb) { return cb.checked; })
      .map(function (cb) { return cb.dataset.assoc; });
  }
  async function refreshAssocChecks() {
    try {
      const state = await tauriInvoke("get_file_association_state");
      const set = new Set(Array.isArray(state) ? state : []);
      document.querySelectorAll("#toolbar-settings .tb-assoc-check input").forEach(function (cb) {
        cb.checked = set.has(cb.dataset.assoc);
      });
    } catch (e) { /* 非 Windows 或查询失败：保留默认（全勾选） */ }
  }
  if (regAssocBtn) {
    regAssocBtn.addEventListener("click", async function () {
      regAssocBtn.disabled = true;
      if (regAssocMsg) { regAssocMsg.textContent = "正在应用…"; regAssocMsg.className = "tb-assoc-msg"; }
      try {
        const res = await tauriInvoke("register_file_associations", { types: getAssocChecks() });
        if (regAssocMsg) { regAssocMsg.textContent = res; regAssocMsg.classList.add("ok"); }
      } catch (e) {
        if (regAssocMsg) {
          regAssocMsg.textContent = "操作失败：" + (e && e.message ? e.message : (e || "未知错误"));
          regAssocMsg.classList.add("err");
        }
      } finally {
        regAssocBtn.disabled = false;
        refreshAssocChecks();
      }
    });
  }

  /* 配置桥：供 pdf.js 读写同一份 mojian.config.json（避免两边各写一份互相覆盖） */
  window.MojianConfig = {
    get: function () { return appConfig; },
    save: function (patch) { return saveConfig(patch); },
  };

  async function loadConfig() {
    try {
      const raw = await tauriInvoke("read_config");
      const parsed = JSON.parse(raw || "{}");
      appConfig = Object.assign({}, DEFAULT_CONFIG, parsed);
    } catch (e) {
      appConfig = Object.assign({}, DEFAULT_CONFIG);
    }
  }

  async function saveConfig(patch) {
    if (patch) Object.assign(appConfig, patch);
    try {
      await tauriInvoke("write_config", { content: JSON.stringify(appConfig, null, 2) });
    } catch (e) {
      console.warn("写入配置失败：", e);
    }
  }

  function getConfig() { return appConfig; }

  /* =====================================================================
   * 常量与全局状态
   * ===================================================================== */
  const STORAGE_KEY = "htmlEditorDraft";
  const MAX_HISTORY = 100;        // 历史栈最大深度（常规场景）
  const COALESCE_MS = 600;        // 连续输入的合并时间窗口
  const SNAPSHOT_SIZE_WARN = 2 * 1024 * 1024; // 单步快照阈值(2MB)，超此为"大快照"
  const LARGE_MODE_KEEP = 15;     // 大快照场景保留的历史步数，防止内存暴涨

  const editor = document.getElementById("editor");
  const toolbar = document.getElementById("toolbar");
  const sourceView = document.getElementById("source-view");
  const sourceHl = document.getElementById("source-hl");
  const sourceHlCode = sourceHl ? sourceHl.querySelector("code") : null;
  const editorWrap = document.getElementById("editor-wrap");
  const folderBtn = document.getElementById("open-folder");
  const filePathEl = document.getElementById("file-path");

  /** 历史栈：每个快照为 { html, caret }，caret 为字符偏移量 */
  let history = [];
  let historyIndex = -1;
  /** 上一次提交历史的时间戳 */
  let lastChangeTs = 0;
  /** 上一次变更是否来自格式化命令（命令需作为独立检查点） */
  let lastWasCommand = true;
  /** 抑制由 execCommand 触发的 input 事件，避免重复记录 */
  let suppressInput = false;
  /** 当前保存的选区（用于对话框场景） */
  let savedRange = null;
  /** 自动保存定时器 */
  let saveTimer = null;
  /**
   * 当前打开的文件：{ path, kind }
   * kind ∈ "html" | "markdown"。为 null 时表示空白草稿（保存走"另存为"）。
   */
  let currentFile = null;
  let siblingFiles = [];   // 同目录受支持文件列表（按文件名自然排序，全路径）
  let siblingIndex = -1;   // 当前文件在 siblingFiles 中的下标（-1 表示不在列表中）
  /** 缓存源模板：已加载 html 文件的 <head> 内部 HTML（已剥离 script/on*） */
  let loadedHead = "";
  /** 已加载文件的标题 */
  let loadedTitle = "";
  /** Markdown 序列化器（懒初始化） */
  let turndownService = null;
  /** 图片对话框：待插入的本地图片 dataURL */
  let pendingImageDataUrl = null;
  /** 当前页面缩放比例（0.5–2.0） */
  let currentZoom = 1;
  /** 是否处于源码视图（单视图：仅源码文本框） */
  let sourceMode = false;
  /** 是否处于源码分栏模式（左渲染 / 右源码，双向同步） */
  let splitMode = false;
  /** 源码栏（source-view）是否自动换行；false 时长行不换行、可横向滚动 */
  let softWrap = true;

  /* =====================================================================
   * 工具函数：HTML 转义、URL 安全校验、时间戳
   * ===================================================================== */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value)
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** 链接地址安全校验（scheme 白名单） */
  function isSafeLink(url) {
    const raw = String(url).trim();
    if (/^(\/|\.\/|\.\.\/)/.test(raw)) return true;   // 相对路径
    if (/^(https?:|mailto:)/i.test(raw)) return true; // http(s) / mailto
    return false;
  }

  /** 图片地址安全校验（scheme 白名单 + 受限 MIME） */
  function isSafeImage(url) {
    const raw = String(url).trim();
    if (/^(\/|\.\/|\.\.\/)/.test(raw)) return true;
    if (/^https?:/i.test(raw)) return true;
    if (/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(raw)) return true;
    return false;
  }

  function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    );
  }

  /* =====================================================================
   * Tauri 封装：弹窗确认 / 提示（优先用 dialog 插件，回退原生）
   * ===================================================================== */
  function uiConfirm(msg) {
    if (TAURI && TAURI.dialog && TAURI.dialog.ask) {
      return TAURI.dialog.ask(msg, { title: "确认" });
    }
    return Promise.resolve(window.confirm(msg));
  }
  function uiAlert(msg) {
    if (TAURI && TAURI.dialog && TAURI.dialog.message) {
      return TAURI.dialog.message(msg, { title: "提示" });
    }
    window.alert(msg);
    return Promise.resolve();
  }

  /* =====================================================================
   * 选区与光标工具
   * ===================================================================== */
  function getCaretOffset() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0).cloneRange();
    const pre = range.cloneRange();
    pre.selectNodeContents(editor);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }

  function setCaretOffset(offset) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let charIndex = 0;
    let target = null;
    let targetOffset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (charIndex + len >= offset) {
        target = node;
        targetOffset = offset - charIndex;
        break;
      }
      charIndex += len;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    if (target) {
      range.setStart(target, Math.min(targetOffset, target.textContent.length));
      range.collapse(true);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    sel.addRange(range);
  }

  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  /* =====================================================================
   * 历史栈：快照、提交、合并、撤销/重做
   * ===================================================================== */
  function takeSnapshot() {
    return { html: editor.innerHTML, caret: getCaretOffset() };
  }

  function commitHistory() {
    const snapshot = takeSnapshot();
    const current = history[historyIndex];
    if (current && current.html === snapshot.html) {
      current.caret = snapshot.caret;
      return;
    }
    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1);
    }
    history.push(snapshot);
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
    if (snapshot.html.length > SNAPSHOT_SIZE_WARN && history.length > LARGE_MODE_KEEP) {
      history = history.slice(history.length - LARGE_MODE_KEEP);
    }
    historyIndex = history.length - 1;
  }

  function recordInput() {
    const now = Date.now();
    if (lastWasCommand) {
      commitHistory();
      lastWasCommand = false;
    } else if (historyIndex >= 0 && now - lastChangeTs < COALESCE_MS) {
      history[historyIndex] = takeSnapshot();
    } else {
      commitHistory();
    }
    lastChangeTs = now;
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreSnapshot(history[historyIndex]);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreSnapshot(history[historyIndex]);
  }

  function restoreSnapshot(snapshot) {
    suppressInput = true;
    editor.innerHTML = snapshot.html;
    setCaretOffset(snapshot.caret);
    lastWasCommand = true;
    updatePlaceholder();
    scheduleAutosave();
    setTimeout(function () { suppressInput = false; }, 0);
  }

  /* =====================================================================
   * 占位提示
   * ===================================================================== */
  function isEditorEmpty() {
    const text = editor.textContent.replace(/ /g, "").trim();
    const hasBlock = editor.querySelector(
      "img, table, hr, pre, blockquote, ul, ol"
    );
    return text === "" && !hasBlock;
  }

  function updatePlaceholder() {
    if (document.activeElement === editor) {
      editor.classList.remove("is-empty");
    } else {
      editor.classList.toggle("is-empty", isEditorEmpty());
    }
  }

  /* =====================================================================
   * 格式化命令封装
   * ===================================================================== */
  function runCommand(command, value) {
    editor.focus();
    const before = editor.innerHTML;
    suppressInput = true;
    document.execCommand(command, false, value);
    if (editor.innerHTML !== before) {
      commitHistory();
    }
    lastWasCommand = true;
    updatePlaceholder();
    updateToolbarState();
    setTimeout(function () { suppressInput = false; }, 0);
  }

  function formatCommand(command, value) {
    runCommand(command, value);
  }

  function toggleBlock(tag) {
    editor.focus();
    const current = getCurrentBlockTag();
    const target = current === tag ? "P" : tag;
    runCommand("formatBlock", "<" + target + ">");
  }

  function getCurrentBlockTag() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    let node =
      sel.anchorNode.nodeType === Node.TEXT_NODE
        ? sel.anchorNode.parentElement
        : sel.anchorNode;
    while (node && node !== editor) {
      if (node.matches("H1,H2,H3,H4,H5,H6,P,BLOCKQUOTE,LI")) {
        return node.tagName;
      }
      node = node.parentElement;
    }
    return null;
  }

  function insertHTML(html) {
    runCommand("insertHTML", html);
  }

  function insertImage(src) {
    insertHTML('<img src="' + escapeAttr(src) + '" alt="">');
  }

  /* =====================================================================
   * 工具栏按钮高亮状态
   * ===================================================================== */
  function updateToolbarState() {
    if (!editor.contains(window.getSelection().anchorNode)) return;
    const setActive = (sel, on) => {
      const btn = toolbar.querySelector(sel);
      if (btn) btn.classList.toggle("active", on);
    };
    setActive('[data-cmd="bold"]', document.queryCommandState("bold"));
    setActive('[data-cmd="italic"]', document.queryCommandState("italic"));
    setActive('[data-cmd="underline"]', document.queryCommandState("underline"));
    setActive('[data-cmd="insertUnorderedList"]', document.queryCommandState("insertUnorderedList"));
    setActive('[data-cmd="insertOrderedList"]', document.queryCommandState("insertOrderedList"));
    const block = getCurrentBlockTag();
    toolbar.querySelectorAll("[data-block]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.block === block);
    });
  }

  /* =====================================================================
   * 对话框：链接 / 图片
   * ===================================================================== */
  const linkDialog = document.getElementById("link-dialog");
  const linkUrlInput = document.getElementById("link-url");
  const imageDialog = document.getElementById("image-dialog");
  const imagePickBtn = document.getElementById("image-pick");
  const imageUrlInput = document.getElementById("image-url");

  function openModal(modal) { modal.classList.remove("hidden"); }
  function closeModal(modal) { modal.classList.add("hidden"); }

  function handleLink() {
    saveSelection();
    const sel = window.getSelection();
    const anchor =
      sel.anchorNode && sel.anchorNode.parentElement
        ? sel.anchorNode.parentElement.closest("a")
        : null;
    linkUrlInput.value = anchor ? anchor.getAttribute("href") || "" : "";
    openModal(linkDialog);
    linkUrlInput.focus();
  }

  document.getElementById("link-ok").addEventListener("click", function () {
    const url = linkUrlInput.value.trim();
    closeModal(linkDialog);
    if (!url) return;
    if (!isSafeLink(url)) {
      uiAlert("不支持的链接协议，已阻止 javascript: 等危险链接。");
      return;
    }
    editor.focus();
    restoreSelection();
    const sel = window.getSelection();
    const anchor =
      sel.anchorNode && sel.anchorNode.parentElement
        ? sel.anchorNode.parentElement.closest("a")
        : null;
    if (anchor) {
      suppressInput = true;
      anchor.setAttribute("href", url);
      if (!anchor.getAttribute("target")) anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      commitHistory();
      lastWasCommand = true;
      setTimeout(function () { suppressInput = false; }, 0);
    } else if (sel && !sel.isCollapsed) {
      const before = editor.innerHTML;
      suppressInput = true;
      document.execCommand("createLink", false, escapeAttr(url));
      editor.querySelectorAll('a[href="' + escapeAttr(url) + '"]').forEach((a) => {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      });
      if (editor.innerHTML !== before) commitHistory();
      lastWasCommand = true;
      setTimeout(function () { suppressInput = false; }, 0);
    } else {
      insertHTML(
        '<a href="' + escapeAttr(url) +
          '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(url) + "</a>&nbsp;"
      );
    }
    updatePlaceholder();
  });

  function handleImage() {
    saveSelection();
    imageUrlInput.value = "";
    pendingImageDataUrl = null;
    imagePickBtn.textContent = "选择本地图片…";
    openModal(imageDialog);
  }

  // 本地图片选择（Tauri 对话框 + Rust base64 读取）
  imagePickBtn.addEventListener("click", async function () {
    if (!TAURI) {
      uiAlert("当前环境不支持选择本地图片，请填写图片 URL。");
      return;
    }
    let p;
    try {
      p = await tauriOpen({
        multiple: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
    } catch (e) {
      return;
    }
    if (!p) return;
    try {
      const img = await tauriInvoke("read_image_base64", { path: p });
      pendingImageDataUrl = "data:" + img.mime + ";base64," + img.data;
      imagePickBtn.textContent = "已选择：" + p.split(/[\\/]/).pop();
    } catch (e) {
      uiAlert("读取图片失败：" + e);
    }
  });

  document.getElementById("image-ok").addEventListener("click", function () {
    const url = imageUrlInput.value.trim();
    closeModal(imageDialog);
    if (pendingImageDataUrl) {
      if (!isSafeImage(pendingImageDataUrl)) {
        uiAlert("仅支持 png/jpeg/gif/webp/bmp 图片。");
        pendingImageDataUrl = null;
        imagePickBtn.textContent = "选择本地图片…";
        return;
      }
      insertImage(pendingImageDataUrl);
      pendingImageDataUrl = null;
      imagePickBtn.textContent = "选择本地图片…";
    } else if (url) {
      if (!isSafeImage(url)) {
        uiAlert("图片地址需以 http(s):// 或受限的 data:image 开头，或使用本地上传。");
        return;
      }
      editor.focus();
      restoreSelection();
      insertImage(url);
    } else {
      uiAlert("请选择本地图片或填写图片 URL。");
    }
  });

  /* =====================================================================
   * 视频嵌入：本地视频转 base64 / 外链直链或嵌入页
   * ===================================================================== */
  const videoDialog = document.getElementById("video-dialog");
  const videoPickBtn = document.getElementById("video-pick");
  const videoUrlInput = document.getElementById("video-url");
  let pendingVideoDataUrl = null;

  function handleVideo() {
    saveSelection();
    videoUrlInput.value = "";
    pendingVideoDataUrl = null;
    videoPickBtn.textContent = "选择本地视频…";
    openModal(videoDialog);
  }

  videoPickBtn.addEventListener("click", async function () {
    if (!TAURI) {
      uiAlert("当前环境不支持选择本地视频，请填写视频链接。");
      return;
    }
    let p;
    try {
      p = await tauriOpen({
        multiple: false,
        filters: [{ name: "视频", extensions: ["mp4", "webm", "ogg", "ogv", "mov", "avi"] }],
      });
    } catch (e) { return; }
    if (!p) return;
    try {
      const v = await tauriInvoke("read_image_base64", { path: p });
      pendingVideoDataUrl = "data:" + v.mime + ";base64," + v.data;
      videoPickBtn.textContent = "已选择：" + p.split(/[\\/]/).pop();
    } catch (e) { uiAlert("读取视频失败：" + e); }
  });

  document.getElementById("video-ok").addEventListener("click", function () {
    const url = videoUrlInput.value.trim();
    closeModal(videoDialog);
    if (pendingVideoDataUrl) {
      if (!/^data:video\//i.test(pendingVideoDataUrl)) {
        uiAlert("仅支持常见视频格式。");
        pendingVideoDataUrl = null;
        videoPickBtn.textContent = "选择本地视频…";
        return;
      }
      insertVideo(pendingVideoDataUrl, true);
      pendingVideoDataUrl = null;
      videoPickBtn.textContent = "选择本地视频…";
    } else if (url) {
      if (!/^https?:/i.test(url)) {
        uiAlert("视频地址需以 http(s):// 开头，或使用本地上传。");
        return;
      }
      insertVideo(url, false);
    } else {
      uiAlert("请选择本地图片或填写视频链接。");
    }
  });

  function insertVideo(url, isData) {
    let html;
    if (isData) {
      html = '<video controls src="' + escapeAttr(url) + '"></video>';
    } else if (/\.(mp4|webm|ogg|ogv|mov|avi)(\?|#|$)/i.test(url)) {
      html = '<video controls src="' + escapeAttr(url) + '"></video>';
    } else {
      html = '<iframe src="' + escapeAttr(url) +
        '" width="640" height="360" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>';
    }
    insertHTML(html);
  }

  // 取消按钮：关闭其所在的 modal（用 closest 而非写死，避免漏掉 video / toolbar-settings 等弹窗）
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", function () {
      const modal = btn.closest(".modal");
      if (modal) closeModal(modal);
    });
  });

  [linkDialog, imageDialog, videoDialog, toolbarSettingsModal].forEach((modal) => {
    if (!modal) return;
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeModal(modal);
    });
  });

  /* =====================================================================
   * 媒体插入：表格 / 代码块 / 分割线
   * ===================================================================== */
  function buildTable(rows, cols) {
    let html = '<table><tbody>';
    for (let r = 0; r < rows; r++) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) {
        html += "<td>&nbsp;</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  function insertTable() { insertHTML(buildTable(3, 3)); }
  function insertCodeBlock() { insertHTML('<pre><code>// 在此输入代码\n</code></pre>'); }
  function insertHr() { insertHTML("<hr>"); }

  /* =====================================================================
   * 表情输入（HTML / Markdown 工具栏）
   * ===================================================================== */
  const EMOJIS = [
    { e: "😀", k: "smile grin happy 笑" }, { e: "😁", k: "grin 大笑" }, { e: "😂", k: "joy lol 笑哭" },
    { e: "🤣", k: "rofl 笑翻" }, { e: "😊", k: "blush smile 微笑" }, { e: "😍", k: "heart eyes 爱" },
    { e: "😘", k: "kiss 飞吻" }, { e: "😎", k: "cool sunglasses 酷" }, { e: "🤔", k: "think 思考" },
    { e: "😅", k: "sweat 尴尬" }, { e: "😉", k: "wink 眨眼" }, { e: "🙂", k: "slight smile" },
    { e: "🙃", k: "upside down 倒脸" }, { e: "😴", k: "sleep 睡" }, { e: "😇", k: "angel 天使" },
    { e: "🥳", k: "party 庆祝" }, { e: "😢", k: "cry 哭" }, { e: "😭", k: "sob 大哭" },
    { e: "😡", k: "angry 生气" }, { e: "🤯", k: "mind blown 震惊" }, { e: "😱", k: "scream 尖叫" },
    { e: "🤗", k: "hug 拥抱" }, { e: "🤝", k: "handshake 握手" }, { e: "👍", k: "thumbs up 赞 好" },
    { e: "👎", k: "thumbs down 踩" }, { e: "👏", k: "clap 鼓掌" }, { e: "🙌", k: "raised hands 欢呼" },
    { e: "💪", k: "muscle 加油 强" }, { e: "🙏", k: "pray 拜托 谢谢" }, { e: "👌", k: "ok 好" },
    { e: "✌️", k: "victory peace 耶" }, { e: "🤞", k: "fingers crossed 好运" }, { e: "👋", k: "wave 你好 拜拜" },
    { e: "❤️", k: "heart 红心 爱" }, { e: "🧡", k: "orange heart" }, { e: "💛", k: "yellow heart" },
    { e: "💚", k: "green heart" }, { e: "💙", k: "blue heart" }, { e: "💜", k: "purple heart" },
    { e: "🖤", k: "black heart" }, { e: "💔", k: "broken heart" }, { e: "💯", k: "hundred 满分" },
    { e: "⭐", k: "star 星" }, { e: "🌟", k: "glowing star" }, { e: "✨", k: "sparkles 闪" },
    { e: "🔥", k: "fire 火 热" }, { e: "🌈", k: "rainbow 彩虹" }, { e: "☀️", k: "sun 太阳" },
    { e: "🌙", k: "moon 月亮" }, { e: "⚡", k: "lightning 闪电" }, { e: "❄️", k: "snow 雪" },
    { e: "🌸", k: "blossom 花" }, { e: "🌹", k: "rose 玫瑰" }, { e: "🍀", k: "clover 幸运" },
    { e: "🎉", k: "tada 庆祝" }, { e: "🎊", k: "confetti 庆祝" }, { e: "🎁", k: "gift 礼物" },
    { e: "🏆", k: "trophy 奖杯" }, { e: "💡", k: "bulb 想法 提示" }, { e: "📌", k: "pin 钉" },
    { e: "✅", k: "check 完成 对" }, { e: "❌", k: "cross 错 否" }, { e: "⚠️", k: "warning 警告" },
    { e: "❓", k: "question 问" }, { e: "❗", k: "exclamation 感叹" }, { e: "💬", k: "speech 评论" },
    { e: "📝", k: "memo 笔记 写" }, { e: "📌", k: "pushpin 标记" }, { e: "🔔", k: "bell 通知" },
    { e: "💰", k: "money 钱" }, { e: "💡", k: "idea 想法" }, { e: "🚀", k: "rocket 火箭 快" },
    { e: "⏰", k: "alarm 闹钟 时间" }, { e: "📅", k: "calendar 日历" }, { e: "🔍", k: "search 搜索" },
    { e: "💻", k: "laptop 电脑" }, { e: "📱", k: "phone 手机" }, { e: "📖", k: "book 书 读" },
    { e: "🍎", k: "apple 苹果" }, { e: "☕", k: "coffee 咖啡" }, { e: "🍺", k: "beer 啤酒" },
    { e: "🏠", k: "home 家" }, { e: "🌍", k: "earth 地球 全球" }, { e: "👀", k: "eyes 看" },
    { e: "🐱", k: "cat 猫" }, { e: "🐶", k: "dog 狗" }, { e: "🐰", k: "rabbit 兔" }, { e: "🐼", k: "panda 熊猫" },
  ];
  const emojiDialog = document.getElementById("emoji-dialog");

  function openEmojiDialog() {
    const grid = document.getElementById("emoji-grid");
    if (grid && !grid.dataset.built) { buildEmojiGrid(grid); grid.dataset.built = "1"; }
    if (emojiDialog) openModal(emojiDialog);
    const search = document.getElementById("emoji-search");
    if (search) { search.value = ""; filterEmoji(""); search.focus(); }
  }
  function buildEmojiGrid(grid) {
    EMOJIS.forEach(function (item) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "emoji-cell";
      s.textContent = item.e;
      s.dataset.k = item.k;
      s.title = item.k;
      s.addEventListener("click", function () {
        insertEmoji(item.e);
        if (emojiDialog) closeModal(emojiDialog);
      });
      grid.appendChild(s);
    });
  }
  function filterEmoji(q) {
    const grid = document.getElementById("emoji-grid");
    if (!grid) return;
    q = (q || "").trim().toLowerCase();
    grid.querySelectorAll(".emoji-cell").forEach(function (c) {
      const hit = !q || (c.dataset.k || "").toLowerCase().indexOf(q) >= 0 || c.textContent.indexOf(q) >= 0;
      c.style.display = hit ? "" : "none";
    });
  }
  function insertEmoji(ch) {
    if (sourceMode) insertAtCaretSource(ch);
    else insertAtCaretEditor(ch);
  }
  function insertAtCaretEditor(text) {
    editor.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      document.execCommand("insertText", false, text);
    }
    commitHistory();
    updatePlaceholder();
    scheduleAutosave();
  }
  function insertAtCaretSource(text) {
    const s = sourceView.selectionStart || 0;
    const e = sourceView.selectionEnd || 0;
    const v = sourceView.value;
    sourceView.value = v.slice(0, s) + text + v.slice(e);
    const pos = s + text.length;
    sourceView.selectionStart = sourceView.selectionEnd = pos;
    scheduleAutosave();
    scheduleHighlight();
  }
  const emojiSearch = document.getElementById("emoji-search");
  if (emojiSearch) emojiSearch.addEventListener("input", function () { filterEmoji(emojiSearch.value); });

  /* =====================================================================
   * 导出与自动保存
   * ===================================================================== */
  function buildExportDocument() {
    const content = editor.innerHTML;
    return (
      '<!DOCTYPE html>\n' +
      '<html lang="zh-CN">\n' +
      "<head>\n" +
      '<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      "<title>导出文档</title>\n" +
      "<style>\n" +
      "  body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto," +
      "\"Helvetica Neue\",Arial,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;" +
      "line-height:1.7;color:#1f2937;max-width:800px;margin:40px auto;padding:0 20px;}\n" +
      "  h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.2em 0 .6em;}\n" +
      "  h1{font-size:2em;} h2{font-size:1.6em;} h3{font-size:1.3em;} h4{font-size:1.1em;}\n" +
      "  p{margin:.6em 0;}\n" +
      "  a{color:#2563eb;}\n" +
      "  blockquote{border-left:4px solid #d1d5db;margin:1em 0;padding:.4em 1em;" +
      "color:#4b5563;background:#f9fafb;}\n" +
      "  code{background:#f3f4f6;padding:.15em .4em;border-radius:4px;" +
      "font-family:Consolas,Menlo,monospace;font-size:.9em;}\n" +
      "  pre{background:#f3f4f6;padding:12px;border-radius:6px;overflow:auto;}\n" +
      "  pre code{background:none;padding:0;}\n" +
      "  table{border-collapse:collapse;width:100%;margin:1em 0;}\n" +
      "  td,th{border:1px solid #d1d5db;padding:8px;}\n" +
      "  img{max-width:100%;height:auto;}\n" +
      "  hr{border:none;border-top:1px solid #d1d5db;margin:1.5em 0;}\n" +
      "  ul,ol{margin:.6em 0;padding-left:1.6em;}\n" +
      "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      content +
      "\n</body>\n</html>"
    );
  }

  /** 导出为自包含 HTML：在 Tauri 下走保存对话框+命令，确保真正落盘 */
  async function exportHTML() {
    const full = buildExportDocument();
    if (TAURI) {
      let path;
      try {
        path = await tauriSave({
          filters: [{ name: "HTML", extensions: ["html"] }],
        });
      } catch (e) {
        setStatus("导出失败：" + e, true);
        return;
      }
      if (!path) return;
      try {
        await tauriInvoke("save_file", { path, kind: "html", content: full });
        setStatus("已导出：" + path);
      } catch (e) {
        setStatus("导出失败：" + e, true);
      }
    } else {
      triggerDownload("document-" + fileStamp() + ".html", full, "text/html;charset=utf-8");
    }
  }

  /* =====================================================================
   * Markdown 幻灯片演示（reveal.js，离线 vendored）
   *  - 仅对 Markdown 文档可用；按「独自成行的 ---」切分幻灯片
   *  - 每页用已 vendored 的 marked 预渲染（与编辑器预览一致），再交给 reveal 播放
   *  - 非破坏性：Esc / 退出按钮返回编辑器，不改源文件
   * ===================================================================== */
  const slidesOverlay = document.getElementById("slides-overlay");
  const slidesContainer = document.getElementById("slides-container");
  let slidesReady = false;
  let lastSlideMarkdown = "";

  function splitSlides(md) {
    const lines = md.split(/\r?\n/);
    const chunks = [];
    let cur = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*---\s*$/.test(lines[i])) { chunks.push(cur.join("\n")); cur = []; }
      else cur.push(lines[i]);
    }
    chunks.push(cur.join("\n"));
    const nonEmpty = chunks.filter(function (c) { return c.trim().length; });
    return nonEmpty.length ? nonEmpty : chunks;
  }

  function buildSlideSections(md) {
    if (!slidesContainer) return;
    const slides = splitSlides(md);
    slidesContainer.innerHTML = "";
    slides.forEach(function (chunk) {
      const section = document.createElement("section");
      try { section.innerHTML = window.marked ? window.marked(chunk) : chunk; }
      catch (e) { section.textContent = chunk; }
      slidesContainer.appendChild(section);
    });
    lastSlideMarkdown = md;
  }

  function updateSlideIndicator() {
    const ind = document.getElementById("slides-indicator");
    if (!ind || !window.Reveal) return;
    const idx = window.Reveal.getIndices ? window.Reveal.getIndices() : { h: 0 };
    const total = window.Reveal.getTotalSlides ? window.Reveal.getTotalSlides() : 1;
    ind.textContent = (idx.h + 1) + " / " + total;
  }

  async function presentSlides() {
    if (!currentFile || currentFile.kind !== "markdown") {
      showToast("幻灯片演示仅适用于 Markdown 文档", true);
      return;
    }
    const md = serializeMarkdown();
    if (!md || !md.trim()) { showToast("当前文档没有可演示的内容", true); return; }
    buildSlideSections(md);
    if (slidesOverlay) slidesOverlay.classList.remove("hidden");
    if (!window.Reveal) { showToast("演示组件未能加载（reveal.js 缺失）", true); return; }
    if (!slidesReady) {
      slidesReady = true;
      requestAnimationFrame(function () {
        const r = window.Reveal;
        r.initialize({
          hash: false, controls: true, progress: true,
          slideNumber: "c/t", center: true, transition: "slide",
          keyboard: true,
        });
        r.on("slidechanged", updateSlideIndicator);
        r.on("ready", updateSlideIndicator);
        updateSlideIndicator();
      });
    } else {
      window.Reveal.sync();
      window.Reveal.slide(0, 0);
      updateSlideIndicator();
    }
  }

  function closeSlides() {
    if (slidesOverlay) slidesOverlay.classList.add("hidden");
  }

  async function exportSlides() {
    if (!currentFile || currentFile.kind !== "markdown") {
      showToast("导出幻灯片仅适用于 Markdown 文档", true);
      return;
    }
    const md = lastSlideMarkdown || serializeMarkdown();
    const slides = splitSlides(md);
    let sectionsHtml = "";
    slides.forEach(function (chunk) {
      let html;
      try { html = window.marked ? window.marked(chunk) : chunk; }
      catch (e) { html = "<pre>" + chunk.replace(/&/g, "&amp;") + "</pre>"; }
      sectionsHtml += "<section>" + html + "</section>\n";
    });
    let revealCss = "", themeCss = "", revealJs = "";
    try {
      revealCss = await (await fetch("vendor/reveal/reveal.css")).text();
      themeCss = await (await fetch("vendor/reveal/theme/white.css")).text();
      revealJs = await (await fetch("vendor/reveal/reveal.js")).text();
    } catch (e) { /* 退化：保留相对引用，用户在原程序目录打开仍可用 */ }
    const title = (currentFile && currentFile.path) ? currentFile.path.split(/[\\/]/).pop() : "slides";
    const doc =
      '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      "<title>" + title + " - 幻灯片</title>\n" +
      "<style>\n" + revealCss + "\n" + themeCss + "\n" +
      ".reveal .slides section{text-align:left}\n" +
      "</style>\n</head>\n<body>\n" +
      '<div class="reveal"><div class="slides">\n' + sectionsHtml + "</div></div>\n" +
      "<script>" + revealJs + "<\/script>\n" +
      '<script>Reveal.initialize({slideNumber:"c/t",center:true,transition:"slide",controls:true,progress:true});<\/script>\n' +
      "</body>\n</html>";
    let path;
    try {
      path = await tauriSave({ filters: [{ name: "HTML 幻灯片", extensions: ["html"] }] });
    } catch (e) { showToast("已取消导出", false); return; }
    if (!path) return;
    try {
      await tauriInvoke("save_file", { path: path, kind: "html", content: doc });
      showToast("已导出幻灯片：" + path);
    } catch (e) { showToast("导出失败：" + e, true); }
  }

  // 演示态按钮绑定（一次性）
  const slidesPrev = document.getElementById("slides-prev");
  const slidesNext = document.getElementById("slides-next");
  const slidesClose = document.getElementById("slides-close");
  const slidesExport = document.getElementById("slides-export");
  if (slidesPrev) slidesPrev.addEventListener("click", function () { if (window.Reveal) window.Reveal.prev(); });
  if (slidesNext) slidesNext.addEventListener("click", function () { if (window.Reveal) window.Reveal.next(); });
  if (slidesClose) slidesClose.addEventListener("click", closeSlides);
  if (slidesExport) slidesExport.addEventListener("click", exportSlides);
  // Esc 退出演示（捕获阶段拦截，避免 reveal 抢占）
  document.addEventListener("keydown", function (e) {
    if (slidesOverlay && !slidesOverlay.classList.contains("hidden") && e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); closeSlides();
    }
  }, true);

  async function clearDraft() {
    const ok = await uiConfirm("确定要清空当前内容吗？此操作不可撤销。");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    editor.innerHTML = "";
    history = [takeSnapshot()];
    historyIndex = 0;
    lastWasCommand = true;
    lastChangeTs = Date.now();
    updatePlaceholder();
    editor.focus();
  }

  function scheduleAutosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, editor.innerHTML);
      } catch (err) {
        console.warn("草稿保存失败：", err);
      }
    }, 500);
  }

  /* =====================================================================
   * 本地文件：打开 / 保存（Tauri invoke + dialog）
   * ===================================================================== */
  function setStatus(msg, isError) {
    const el = document.getElementById("status");
    if (el) {
      el.textContent = msg || "";
      el.classList.toggle("status-error", !!isError);
    }
    if (msg) showToast(msg, isError);
  }

  /* 主程序（HTML/Markdown 编辑器）状态栏：字数 / 词数 / 编码 / 光标位置。
   * 直接写 #status（不走 setStatus，避免每次输入都弹 Toast）。
   * PDF 模式下由 pdf.js 接管状态栏，这里直接返回。 */
  let statusTimer = null;
  function updateEditorStatus() {
    if (window.__pdfActive) return;
    const el = document.getElementById("status");
    if (!el) return;
    const enc = (encodingSelect && encodingSelect.value) || "自动";
    const text = editor && editor.innerText ? editor.innerText : "";
    const chars = text.replace(/\s/g, "").length;
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    const en = (text.match(/[A-Za-z0-9]+/g) || []).length;
    let pos = "";
    try {
      const sel = window.getSelection();
      if (sel && sel.anchorNode && editor.contains(sel.anchorNode) && typeof getCaretOffset === "function") {
        pos = "　光标 " + (getCaretOffset() + 1);
      }
    } catch (e) {}
    el.textContent = "字数 " + chars + "　词数 " + (cjk + en) + "　编码 " + (enc || "自动") + pos;
    el.classList.remove("status-error");
  }
  function scheduleStatus() {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(updateEditorStatus, 150);
  }

  /* 顶部 Toast 提示：显示后自动隐藏，可点击关闭 */
  let toastTimer = null;
  function showToast(msg, isError) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("toast-error", !!isError);
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  /* Tauri 窗口模块（v2：__TAURI__.window），用于记住窗口尺寸 */
  function tauriWindowApi() {
    if (TAURI.window && typeof TAURI.window.getCurrentWindow === "function") {
      return TAURI.window;
    }
    return null;
  }

  /** 启动时恢复上次窗口尺寸（来自同目录配置文件；最小尺寸由 tauri.conf.json 兜底） */
  async function restoreWindowSize() {
    const w = tauriWindowApi();
    if (!w) return;
    try {
      const s = appConfig.windowSize;
      if (!s || !s.w || !s.h) return;
      const win = w.getCurrentWindow();
      // 用 PhysicalSize 读写保持一致，避免高 DPI 下的单位换算误差
      await win.setSize(new w.PhysicalSize(
        Math.max(1, Math.round(s.w)),
        Math.max(1, Math.round(s.h))
      ));
    } catch (e) { /* 窗口尺寸恢复失败不致命 */ }
  }

  /** 保存当前窗口尺寸到配置文件（物理像素，与读取保持一致） */
  async function saveWindowSize() {
    const w = tauriWindowApi();
    if (!w) return;
    try {
      const win = w.getCurrentWindow();
      const size = await win.innerSize(); // 返回 PhysicalSize
      appConfig.windowSize = { w: size.width, h: size.height };
      await saveConfig();
    } catch (e) { /* 忽略 */ }
  }

  /** 监听窗口尺寸变化并防抖保存 */
  function setupWindowSizePersistence() {
    const w = tauriWindowApi();
    if (!w) return;
    try {
      const win = w.getCurrentWindow();
      let t = null;
      win.onResized(function () {
        if (t) clearTimeout(t);
        t = setTimeout(saveWindowSize, 400);
      });
    } catch (e) { /* 忽略 */ }
  }

  /** 递归移除所有 on* 事件处理属性（防 XSS） */
  function stripOnAttributes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    const toStrip = [];
    let node;
    while ((node = walker.nextNode())) {
      const attrs = node.attributes;
      for (let i = 0; i < attrs.length; i++) {
        if (/^on/i.test(attrs[i].name)) toStrip.push([node, attrs[i].name]);
      }
    }
    toStrip.forEach(function (pair) { pair[0].removeAttribute(pair[1]); });
  }

  /** 将 HTML 文本中的 <style> 注入页面，使编辑区所见即所得 */
  function injectFileStyle(head) {
    const old = document.getElementById("file-style");
    if (old) old.remove();
    if (!head) return;
    let css = "";
    head.querySelectorAll("style").forEach(function (s) { css += s.textContent + "\n"; });
    if (!css) return;
    const el = document.createElement("style");
    el.id = "file-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  /** 解析并加载 HTML 文本到编辑区（剥离 script/on*，保留样式与标题） */
  function loadHtmlDocument(text) {
    editor.contentEditable = "true";
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script").forEach(function (s) { s.remove(); });
    stripOnAttributes(doc.documentElement);
    loadedHead = doc.head ? doc.head.innerHTML : "";
    loadedTitle = doc.title || "";
    injectFileStyle(doc.head);
    if (loadedTitle) document.title = loadedTitle;
    editor.innerHTML = doc.body ? doc.body.innerHTML : "";
    history = [takeSnapshot()];
    historyIndex = 0;
    lastWasCommand = true;
    lastChangeTs = Date.now();
    updatePlaceholder();
    updateToolbarState();
    scheduleAutosave();
  }

  /** 把任意 HTML 字符串净化（去 script / on*）后返回 body 内部 HTML */
  function sanitizeHtmlString(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script").forEach(function (s) { s.remove(); });
    stripOnAttributes(doc.documentElement);
    return doc.body ? doc.body.innerHTML : "";
  }

  /** 加载 Markdown 文本：marked 渲染为 HTML 后净化注入编辑区 */
  /** 加载 SVG 文件：左侧 editor 作为只读预览，右侧 source-view 作为可编辑源码，默认进入分栏 */
  function loadSvg(svgText) {
    editor.contentEditable = "false"; // 预览只读，编辑在右侧源码区进行
    // 内联渲染（保留动画/渐变等），sanitizeHtmlString 已剔除 <script> 与 on* 属性
    editor.innerHTML = sanitizeHtmlString(svgText);
    sourceView.value = svgText;
    enterSplitMode();
    updatePlaceholder();
    updateToolbarState();
  }

  function loadMarkdown(mdText) {
    editor.contentEditable = "true";
    let html;
    try {
      const parsed = (window.marked && window.marked.parse)
        ? window.marked.parse(mdText)
        : window.marked(mdText);
      html = sanitizeHtmlString(parsed);
    } catch (e) {
      html = escapeHtml(mdText).replace(/\n/g, "<br>");
    }
    editor.innerHTML = html;
    loadedHead = "";
    loadedTitle = "";
    document.title = "墨笺";
    history = [takeSnapshot()];
    historyIndex = 0;
    lastWasCommand = true;
    lastChangeTs = Date.now();
    updatePlaceholder();
    updateToolbarState();
    scheduleAutosave();
  }

  /** 把编辑区内容序列化为 Markdown 文本（turndown） */
  function serializeMarkdown() {
    if (!window.TurndownService) return editor.innerHTML; // 退化
    if (!turndownService) {
      turndownService = new window.TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
      });
    }
    return turndownService.turndown(editor.innerHTML);
  }

  /** 拼装完整 HTML 文档（源模板 head + 当前编辑内容） */
  function buildFullDocument() {
    const head = loadedHead && loadedHead.trim()
      ? loadedHead
      : '<meta charset="UTF-8">';
    return (
      '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
      head + "\n</head>\n<body>\n" +
      editor.innerHTML + "\n</body>\n</html>"
    );
  }

  function triggerDownload(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function detectKindFromPath(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
    if (lower.endsWith(".svg")) return "svg";
    return "html";
  }

  /** 通过 Tauri 对话框选择文件并打开 */
  async function openFile() {
    if (!TAURI) { setStatus("当前环境不支持文件对话框。", true); return; }
    let selected;
    try {
      selected = await tauriOpen({
        multiple: false,
        filters: [{ name: "HTML / Markdown / PDF / SVG / EPUB", extensions: ["html", "htm", "md", "markdown", "pdf", "svg", "epub"] }],
      });
    } catch (e) {
      setStatus("打开失败：" + e, true);
      return;
    }
    if (!selected) return; // 用户取消
    await openFileWithPath(selected);
  }

  /** 按路径打开文件（供对话框与拖放共用） */
  async function openFileWithPath(path) {
    if (!TAURI) { setStatus("当前环境不支持文件读取。", true); return; }
    // PDF：交给 PDF 模块（查看 / 旋转 / 备注 / 合并 / 拆分），不走文本编辑器
    const lower = path.toLowerCase();
    if (lower.endsWith(".pdf")) {
      if (window.PDFApp) window.PDFApp.open(path);
      currentFile = { path: path, kind: "pdf" };
      refreshSiblings();
      return;
    }
    // EPUB：交给 EPUB 只读阅读视图，不走文本编辑器
    if (lower.endsWith(".epub")) {
      currentFile = { path: path, kind: "epub" };
      refreshSiblings();
      openEpub(path);
      return;
    }
    // 打开其它文档前，若正处于 PDF / EPUB 模式则先退出
    if (window.__pdfActive && window.PDFApp) window.PDFApp.close();
    if (window.__epubActive) exitEpub();
    editor.contentEditable = "true"; // SVG 模式会把 editor 置为只读，这里恢复可编辑
    let res;
    try {
      const enc = (getConfig().defaultEncoding || "") || undefined;
      res = await tauriInvoke("open_file", { path, encoding: enc });
    } catch (e) {
      setStatus("打开失败：" + e, true);
      return;
    }
    if (sourceMode) exitSourceMode();
    else if (splitMode) exitSplitMode();
    currentFile = { path: res.path, kind: res.kind };
    setFilePath(res.path, true);
    refreshSiblings();
    if (res.kind === "markdown") {
      loadMarkdown(res.content);
    } else if (res.kind === "svg") {
      loadSvg(res.content);
    } else {
      loadHtmlDocument(res.content);
    }
    setStatus("已打开：" + res.path);
  }

  /** 取路径所在的目录（兼容 / 与 \\） */
  function dirOf(p) {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? "." : p.slice(0, i);
  }

  /** 刷新同目录受支持文件列表（用于上一个 / 下一个导航）；异步，失败时给出提示 */
  async function refreshSiblings() {
    siblingFiles = [];
    siblingIndex = -1;
    if (!currentFile || !currentFile.path) { updateNavButtons(); return; }
    try {
      const list = await tauriInvoke("list_supported_files", { dir: dirOf(currentFile.path) });
      if (Array.isArray(list) && list.length) {
        // 匹配归一化：大小写不敏感（Windows 不区分）+ 分隔符统一为正斜杠（对话框返回的路径可能与 Rust 枚举的 \ 不同）
        const norm = function (p) { return p.replace(/\\/g, "/").toLowerCase(); };
        const normCur = norm(currentFile.path);
        let idx = list.findIndex(function (x) { return norm(x) === normCur; });
        if (idx < 0) {
          // 当前文件未命中（罕见），兜底把自身补进列表末尾，保证至少"上一个"可用
          siblingFiles = list.concat([currentFile.path]);
          idx = siblingFiles.length - 1;
        } else {
          siblingFiles = list;
        }
        siblingIndex = idx;
      }
    } catch (e) {
      // 命令不可用 / 目录不可读：给出可见提示，避免"按钮灰着却不知原因"
      setStatus("无法获取同目录文件列表：" + e, true);
    }
    updateNavButtons();
  }

  /* =====================================================================
   * EPUB 只读阅读视图（Level A：只预览，不编辑）
   * 复用 PDF 模块的"接管主视图"模式：显示 #epub-root、隐藏 #editor-wrap 与主 #toolbar。
   * ===================================================================== */
  let epubChapters = [];
  let epubIndex = -1;
  let epubPath = null;
  let epubFindMarks = [];   // 当前章节内查找匹配的高亮 <mark> 列表
  let epubFindIndex = -1;   // 当前激活的匹配下标

  function openEpub(path) {
    if (!TAURI) { setStatus("当前环境不支持文件读取。", true); return; }
    window.__epubActive = true;
    const ew = document.getElementById("editor-wrap");
    if (ew) ew.style.display = "none";
    const tb = document.getElementById("toolbar");
    if (tb) tb.classList.add("hidden");
    const root = document.getElementById("epub-root");
    if (root) root.classList.remove("hidden");
    setStatus("正在解析 EPUB…");
    tauriInvoke("open_epub", { path })
      .then(function (meta) {
        epubChapters = meta.chapters || [];
        epubPath = path;
        const toc = document.getElementById("epub-toc");
        if (toc) {
          toc.innerHTML = "";
          epubChapters.forEach(function (ch, i) {
            const item = document.createElement("div");
            item.className = "epub-toc-item";
            item.textContent = ch.title;
            item.addEventListener("click", function () { renderEpubChapter(i); });
            toc.appendChild(item);
          });
        }
        if (!epubChapters.length) {
          setStatus("该 EPUB 没有可阅读的章节。", true);
          exitEpub();
          return;
        }
        renderEpubChapter(0);
      })
      .catch(function (e) {
        setStatus("打开 EPUB 失败：" + e, true);
        exitEpub();
      });
  }

  function renderEpubChapter(i) {
    if (i < 0 || i >= epubChapters.length) return;
    epubIndex = i;
    const ch = epubChapters[i];
    // 切换章节时重置查找状态（内容将被整体替换）
    epubFindMarks = [];
    epubFindIndex = -1;
    const fcount = document.getElementById("epub-find-count");
    if (fcount) fcount.textContent = "";
    const titleEl = document.getElementById("epub-title");
    if (titleEl) titleEl.textContent = ch.title;
    const content = document.getElementById("epub-content");
    if (content) content.innerHTML = "<p style='padding:24px;color:var(--color-muted)'>正在加载章节…</p>";
    // 目录高亮当前章
    const tocItems = document.querySelectorAll("#epub-toc .epub-toc-item");
    tocItems.forEach(function (el, idx) { el.classList.toggle("active", idx === i); });
    // 首尾禁用翻页按钮
    const prev = document.getElementById("epub-prev");
    const next = document.getElementById("epub-next");
    if (prev) prev.disabled = (i === 0);
    if (next) next.disabled = (i === epubChapters.length - 1);
    tauriInvoke("get_epub_chapter", { path: epubPath, href: ch.href })
      .then(function (res) {
        if (content) {
          content.innerHTML = res.html || "";
          content.scrollTop = 0;
        }
      })
      .catch(function (e) {
        if (content) content.innerHTML = "<p style='padding:24px;color:#c0392b'>章节加载失败：" + e + "</p>";
      });
  }

  function exitEpub() {
    window.__epubActive = false;
    const root = document.getElementById("epub-root");
    if (root) root.classList.add("hidden");
    const ew = document.getElementById("editor-wrap");
    if (ew) ew.style.display = "";
    const tb = document.getElementById("toolbar");
    if (tb) tb.classList.remove("hidden");
    epubChapters = [];
    epubIndex = -1;
    epubPath = null;
    epubFindMarks = [];
    epubFindIndex = -1;
    const fb = document.getElementById("epub-find-bar");
    if (fb) fb.classList.add("hidden");
  }

  function bindEpubControls() {
    const prev = document.getElementById("epub-prev");
    const next = document.getElementById("epub-next");
    const tocToggle = document.getElementById("epub-toc-toggle");
    const close = document.getElementById("epub-close");
    const toc = document.getElementById("epub-toc");
    if (prev) prev.addEventListener("click", function () { if (epubIndex > 0) renderEpubChapter(epubIndex - 1); });
    if (next) next.addEventListener("click", function () { if (epubIndex < epubChapters.length - 1) renderEpubChapter(epubIndex + 1); });
    if (tocToggle && toc) tocToggle.addEventListener("click", function () { toc.classList.toggle("hidden"); });
    if (close) close.addEventListener("click", exitEpub);
    // 查找功能（当前章节内）
    const findToggle = document.getElementById("epub-find-toggle");
    const findBar = document.getElementById("epub-find-bar");
    const findInput = document.getElementById("epub-find-input");
    const findPrev = document.getElementById("epub-find-prev");
    const findNext = document.getElementById("epub-find-next");
    const findClose = document.getElementById("epub-find-close");
    const findCase = document.getElementById("epub-find-case");
    if (findToggle && findBar) findToggle.addEventListener("click", function () {
      findBar.classList.toggle("hidden");
      if (!findBar.classList.contains("hidden") && findInput) findInput.focus();
    });
    if (findInput) {
      findInput.addEventListener("input", runEpubFind);
      findInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); epubFindGo(e.shiftKey ? -1 : 1); }
      });
    }
    if (findCase) findCase.addEventListener("change", runEpubFind);
    if (findPrev) findPrev.addEventListener("click", function () { epubFindGo(-1); });
    if (findNext) findNext.addEventListener("click", function () { epubFindGo(1); });
    if (findClose) findClose.addEventListener("click", function () {
      if (findBar) findBar.classList.add("hidden");
      clearEpubFind();
      const fc = document.getElementById("epub-find-count");
      if (fc) fc.textContent = "";
    });
  }

  /* ---------- EPUB 查找（当前章节内，纯前端高亮 + 导航） ---------- */
  function clearEpubFind() {
    const content = document.getElementById("epub-content");
    if (content) {
      const marks = content.querySelectorAll("mark");
      marks.forEach(function (m) {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
      });
    }
    epubFindMarks = [];
    epubFindIndex = -1;
  }

  function runEpubFind() {
    const content = document.getElementById("epub-content");
    const input = document.getElementById("epub-find-input");
    const countEl = document.getElementById("epub-find-count");
    if (!content || !input) return;
    clearEpubFind();
    const q = input.value;
    if (!q) { if (countEl) countEl.textContent = ""; return; }
    const caseSensitive = !!(document.getElementById("epub-find-case") &&
      document.getElementById("epub-find-case").checked);
    let re;
    try {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(esc, caseSensitive ? "g" : "gi");
    } catch (e) { if (countEl) countEl.textContent = "无效"; return; }
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      const p = node.parentNode;
      if (p && (p.tagName === "STYLE" || p.tagName === "SCRIPT")) continue;
      if (!node.nodeValue || node.nodeValue.length === 0) continue;
      if (!re.test(node.nodeValue)) continue;
      textNodes.push(node);
    }
    textNodes.forEach(function (tn) {
      const text = tn.nodeValue;
      re.lastIndex = 0;
      const ranges = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        ranges.push([m.index, m.index + m[0].length]);
      }
      // 从后往前包裹，避免索引偏移
      for (let k = ranges.length - 1; k >= 0; k--) {
        const start = ranges[k][0], end = ranges[k][1];
        const r = document.createRange();
        r.setStart(tn, start);
        r.setEnd(tn, end);
        const mark = document.createElement("mark");
        try { r.surroundContents(mark); epubFindMarks.push(mark); } catch (e) { /* 忽略跨节点异常 */ }
      }
    });
    epubFindIndex = epubFindMarks.length ? 0 : -1;
    highlightEpubFind();
  }

  function highlightEpubFind() {
    epubFindMarks.forEach(function (mk, i) { mk.classList.toggle("current", i === epubFindIndex); });
    const cur = epubFindMarks[epubFindIndex];
    const countEl = document.getElementById("epub-find-count");
    if (countEl) countEl.textContent = epubFindMarks.length
      ? ((epubFindIndex + 1) + "/" + epubFindMarks.length) : "0";
    if (cur) cur.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function epubFindGo(delta) {
    if (!epubFindMarks.length) return;
    epubFindIndex = (epubFindIndex + delta + epubFindMarks.length) % epubFindMarks.length;
    highlightEpubFind();
  }

  /** 切换上一个 / 下一个文件（delta = -1 / +1）；到头即停，不循环 */
  function goSibling(delta) {
    if (!siblingFiles.length || siblingIndex < 0) return;
    const ni = siblingIndex + delta;
    if (ni < 0 || ni >= siblingFiles.length) return;
    openFileWithPath(siblingFiles[ni]);
  }

  /** 根据当前导航状态启用 / 禁用两个按钮 */
  function updateNavButtons() {
    if (!toolbar) return;
    const prev = toolbar.querySelector('[data-action="prevfile"]');
    const next = toolbar.querySelector('[data-action="nextfile"]');
    const enabled = siblingFiles.length > 1;
    if (prev) prev.disabled = !(enabled && siblingIndex > 0);
    if (next) next.disabled = !(enabled && siblingIndex >= 0 && siblingIndex < siblingFiles.length - 1);
  }

  /** 保存当前内容到指定路径（按类型决定序列化方式） */
  async function saveFileWithContent(path, kind) {
    let content;
    if (kind === "markdown") {
      content = serializeMarkdown();
    } else if (kind === "svg") {
      content = sourceView.value; // SVG 源码即真相
    } else {
      content = buildFullDocument();
    }
    try {
      const enc = (getConfig().defaultEncoding || "") || undefined;
      await tauriInvoke("save_file", { path, kind, content, encoding: enc });
      setStatus("已保存：" + path);
    } catch (e) {
      setStatus("保存失败：" + e, true);
    }
  }

  /** 保存：有打开的文件则写回，否则走"另存为" */
  async function saveFile() {
    // PDF 模式下，保存走 PDF 模块（写回旋转 / 备注）
    if (window.__pdfActive && window.PDFApp) { window.PDFApp.save(); return; }
    if (sourceMode) applySourceToEditor();
    if (currentFile) {
      await saveFileWithContent(currentFile.path, currentFile.kind);
    } else {
      await saveFileAs();
    }
  }

  /** 另存为：弹出保存对话框，按后缀决定类型 */
  async function saveFileAs() {
    // PDF 模式下，另存为走 PDF 模块（把旋转/备注/水印/签章一并烤进新文件）
    if (window.__pdfActive && window.PDFApp && window.PDFApp.saveAs) { window.PDFApp.saveAs(); return; }
    if (!TAURI) { setStatus("当前环境不支持保存对话框。", true); return; }
    let path;
    try {
      path = await tauriSave({
        filters: [
          { name: "HTML", extensions: ["html"] },
          { name: "Markdown", extensions: ["md"] },
          { name: "SVG", extensions: ["svg"] },
        ],
      });
    } catch (e) {
      setStatus("保存失败：" + e, true);
      return;
    }
    if (!path) return;
    const kind = detectKindFromPath(path);
    currentFile = { path, kind };
    // 同步首屏路径指示与"打开位置"按钮（否则另存为之后仍显示"未打开文件"且按钮灰掉）
    setFilePath(path, true);
    try {
      const name = path.split(/[\\/]/).pop() || path;
      document.title = name + " · 墨笺";
    } catch (e) {}
    await saveFileWithContent(path, kind);
  }

  /** 监听窗口拖放（Tauri dragDropEnabled + tauri://drag-drop 事件） */
  async function setupDragDrop() {
    if (!TAURI) return;
    try {
      await tauriListen("tauri://drag-drop", function (event) {
        const paths = (event && event.payload && event.payload.paths) || [];
        if (!paths.length) return;
        openFileWithPath(paths[0]).then(function () {
          if (paths.length > 1) {
            setStatus("已打开：" + paths[0] + "（一次仅加载一个文件）");
          }
        });
      });
    } catch (e) {
      // 拖放监听失败不致命
    }
  }

  /* =====================================================================
   * 缩放（页面 Zoom）：优先走 Tauri webview.setZoom，否则 CSS zoom 兜底
   * ===================================================================== */
  function clampZoom(v) { return Math.min(2, Math.max(0.5, v)); }

  function applyZoom(scale, persist) {
    currentZoom = clampZoom(scale);
    // 仅缩放编辑区"白底画布"的内容（.editor 与 .source-view 元素级 zoom），
    // 工具栏、按钮等界面控件保持原尺寸不变。Chromium / WebView2 支持元素级 zoom。
    if (editor) editor.style.zoom = String(currentZoom);
    const sv = document.getElementById("source-view");
    if (sv) sv.style.zoom = String(currentZoom);
    const zl = document.getElementById("zoom-label");
    if (zl) zl.textContent = Math.round(currentZoom * 100) + "%";
    if (persist !== false) {
      try { localStorage.setItem("editorZoom", String(currentZoom)); } catch (e) {}
    }
  }

  function zoomIn() { applyZoom(currentZoom + 0.1); }
  function zoomOut() { applyZoom(currentZoom - 0.1); }

  /* =====================================================================
   * 源码视图切换
   * ===================================================================== */
  function applySourceToEditor() {
    if (!sourceMode) return;
    const src = sourceView.value;
    if (currentFile && currentFile.kind === "markdown") {
      loadMarkdown(src);
    } else {
      editor.innerHTML = sanitizeHtmlString(src);
      history = [takeSnapshot()];
      historyIndex = 0;
      lastWasCommand = true;
      lastChangeTs = Date.now();
      updatePlaceholder();
      updateToolbarState();
    }
  }

  /** 同步源码/分栏按钮高亮态 */
  function setSourceBtnActive() {
    const srcBtn = toolbar.querySelector('[data-action="source"]');
    if (srcBtn) srcBtn.classList.toggle("active", sourceMode || splitMode);
    const spBtn = toolbar.querySelector('[data-action="split"]');
    if (spBtn) spBtn.classList.toggle("active", splitMode);
  }

  function enterSourceMode() {
    if (splitMode) exitSplitMode();
    if (sourceMode) return;
    let src;
    if (currentFile && currentFile.kind === "markdown") {
      src = serializeMarkdown();
    } else if (currentFile && currentFile.kind === "svg") {
      src = sourceView.value; // SVG 下右侧源码才是真相，不要被渲染 DOM 覆盖
    } else {
      src = editor.innerHTML;
    }
    sourceView.value = src;
    editor.style.display = "none";
    sourceView.style.display = "block";
    sourceMode = true;
    toolbar.classList.add("source-mode");
    setSourceBtnActive();
    sourceView.focus();
    highlightSource();
  }

  function exitSourceMode() {
    if (!sourceMode) return;
    applySourceToEditor();
    sourceView.style.display = "none";
    editor.style.display = "";
    sourceMode = false;
    toolbar.classList.remove("source-mode");
    setSourceBtnActive();
    editor.focus();
  }

  /** 进入分栏：左渲染区 + 右源码并排显示，双向防抖同步 */
  function enterSplitMode() {
    if (splitMode) return;
    if (sourceMode) exitSourceMode();
    let src;
    if (currentFile && currentFile.kind === "markdown") src = serializeMarkdown();
    else if (currentFile && currentFile.kind === "svg") src = sourceView.value;
    else src = editor.innerHTML;
    sourceView.value = src;
    editor.style.display = "";
    sourceView.style.display = "block";
    if (editorWrap) editorWrap.classList.add("split");
    toolbar.classList.add("split");
    splitMode = true;
    setSourceBtnActive();
    highlightSource();
    saveConfig({ sourceSplit: true });
  }

  /** 退出分栏（回到单视图可视化） */
  function exitSplitMode() {
    if (!splitMode) return;
    if (editorWrap) editorWrap.classList.remove("split");
    toolbar.classList.remove("split");
    sourceView.style.display = "none";
    splitMode = false;
    setSourceBtnActive();
    saveConfig({ sourceSplit: false });
  }

  function toggleSplitMode() {
    if (splitMode) exitSplitMode();
    else enterSplitMode();
  }

  function toggleSourceMode() {
    if (splitMode) { exitSplitMode(); enterSourceMode(); return; }
    if (sourceMode) exitSourceMode();
    else enterSourceMode();
  }

  /** 切换源码栏（source-view）是否自动换行；结果持久化到配置 */
  function setSoftWrap(on) {
    softWrap = !!on;
    if (sourceView) {
      sourceView.wrap = softWrap ? "soft" : "off";
      sourceView.classList.toggle("wrap-off", !softWrap);
    }
    if (sourceHl) {
      sourceHl.classList.toggle("wrap-off", !softWrap);
      syncHlScroll();
    }
    const b = toolbar.querySelector('[data-action="softwrap"]');
    if (b) b.classList.toggle("active", softWrap);
    saveConfig({ softWrap: softWrap });
  }

  /* =====================================================================
   * 新建文档（选择 HTML / Markdown）
   * ===================================================================== */
  const newDialog = document.getElementById("new-dialog");

  function openNewDialog() {
    if (newDialog) openModal(newDialog);
  }

  async function confirmNewFile(kind) {
    const hasContent =
      editor.textContent.replace(/ /g, "").trim() !== "" ||
      editor.querySelector("img,table,hr,pre,blockquote,ul,ol");
    if (hasContent) {
      const ok = await uiConfirm("当前内容尚未保存，确定新建文档吗？");
      if (!ok) return;
    }
    if (sourceMode) exitSourceMode();
    editor.contentEditable = "true";
    editor.innerHTML = "";
    currentFile = { path: null, kind: kind };
    loadedHead = "";
    loadedTitle = "";
    document.title = "墨笺";
    history = [takeSnapshot()];
    historyIndex = 0;
    lastWasCommand = true;
    lastChangeTs = Date.now();
    updatePlaceholder();
    updateToolbarState();
    scheduleAutosave();
    setFilePath("", false);
    setStatus(kind === "markdown" ? "已新建 Markdown 文档" : "已新建 HTML 文档");
  }

  /* =====================================================================
   * 打开文件所在位置（Rust 命令）+ 标题路径显示
   * ===================================================================== */
  function setFilePath(path, hasFile) {
    if (filePathEl) {
      filePathEl.textContent = path || "未打开文件";
      filePathEl.title = path || "";
    }
    if (folderBtn) folderBtn.disabled = !hasFile;
  }

  async function openContainingFolder() {
    const path = (currentFile && currentFile.path) || (window.__pdfPath) || null;
    if (!path) {
      setStatus("请先打开一个文件再定位。", true);
      return;
    }
    try {
      await tauriInvoke("open_containing_folder", { path: path });
    } catch (e) {
      setStatus("打开文件位置失败：" + e, true);
    }
  }

  /* 新建对话框与打开位置按钮的事件接线 */
  if (newDialog) {
    const nh = document.getElementById("new-html");
    const nm = document.getElementById("new-md");
    if (nh) nh.addEventListener("click", function () { closeModal(newDialog); confirmNewFile("html"); });
    if (nm) nm.addEventListener("click", function () { closeModal(newDialog); confirmNewFile("markdown"); });
    newDialog.addEventListener("click", function (e) { if (e.target === newDialog) closeModal(newDialog); });
    newDialog.querySelectorAll("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () { closeModal(newDialog); });
    });
  }
  if (folderBtn) folderBtn.addEventListener("click", openContainingFolder);

  /* =====================================================================
   * 主题切换（持久化到配置文件）
   * ===================================================================== */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "light");
    const sel = document.getElementById("theme-select");
    if (sel) sel.value = theme || "light";
  }

  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.addEventListener("change", function () {
      applyTheme(themeSelect.value);
      saveConfig({ theme: themeSelect.value });
    });
  }

  const encodingSelect = document.getElementById("encoding-select");
  if (encodingSelect) {
    encodingSelect.value = appConfig.defaultEncoding || "";
    encodingSelect.addEventListener("change", function () {
      saveConfig({ defaultEncoding: encodingSelect.value });
      updateEditorStatus();
    });
  }

  /* =====================================================================
   * 事件绑定
   * ===================================================================== */
  /* =====================================================================
   * 查找 / 替换（遍历文本节点，保持原有格式）
   * ===================================================================== */
  const findBar = document.getElementById("find-bar");
  const findInput = document.getElementById("find-input");
  const replaceInput = document.getElementById("replace-input");
  const findCase = document.getElementById("find-case");
  let findState = null; // { nodes, query, idx, caseSensitive }

  function openFindBar() {
    if (findBar) {
      // 顶部浮动：精确贴在工具栏底边下方（工具栏高度随换行/主题变化，按真实位置算）
      const tb = document.getElementById("toolbar");
      if (tb) {
        const top = tb.getBoundingClientRect().bottom + 6;
        findBar.style.top = top + "px";
      }
      findBar.classList.remove("hidden");
    }
    if (findInput) findInput.focus();
  }
  function closeFindBar() {
    if (findBar) findBar.classList.add("hidden");
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    findState = null;
  }
  function collectTextNodes() {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.textContent.length) nodes.push(n);
    }
    return nodes;
  }
  function doFind(forward) {
    if (!findInput) return;
    const q = findInput.value;
    if (!q) return;
    const caseSensitive = !!(findCase && findCase.checked);
    if (!findState || findState.query !== q || findState.caseSensitive !== caseSensitive) {
      findState = { nodes: collectTextNodes(), query: q, idx: -1, caseSensitive };
    }
    const nodes = findState.nodes;
    if (!nodes.length) { setStatus("未找到：" + q); return; }
    let start = forward ? findState.idx + 1 : findState.idx - 1;
    if (start >= nodes.length) start = 0;
    if (start < 0) start = nodes.length - 1;
    for (let i = 0; i < nodes.length; i++) {
      const ni = (start + i) % nodes.length;
      const node = nodes[ni];
      const text = caseSensitive ? node.textContent : node.textContent.toLowerCase();
      const ql = caseSensitive ? q : q.toLowerCase();
      const pos = text.indexOf(ql);
      if (pos !== -1) {
        findState.idx = ni;
        const range = document.createRange();
        range.setStart(node, pos);
        range.setEnd(node, pos + q.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (node.parentElement && node.parentElement.scrollIntoView) {
          node.parentElement.scrollIntoView({ block: "nearest" });
        }
        setStatus("匹配：" + (ni + 1) + " / " + nodes.length);
        return;
      }
    }
    setStatus("未找到：" + q);
  }
  function replaceCurrent() {
    if (!findState || findState.idx < 0) {
      doFind(true);
      if (!findState || findState.idx < 0) return;
    }
    const node = findState.nodes[findState.idx];
    const q = findState.query;
    const repl = replaceInput ? replaceInput.value : "";
    const text = node.textContent;
    const pos = findState.caseSensitive ? text.indexOf(q) : text.toLowerCase().indexOf(q.toLowerCase());
    if (pos === -1) return;
    const before = editor.innerHTML;
    node.textContent = text.slice(0, pos) + repl + text.slice(pos + q.length);
    if (editor.innerHTML !== before) commitHistory();
    lastWasCommand = true;
    setStatus("已替换 1 处");
    doFind(true);
  }
  function replaceAll() {
    const q = findInput ? findInput.value : "";
    if (!q) return;
    const caseSensitive = !!(findCase && findCase.checked);
    const repl = replaceInput ? replaceInput.value : "";
    const nodes = collectTextNodes();
    let count = 0;
    const before = editor.innerHTML;
    nodes.forEach(function (node) {
      let text = node.textContent;
      let idx;
      if (caseSensitive) {
        while ((idx = text.indexOf(q)) !== -1) {
          text = text.slice(0, idx) + repl + text.slice(idx + q.length);
          count++;
        }
      } else {
        const ql = q.toLowerCase();
        while ((idx = text.toLowerCase().indexOf(ql)) !== -1) {
          text = text.slice(0, idx) + repl + text.slice(idx + q.length);
          count++;
        }
      }
      node.textContent = text;
    });
    if (editor.innerHTML !== before) commitHistory();
    lastWasCommand = true;
    setStatus("已替换 " + count + " 处");
    findState = null;
  }

  if (findBar) {
    document.getElementById("find-next").addEventListener("click", function () { doFind(true); });
    document.getElementById("find-prev").addEventListener("click", function () { doFind(false); });
    document.getElementById("find-replace").addEventListener("click", replaceCurrent);
    document.getElementById("find-replace-all").addEventListener("click", replaceAll);
    document.getElementById("find-close").addEventListener("click", closeFindBar);
    if (findInput) findInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doFind(true); }
    });
    if (replaceInput) replaceInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
    });
  }

  toolbar.addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    // 纯源码视图下仅允许 keep 类控件（缩放/分栏/源码），禁用其它格式化/插入按钮
    if (sourceMode && !btn.classList.contains("keep")) return;
    if (btn.dataset.cmd) {
      formatCommand(btn.dataset.cmd);
    } else if (btn.dataset.block) {
      toggleBlock(btn.dataset.block);
    } else if (btn.dataset.action) {
      const action = btn.dataset.action;
      if (action === "link") handleLink();
      else if (action === "image") handleImage();
      else if (action === "video") handleVideo();
      else if (action === "find") openFindBar();
      else if (action === "table") insertTable();
      else if (action === "code") insertCodeBlock();
      else if (action === "hr") insertHr();
      else if (action === "emoji") openEmojiDialog();
      else if (action === "undo") undo();
      else if (action === "redo") redo();
      else if (action === "open") openFile();
      else if (action === "prevfile") goSibling(-1);
      else if (action === "nextfile") goSibling(1);
      else if (action === "save") saveFile();
      else if (action === "saveas") saveFileAs();
      else if (action === "export") exportHTML();
      else if (action === "slides") presentSlides();
      else if (action === "clear") clearDraft();
      else if (action === "new") openNewDialog();
      else if (action === "zoom-in") zoomIn();
      else if (action === "zoom-out") zoomOut();
      else if (action === "source") toggleSourceMode();
      else if (action === "split") toggleSplitMode();
      else if (action === "softwrap") setSoftWrap(!softWrap);
      else if (action === "open-folder") openContainingFolder();
      else if (action === "forecolor") { saveSelection(); if (foreColorInput) foreColorInput.click(); }
      else if (action === "backcolor") { saveSelection(); if (backColorInput) backColorInput.click(); }
    }
  });

  toolbar.addEventListener("mousedown", function (e) {
    if (e.target.closest("button")) e.preventDefault();
  });

  /* =====================================================================
   * 文字颜色 / 背景颜色
   * ===================================================================== */
  const foreColorInput = document.getElementById("fore-color-input");
  const backColorInput = document.getElementById("back-color-input");

  /** 给选中文字上色（styleWithCSS 让颜色以 inline style 写入，便于导出/保存保留） */
  function applyForeColor(color) {
    restoreSelection();
    document.execCommand("styleWithCSS", false, true);
    runCommand("foreColor", color);
  }

  /** 给选中文字加背景色（高亮）；Chromium 用 hiliteColor，退化用 backColor */
  function applyBackColor(color) {
    restoreSelection();
    document.execCommand("styleWithCSS", false, true);
    const applied = document.execCommand("hiliteColor", false, color);
    if (!applied) document.execCommand("backColor", false, color);
    commitHistory();
    updateToolbarState();
  }

  if (foreColorInput) {
    foreColorInput.addEventListener("input", function () {
      applyForeColor(foreColorInput.value);
    });
  }
  if (backColorInput) {
    backColorInput.addEventListener("input", function () {
      applyBackColor(backColorInput.value);
    });
  }

  editor.addEventListener("input", function () {
    if (suppressInput) {
      suppressInput = false;
      return;
    }
    recordInput();
    updatePlaceholder();
    scheduleAutosave();
    if (splitMode) scheduleSyncEditorToSource();
    scheduleStatus();
  });

  /* 源码分栏：左渲染区 → 右源码（防抖写入，避免每键重绘） */
  let syncToSourceTimer = null;
  let suppressSourceInput = false;
  function scheduleSyncEditorToSource() {
    clearTimeout(syncToSourceTimer);
    syncToSourceTimer = setTimeout(function () {
      suppressSourceInput = true;
      sourceView.value = (currentFile && currentFile.kind === "markdown")
        ? serializeMarkdown()
        : (currentFile && currentFile.kind === "svg") ? sourceView.value
        : editor.innerHTML;
      setTimeout(function () { suppressSourceInput = false; }, 0);
    }, 300);
  }

  /* 源码分栏：右源码 → 左渲染区（防抖应用，方向单向避免回环） */
  let syncToEditorTimer = null;
  function scheduleSyncSourceToEditor() {
    clearTimeout(syncToEditorTimer);
    syncToEditorTimer = setTimeout(function () {
      suppressInput = true;
      const src = sourceView.value;
      if (currentFile && currentFile.kind === "markdown") {
        loadMarkdown(src);
      } else {
        editor.innerHTML = sanitizeHtmlString(src);
        history = [takeSnapshot()];
        historyIndex = 0;
        lastWasCommand = true;
        lastChangeTs = Date.now();
        updatePlaceholder();
        updateToolbarState();
      }
      setTimeout(function () { suppressInput = false; }, 0);
      scheduleAutosave();
    }, 300);
  }

  /* ============================ 源码栏语法高亮（highlight.js 叠加层） ============================ */
  let hlTimer = null;
  function syncHlScroll() {
    if (!sourceView || !sourceHl) return;
    sourceHl.scrollTop = sourceView.scrollTop;
    sourceHl.scrollLeft = sourceView.scrollLeft;
  }
  function highlightLanguage() {
    if (!currentFile) return null;
    if (currentFile.kind === "markdown") return "markdown";
    if (currentFile.kind === "html" || currentFile.kind === "svg") return "xml";
    return null;
  }
  function highlightSource() {
    if (!sourceView || !sourceHl || !sourceHlCode) return;
    if (sourceView.style.display === "none") return;
    if (!window.hljs) return; // 库未加载：保持纯文本，不加 hl-on
    const code = sourceView.value;
    const lang = highlightLanguage();
    let html = "";
    try {
      html = lang
        ? window.hljs.highlight(code, { language: lang }).value
        : window.hljs.highlightAuto(code).value;
    } catch (e) {
      html = "";
    }
    sourceHlCode.innerHTML = html + (code.endsWith("\n") ? "\n" : "");
    sourceView.classList.add("hl-on");
    syncHlScroll();
  }
  function scheduleHighlight() {
    if (hlTimer) clearTimeout(hlTimer);
    hlTimer = setTimeout(highlightSource, 150);
  }

  sourceView.addEventListener("input", function () {
    if (suppressSourceInput) { suppressSourceInput = false; return; }
    if (splitMode) scheduleSyncSourceToEditor();
    scheduleHighlight();
  });
  sourceView.addEventListener("scroll", syncHlScroll);

  editor.addEventListener("focus", updatePlaceholder);
  editor.addEventListener("blur", updatePlaceholder);

  document.addEventListener("selectionchange", function () {
    updateToolbarState();
    scheduleStatus();
  });

  /** 当前选区是否位于列表项（li）内，用于决定 Tab 是否执行缩进 */
  function isSelectionInList() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return false;
    let node =
      sel.anchorNode.nodeType === Node.TEXT_NODE
        ? sel.anchorNode.parentElement
        : sel.anchorNode;
    while (node && node !== editor) {
      if (node.tagName === "LI") return true;
      node = node.parentElement;
    }
    return false;
  }

  editor.addEventListener("keydown", function (e) {
    // 列表内 Tab / Shift+Tab 缩进 / 取消缩进（contenteditable 默认 Tab 会跳焦点）
    if (e.key === "Tab" && isSelectionInList()) {
      e.preventDefault();
      runCommand(e.shiftKey ? "outdent" : "indent");
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "b") {
      e.preventDefault();
      formatCommand("bold");
    } else if (key === "i") {
      e.preventDefault();
      formatCommand("italic");
    } else if (key === "u") {
      e.preventDefault();
      formatCommand("underline");
    } else if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (key === "y") {
      e.preventDefault();
      redo();
    } else if (key === "s") {
      e.preventDefault();
      saveFile();
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      zoomIn();
    } else if (key === "-") {
      e.preventDefault();
      zoomOut();
    }
  });

  editor.addEventListener("paste", function (e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    const before = editor.innerHTML;
    suppressInput = true;
    document.execCommand("insertText", false, text);
    if (editor.innerHTML !== before) {
      commitHistory();
    }
    lastWasCommand = true;
    updatePlaceholder();
    scheduleAutosave();
    setTimeout(function () { suppressInput = false; }, 0);
  });

  /* =====================================================================
   * 初始化：恢复草稿、建立初始历史、注册拖放
   * ===================================================================== */
  async function init() {
    // 禁用主界面右键菜单（保持应用内统一体验，避免误触系统菜单）
    document.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    // 先加载同目录配置文件（窗格大小/主题/工具栏布局等），再据其恢复
    await loadConfig();
    // 源码栏自动换行（默认开启，可从配置恢复）
    softWrap = getConfig().softWrap !== false;
    if (sourceView) {
      sourceView.wrap = softWrap ? "soft" : "off";
      sourceView.classList.toggle("wrap-off", !softWrap);
    }
    // 依据配置动态渲染工具栏（顺序 / 显隐由定制弹窗的 ↑/↓ 调整）
    renderToolbar();
    // 启动不再自动恢复上次草稿内容，避免误以为"已打开文件"；
    // 应用启动即空白新文档（标题显示"未打开文件"）。
    updatePlaceholder();
    history = [takeSnapshot()];
    historyIndex = 0;
    lastWasCommand = true;
    lastChangeTs = Date.now();
    updateToolbarState();
    setupDragDrop();
    bindEpubControls();

    // 状态栏：编辑器内容 / 光标 / 编码变化时刷新（直接写 #status，不弹 Toast）
    try {
      if (typeof MutationObserver !== "undefined" && editor) {
        const mo = new MutationObserver(function () { scheduleStatus(); });
        mo.observe(editor, { childList: true, subtree: true, characterData: true });
      }
    } catch (e) {}
    updateEditorStatus();

    // 顶部提示：点击即可关闭
    const toastEl = document.getElementById("toast");
    if (toastEl) {
      toastEl.addEventListener("click", function () { this.classList.remove("show"); });
    }
    // 记住窗口最后尺寸（最小尺寸由 tauri.conf.json 的 minWidth/minHeight 兜底保护）
    setupWindowSizePersistence();
    restoreWindowSize();
    // 应用上次主题
    applyTheme(appConfig.theme);
    // 应用上次页面缩放
    try {
      const z = parseFloat(localStorage.getItem("editorZoom"));
      if (!isNaN(z) && z >= 0.5 && z <= 2) applyZoom(z, false);
    } catch (e) {}
    // 恢复上次源码分栏
    if (appConfig.sourceSplit) enterSplitMode();
    // 处理文件关联：Windows 双击 .md/.html 时路径作为命令行参数传入，
    // Tauri 不会自动打开，这里主动读取并在启动后加载该文件。
    try {
      const initialFile = await tauriInvoke("get_initial_file");
      if (initialFile) openFileWithPath(initialFile);
    } catch (e) {}
  }

  init();
})();
