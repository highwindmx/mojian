"use strict";
/* =====================================================================
 * 墨笺 · PDF 页缓存（LRU + 字节预算）—— 纯逻辑，无 DOM 依赖
 *
 * 浏览器：<script src="pdf-cache.js"></script> → window.PdfPageCache
 * Node：  require("./pdf-cache.js")           → { createPageCache }
 *
 * 只管「页的字节账 + 回收顺序」，真正销毁 canvas 的动作由 onRelease 回调
 * 交回 pdf.js 完成。这样算法可以在 Node 里单测，不被浏览器/DOM 绑住。
 *
 * 关键约束：
 *  - 永远保留最近使用的那一页（即使它单页就超预算），避免把当前页抽空；
 *  - isProtected(num) 为真的页（当前可见 / 正在渲染 / 当前页）不回收；
 *  - clear() 只清账本，不触发 onRelease（调用方自行清空 DOM）。
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PdfPageCache = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_BUDGET = 256 * 1024 * 1024; // canvas 后备存储字节上限（实际 GPU 纹理约再 ×2）

  function createPageCache(opts) {
    opts = opts || {};
    const budget = Number.isFinite(opts.budget) && opts.budget >= 0 ? opts.budget : DEFAULT_BUDGET;
    const onRelease = typeof opts.onRelease === "function" ? opts.onRelease : function () {};
    const isProtected = typeof opts.isProtected === "function" ? opts.isProtected : function () { return false; };

    let total = 0;
    const bytes = new Map(); // num -> 估算字节数
    const lru = new Map();   // num -> true；插入顺序即访问顺序（最老在前）

    function removeRecord(num) {
      if (bytes.has(num)) { total -= bytes.get(num); bytes.delete(num); }
      lru.delete(num);
    }

    function touch(num) {
      if (!bytes.has(num)) return false;
      if (lru.has(num)) lru.delete(num);
      lru.set(num, true);
      return true;
    }

    function add(num, size) {
      const n = Number.isFinite(size) && size > 0 ? size : 0;
      if (bytes.has(num)) removeRecord(num);
      bytes.set(num, n);
      total += n;
      touch(num);
    }

    function release(num) {
      if (!bytes.has(num)) return false;
      removeRecord(num);
      onRelease(num);
      return true;
    }

    /* 按 LRU 从老到新回收，直到 total <= budget。
     * 跳过受保护页；并始终保留最近使用的那一页（order 末位）。 */
    function enforce() {
      const freed = [];
      const order = Array.from(lru.keys());
      for (let i = 0; i < order.length - 1 && total > budget; i++) {
        const num = order[i];
        if (isProtected(num)) continue;
        release(num);
        freed.push(num);
      }
      return freed;
    }

    function clear() {
      const keys = Array.from(bytes.keys());
      bytes.clear(); lru.clear(); total = 0;
      return keys;
    }

    function stats() {
      return { pages: bytes.size, bytes: total, budget: budget, lru: Array.from(lru.keys()) };
    }

    return {
      add: add, touch: touch, release: release, enforce: enforce,
      clear: clear, stats: stats, getBudget: function () { return budget; },
    };
  }

  return { createPageCache: createPageCache, DEFAULT_BUDGET: DEFAULT_BUDGET };
});
