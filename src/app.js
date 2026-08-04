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
  const zoomLabel = document.getElementById("zoom-label");
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
  /** 是否处于源码视图 */
  let sourceMode = false;

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

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", function () {
      closeModal(linkDialog);
      closeModal(imageDialog);
    });
  });

  [linkDialog, imageDialog].forEach((modal) => {
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

  /** 启动时恢复上次窗口尺寸（最小尺寸由 tauri.conf.json 的 minWidth/minHeight 保护） */
  async function restoreWindowSize() {
    const w = tauriWindowApi();
    if (!w) return;
    try {
      const raw = localStorage.getItem("windowSize");
      if (!raw) return;
      const s = JSON.parse(raw);
      const win = w.getCurrentWindow();
      // 用 PhysicalSize 读写保持一致，避免高 DPI 下的单位换算误差
      await win.setSize(new w.PhysicalSize(
        Math.max(1, Math.round(s.w) || 600),
        Math.max(1, Math.round(s.h) || 400)
      ));
    } catch (e) { /* 窗口尺寸恢复失败不致命 */ }
  }

  /** 保存当前窗口尺寸到 localStorage（物理像素，与读取保持一致） */
  async function saveWindowSize() {
    const w = tauriWindowApi();
    if (!w) return;
    try {
      const win = w.getCurrentWindow();
      const size = await win.innerSize(); // 返回 PhysicalSize
      localStorage.setItem("windowSize", JSON.stringify({ w: size.width, h: size.height }));
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
  function loadMarkdown(mdText) {
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
    return "html";
  }

  /** 通过 Tauri 对话框选择文件并打开 */
  async function openFile() {
    if (!TAURI) { setStatus("当前环境不支持文件对话框。", true); return; }
    let selected;
    try {
      selected = await tauriOpen({
        multiple: false,
        filters: [{ name: "HTML / Markdown", extensions: ["html", "htm", "md", "markdown"] }],
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
    let res;
    try {
      res = await tauriInvoke("open_file", { path });
    } catch (e) {
      setStatus("打开失败：" + e, true);
      return;
    }
    if (sourceMode) exitSourceMode();
    currentFile = { path: res.path, kind: res.kind };
    setFilePath(res.path, true);
    if (res.kind === "markdown") {
      loadMarkdown(res.content);
    } else {
      loadHtmlDocument(res.content);
    }
    setStatus("已打开：" + res.path);
  }

  /** 保存当前内容到指定路径（按类型决定序列化方式） */
  async function saveFileWithContent(path, kind) {
    let content;
    if (kind === "markdown") {
      content = serializeMarkdown();
    } else {
      content = buildFullDocument();
    }
    try {
      await tauriInvoke("save_file", { path, kind, content });
      setStatus("已保存：" + path);
    } catch (e) {
      setStatus("保存失败：" + e, true);
    }
  }

  /** 保存：有打开的文件则写回，否则走"另存为" */
  async function saveFile() {
    if (sourceMode) applySourceToEditor();
    if (currentFile) {
      await saveFileWithContent(currentFile.path, currentFile.kind);
    } else {
      await saveFileAs();
    }
  }

  /** 另存为：弹出保存对话框，按后缀决定类型 */
  async function saveFileAs() {
    if (!TAURI) { setStatus("当前环境不支持保存对话框。", true); return; }
    let path;
    try {
      path = await tauriSave({
        filters: [
          { name: "HTML", extensions: ["html"] },
          { name: "Markdown", extensions: ["md"] },
        ],
      });
    } catch (e) {
      setStatus("保存失败：" + e, true);
      return;
    }
    if (!path) return;
    const kind = detectKindFromPath(path);
    currentFile = { path, kind };
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
    if (zoomLabel) zoomLabel.textContent = Math.round(currentZoom * 100) + "%";
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

  function enterSourceMode() {
    if (sourceMode) return;
    let src;
    if (currentFile && currentFile.kind === "markdown") {
      src = serializeMarkdown();
    } else {
      src = editor.innerHTML;
    }
    sourceView.value = src;
    editor.style.display = "none";
    sourceView.style.display = "block";
    sourceMode = true;
    toolbar.classList.add("source-mode");
    const srcBtn = toolbar.querySelector('[data-action="source"]');
    if (srcBtn) srcBtn.classList.add("active");
    sourceView.focus();
  }

  function exitSourceMode() {
    if (!sourceMode) return;
    applySourceToEditor();
    sourceView.style.display = "none";
    editor.style.display = "";
    sourceMode = false;
    toolbar.classList.remove("source-mode");
    const srcBtn = toolbar.querySelector('[data-action="source"]');
    if (srcBtn) srcBtn.classList.remove("active");
    editor.focus();
  }

  function toggleSourceMode() {
    if (sourceMode) exitSourceMode();
    else enterSourceMode();
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
    if (!currentFile || !currentFile.path) {
      setStatus("请先打开一个文件再定位。", true);
      return;
    }
    try {
      await tauriInvoke("open_containing_folder", { path: currentFile.path });
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
   * 事件绑定
   * ===================================================================== */
  toolbar.addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    // 源码视图下仅允许缩放组（含源码切换）操作，禁用其它格式化/插入按钮
    if (sourceMode && !btn.closest(".source-keep")) return;
    if (btn.dataset.cmd) {
      formatCommand(btn.dataset.cmd);
    } else if (btn.dataset.block) {
      toggleBlock(btn.dataset.block);
    } else if (btn.dataset.action) {
      const action = btn.dataset.action;
      if (action === "link") handleLink();
      else if (action === "image") handleImage();
      else if (action === "table") insertTable();
      else if (action === "code") insertCodeBlock();
      else if (action === "hr") insertHr();
      else if (action === "undo") undo();
      else if (action === "redo") redo();
      else if (action === "open") openFile();
      else if (action === "save") saveFile();
      else if (action === "saveas") saveFileAs();
      else if (action === "export") exportHTML();
      else if (action === "clear") clearDraft();
      else if (action === "new") openNewDialog();
      else if (action === "zoom-in") zoomIn();
      else if (action === "zoom-out") zoomOut();
      else if (action === "source") toggleSourceMode();
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
  });

  editor.addEventListener("focus", updatePlaceholder);
  editor.addEventListener("blur", updatePlaceholder);

  document.addEventListener("selectionchange", updateToolbarState);

  editor.addEventListener("keydown", function (e) {
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
  function init() {
    // 启动不再自动恢复上次草稿内容，避免误以为"已打开文件"；
    // 应用启动即空白新文档（标题显示"未打开文件"）。
    updatePlaceholder();
    history = [takeSnapshot()];
    historyIndex = 0;
    lastWasCommand = true;
    lastChangeTs = Date.now();
    updateToolbarState();
    setupDragDrop();

    // 顶部提示：点击即可关闭
    const toastEl = document.getElementById("toast");
    if (toastEl) {
      toastEl.addEventListener("click", function () { this.classList.remove("show"); });
    }
    // 记住窗口最后尺寸（最小尺寸由 tauri.conf.json 的 minWidth/minHeight 兜底保护）
    setupWindowSizePersistence();
    restoreWindowSize();
    // 应用上次页面缩放
    try {
      const z = parseFloat(localStorage.getItem("editorZoom"));
      if (!isNaN(z) && z >= 0.5 && z <= 2) applyZoom(z, false);
    } catch (e) {}
  }

  init();
})();
