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
    prevfile:   { name:"上一个", kind:"action", value:"prevfile", title:"打开同目录下上一个受支持的文件", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' },
    nextfile:   { name:"下一个", kind:"action", value:"nextfile", title:"打开同目录下下一个受支持的文件", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' },
    save:       { name:"保存", kind:"action", value:"save", title:"保存（存回原文件）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' },
    saveas:     { name:"另存为", kind:"action", value:"saveas", title:"另存副本", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 21V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="16" x2="12" y2="9"/></svg>' },
    export:     { name:"导出", kind:"action", value:"export", title:"导出为网页", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="8 11 12 15 16 11"/><path d="M5 19h14"/></svg>' },
    clear:      { name:"清空", kind:"action", value:"clear", title:"清空草稿", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' },
    undo:       { name:"撤销", kind:"action", value:"undo", title:"撤销", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>' },
    redo:       { name:"重做", kind:"action", value:"redo", title:"重做", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>' },
    bold:       { name:"加粗", kind:"cmd", value:"bold", title:"加粗", label:'<b>B</b>' },
    italic:     { name:"斜体", kind:"cmd", value:"italic", title:"斜体", label:'<i>I</i>' },
    underline:  { name:"下划线", kind:"cmd", value:"underline", title:"下划线（仅 HTML 文档，Markdown 不支持）", htmlOnly:true, label:'<u>U</u>' },
    forecolor:  { name:"文字颜色", kind:"action", value:"forecolor", title:"文字颜色（仅 HTML 文档，Markdown 不支持）", htmlOnly:true, svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><text x="12" y="16" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">A</text><line x1="5" y1="20" x2="9" y2="20" stroke="#ef4444" stroke-width="2.6"/><line x1="9.6" y1="20" x2="13.6" y2="20" stroke="#f59e0b" stroke-width="2.6"/><line x1="14.2" y1="20" x2="19" y2="20" stroke="#3b82f6" stroke-width="2.6"/></svg>' },
    backcolor:  { name:"背景颜色", kind:"action", value:"backcolor", title:"背景颜色 / 高亮（仅 HTML 文档，Markdown 不支持）", htmlOnly:true, svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="13" width="15" height="4.5" rx="1.2" fill="#fde047" stroke="none"/><text x="12" y="17" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">A</text></svg>' },
    H1:         { name:"标题 1", kind:"block", value:"H1", title:"一级标题", label:'1' },
    H2:         { name:"标题 2", kind:"block", value:"H2", title:"二级标题", label:'2' },
    H3:         { name:"标题 3", kind:"block", value:"H3", title:"三级标题", label:'3' },
    H4:         { name:"标题 4", kind:"block", value:"H4", title:"四级标题", label:'4' },
    H5:         { name:"标题 5", kind:"block", value:"H5", title:"五级标题", label:'5' },
    H6:         { name:"标题 6", kind:"block", value:"H6", title:"六级标题", label:'6' },
    insertUnorderedList: { name:"项目符号", kind:"cmd", value:"insertUnorderedList", title:"加圆点列表", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>' },
    insertOrderedList:   { name:"编号", kind:"cmd", value:"insertOrderedList", title:"加数字列表", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg>' },
    indent:     { name:"缩进", kind:"cmd", value:"indent", title:"向右缩进（先选中内容）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/><polyline points="3 9 7 12 3 15"/></svg>' },
    outdent:    { name:"退一级", kind:"cmd", value:"outdent", title:"向左缩进（先选中内容）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/><polyline points="7 9 3 12 7 15"/></svg>' },
    BLOCKQUOTE: { name:"引用块", kind:"block", value:"BLOCKQUOTE", title:"引用块", svg:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h4v6H7v2H5V9a2 2 0 0 1 2-2zm8 0h4v6h-4v2h-2V9a2 2 0 0 1 2-2z" transform="scale(0.9) translate(1 1)"/></svg>' },
    link:       { name:"链接", kind:"action", value:"link", title:"插入/编辑链接", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>' },
    image:      { name:"图片", kind:"action", value:"image", title:"插入图片", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/></svg>' },
    video:      { name:"视频", kind:"action", value:"video", title:"插入视频 / 嵌入播放器（仅 HTML 文档，Markdown 不支持）", htmlOnly:true, svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15" fill="currentColor" stroke="none"/></svg>' },
    table:      { name:"表格", kind:"action", value:"table", title:"插入表格 (3×3)", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/></svg>' },
    code:       { name:"代码块", kind:"action", value:"code", title:"插入代码块", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 7 4 12 8 17"/><polyline points="16 7 20 12 16 17"/></svg>' },
    hr:         { name:"分割线", kind:"action", value:"hr", title:"插入分割线", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>' },
    emoji:      { name:"表情", kind:"action", value:"emoji", title:"插入表情（Emoji）", label:'😀' },
    slides:     { name:"演示", kind:"action", value:"slides", title:"做成幻灯片播放（仅 Markdown）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none"/></svg>' },
    outline:    { name:"大纲", kind:"action", value:"outline", title:"显示/隐藏 Markdown 大纲", label:'大纲', keep:true },
    find:       { name:"查找替换", kind:"action", value:"find", title:"查找 / 替换", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' },
    zoomout:    { name:"缩小", kind:"action", value:"zoom-out", title:"缩小", label:'−', keep:true },
    zoomin:     { name:"放大", kind:"action", value:"zoom-in", title:"放大", label:'+', keep:true },
    split:      { name:"分栏", kind:"action", value:"split", title:"左右分屏对照查看", label:'分栏', keep:true },
    source:     { name:"原文", kind:"action", value:"source", title:"查看原始内容", label:'原文', keep:true },
    softwrap:   { name:"自动换行", kind:"action", value:"softwrap", title:"长行自动折行", label:'换行', keep:true },
    ZOOMLABEL:  { kind:"zoomlabel", keep:true },
    mergePdf:   { name:"合并PDF", kind:"action", value:"mergePdf", title:"合并多个 PDF（无需先打开 PDF）", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="9" height="12" rx="1.5"/><rect x="11" y="8" width="9" height="12" rx="1.5"/></svg>' },
  };

  const DEFAULT_ORDER = [
    "new","open","mergePdf","prevfile","nextfile","save","saveas","export","clear",
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
    "zoomout","ZOOMLABEL","zoomin","slides","outline","split","source","softwrap",
  ];

  /** 解析工具栏配置（缺省回退默认顺序），返回 { order, hidden } */
  function getToolbarConfig() {
    const t = appConfig.toolbar || {};
    let order;
    if (Array.isArray(t.order) && t.order.length) {
      order = t.order.slice();
      // 合并新增的默认项：若用户此前保存过工具栏顺序（早于本次新增的 outline 等项），
      // 老布局里没有这些新按钮 → 自动补到末尾，确保新功能对老用户可见。
      // （被用户主动隐藏的项在 hidden 里，renderToolbar 仍会跳过，不会被强制显示。）
      DEFAULT_ORDER.forEach(function (tok) {
        if (!order.includes(tok)) order.push(tok);
      });
    } else {
      order = DEFAULT_ORDER.slice();
    }
    const hidden = (t.hidden && typeof t.hidden === "object") ? t.hidden : {};
    return { order: order, hidden: hidden };
  }

  /** 当前是否在编辑 Markdown 文档（含未保存的 md 新文档） */
  function isMarkdownDoc() {
    return !!(currentFile && currentFile.kind === "markdown");
  }

  /** 当前可见工具栏项的统一数据源（顺序 + 显隐 + 分隔符），renderToolbar 共用 */
  function visibleTokens() {
    const cfg = getToolbarConfig();
    const md = isMarkdownDoc();
    const out = [];
    cfg.order.forEach(function (token) {
      if (token === "__divider__") { out.push({ divider: true }); return; }
      const item = TOOLBAR_ITEMS[token];
      if (!item) return;
      if (cfg.hidden[token] && !item.keep && item.kind !== "zoomlabel") return;
      // Markdown 下隐藏"存不进 .md"的按钮（下划线/颜色/视频，htmlOnly:true），打开 HTML 时恢复显示
      if (md && item.htmlOnly) return;
      out.push({ token: token, item: item, keep: !!item.keep });
    });
    return out;
  }

  /** 依据配置动态渲染工具栏（分组 / 缩放标签 / 显隐 / 可拖拽） */
  function renderToolbar() {
    if (!toolbar) return;
    toolbar.innerHTML = "";
    let lastWasDivider = false;
    visibleTokens().forEach(function (entry) {
      if (entry.divider) {
        if (lastWasDivider) return;
        const d = document.createElement("div");
        d.className = "divider";
        toolbar.appendChild(d);
        lastWasDivider = true;
        return;
      }
      lastWasDivider = false;
      const item = entry.item;
      const token = entry.token;
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
      btn.dataset.tip = item.title || item.name; btn.setAttribute('aria-label', item.title || item.name);
      if (item.svg) btn.innerHTML = item.svg;
      else if (item.label) btn.innerHTML = item.label;
      if (item.keep) btn.classList.add("keep");
      if (item.value === "softwrap") btn.classList.toggle("active", softWrap);
      toolbar.appendChild(btn);
    });
    updateNavButtons();
  }

  /* 自定义弹窗：Word 式双列表（左=当前显示的选项，右=可用命令）。
   * 编辑器工具栏与 PDF 工具栏共用同一套面板，通过 tbCtx 上下文适配：
   * { items, getConfig, commit(order, hidden), isFlexible(item) } */
  const toolbarSettingsModal = document.getElementById("toolbar-settings");
  const toolbarSettingsBtn = document.getElementById("toolbar-settings-btn");
  const tbWordPanel = document.getElementById("tb-word");
  const tbAvailList = document.getElementById("tb-avail-list");   /* 右列：可用命令 */
  const tbCurList = document.getElementById("tb-current-list");   /* 左列：当前显示 */
  let tbAvailSel = null;  /* 右列表选中的命令 token */
  let tbCurSelIdx = -1;   /* 左列表选中的序号（在可见序列中的位置） */
  let tbCtx = null;       /* 当前定制的上下文，打开弹窗时设置 */

  /** 编辑器工具栏上下文 */
  const editorTbCtx = {
    items: TOOLBAR_ITEMS,
    getConfig: getToolbarConfig,
    commit: function (order, hidden) {
      appConfig.toolbar = { order: order, hidden: hidden };
      renderToolbar();
      saveConfig({ toolbar: appConfig.toolbar });
    },
    isFlexible: isFlexibleItem,
  };

  /** 可自由增删/排序的项（keep 核心控件与缩放标签固定，不进双列表） */
  function isFlexibleItem(item) {
    return !!(item && !item.keep && item.kind !== "zoomlabel");
  }

  /** 左列表数据：完整 order 中"当前显示"的可排序项（含分隔符；隐藏项不显示） */
  function tbFlexTokens(ctx) {
    const cfg = ctx.getConfig();
    return cfg.order.filter(function (tok) {
      if (tok === "__divider__") return true;
      return ctx.isFlexible(ctx.items[tok]) && !cfg.hidden[tok];
    });
  }

  /** 可见序列第 fi 项在完整 order 中的下标 */
  function tbOrderIndexAt(ctx, cfg, fi) {
    let n = 0;
    for (let i = 0; i < cfg.order.length; i++) {
      const tok = cfg.order[i];
      const vis = tok === "__divider__" || (ctx.isFlexible(ctx.items[tok]) && !cfg.hidden[tok]);
      if (vis) { if (n === fi) return i; n++; }
    }
    return -1;
  }

  /** 把左列表新顺序回填完整 order：keep/缩放标签/隐藏项槽位原位保留，可排序槽位按新顺序填充 */
  function tbCommitFlex(ctx, flex) {
    const cfg = ctx.getConfig();
    let i = 0;
    const newOrder = [];
    cfg.order.forEach(function (tok) {
      const it = ctx.items[tok];
      const vis = tok === "__divider__" || (it && ctx.isFlexible(it) && !cfg.hidden[tok]);
      if (vis) {
        if (i < flex.length) newOrder.push(flex[i++]);
        return;                       /* 删除后多余的旧槽位丢弃 */
      }
      if (it) newOrder.push(tok);     /* keep / 缩放标签 / 隐藏项原位保留；未知 token 顺手清理 */
    });
    while (i < flex.length) newOrder.push(flex[i++]);
    ctx.commit(newOrder, cfg.hidden);
    tbRenderPanel(ctx);
  }

  function openToolbarSettings() {
    if (!tbCurList) return;
    tbCtx = editorTbCtx;
    tbAvailSel = null;
    tbCurSelIdx = -1;
    if (toolbarSettingsModal) {
      toolbarSettingsModal.classList.add("wide");   /* Word 式双列表需要更宽的弹窗 */
      openModal(toolbarSettingsModal);
    }
    tbRenderPanel(tbCtx);
    /* 打开即刷新文件关联勾选状态，不必切到「文件关联」Tab */
    refreshAssocChecks();
  }

  /** 双列表行通用渲染：图标 + 名称（分隔符为特殊行；分组名带下拉标记） */
  function tbRowFor(tok, items) {
    const row = document.createElement("div");
    row.className = "tb-word-row";
    row.setAttribute("role", "option");
    if (tok === "__divider__") {
      row.classList.add("tb-word-divider-row");
      row.textContent = "—— 分隔符 ——";
      return row;
    }
    const it = items[tok];
    if (it.svg) {
      const ic = document.createElement("span");
      ic.className = "tb-word-ico";
      ic.innerHTML = it.svg;
      row.appendChild(ic);
    }
    const nm = document.createElement("span");
    nm.className = "tb-word-name";
    nm.textContent = it.name + (it.kind === "group" ? " ▾" : "");
    row.appendChild(nm);
    return row;
  }

  function tbRenderPanel(ctx) {
    if (!tbAvailList || !tbCurList) return;
    const flex = tbFlexTokens(ctx);

    /* 左列表：当前显示的选项（按顺序） */
    tbCurList.innerHTML = "";
    if (tbCurSelIdx >= flex.length) tbCurSelIdx = flex.length - 1;
    flex.forEach(function (tok, fi) {
      const row = tbRowFor(tok, ctx.items);
      if (fi === tbCurSelIdx) row.classList.add("selected");
      row.addEventListener("click", function () {
        tbCurSelIdx = fi;
        tbRenderPanel(ctx);
      });
      row.addEventListener("dblclick", function () { tbCurSelIdx = fi; tbRemoveSelected(ctx); });
      tbCurList.appendChild(row);
    });

    /* 右列表：可用命令 = 尚未显示的可排序命令 + 分隔符 */
    const shown = {};
    flex.forEach(function (t) { if (t !== "__divider__") shown[t] = true; });
    const avail = Object.keys(ctx.items).filter(function (tok) {
      return ctx.isFlexible(ctx.items[tok]) && !shown[tok];
    });
    avail.push("__divider__");
    if (tbAvailSel !== null && avail.indexOf(tbAvailSel) < 0) tbAvailSel = null;

    tbAvailList.innerHTML = "";
    avail.forEach(function (tok) {
      const row = tbRowFor(tok, ctx.items);
      if (tbAvailSel === tok) row.classList.add("selected");
      row.addEventListener("click", function () {
        tbAvailSel = tok;
        tbRenderPanel(ctx);
      });
      row.addEventListener("dblclick", function () { tbAvailSel = tok; tbAddSelected(ctx); });
      tbAvailList.appendChild(row);
    });

    updateWordButtons(flex);
  }

  function updateWordButtons(flex) {
    const add = document.getElementById("tb-add-btn");
    const remove = document.getElementById("tb-remove-btn");
    const up = document.getElementById("tb-up-btn");
    const down = document.getElementById("tb-down-btn");
    if (add) add.disabled = tbAvailSel === null;
    if (remove) remove.disabled = tbCurSelIdx < 0;
    if (up) up.disabled = tbCurSelIdx <= 0;
    if (down) down.disabled = tbCurSelIdx < 0 || tbCurSelIdx >= flex.length - 1;
  }

  /* 添加：右列表选中项插入到左列表选中项之后（无选中则追加到末尾） */
  function tbAddSelected(ctx) {
    if (tbAvailSel === null) return;
    const cfg = ctx.getConfig();
    const order = cfg.order.slice();
    const tok = tbAvailSel;
    let insertAt = order.length;
    if (tbCurSelIdx >= 0) {
      const oi = tbOrderIndexAt(ctx, cfg, tbCurSelIdx);
      if (oi >= 0) insertAt = oi + 1;
    }
    if (tok !== "__divider__" && order.includes(tok)) {
      order.splice(order.indexOf(tok), 1);  /* 之前被删除过：先挪出旧位再插入 */
    }
    order.splice(Math.min(insertAt, order.length), 0, tok);
    if (tok !== "__divider__") delete cfg.hidden[tok];
    ctx.commit(order, cfg.hidden);
    tbRenderPanel(ctx);
  }

  /* 删除：左列表选中项从显示中移除（命令隐藏并保留位置可再加回，分隔符直接删掉） */
  function tbRemoveSelected(ctx) {
    if (tbCurSelIdx < 0) return;
    const cfg = ctx.getConfig();
    const order = cfg.order.slice();
    const oi = tbOrderIndexAt(ctx, cfg, tbCurSelIdx);
    if (oi < 0) return;
    const tok = order[oi];
    if (tok === "__divider__") order.splice(oi, 1);
    else cfg.hidden[tok] = true;
    tbCurSelIdx = Math.min(tbCurSelIdx, tbFlexTokens(ctx).length - 1);
    ctx.commit(order, cfg.hidden);
    tbRenderPanel(ctx);
  }

  /* 上移/下移：在可见序列内交换后回填完整 order（分隔符、隐藏项均参与排序） */
  function tbMoveSelected(ctx, dir) {
    if (tbCurSelIdx < 0) return;
    const flex = tbFlexTokens(ctx);
    const j = tbCurSelIdx + dir;
    if (j < 0 || j >= flex.length) return;
    const t = flex[tbCurSelIdx];
    flex[tbCurSelIdx] = flex[j];
    flex[j] = t;
    tbCurSelIdx = j;
    tbCommitFlex(ctx, flex);
  }

  if (tbWordPanel) {
    const add = document.getElementById("tb-add-btn");
    const remove = document.getElementById("tb-remove-btn");
    const up = document.getElementById("tb-up-btn");
    const down = document.getElementById("tb-down-btn");
    if (add) add.addEventListener("click", function () { if (tbCtx) tbAddSelected(tbCtx); });
    if (remove) remove.addEventListener("click", function () { if (tbCtx) tbRemoveSelected(tbCtx); });
    if (up) up.addEventListener("click", function () { if (tbCtx) tbMoveSelected(tbCtx, -1); });
    if (down) down.addEventListener("click", function () { if (tbCtx) tbMoveSelected(tbCtx, 1); });
  }

  /* PDF 打开时，「定制」同样用 Word 式双列表，只是上下文换成 PDF 工具栏 */
  function pdfCustomizeActive() {
    return !!(window.__pdfActive && window.PDFApp && window.PDFApp.getToolbarCtx);
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
  // 定制弹窗布局三态：editor=Tab 栏+双列表+md 说明；pdf=Tab 栏+双列表（无 md 说明，
  // 保留「文件关联」Tab）；assoc-only=仅文件关联面板（EPUB 只读模式没有工具栏可定制）
  function setTbTabsVisible(mode) {
    const tabsEl = document.getElementById("tb-tabs");
    const tbPanel = document.getElementById("tb-panel-toolbar");
    const ac = document.getElementById("tb-panel-assoc");
    const desc = document.getElementById("tb-htmlonly-desc");
    const assocOnly = mode === "assoc-only";
    if (tabsEl) tabsEl.classList.toggle("hidden", assocOnly);
    if (tbPanel) tbPanel.classList.toggle("hidden", assocOnly);
    if (tbWordPanel) tbWordPanel.classList.toggle("hidden", assocOnly);
    if (toolbarSettingsModal) toolbarSettingsModal.classList.toggle("wide", !assocOnly);
    if (desc) desc.classList.toggle("hidden", mode !== "editor");
    if (assocOnly && ac) ac.classList.remove("hidden");
  }

  if (toolbarSettingsBtn) toolbarSettingsBtn.addEventListener("click", function () {
    const title = toolbarSettingsModal && toolbarSettingsModal.querySelector("h3");
    // EPUB 只读模式：没有可定制的工具栏，直接展示「文件关联」面板
    if (window.__epubActive) {
      if (title) title.textContent = "文件关联";
      tbCtx = null;                          // 双列表已隐藏，防误触
      setTbTabsVisible("assoc-only");
      if (toolbarSettingsModal) openModal(toolbarSettingsModal);
      refreshAssocChecks();
      return;
    }
    if (pdfCustomizeActive()) {
      // PDF 模式：同一套 Word 双列表，上下文换成 PDF 工具栏；Tab 栏保留（视觉统一，含「文件关联」）
      if (title) title.textContent = "自定义 PDF 工具栏";
      tbCtx = window.PDFApp.getToolbarCtx();
      tbAvailSel = null;
      tbCurSelIdx = -1;
      setTbTabsVisible("pdf");
      if (toolbarSettingsModal) openModal(toolbarSettingsModal);
      tbRenderPanel(tbCtx);
      showTbTab("toolbar");
      return;
    }
    if (title) title.textContent = "自定义工具栏";
    setTbTabsVisible("editor");
    openToolbarSettings();
    showTbTab("toolbar");                    // 编辑器模式：默认停在「工具栏」Tab
  });
  if (toolbarSettingsModal) {
    const reset = document.getElementById("toolbar-reset");
    if (reset) reset.addEventListener("click", function () {
      tbAvailSel = null;
      tbCurSelIdx = -1;
      if (pdfCustomizeActive() && window.PDFApp.resetToolbar) {
        window.PDFApp.resetToolbar();        // 还原 PDF 配置并重渲工具栏
        if (tbCtx) tbRenderPanel(tbCtx);     // 双列表刷新到默认状态
        return;
      }
      appConfig.toolbar = null;
      renderToolbar();
      saveConfig({ toolbar: null });
      tbRenderPanel(editorTbCtx);
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
    const loading = document.getElementById("register-assoc-loading");
    const checks = document.querySelector("#tb-panel-assoc .tb-assoc-checks");
    if (loading) loading.classList.remove("hidden");
    if (checks) checks.classList.add("loading");
    try {
      const state = await tauriInvoke("get_file_association_state");
      const set = new Set(Array.isArray(state) ? state : []);
      document.querySelectorAll("#toolbar-settings .tb-assoc-check input").forEach(function (cb) {
        cb.checked = set.has(cb.dataset.assoc);
      });
    } catch (e) { /* 非 Windows 或查询失败：保留默认（全勾选） */ }
    finally {
      if (loading) loading.classList.add("hidden");
      if (checks) checks.classList.remove("loading");
    }
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
  const mdOutline = document.getElementById("md-outline");
  const mdOutlineList = document.getElementById("md-outline-list");
  const mdOutlineClose = document.getElementById("md-outline-close");
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
  /* 关闭保护：savedSignature = 最近一次"打开/保存"时内容的签名（与 contentSignature 同表示），
   * 关窗前对比二者判断是否有未保存修改；closeBypass 供"直接关闭"跳过守卫 */
  let savedSignature = "";
  let closeBypass = false;
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
    refreshAfterRender();
    scheduleOutline();
    setCaretOffset(snapshot.caret);
    lastWasCommand = true;
    updatePlaceholder();
    scheduleAutosave();
    if (splitMode) scheduleSyncEditorToSource(); // 撤销/重做后同步源码栏
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
   * 表格行/列编辑：光标进入表格时显示浮动工具条，支持增/删 行、列
   * 依赖 serializeMarkdown 的 gfmTable 规则，改动可被写回 .md
   * ===================================================================== */
  const tableEditBar = document.createElement("div");
  tableEditBar.className = "table-edit-bar";
  tableEditBar.innerHTML =
    '<button data-tbl="row-above" data-tip="在上方插入行">＋行↑</button>' +
    '<button data-tbl="row-below" data-tip="在下方插入行">＋行↓</button>' +
    '<button data-tbl="row-del" data-tip="删除本行">－行</button>' +
    '<span class="sep"></span>' +
    '<button data-tbl="col-left" data-tip="在左侧插入列">＋列←</button>' +
    '<button data-tbl="col-right" data-tip="在右侧插入列">＋列→</button>' +
    '<button data-tbl="col-del" data-tip="删除本列">－列</button>';
  document.body.appendChild(tableEditBar);

  function cellFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let n = sel.anchorNode;
    while (n && n.nodeType !== 1) n = n.parentNode;
    return n ? n.closest("td,th") : null;
  }

  function placeCaretIn(el) {
    if (!el) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function tblInsertRow(offset) {
    const cell = cellFromSelection();
    if (!cell) return;
    const tr = cell.closest("tr");
    if (!tr || !tr.parentNode) return;
    const cols = tr.cells.length;
    const newTr = document.createElement("tr");
    for (let i = 0; i < cols; i++) newTr.appendChild(document.createElement("td"));
    tr.parentNode.insertBefore(newTr, offset < 0 ? tr : tr.nextSibling);
    placeCaretIn(newTr.cells[cell.cellIndex] || newTr.firstElementChild);
  }

  function tblDeleteRow() {
    const cell = cellFromSelection();
    if (!cell) return;
    const tr = cell.closest("tr");
    if (!tr || !tr.parentNode) return;
    if (tr.parentNode.querySelectorAll("tr").length <= 1) return; // 至少保留一行
    const idx = cell.cellIndex;
    const sib = tr.previousElementSibling || tr.nextElementSibling;
    tr.parentNode.removeChild(tr);
    if (sib) placeCaretIn(sib.cells[Math.min(idx, sib.cells.length - 1)] || sib);
  }

  function tblInsertCol(offset) {
    const cell = cellFromSelection();
    if (!cell) return;
    const table = cell.closest("table");
    if (!table) return;
    const idx = cell.cellIndex + (offset < 0 ? 0 : 1);
    const rows = table.rows;
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      const isHeader = tr.parentElement.tagName === "THEAD" ||
        (i === 0 && !table.querySelector("thead"));
      const td = document.createElement(isHeader ? "th" : "td");
      if (idx >= tr.cells.length) tr.appendChild(td);
      else tr.insertBefore(td, tr.cells[idx]);
    }
    const row = cell.closest("tr");
    if (row && row.cells[idx]) placeCaretIn(row.cells[idx]);
  }

  function tblDeleteCol() {
    const cell = cellFromSelection();
    if (!cell) return;
    const table = cell.closest("table");
    if (!table) return;
    const idx = cell.cellIndex;
    const rows = table.rows;
    if (rows.length && rows[0].cells.length <= 1) return; // 至少保留一列
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].cells[idx]) rows[i].deleteCell(idx);
    }
    const row = cell.closest("tr");
    if (row && row.cells.length) {
      const ni = Math.min(idx, row.cells.length - 1);
      placeCaretIn(row.cells[ni]);
    }
  }

  function updateTableEditBar() {
    const inMd = currentFile && currentFile.kind === "markdown";
    const cell = (editor && editor.isContentEditable && inMd) ? cellFromSelection() : null;
    tableEditBar.classList.toggle("show", !!cell);
  }

  tableEditBar.addEventListener("click", function (e) {
    const btn = e.target.closest("button[data-tbl]");
    if (!btn) return;
    switch (btn.getAttribute("data-tbl")) {
      case "row-above": tblInsertRow(-1); break;
      case "row-below": tblInsertRow(1); break;
      case "row-del": tblDeleteRow(); break;
      case "col-left": tblInsertCol(-1); break;
      case "col-right": tblInsertCol(1); break;
      case "col-del": tblDeleteCol(); break;
    }
    updateTableEditBar();
  });

  document.addEventListener("selectionchange", updateTableEditBar);

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
      s.dataset.tip = item.k; s.setAttribute('aria-label', item.k);
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
    if (splitMode) scheduleSyncEditorToSource(); // 手动 DOM 插入不触发 input，需显式同步
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
    // 网页标题跟随当前文件名（无文件时退回"导出文档"）
    let pageTitle = "导出文档";
    if (currentFile && currentFile.path) {
      const _n = currentFile.path.split(/[\\/]/).pop() || "";
      const _stem = _n.replace(/\.[^.]+$/, "").trim();
      if (_stem) pageTitle = _stem;
    }
    return (
      '<!DOCTYPE html>\n' +
      '<html lang="zh-CN">\n' +
      "<head>\n" +
      '<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      "<title>" + pageTitle + "</title>\n" +
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
    if (window.__pdfActive || window.__epubActive) return;
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
    el.textContent = "字数 " + chars + "　编码 " + (enc || "自动") + pos;
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
  /** 把页面 CSS 限制到编辑区内（防止 body / * / #toolbar 等全局选择器污染整个应用外壳）。
    用浏览器原生 CSSOM 解析后改写选择器，相比 @scope 能正确处理 @media/@keyframes/@font-face/@layer 等顶层规则；
    解析失败则回退为原样注入（不阻断编辑）。 */
  function scopeCss(rawCss) {
    const css = String(rawCss || "");
    if (!css.trim()) return css;
    const style = document.createElement("style");
    document.head.appendChild(style);
    style.textContent = css;
    let out = "", imports = "";
    try {
      const sheet = style.sheet;
      if (!sheet) throw new Error("no sheet");
      const rules = sheet.cssRules;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const t = rule.type;
        if (t === CSSRule.STYLE_RULE) {
          out += prefixSelector(rule.selectorText) + " { " + rule.style.cssText + " }\n";
        } else if (rule.cssRules &&
                   t !== CSSRule.KEYFRAMES_RULE &&
                   t !== CSSRule.FONT_FACE_RULE) {
          // 分组型 at-rule（@media / @supports / @container / @layer / 嵌套等）：
          // 递归改写内层选择器，外层用 cssText 的头部原样保留。
          let inner = "";
          for (let j = 0; j < rule.cssRules.length; j++) {
            inner += serializeScopedRule(rule.cssRules[j]) + "\n";
          }
          const head = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
          out += head + " {\n" + inner + "}\n";
        } else {
          // @import / @charset / @font-face / @keyframes 等：保持原样（全局、无害）。
          // @import / @charset 必须位于样式表顶部，单独前置。
          const txt = rule.cssText;
          if (/^@import/i.test(txt) || /^@charset/i.test(txt)) imports += txt + "\n";
          else out += txt + "\n";
        }
      }
    } catch (e) {
      document.head.removeChild(style);
      return css; // 解析失败：回退原样注入
    }
    document.head.removeChild(style);
    return imports + out;
  }

  function serializeScopedRule(rule) {
    if (rule.type === CSSRule.STYLE_RULE) {
      return prefixSelector(rule.selectorText) + " { " + rule.style.cssText + " }";
    }
    if (rule.cssRules && rule.type !== CSSRule.KEYFRAMES_RULE && rule.type !== CSSRule.FONT_FACE_RULE) {
      let inner = "";
      for (let j = 0; j < rule.cssRules.length; j++) inner += serializeScopedRule(rule.cssRules[j]) + "\n";
      const head = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
      return head + " {\n" + inner + "}";
    }
    return rule.cssText; // @keyframes / @font-face 等保持原样
  }

  function prefixSelector(sel) {
    return sel.split(",").map(function (s) {
      s = s.trim();
      if (!s) return s;
      // html / :root / * 等文档级选择器加了 #editor 前缀也不会匹配（编辑区内无这些元素），
      // 自然失效、不污染应用；标签 / 类 / id 选择器则被锁定在 #editor 内。
      return "#editor " + s;
    }).join(", ");
  }

  function injectFileStyle(root) {
    const old = document.getElementById("file-style");
    if (old) old.remove();
    if (!root) return;
    let css = "";
    // 同时扫描 head 与 body 内嵌的 <style>/<link>，避免 body 内样式绕过隔离泄漏到应用外壳
    root.querySelectorAll("style, link[rel='stylesheet']").forEach(function (s) {
      css += (s.textContent || "") + "\n";
      s.remove();
    });
    if (!css.trim()) return;
    // 页面 CSS 经选择器前缀改写锁在 #editor 内，杜绝全局选择器污染应用外壳；
    // 弹窗/遮罩覆盖菜单的问题另由 .editor 的 `contain: paint` 解决。
    const scoped = scopeCss(css);
    const el = document.createElement("style");
    el.id = "file-style";
    el.textContent = scoped;
    document.head.appendChild(el);
  }

  /** 解析并加载 HTML 文本到编辑区（剥离 script/on*，保留样式与标题） */
  function loadHtmlDocument(text) {
    editor.contentEditable = "true";
    closeMdOutline();
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script").forEach(function (s) { s.remove(); });
    stripOnAttributes(doc.documentElement);
    loadedHead = doc.head ? doc.head.innerHTML : "";
    loadedTitle = doc.title || "";
    injectFileStyle(doc.documentElement);   // 全文档(head+body)样式限定到 #editor，含 body 内嵌 <style>
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
    closeMdOutline();
    // 内联渲染（保留动画/渐变等）：SVG 内嵌 <style>/<link> 经 injectFileStyle 限定到 #editor 防泄漏，其余交给 contenteditable
    const svgDoc = new DOMParser().parseFromString(svgText, "text/html");
    svgDoc.querySelectorAll("script").forEach(function (s) { s.remove(); });
    stripOnAttributes(svgDoc.documentElement);
    injectFileStyle(svgDoc.documentElement);
    editor.innerHTML = svgDoc.body ? svgDoc.body.innerHTML : "";
    sourceView.value = svgText;
    enterSplitMode();
    updatePlaceholder();
    updateToolbarState();
  }

  /** 配置 marked：屏蔽 GFM 删除线对 ~ 的误判。
      医学/科学文本常用 ~ 表示“约/范围”（如 1.2~1.5 cm），同一段落出现两处 ~ 时，
      marked 的 ~~ 删除线会把中间整段渲染成 <del>，导致正常内容被加删除线。
      用 inline 扩展把 ~ 当作普通字符，彻底规避误删；标题/加粗/代码/表格等不受影响。 */
  let markedConfigured = false;
  function applyMarkedConfig() {
    if (markedConfigured) return;
    if (!window.marked || !window.marked.use) return;
    window.marked.use({
      extensions: [{
        name: "notilde",
        level: "inline",
        start: function (src) { const i = src.indexOf("~"); return i < 0 ? undefined : i; },
        tokenizer: function (src) {
          const m = /^~+/.exec(src);
          if (m) return { type: "notilde", raw: m[0], text: m[0] };
          return false;
        },
        renderer: function (token) { return token.text; }
      }]
    });
    markedConfigured = true;
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
    refreshAfterRender();
    scheduleOutline();
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

  /** 把 <table> 序列化为 GFM 表格（| a | b |\n|---|---|）。turndown 核心不支持表格，
      不注册此规则则保存时表格结构会被压成零散文本、丢失行列关系。 */
  function tableToMd(node) {
    const rows = Array.prototype.slice.call(node.rows || []);
    if (!rows.length) return "";
    const clean = function (cell) {
      return (cell.textContent || "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
    };
    const numCols = rows.reduce(function (m, tr) { return Math.max(m, tr.cells.length); }, 0);
    if (!numCols) return "";
    const lines = [];
    rows.forEach(function (tr, ri) {
      const cells = Array.prototype.slice.call(tr.cells || []);
      const vals = [];
      for (let i = 0; i < numCols; i++) vals.push(clean(cells[i] || { textContent: "" }));
      lines.push("| " + vals.join(" | ") + " |");
      if (ri === 0) {
        const sep = [];
        for (let i = 0; i < numCols; i++) sep.push("---");
        lines.push("| " + sep.join(" | ") + " |");
      }
    });
    return "\n" + lines.join("\n") + "\n";
  }

  /** 初始化 turndown（规则与 serializeMarkdown 完全一致；懒加载，供分栏块级映射复用） */
  function ensureTurndownService() {
    if (turndownService || !window.TurndownService) return;
    turndownService = new window.TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    // 非编辑岛（Mermaid / KaTeX）回写为围栏代码块，保证往返零损失
    turndownService.addRule("mdDynamicBlock", {
      filter: function (node) {
        return node.nodeName === "DIV" && node.classList && node.classList.contains("md-block");
      },
      replacement: function (content, node) {
        const lang = node.getAttribute("data-md-lang") || "";
        const src = (node.getAttribute("data-md-source") || "").replace(/\n+$/, "");
        return "\n\n```" + lang + "\n" + src + "\n```\n\n";
      },
    });
    // GFM 表格：整表直接转写，避免 turndown 默认行为丢失结构
    turndownService.addRule("gfmTable", {
      filter: "table",
      replacement: function (content, node) { return tableToMd(node); },
    });
  }

  /** 把编辑区内容序列化为 Markdown 文本（turndown） */
  function serializeMarkdown() {
    if (!window.TurndownService) return editor.innerHTML; // 退化
    ensureTurndownService();
    return turndownService.turndown(editor.innerHTML);
  }

  /** 估算 MD 往返文本丢失比例：比较编辑器 HTML 可见文本 与 序列化后 MD 文本。
   *  turndown 在复杂嵌套下可能静默丢内容，保存前做一次粗粒度核对，差异过大则提示（不阻断保存）。 */
  function estimateMdTextLoss(html, md) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    const hText = (tmp.textContent || "").replace(/\s+/g, "");
    const mText = (md || "").replace(/\s+/g, "");
    if (!hText.length) return 0;
    return (hText.length - mText.length) / hText.length;
  }

  /** 检测编辑区中 Markdown 表达不了的格式（保存 .md 后重新打开会丢失），返回中文名列表 */
  function detectMdFormatLoss() {
    const html = editor.innerHTML;
    const out = [];
    if (/<u[\s>]/i.test(html) || /text-decoration[^;">]*underline/i.test(html) || /<font\b/i.test(html)) out.push("下划线");
    if (/<span[^>]*style="[^"]*(color|background)[^"]*"/i.test(html)) out.push("颜色/高亮");
    if (/<video\b/i.test(html)) out.push("视频");
    if (/<iframe\b/i.test(html)) out.push("嵌入网页");
    return out;
  }

  /* ============================ Markdown 动态块（Mermaid / KaTeX 非编辑岛） ============================ */
  let mermaidReady = false, mermaidSeq = 0;

  /** 把 ```mermaid / ```math 围栏块渲染成只读岛；保存时由 turndown 规则还原为围栏块，往返零损失。
      库未加载时保留原始 <pre><code> 退化为纯文本，不阻断编辑。 */
  function renderMdDynamicBlocks(root) {
    if (!root) return Promise.resolve();
    const doc = root.ownerDocument || document;
    // 清理 mermaid 历史遗留的临时节点：mermaid.render 会在 body 留下以 id 命名的临时元素，
    // 解析失败时把 "Syntax error in text" 塞进去且不清空 → 错误框残留在界面。先清掉。
    doc.querySelectorAll('[id^="mmd-"], [id^="dmmd-"]').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    const blocks = root.querySelectorAll("pre > code");
    const tasks = [];
    blocks.forEach(function (code) {
      const pre = code.parentNode;
      if (!pre || pre.nodeName !== "PRE" || pre.__mdRendered) return;
      const cls = code.className || "";
      const m = cls.match(/language-([\w-]+)/);
      const lang = m ? m[1].toLowerCase() : "";
      if (lang !== "mermaid" && lang !== "math" && lang !== "katex") return;
      const source = (code.textContent || "").trim(); // 去首尾空白，避免尾换行/首行空导致解析失败
      const div = document.createElement("div");
      div.className = "md-block md-" + lang;
      div.setAttribute("data-md-lang", lang);
      div.setAttribute("data-md-source", source);
      div.contentEditable = "false";
      pre.__mdRendered = true; // 立即标记，防止重入重复处理
      if (lang === "mermaid" && window.mermaid) {
        if (!mermaidReady) { try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose" }); } catch (e) {} mermaidReady = true; }
        const id = "mmd-" + (mermaidSeq++);
        const cleanupMmd = function () {
          ["d" + id, id].forEach(function (eid) {
            const el = doc.getElementById(eid);
            if (el && el.parentNode) el.parentNode.removeChild(el);
          });
        };
        const fail = function (err) {
          cleanupMmd();
          div.textContent = source;
          div.dataset.tip = "Mermaid 渲染失败：" + (err && err.message ? err.message : String(err)); div.setAttribute('aria-label', "Mermaid 渲染失败：" + (err && err.message ? err.message : String(err)));
          div.classList.add("md-block-error");
          if (pre.parentNode) pre.parentNode.replaceChild(div, pre);
        };
        let p;
        try {
          p = window.mermaid.render(id, source);
        } catch (e) {
          fail(e);
          return;
        }
        tasks.push(p.then(function (res) {
          cleanupMmd();
          div.innerHTML = res.svg || "";
          if (pre.parentNode) pre.parentNode.replaceChild(div, pre);
        }).catch(fail));
      } else if ((lang === "math" || lang === "katex") && window.katex) {
        try {
          div.innerHTML = window.katex.renderToString(source, { displayMode: true, throwOnError: false });
          if (pre.parentNode) pre.parentNode.replaceChild(div, pre);
        } catch (e) {
          div.textContent = source;
          if (pre.parentNode) pre.parentNode.replaceChild(div, pre);
        }
      } else {
        // 对应库缺失：撤销标记，保留原始 <pre><code> 不动
        pre.__mdRendered = false;
      }
    });
    return Promise.all(tasks).catch(function () {});
  }

  /** 关闭代码块 / 内联 code 的原生拼写检查，避免标识符被划红线 */
  function applySpellcheckExceptions(root) {
    if (!root) return;
    root.querySelectorAll("pre, code").forEach(function (el) { el.spellcheck = false; });
  }

  /** 载入 / 同步后统一收尾：渲染动态块 + 关闭代码拼写 */
  function refreshAfterRender() {
    invalidateSplitMap(); // 编辑区 DOM 整体重建（打开文件/撤销重做）后映射失效
    renderMdDynamicBlocks(editor).catch(function () {});
    applySpellcheckExceptions(editor);
  }

  /* ============================ Markdown 大纲 ============================ */
  let outlineTimer = null;
  function scheduleOutline() {
    if (outlineTimer) clearTimeout(outlineTimer);
    outlineTimer = setTimeout(buildMdOutline, 250);
  }
  function closeMdOutline() {
    if (editorWrap) editorWrap.classList.remove("outline-open");
    if (mdOutline) mdOutline.classList.add("hidden");
    const olBtn = toolbar.querySelector('[data-action="outline"]');
    if (olBtn) olBtn.classList.remove("active");
  }
  function toggleMdOutline() {
    if (!currentFile || currentFile.kind !== "markdown") { showToast("大纲仅对 Markdown 文档可用"); return; }
    const open = editorWrap.classList.toggle("outline-open");
    if (mdOutline) mdOutline.classList.toggle("hidden", !open);
    const olBtn = toolbar.querySelector('[data-action="outline"]');
    if (olBtn) olBtn.classList.toggle("active", open);
    if (open) buildMdOutline();
  }
  function buildMdOutline() {
    if (!mdOutlineList) return;
    const heads = editor ? editor.querySelectorAll("h1,h2,h3,h4,h5,h6") : [];
    mdOutlineList.innerHTML = "";
    if (!heads.length) {
      const tip = document.createElement("div");
      tip.className = "pdf-outline-empty";
      tip.style.padding = "8px";
      tip.textContent = "（文档无标题）";
      mdOutlineList.appendChild(tip);
      return;
    }
    heads.forEach(function (h, idx) {
      const level = parseInt(h.tagName.substring(1), 10) || 1;
      const a = document.createElement("a");
      a.dataset.idx = String(idx);
      a.style.paddingLeft = (8 + (level - 1) * 12) + "px";
      a.textContent = h.textContent.trim() || ("H" + level);
      a.dataset.tip = a.textContent; a.setAttribute('aria-label', a.textContent);
      a.addEventListener("click", function () {
        const list = editor.querySelectorAll("h1,h2,h3,h4,h5,h6");
        const target = list[idx];
        if (!target) return;
        target.scrollIntoView({ block: "start" });
        try {
          const r = document.createRange(); r.setStart(target, 0); r.collapse(true);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          editor.focus();
        } catch (e) {}
        mdOutlineList.querySelectorAll("a.active").forEach(function (x) { x.classList.remove("active"); });
        a.classList.add("active");
      });
      mdOutlineList.appendChild(a);
    });
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

  /** 按路径打开文件（供对话框与拖放共用）
   * @param {string} path 文件路径 */
  async function openFileWithPath(path) {
    if (!TAURI) { setStatus("当前环境不支持文件读取。", true); return; }
    const lower = path.toLowerCase();
    if (lower.endsWith(".pdf")) {
      if (window.__epubActive) exitEpub();   // 若当前在 EPUB 模式，先退出避免双视图叠加（epub-root 残留会压扁 PDF）
      if (window.__pdfActive && window.PDFApp) window.PDFApp.close();
      if (window.PDFApp) window.PDFApp.open(path);
      currentFile = { path: path, kind: "pdf" };
      refreshSiblings();
      setFilePath(path, true);   // 与 EPUB 分支一致：入口处维护路径与「打开位置」按钮状态（pdf.js 内的 setFilePath 仍会再次同步）
      return;
    }
    // EPUB：交给 EPUB 只读阅读视图，不走文本编辑器
    if (lower.endsWith(".epub")) {
      if (window.__pdfActive && window.PDFApp) window.PDFApp.close();   // 若当前在 PDF 模式，先退出避免双视图叠加
      if (window.__epubActive) exitEpub();
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
    renderToolbar();   // 文档类型可能切换（md↔html），重算 htmlOnly 按钮显隐
    setFilePath(res.path, true);
    refreshSiblings();
    if (res.kind === "markdown") {
      loadMarkdown(res.content);
      savedSignature = serializeMarkdown();   // 以 turndown 序列化结果为基线（与 contentSignature 同表示）
    } else if (res.kind === "svg") {
      loadSvg(res.content);
      savedSignature = res.content;           // SVG 源码即真相
    } else {
      loadHtmlDocument(res.content);
      savedSignature = editor.innerHTML;      // 浏览器规范化后的 innerHTML（与 contentSignature 同表示）
    }
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
    // 兜底清场：若 PDF 视图仍开着（调用方未先 PDFApp.close()），直接收起其容器。
    // 与 pdf.js open() 的清场对称——接管方自清场，不依赖调用方守卫，防双视图堆叠。
    const pr = document.querySelector(".pdf-root");
    if (pr) pr.classList.add("hidden");
    const ew = document.getElementById("editor-wrap");
    if (ew) ew.style.display = "none";
    const tb = document.getElementById("toolbar");
    if (tb) tb.classList.add("hidden");
    const root = document.getElementById("epub-root");
    if (root) root.classList.remove("hidden");
    // EPUB 自带顶部信息栏（目录/章节/查找/退出）；主状态栏在此模式下无意义且会顶到页面上方，隐藏之。
    // 全局应用栏（打开位置/定制/主题）保留可见，避免 EPUB 模式下顶部菜单整体丢失；编码选框隐藏（对 EPUB 无意义）。
    updateEncodingVisible();
    const stb = document.querySelector(".status-bar");
    if (stb) stb.classList.add("hidden");
    window.__epubPath = path;   // 供「打开位置」在 EPUB 模式下定位当前文件
    setFilePath(path, true);   // 显示 EPUB 路径并启用「打开位置」按钮（该按钮在全局顶栏 header）
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

  /** EPUB 阅读视图基础排版（注入 Shadow DOM，供章节内容兜底；出版社自带 <style> 在其后注入、冲突时优先生效）。
      全部用字面色，不依赖应用 CSS 变量（影子树内 :root 变量虽可继承，但字面色更稳）。 */
  const EPUB_BASE_CSS = [
    "img,svg{max-width:100%;height:auto;display:block;margin:12px auto;}",
    "pre{white-space:pre-wrap;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;padding:12px 14px;overflow-x:auto;}",
    "a{color:#2563eb;}",
    "blockquote{border-left:4px solid #d1d5db;margin:1em 0;padding:.4em 1em;color:#4b5563;background:#f9fafb;}",
    "table{border-collapse:collapse;width:100%;margin:1em 0;}",
    "td,th{border:1px solid #d1d5db;padding:8px;}",
    "h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.2em 0 .6em;}",
    "code{background:#f3f4f6;padding:.15em .4em;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:.9em;}",
    "hr{border:none;border-top:1px solid #d1d5db;margin:1.5em 0;}",
    "ul,ol{margin:.6em 0;padding-left:1.6em;}",
    "mark{background:#ffe58f;color:inherit;border-radius:2px;padding:0 1px;}",
    "mark.current{background:#ff9c3f;}"
  ].join("\n");

  /**
   * 把第三方 HTML 渲染进宿主元素的 Shadow DOM：其内 <style>/<link> 按规范仅作用于影子子树，
   * 结构上不可能泄漏到应用外壳（顶栏/工具栏），同时 100% 保留文档自带排版（表格/字体等）。
   * 仅剥离 <script>/on* 防 XSS；解析失败退回原文（宁可样式泄漏也别丢内容）。
   */
  function renderIntoIsolatedHost(host, html, baseCss) {
    if (!host) return;
    let sr = host.shadowRoot;
    if (!sr) sr = host.attachShadow({ mode: "open" });
    let cleaned = String(html || "");
    try {
      const doc = new DOMParser().parseFromString(cleaned, "text/html");
      doc.querySelectorAll("script").forEach(function (s) { s.remove(); });
      stripOnAttributes(doc.documentElement);
      // 收集 head/body 内全部 <style>/<link>（解析器可能把 <style> 移入 head），内联回影子树，
      // 既保留文档自带排版（表格/字体），又靠 Shadow DOM 封装不泄漏到应用外壳。
      let styles = "";
      doc.querySelectorAll("style, link[rel='stylesheet']").forEach(function (s) {
        styles += s.outerHTML;
        s.remove();
      });
      const bodyHtml = doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;
      cleaned = styles + bodyHtml;
    } catch (e) { /* 解析失败时保留原文 */ }
    // baseCss 在前、出版社样式在后：冲突时出版社优先生效（保真）
    sr.innerHTML = (baseCss ? "<style>" + baseCss + "</style>" : "") + cleaned;
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
    if (content) renderIntoIsolatedHost(content, "<p style='padding:24px;color:#6b7280'>正在加载章节…</p>", EPUB_BASE_CSS);
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
          renderIntoIsolatedHost(content, res.html || "", EPUB_BASE_CSS);
          content.scrollTop = 0;
        }
      })
      .catch(function (e) {
        if (content) renderIntoIsolatedHost(content, "<p style='padding:24px;color:#c0392b'>章节加载失败：" + String(e) + "</p>", EPUB_BASE_CSS);
      });
  }

  function exitEpub() {
    window.__epubActive = false;
    updateEncodingVisible();   // 回到编辑界面，恢复编码选框
    const root = document.getElementById("epub-root");
    if (root) root.classList.add("hidden");
    const ew = document.getElementById("editor-wrap");
    if (ew) ew.style.display = "";
    const tb = document.getElementById("toolbar");
    if (tb) tb.classList.remove("hidden");
    const stb = document.querySelector(".status-bar");
    if (stb) stb.classList.remove("hidden");
    window.__epubPath = null;   // 清除 EPUB 路径标记，恢复「打开位置」对普通文档的定位
    setFilePath("", false);   // 退出阅读后无活动文档：复位路径指示并禁用「打开位置」
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
      const root = content.shadowRoot || content;
      const marks = root.querySelectorAll("mark");
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
    const walker = document.createTreeWalker(content.shadowRoot || content, NodeFilter.SHOW_TEXT, null);
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
      const loss = estimateMdTextLoss(editor.innerHTML, content);
      if (loss > 0.15) {
        showToast("⚠️ 保存的 MD 可能丢失约 " + Math.round(loss * 100) + "% 文本，建议另存备份核对");
        setStatus("⚠️ MD 往返可能丢失内容，已照常保存：" + path, true);
      }
    } else if (kind === "svg") {
      content = sourceView.value; // SVG 源码即真相
    } else {
      content = buildFullDocument();
    }
    try {
      const enc = (getConfig().defaultEncoding || "") || undefined;
      await tauriInvoke("save_file", { path, kind, content, encoding: enc });
      setStatus("已保存：" + path);
      savedSignature = contentSignature();   // 关闭保护基线：以"刚落盘的内容"为准
      if (kind === "markdown") {
        const lossy = detectMdFormatLoss();
        if (lossy.length) {
          showToast("已保存。Markdown 不支持：" + lossy.join("、") + "，重新打开会丢失");
        }
      }
      return { ok: true, content: content };   // 供另存为做跨格式重载
    } catch (e) {
      setStatus("保存失败：" + e, true);
      return { ok: false, content: null };
    }
  }

  /** 保存：有打开的文件则写回，否则走"另存为" */
  async function saveFile() {
    // PDF 模式下，保存走 PDF 模块（写回旋转 / 备注）
    if (window.__pdfActive && window.PDFApp) { window.PDFApp.save(); return; }
    if (sourceMode) applySourceToEditor();
    // 仅当已有关联路径才写回；path 为 null（新建未保存的文档）走"另存为"。
    if (currentFile && currentFile.path) {
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
    // 源码模式下右侧是唯一真相：先回填编辑区再序列化，防止另存内容陈旧
    if (sourceMode) applySourceToEditor();
    // 过滤器按当前文档格式动态排序：Windows 对话框默认选中首个过滤器，
    // 因此把"正在编辑的格式"放首位——打开 md 默认存 md，打开 html 默认存 html；
    // 未打开/空白文档默认 md（日常以写 md 为主）。
    const _curKind = (currentFile && currentFile.kind) || "markdown";
    const _allFilters = [
      { name: "Markdown", extensions: ["md"], k: "markdown" },
      { name: "HTML", extensions: ["html"], k: "html" },
      { name: "SVG", extensions: ["svg"], k: "svg" },
      { name: "PDF", extensions: ["pdf"], k: "pdf" },
    ].sort(function (a, b) { return (a.k === _curKind ? -1 : 1) - (b.k === _curKind ? -1 : 1); })
     .map(function (f) { return { name: f.name, extensions: f.extensions }; });
    let path;
    try {
      path = await tauriSave({ filters: _allFilters });
    } catch (e) {
      setStatus("保存失败：" + e, true);
      return;
    }
    if (!path) return;
    if (/\.pdf$/i.test(path)) { await exportEditorPDF(path); return; }
    // 自动补全扩展名：用户未输入扩展名时按当前文档类型补齐（Windows 保存框未自动补时兜底）。
    // 未打开任何文档时默认补 .md（日常以写 md 为主）；html 文档另存仍补 .html。
    const _base = path.split(/[\\/]/).pop();
    if (!/\./.test(_base)) {
      const _ext = (currentFile && currentFile.kind === "markdown") ? ".md"
                 : (currentFile && currentFile.kind === "svg") ? ".svg"
                 : (currentFile && currentFile.kind === "html") ? ".html"
                 : ".md";
      path += _ext;
    }
    const kind = detectKindFromPath(path);
    // md → html 特例：不切换编辑对象（md 渲染成的 html 没有继续编辑的价值），
    // 而是写一份带排版样式的独立网页（与「导出」同产物），当前文档仍是 .md。
    // 未保存的新草稿除外——用户正在给文档命名，按真正的转格式处理。
    if (kind === "html" && currentFile && currentFile.kind === "markdown" && currentFile.path) {
      try {
        const enc = (getConfig().defaultEncoding || "") || undefined;
        await tauriInvoke("save_file", { path, kind: "html", content: buildExportDocument(), encoding: enc });
        showToast("已存为独立网页，当前仍编辑原 Markdown 文档");
      } catch (e) {
        setStatus("保存失败：" + e, true);
      }
      return;
    }
    const prevKind = currentFile ? currentFile.kind : null;
    currentFile = { path, kind };
    renderToolbar();   // 另存为可能改类型（如草稿存成 html），重算 htmlOnly 按钮显隐
    // 同步首屏路径指示与"打开位置"按钮（否则另存为之后仍显示"未打开文件"且按钮灰掉）
    setFilePath(path, true);
    const name = path.split(/[\\/]/).pop() || path;
    const r = await saveFileWithContent(path, kind);
    // 跨格式另存（如 html→md）：当前窗口接管新文件身份，按新格式重载视图。
    // 不重载的话：分栏右侧还是按旧格式填的源码、工具栏重渲染后 active 态丢失。
    // （md→html 特例已在上面提前返回；md→md / html→html 同格式无需重载。）
    if (r && r.ok && prevKind && prevKind !== kind) {
      if (kind === "svg" && prevKind !== "svg") {
        // 内容不是 SVG 源码（是 md/html 文本），存出的 .svg 无法正常预览，仅提示不重载
        showToast("已按原文本存为 .svg，但内容并非 SVG 源码，图形预览可能为空");
      } else {
        reloadAfterTranscode(kind, r.content);
        setFilePath(path, true);   // 重载内部可能重置路径指示，这里再钉一次
      }
    }
    // 标题放重载之后：loadMarkdown 会把标题重置回「墨笺」
    try { document.title = name + " · 墨笺"; } catch (e) {}
  }

  /** 跨格式另存后按新格式重载视图：等价于"重新打开刚存的文件"，但保留用户当前的
   *  分栏 / 原文视图模式。内容以刚落盘的文本为准（新格式下的规范形态）。 */
  function reloadAfterTranscode(kind, content) {
    const wasSplit = splitMode, wasSource = sourceMode;
    if (sourceMode) exitSourceMode();
    else if (splitMode) exitSplitMode();
    if (kind === "markdown") {
      loadMarkdown(content);
      savedSignature = content;
    } else if (kind === "svg") {
      loadSvg(content);        // 内部已进入分栏（左预览右源码）
      savedSignature = content;
    } else {
      loadHtmlDocument(content);
      savedSignature = editor.innerHTML;
    }
    if (kind !== "svg") {
      if (wasSplit) enterSplitMode();
      else if (wasSource) enterSourceMode();
    }
    invalidateSplitMap();
  }

  /** 另存为 PDF：复用浏览器打印管线（与 PDF 模块 printPdf 同机制），
   *  经系统「另存为 PDF / Microsoft Print to PDF」落盘，文件名预填为用户所选。
   *  说明：打印对话框由系统接管，最终文件位置/文件名在对话框中确认；
   *  这里只负责把编辑器内容排成可打印文档并以所选名字预填对话框。 */
  async function exportEditorPDF(pdfPath) {
    const content = editor.innerHTML;
    const styleCss =
      ".ep-body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto," +
      "\"Helvetica Neue\",Arial,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;" +
      "line-height:1.7;color:#1f2937;max-width:820px;margin:0 auto;padding:24px;}" +
      ".ep-body h1,.ep-body h2,.ep-body h3,.ep-body h4,.ep-body h5,.ep-body h6{line-height:1.3;margin:1.2em 0 .6em;}" +
      ".ep-body h1{font-size:2em;} .ep-body h2{font-size:1.6em;} .ep-body h3{font-size:1.3em;} .ep-body h4{font-size:1.1em;}" +
      ".ep-body p{margin:.6em 0;}" +
      ".ep-body a{color:#2563eb;}" +
      ".ep-body blockquote{border-left:4px solid #d1d5db;margin:1em 0;padding:.4em 1em;color:#4b5563;background:#f9fafb;}" +
      ".ep-body code{background:#f3f4f6;padding:.15em .4em;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:.9em;}" +
      ".ep-body pre{background:#f3f4f6;padding:12px;border-radius:6px;overflow:auto;}" +
      ".ep-body pre code{background:none;padding:0;}" +
      ".ep-body table{border-collapse:collapse;width:100%;margin:1em 0;}" +
      ".ep-body td,.ep-body th{border:1px solid #d1d5db;padding:8px;}" +
      ".ep-body img{max-width:100%;height:auto;}" +
      ".ep-body hr{border:none;border-top:1px solid #d1d5db;margin:1.5em 0;}" +
      ".ep-body ul,.ep-body ol{margin:.6em 0;padding-left:1.6em;}" +
      "@media print{.ep-body{max-width:none;margin:0;}}";
    const container = document.createElement("div");
    container.id = "editor-print";
    container.innerHTML = "<style>" + styleCss + "</style><div class=\"ep-body\">" + content + "</div>";
    document.body.appendChild(container);
    const oldTitle = document.title;
    const base = (pdfPath.split(/[\\/]/).pop() || "document").replace(/\.pdf$/i, "");
    document.title = base; // 让打印对话框默认文件名取用户所选
    setStatus("已调起打印：在对话框中选择「另存为 PDF / Microsoft Print to PDF」，文件名默认为「" + base + "」");
    setTimeout(function () {
      window.print();
      setTimeout(function () {
        if (container.parentNode) container.parentNode.removeChild(container);
        document.title = oldTitle;
      }, 500);
    }, 120);
  }

  /** 监听窗口拖放（Tauri dragDropEnabled + tauri://drag-drop 事件） */
  /** 拖放落盘 → 多实例：每个拖入文件各占一个独立窗口。
      当前窗口无文件时首个在本窗打开（避免留空窗），其余各开新实例；
      当前窗口已有文件时全部开新实例，不打扰当前编辑内容。 */
  function handleDroppedFiles(paths) {
    /* 空白实例（无文件且无未保存内容）= 用户刚开的空窗口：
     * 拖入的文档直接就地打开——多个文件时最后一个开在这里，其余各开新实例；
     * 非空白窗口（已有文档或有未保存内容）不覆盖现状，全部开新实例。 */
    const hasDoc = !!(currentFile && currentFile.path) || hasUnsavedChanges();
    if (hasDoc) {
      for (let i = 0; i < paths.length; i++) openInNewInstance(paths[i]);
      return;
    }
    for (let i = 0; i < paths.length - 1; i++) openInNewInstance(paths[i]);
    openFileWithPath(paths[paths.length - 1]);
  }

  /** 在新窗口中打开文件（独立应用实例）。Rust 侧 open_new_instance 经
      initialization_script 注入 window.__OPEN_PATH__，新窗口 init 检测到后自动加载。 */
  function openInNewInstance(path) {
    if (!TAURI) return;
    tauriInvoke("open_new_instance", { path: path }).catch(function (e) {
      setStatus("打开新实例失败：" + e, true);
    });
  }

  async function setupDragDrop() {
    if (!TAURI) return;
    try {
      await tauriListen("tauri://drag-drop", function (event) {
        const paths = (event && event.payload && event.payload.paths) || [];
        if (!paths.length) return;
        handleDroppedFiles(paths);
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
    // 源码栏把 zoom 加在容器 .source-view-wrap 上（textarea 铺满容器，zoom 容器即同步缩放文本域）。
    const sv = document.getElementById("source-view-wrap");
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

  /** 同步源码/分栏/大纲按钮高亮态 */
  function setSourceBtnActive() {
    const srcBtn = toolbar.querySelector('[data-action="source"]');
    if (srcBtn) srcBtn.classList.toggle("active", sourceMode || splitMode);
    const spBtn = toolbar.querySelector('[data-action="split"]');
    if (spBtn) spBtn.classList.toggle("active", splitMode);
    const olBtn = toolbar.querySelector('[data-action="outline"]');
    if (olBtn) olBtn.classList.toggle("active", !!(editorWrap && editorWrap.classList.contains("outline-open")));
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
    if (editorWrap) editorWrap.classList.add("source");
    toolbar.classList.add("source-mode");
    setSourceBtnActive();
    sourceFind = null;
    sourceView.focus();
    highlightSource();
  }

  function exitSourceMode() {
    if (!sourceMode) return;
    applySourceToEditor();
    sourceView.style.display = "none";
    editor.style.display = "";
    sourceMode = false;
    if (editorWrap) editorWrap.classList.remove("source");
    toolbar.classList.remove("source-mode");
    setSourceBtnActive();
    sourceFind = null;
    editor.focus();
  }

  /** 进入分栏：左渲染区 + 右源码并排显示，双向防抖同步 */
  function enterSplitMode() {
    if (splitMode) return;
    if (sourceMode) exitSourceMode();
    invalidateSplitMap(); // 重新进入分栏：块级映射按当前内容重建
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
    sourceFind = null;
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
    sourceFind = null;
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
    // 新建一律开新窗口实例：当前窗口内容原样保留，不再就地清空。
    // Rust 侧 open_new_instance 收到 newKind 后注入 window.__NEW_KIND__，
    // 新窗口 init 按空白文档启动（跳过 argv 文件关联，避免误读进程参数）。
    if (TAURI_CORE) {
      try {
        await tauriInvoke("open_new_instance", { path: "", newKind: kind });
        setStatus("已在新窗口新建" + (kind === "html" ? " HTML 文档" : " Markdown 文档"));
      } catch (e) {
        setStatus("新建窗口失败：" + e, true);
      }
      return;
    }
    // 无 Tauri（浏览器 / 无头测试环境）退回旧的就地清空行为
    if (sourceMode) exitSourceMode();
    editor.contentEditable = "true";
    editor.innerHTML = "";
    currentFile = { path: null, kind: kind };
    renderToolbar();   // md↔html 新建切换，重算 htmlOnly 按钮显隐
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
      filePathEl.dataset.tip = path || ""; filePathEl.setAttribute('aria-label', path || "");
    }
    if (folderBtn) folderBtn.disabled = !hasFile;
  }

  async function openContainingFolder() {
    const path = (currentFile && currentFile.path) || window.__pdfPath || window.__epubPath || null;
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
   * 关闭保护：有未保存修改时拦截关窗，弹「保存并关闭 / 直接关闭 / 取消」
   * ===================================================================== */
  function currentWindow() {
    try {
      return (TAURI.window && TAURI.window.getCurrentWindow) ? TAURI.window.getCurrentWindow() : null;
    } catch (e) { return null; }
  }

  /** 当前内容签名（与 savedSignature 同一表示，可直接对比）；
   *  PDF / EPUB 模式有各自的保存语义，返回 null 跳过守卫 */
  function contentSignature() {
    if (!currentFile || window.__pdfActive || window.__epubActive) return null;
    if (currentFile.kind === "svg") return sourceView.value;   // SVG 源码即真相
    if (sourceMode) return sourceView.value;                    // 源码模式下右侧是唯一真相
    if (currentFile.kind === "markdown") return serializeMarkdown();
    return editor.innerHTML;
  }

  function hasUnsavedChanges() {
    if (closeBypass) return false;
    const sig = contentSignature();
    if (sig === null) return false;
    return sig !== savedSignature;
  }

  /** 注册关窗拦截：无修改直接放行（不 preventDefault 即默认关闭）；
   *  有修改则弹确认框。注册失败（旧运行时）时静默退化为系统默认行为。 */
  function setupCloseGuard() {
    const win = currentWindow();
    if (!win || !win.onCloseRequested) return;
    try {
      win.onCloseRequested(async function (event) {
        if (!hasUnsavedChanges()) return;
        event.preventDefault();
        const cd = document.getElementById("close-dialog");
        if (cd) openModal(cd);
      });
    } catch (e) {}
  }

  function destroyCurrentWindow() {
    closeBypass = true;   // destroy 不再触发 onCloseRequested，标志位双保险
    const win = currentWindow();
    if (win && win.destroy) win.destroy();
  }

  /* 关闭确认弹窗接线 */
  const closeDialog = document.getElementById("close-dialog");
  if (closeDialog) {
    const cc = document.getElementById("close-cancel");
    const cdx = document.getElementById("close-discard");
    const cs = document.getElementById("close-save");
    if (cc) cc.addEventListener("click", function () { closeModal(closeDialog); });
    if (cdx) cdx.addEventListener("click", function () {
      closeModal(closeDialog);
      destroyCurrentWindow();
    });
    if (cs) cs.addEventListener("click", async function () {
      // 保存并关闭：写回成功（签名一致）才真正关窗；另存对话框被取消则留在编辑器
      if (currentFile && currentFile.path) await saveFile();
      else await saveFileAs();
      if (!hasUnsavedChanges()) {
        closeModal(closeDialog);
        destroyCurrentWindow();
      }
    });
    closeDialog.addEventListener("click", function (e) { if (e.target === closeDialog) closeModal(closeDialog); });
  }

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

  /* 编码选框只对文本类文档有意义：PDF / EPUB 模式下连同「编码」标签一起隐藏。
   * pdf.js open()/close() 与 enterEpub/exitEpub 在模式切换点调用本函数（全局挂载）。 */
  function updateEncodingVisible() {
    const hide = !!(window.__pdfActive || window.__epubActive);
    const sel = document.getElementById("encoding-select");
    const lab = document.getElementById("encoding-label");
    if (sel) sel.classList.toggle("hidden", hide);
    if (lab) lab.classList.toggle("hidden", hide);
  }
  window.__updateEncodingVisible = updateEncodingVisible;

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
  let renderFind = null;    // 渲染区匹配：{ matches:[{node,start,end}], query, cs, idx }
  let sourceFind = null;    // 源码区匹配：{ matches:[pos...], query, cs, idx }
  let lastFindSide = "editor"; // 分栏模式：查找/替换跟随当前聚焦面板（editor 渲染区 / source 源码）

  // 编辑内容会移动匹配位置，使已构建的查找结果失效
  function invalidateFind() { renderFind = null; sourceFind = null; }

  // 把命中的 range 精确垂直居中到渲染区滚动容器（.editor-wrap）
  function scrollRangeToCenter(range) {
    const wrap = editor.parentElement;
    if (!wrap) return;
    const rect = range.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const targetY = rect.top - wrapRect.top + rect.height / 2; // 命中点在容器内的相对位置
    wrap.scrollTop = Math.max(0, wrap.scrollTop + targetY - wrap.clientHeight / 2);
  }

  function openFindBar() {
    // 先记录当前聚焦的面板（在焦点转移给查找框之前），用于分栏模式跟随鼠标所在侧
    const ae = document.activeElement;
    if (ae === sourceView) lastFindSide = "source";
    else if (ae === editor || (editor && editor.contains(ae))) lastFindSide = "editor";
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
    renderFind = null;
    sourceFind = null;
  }
  /* ---------- 渲染区查找：遍历所有文本节点，记录每一处出现，支持上/下翻 ---------- */
  function buildRenderMatches(q, cs) {
    const out = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.textContent) continue;
      const text = cs ? n.textContent : n.textContent.toLowerCase();
      const needle = cs ? q : q.toLowerCase();
      let from = 0, p;
      while ((p = text.indexOf(needle, from)) !== -1) {
        out.push({ node: n, start: p, end: p + q.length });
        from = p + q.length;
      }
    }
    return out;
  }
  function selectAndCenter(r) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(r.node, r.start);
    range.setEnd(r.node, r.end);
    sel.addRange(range);
    scrollRangeToCenter(range);
  }
  function stepRender(forward) {
    if (!renderFind || !renderFind.matches.length) return -1;
    const m = renderFind.matches;
    let ni = renderFind.idx < 0 ? (forward ? -1 : 0) : renderFind.idx;
    ni = forward ? ni + 1 : ni - 1;
    if (ni >= m.length) ni = 0;
    if (ni < 0) ni = m.length - 1;
    return ni;
  }
  function doFind(forward) {
    if (sourceMode) { doFindSource(forward); return; }
    if (splitMode && lastFindSide === "source") { doFindSource(forward); return; }
    if (!findInput) return;
    const q = findInput.value;
    if (!q) return;
    const cs = !!(findCase && findCase.checked);
    if (!renderFind || renderFind.query !== q || renderFind.cs !== cs) {
      renderFind = { matches: buildRenderMatches(q, cs), query: q, cs: cs, idx: -1 };
    }
    if (!renderFind.matches.length) { setStatus("未找到：" + q); return; }
    const ni = stepRender(forward);
    renderFind.idx = ni;
    selectAndCenter(renderFind.matches[ni]);
    setStatus("匹配：" + (ni + 1) + " / " + renderFind.matches.length);
  }
  function replaceCurrent() {
    if (sourceMode) { replaceCurrentSource(); return; }
    if (splitMode && lastFindSide === "source") { replaceCurrentSource(); return; }
    if (!renderFind || renderFind.idx < 0) { doFind(true); if (!renderFind || renderFind.idx < 0) return; }
    const r = renderFind.matches[renderFind.idx];
    const q = renderFind.query;
    const repl = replaceInput ? replaceInput.value : "";
    const node = r.node;
    const text = node.textContent;
    const before = editor.innerHTML;
    node.textContent = text.slice(0, r.start) + repl + text.slice(r.end);
    if (editor.innerHTML !== before) commitHistory();
    lastWasCommand = true;
    const cs = renderFind.cs;
    renderFind = { matches: buildRenderMatches(q, cs), query: q, cs: cs, idx: renderFind.idx };
    setStatus("已替换 1 处");
    doFind(true);
  }
  function replaceAll() {
    if (sourceMode) { replaceAllSource(); return; }
    if (splitMode && lastFindSide === "source") { replaceAllSource(); return; }
    const q = findInput ? findInput.value : "";
    if (!q) return;
    const cs = !!(findCase && findCase.checked);
    const repl = replaceInput ? replaceInput.value : "";
    const matches = buildRenderMatches(q, cs);
    if (!matches.length) { setStatus("未找到：" + q); return; }
    const before = editor.innerHTML;
    // 按节点分组，组内从后往前替换，避免偏移错位
    const byNode = {};
    matches.forEach(function (m) { (byNode[m.node] || (byNode[m.node] = [])).push(m); });
    let count = 0;
    Object.keys(byNode).forEach(function (key) {
      const list = byNode[key].slice().sort(function (a, b) { return b.start - a.start; });
      let text = list[0].node.textContent;
      list.forEach(function (m) {
        text = text.slice(0, m.start) + repl + text.slice(m.end);
        count++;
      });
      list[0].node.textContent = text;
    });
    if (editor.innerHTML !== before) commitHistory();
    lastWasCommand = true;
    setStatus("已替换 " + count + " 处");
    renderFind = null;
  }

  /* ---------- 源码/分栏视图查找：直接操作 textarea 文本，记录每处字符位置 ---------- */
  // 用镜像 div 精确计算 caret 在 textarea 内的垂直像素位置（考虑长行自动换行撑出多视觉行）
  function caretTopInTextarea(ta, pos) {
    const div = document.createElement("div");
    const s = getComputedStyle(ta);
    const copy = [
      "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
      "lineHeight", "textTransform", "wordSpacing", "textIndent"
    ];
    copy.forEach(function (p) { div.style[p] = s[p]; });
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.overflowWrap = "break-word";
    div.style.wordBreak = "break-word";
    div.style.height = "auto";
    div.style.width = ta.clientWidth + "px";
    div.style.borderWidth = "0";
    div.textContent = ta.value.slice(0, pos);
    document.body.appendChild(div);
    const h = div.getBoundingClientRect().height;
    const padB = parseFloat(s.paddingBottom) || 0;
    const caretY = h - padB; // 相对 textarea 内容顶部的偏移
    document.body.removeChild(div);
    return caretY;
  }
  function scrollSourceToPos(pos) {
    if (!sourceView) return;
    const caretY = caretTopInTextarea(sourceView, pos);
    sourceView.scrollTop = Math.max(0, caretY - sourceView.clientHeight / 2);
  }
  function buildSourceMatches(q, cs) {
    const text = sourceView.value;
    const hay = cs ? text : text.toLowerCase();
    const needle = cs ? q : q.toLowerCase();
    const out = [];
    let from = 0, p;
    while ((p = hay.indexOf(needle, from)) !== -1) { out.push(p); from = p + needle.length; }
    return out;
  }
  function stepSource(forward) {
    if (!sourceFind || !sourceFind.matches.length) return -1;
    const m = sourceFind.matches;
    let ni = sourceFind.idx < 0 ? (forward ? -1 : 0) : sourceFind.idx;
    ni = forward ? ni + 1 : ni - 1;
    if (ni >= m.length) ni = 0;
    if (ni < 0) ni = m.length - 1;
    return ni;
  }
  function doFindSource(forward) {
    if (!findInput || !sourceView) return;
    const q = findInput.value;
    if (!q) return;
    const cs = !!(findCase && findCase.checked);
    if (!sourceFind || sourceFind.query !== q || sourceFind.cs !== cs) {
      sourceFind = { matches: buildSourceMatches(q, cs), query: q, cs: cs, idx: -1 };
    }
    if (!sourceFind.matches.length) { setStatus("原文区未找到：" + q); return; }
    const ni = stepSource(forward);
    sourceFind.idx = ni;
    const pos = sourceFind.matches[ni];
    sourceView.focus();
    try { sourceView.setSelectionRange(pos, pos + q.length); } catch (e) {}
    scrollSourceToPos(pos);
    setStatus("原文区匹配：" + (ni + 1) + " / " + sourceFind.matches.length);
  }
  function replaceCurrentSource() {
    if (!sourceFind || sourceFind.idx < 0) { doFindSource(true); if (!sourceFind || sourceFind.idx < 0) return; }
    const q = sourceFind.query;
    const cs = sourceFind.cs;
    const repl = replaceInput ? replaceInput.value : "";
    const pos = sourceFind.matches[sourceFind.idx];
    const text = sourceView.value;
    const next = text.slice(0, pos) + repl + text.slice(pos + q.length);
    suppressSourceInput = true;
    sourceView.value = next;
    highlightSource();
    const oldIdx = sourceFind.idx;
    sourceFind = { matches: buildSourceMatches(q, cs), query: q, cs: cs, idx: oldIdx };
    const np = sourceFind.matches[oldIdx] !== undefined ? sourceFind.matches[oldIdx] : -1;
    if (np >= 0) {
      sourceView.focus();
      try { sourceView.setSelectionRange(np, np + q.length); } catch (e) {}
      scrollSourceToPos(np);
    }
    setStatus("原文区已替换 1 处");
    doFindSource(true);
  }
  function replaceAllSource() {
    const q = findInput ? findInput.value : "";
    if (!q) return;
    const cs = !!(findCase && findCase.checked);
    const repl = replaceInput ? replaceInput.value : "";
    const text = sourceView.value;
    const hay = cs ? text : text.toLowerCase();
    const needle = cs ? q : q.toLowerCase();
    let out = "", i = 0, count = 0, p;
    while ((p = hay.indexOf(needle, i)) !== -1) { out += text.slice(i, p) + repl; i = p + needle.length; count++; }
    out += text.slice(i);
    suppressSourceInput = true;
    sourceView.value = out;
    highlightSource();
    sourceFind = null;
    setStatus("原文区已替换 " + count + " 处");
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
  // 分栏模式：记录当前聚焦的面板，使查找/替换跟随鼠标所在侧（左渲染区 / 右源码）
  if (editor) editor.addEventListener("focus", function () { lastFindSide = "editor"; });
  if (sourceView) sourceView.addEventListener("focus", function () { lastFindSide = "source"; });

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
      else if (action === "outline") toggleMdOutline();
      else if (action === "clear") clearDraft();
      else if (action === "new") openNewDialog();
      else if (action === "zoom-in") zoomIn();
      else if (action === "zoom-out") zoomOut();
      else if (action === "source") toggleSourceMode();
      else if (action === "split") toggleSplitMode();
      else if (action === "softwrap") setSoftWrap(!softWrap);
      else if (action === "open-folder") openContainingFolder();
      else if (action === "mergePdf") { if (window.PDFApp) window.PDFApp.merge(); }
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
    document.execCommand("styleWithCSS", false, false); // 复位：否则后续加粗/斜体也变成 span 样式，md 保存会静默丢失
  }

  /** 给选中文字加背景色（高亮）；Chromium 用 hiliteColor，退化用 backColor */
  function applyBackColor(color) {
    restoreSelection();
    document.execCommand("styleWithCSS", false, true);
    const applied = document.execCommand("hiliteColor", false, color);
    if (!applied) document.execCommand("backColor", false, color);
    document.execCommand("styleWithCSS", false, false); // 复位（同上）
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
    invalidateSplitMap(); // 内容变化后块级映射失效
    if (suppressInput) {
      suppressInput = false;
      // execCommand 路径（工具栏格式命令 / 粘贴 / Ctrl+B 等）：历史已由调用方记录，
      // 但分栏源码栏仍需同步——否则格式变化要等下次敲键（回车）才在右栏出现
      if (splitMode) scheduleSyncEditorToSource();
      return;
    }
    recordInput();
    updatePlaceholder();
    scheduleAutosave();
    invalidateFind(); // 编辑后已构建的查找结果失效
    if (splitMode) scheduleSyncEditorToSource();
    scheduleStatus();
    if (currentFile && currentFile.kind === "markdown") scheduleOutline();
  });

  /* 源码分栏：左渲染区 → 右源码（防抖写入，避免每键重绘） */
  let syncToSourceTimer = null;
  let suppressSourceInput = false;
  function scheduleSyncEditorToSource() {
    clearTimeout(syncToSourceTimer);
    syncToSourceTimer = setTimeout(function () {
      suppressSourceInput = true;
      // 保留源码栏滚动位置：写入 value 会重置 scrollTop，用户在右栏滚动查看时会被弹回顶部
      const keepTop = sourceView.scrollTop;
      sourceView.value = (currentFile && currentFile.kind === "markdown")
        ? serializeMarkdown()
        : (currentFile && currentFile.kind === "svg") ? sourceView.value
        : editor.innerHTML;
      sourceView.scrollTop = keepTop;
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

  /* =====================================================================
   * 分栏联动：编辑位置 ↔ 源码位置（仅 Markdown 文档）
   * 映射原理：对编辑区每个顶层块单独 turndown 得到片段，按文档顺序在源码
   * 文本中顺序 indexOf，得到每个块在源码中的精确 [start,end) 区间；任一侧
   * 内容变化即失效重建。光标移动与滚动双向跟随，程序滚动用时间窗防回环。
   * ===================================================================== */
  let splitMapCache = null;
  let splitLinkBusyUntil = 0;
  let linkEditorCaretTimer = null;
  let linkSourceCaretTimer = null;
  let linkEditorScrollTimer = null;
  let linkSourceScrollTimer = null;

  function invalidateSplitMap() { splitMapCache = null; }

  function splitLinkEnabled() {
    return splitMode && !window.__pdfActive && !window.__epubActive &&
      currentFile && currentFile.kind === "markdown" && window.TurndownService;
  }

  function buildSplitMap() {
    if (!splitLinkEnabled()) return null;
    if (splitMapCache) return splitMapCache;
    const mdText = sourceView.value || "";
    const map = [];
    if (mdText) {
      ensureTurndownService();
      let from = 0;
      Array.prototype.forEach.call(editor.children, function (node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        let frag = null;
        try { frag = turndownService.turndown(node.outerHTML); } catch (e) { frag = null; }
        if (frag == null) return;
        frag = frag.replace(/^\s+|\s+$/g, "");
        if (!frag) return;
        const idx = mdText.indexOf(frag, from);
        if (idx >= 0) {
          map.push({ node: node, start: idx, end: idx + frag.length });
          from = idx + frag.length;
        }
      });
    }
    splitMapCache = map;
    return map;
  }

  /** 光标所在（或最近）的编辑器顶层块 */
  function caretBlockInEditor() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return null;
    let node = sel.anchorNode.nodeType === Node.TEXT_NODE
      ? sel.anchorNode.parentElement : sel.anchorNode;
    while (node && node.parentElement !== editor) node = node.parentElement;
    return node;
  }

  /** 源码栏滚到文本偏移处；onlyIfOutside=true 时已在舒适视野内则不动 */
  function splitScrollSourceTo(offset, onlyIfOutside) {
    const y = caretTopInTextarea(sourceView, offset);
    const st = sourceView.scrollTop, h = sourceView.clientHeight;
    if (onlyIfOutside && y >= st + h * 0.08 && y <= st + h * 0.85) return;
    splitLinkBusyUntil = Date.now() + 300;
    sourceView.scrollTop = Math.max(0, y - h / 3);
  }

  /** 编辑区滚到某顶层块 */
  function splitScrollEditorTo(node) {
    if (!node || !editor.contains(node)) return;
    const er = editor.getBoundingClientRect();
    const rel = node.getBoundingClientRect().top - er.top;
    const h = editor.clientHeight;
    if (rel >= h * 0.08 && rel <= h * 0.85) return;
    splitLinkBusyUntil = Date.now() + 300;
    editor.scrollTop = Math.max(0, editor.scrollTop + rel - h / 3);
  }

  function mapEntryForNode(map, node) {
    for (let i = 0; i < map.length; i++) if (map[i].node === node) return map[i];
    return null;
  }

  function mapEntryForOffset(map, pos) {
    for (let i = 0; i < map.length; i++) {
      if (pos >= map[i].start && pos <= map[i].end) return map[i];
    }
    for (let i = 0; i < map.length; i++) {       // 落在块间隙：取后一个块
      if (map[i].start > pos) return map[i];
    }
    return map.length ? map[map.length - 1] : null;
  }

  /** 源码 scrollTop+目标行 → 近似文本偏移（caretTopInTextarea 单调，二分） */
  function sourcePosAtY(y) {
    let lo = 0, hi = sourceView.value.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (caretTopInTextarea(sourceView, mid) < y) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* 左 → 右：编辑器光标移动（打字/点击/方向键）跟随 */
  document.addEventListener("selectionchange", function () {
    if (!splitLinkEnabled() || document.activeElement !== editor) return;
    clearTimeout(linkEditorCaretTimer);
    linkEditorCaretTimer = setTimeout(function () {
      const map = buildSplitMap();
      if (!map || !map.length) return;
      const node = caretBlockInEditor();
      if (!node) return;
      const entry = mapEntryForNode(map, node);
      if (entry) splitScrollSourceTo(entry.start, true);
    }, 200);
  });

  /* 左 → 右：编辑器滚动跟随（滚轮翻页） */
  editor.addEventListener("scroll", function () {
    if (!splitLinkEnabled() || Date.now() < splitLinkBusyUntil) return;
    clearTimeout(linkEditorScrollTimer);
    linkEditorScrollTimer = setTimeout(function () {
      const map = buildSplitMap();
      if (!map || !map.length) return;
      const er = editor.getBoundingClientRect();
      const line = editor.clientHeight / 3;
      let anchor = null;
      for (let i = 0; i < map.length; i++) {
        if (map[i].node.getBoundingClientRect().top - er.top <= line) anchor = map[i];
        else break;
      }
      if (!anchor) anchor = map[0];
      splitScrollSourceTo(anchor.start, false);
    }, 120);
  });

  /* 右 → 左：源码光标移动（点击/方向键）跟随 */
  ["keyup", "mouseup"].forEach(function (evt) {
    sourceView.addEventListener(evt, function () {
      if (!splitLinkEnabled()) return;
      clearTimeout(linkSourceCaretTimer);
      linkSourceCaretTimer = setTimeout(function () {
        const map = buildSplitMap();
        if (!map || !map.length) return;
        const entry = mapEntryForOffset(map, sourceView.selectionStart || 0);
        if (entry) splitScrollEditorTo(entry.node);
      }, 250);
    });
  });

  /* 右 → 左：源码滚动跟随（滚轮翻页） */
  sourceView.addEventListener("scroll", function () {
    if (!splitLinkEnabled() || Date.now() < splitLinkBusyUntil) return;
    clearTimeout(linkSourceScrollTimer);
    linkSourceScrollTimer = setTimeout(function () {
      const map = buildSplitMap();
      if (!map || !map.length) return;
      const y = sourceView.scrollTop + sourceView.clientHeight / 3;
      const entry = mapEntryForOffset(map, sourcePosAtY(y));
      if (entry) splitScrollEditorTo(entry.node);
    }, 120);
  });

  /* ============================ 分栏光标联动：左渲染 ↔ 右源码 ============================
   * 模型：跟随光标——哪边获得焦点/光标移动，对面栏滚到对应位置（只滚动、不抢焦点）。
   * 映射用"文本锚点"：取光标所在顶层块的纯文本（压缩空白），到对面全文里搜首处出现。
   * 优点：对 turndown 往返差异、软换行、表格/嵌套列表都稳健，内容变后每次实时重查、自愈。
   * 程序化 scrollTop 赋值不触发 selectionchange，天然无回环。 */
  let caretSyncTimer = null;
  function scheduleCaretSync(fromEditor) {
    if (!splitMode) return;
    if (currentFile && currentFile.kind === "svg") return; // svg 左侧只读预览，无光标语义
    clearTimeout(caretSyncTimer);
    caretSyncTimer = setTimeout(function () { runCaretSync(fromEditor); }, 200);
  }
  function runCaretSync(fromEditor) {
    try {
      if (fromEditor) syncCaretToSource();
      else syncCaretToEditor();
    } catch (e) { /* 联动是增强体验，任何异常静默忽略 */ }
  }
  /** 压缩空白键：源码里的 | 、多余空格与块文本 textContent 之间的差异全部抹平 */
  function normKey(s) { return String(s).replace(/\s+/g, ""); }

  /** 源码的"去空白"副本缓存 + 每字符在原文中的下标映射（键空间匹配后回映射到原始偏移） */
  let normSrcCache = { raw: null, norm: "", map: null };
  function normSourceIndex() {
    if (normSrcCache.raw === sourceView.value) return normSrcCache;
    const src = sourceView.value;
    const map = new Array(src.length);
    let norm = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (/\s/.test(ch)) continue;
      map[norm.length] = i;
      norm += ch;
    }
    normSrcCache = { raw: src, norm: norm, map: map };
    return normSrcCache;
  }

  /** 就近匹配：内容有重复时优先取离上次同步位置最近的命中 */
  let lastCaretMatchNorm = -1;
  function findNearest(hay, needle, preferIdx) {
    if (preferIdx == null || preferIdx < 0) return hay.indexOf(needle);
    const fwd = hay.indexOf(needle, Math.max(0, preferIdx - needle.length));
    const back = hay.lastIndexOf(needle, preferIdx);
    if (fwd >= 0 && back >= 0) return (fwd - preferIdx <= preferIdx - back) ? fwd : back;
    return fwd >= 0 ? fwd : back;
  }

  /** 左 → 右：光标所在顶层块 → 在源码中定位（渐进放宽匹配长度）→ 滚动居中 */
  function syncCaretToSource() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return;
    let node = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
    let block = null;
    while (node && node !== editor) {
      if (node.parentElement === editor) { block = node; break; }
      node = node.parentElement;
    }
    if (!block) return;
    const key = normKey(block.textContent || "");
    if (!key) return;
    const ns = normSourceIndex();
    let idx = -1;
    const tries = [key, key.slice(0, 24), key.slice(0, 10)];
    for (let i = 0; i < tries.length && idx < 0; i++) {
      if (!tries[i]) continue;
      idx = findNearest(ns.norm, tries[i], lastCaretMatchNorm);
    }
    if (idx < 0) return;
    lastCaretMatchNorm = idx;
    const rawIdx = ns.map[idx];
    const y = caretTopInTextarea(sourceView, rawIdx);
    sourceView.scrollTop = Math.max(0, y - sourceView.clientHeight / 2);
  }

  /** 右 → 左：光标所在行 → 剥 markdown/html 标记 → 找渲染块 → 滚到视口上 1/3 处 */
  let lastCaretBlockIdx = -1;
  function syncCaretToEditor() {
    const pos = sourceView.selectionStart || 0;
    const src = sourceView.value;
    const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
    let lineEnd = src.indexOf("\n", pos);
    if (lineEnd < 0) lineEnd = src.length;
    const key = normKey(
      src.slice(lineStart, lineEnd)
        .replace(/<[^>]+>/g, "")
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s|\d+\.\s)/, "")
        .replace(/[*_`~]/g, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    ).slice(0, 24);
    if (!key) return;
    // 就近优先：从上次命中的块向两侧扩展搜索（重复文本场景取离上次位置最近的块）
    const kids = editor.children;
    let block = null;
    const n = kids.length;
    const start = lastCaretBlockIdx >= 0 && lastCaretBlockIdx < n ? lastCaretBlockIdx : 0;
    for (let d = 0; d < n && !block; d++) {
      const i = start + d; if (i < n && normKey(kids[i].textContent || "").indexOf(key) >= 0) { block = kids[i]; lastCaretBlockIdx = i; break; }
      const j = start - d; if (j >= 0 && j !== i && normKey(kids[j].textContent || "").indexOf(key) >= 0) { block = kids[j]; lastCaretBlockIdx = j; break; }
    }
    if (!block) return;
    const er = editor.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    const target = editor.scrollTop + (br.top - er.top) - editor.clientHeight * 0.3;
    editor.scrollTop = Math.max(0, target);
  }

  // selectionchange 驱动：编辑器/源码栏获得焦点并移动光标时各自动对面栏。
  // 我们的程序化滚动只改 scrollTop，不产生 selectionchange，故不会互相触发死循环。
  document.addEventListener("selectionchange", function () {
    const ae = document.activeElement;
    if (ae === editor) scheduleCaretSync(true);
    else if (ae === sourceView) scheduleCaretSync(false);
  });

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
    // 源码视图已改为单层可见 textarea，不再叠加语法高亮层。
    // 保留此函数为 no-op 以兼容既有调用点（scheduleHighlight / 模式切换），避免残留 hl-on/旧高亮造成"两层文字"。
    return;
  }
  function scheduleHighlight() {
    if (hlTimer) clearTimeout(hlTimer);
    hlTimer = setTimeout(highlightSource, 150);
  }

  sourceView.addEventListener("input", function () {
    if (suppressSourceInput) { suppressSourceInput = false; return; }
    invalidateSplitMap(); // 源码变化后块级映射失效
    invalidateFind(); // 内容已变，旧匹配位置失效（源码/渲染两侧均重置）
    if (splitMode) scheduleSyncSourceToEditor();
    scheduleHighlight();
  });
  sourceView.addEventListener("scroll", syncHlScroll);

  editor.addEventListener("focus", updatePlaceholder);
  editor.addEventListener("blur", updatePlaceholder);
  if (mdOutlineClose) mdOutlineClose.addEventListener("click", closeMdOutline);

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
    // 启动即空白新文档，默认进入 Markdown 撰写模式（kind=markdown，path=null 待保存）。
    // 不再以 currentFile=null 的"中性空白"启动，以便开箱即用 Markdown 的
    // WYSIWYG 往返 / 大纲 / 围栏块(math,mermaid) 等能力；标题仍显示"未打开文件"。
    // 注意：须先定 currentFile 再渲染工具栏——md 下要隐藏 htmlOnly 按钮（下划线/颜色/视频）。
    currentFile = { path: null, kind: "markdown" };
    // 依据配置动态渲染工具栏（顺序 / 显隐由定制弹窗的 ↑/↓ 调整）
    renderToolbar();
    applyMarkedConfig(); // 屏蔽 GFM 删除线对医学文本 ~ 范围的误判（必须在首次 marked.parse 前生效）
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
    setupCloseGuard();   // 关闭保护：有未保存修改时弹确认（须在窗口 API 可用后注册）
    applyTheme(appConfig.theme);
    // 应用上次页面缩放
    try {
      const z = parseFloat(localStorage.getItem("editorZoom"));
      if (!isNaN(z) && z >= 0.5 && z <= 2) applyZoom(z, false);
    } catch (e) {}
    // 恢复上次源码分栏
    if (appConfig.sourceSplit) enterSplitMode();
    // 处理启动文件来源（优先级：多实例「新建」注入 > 多实例打开注入 > 命令行参数）：
    // ① 多实例「新建」：Rust open_new_instance(path, newKind) 注入 window.__NEW_KIND__，
    //    本窗口按空白文档启动；必须最先检查，否则会误读进程级 argv；
    // ② 多实例打开：Rust open_new_instance 经 initialization_script 注入 window.__OPEN_PATH__；
    // ③ 文件关联：Windows 双击 .md/.html 时路径作为命令行参数传入，
    //    Tauri 不会自动打开，这里主动读取并在启动后加载该文件。
    if (window.__NEW_KIND__) {
      const nk = window.__NEW_KIND__ === "html" ? "html" : "markdown";
      currentFile = { path: null, kind: nk };
      renderToolbar();   // 新建可能是 html，重算 htmlOnly 按钮显隐
      setStatus(nk === "html" ? "已新建 HTML 文档" : "已新建 Markdown 文档");
    } else if (window.__OPEN_PATH__) {
      openFileWithPath(window.__OPEN_PATH__);
    } else {
      try {
        const initialFile = await tauriInvoke("get_initial_file");
        if (initialFile) {
          openFileWithPath(initialFile);
        } else {
          // 仅在无文件关联传入时提示「新建」；有启动文件（如双击 PDF）时不提示，
          // 避免打开 PDF/HTML 前先弹出误导性的「已新建 Markdown 文档」
          setStatus("已新建 Markdown 文档");
        }
      } catch (e) {}
    }
  }

  init();
})();
