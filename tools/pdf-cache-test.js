"use strict";
/* PDF 页缓存（LRU + 字节预算）单元测试：纯 Node，无需浏览器/DOM。
 * 运行：node tools/pdf-cache-test.js
 */
const assert = require("assert");
const path = require("path");
const { createPageCache, DEFAULT_BUDGET } = require(path.join(__dirname, "..", "src", "pdf-cache.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n      " + e.message); }
}

t("默认预算 256MB", function () {
  assert.strictEqual(DEFAULT_BUDGET, 256 * 1024 * 1024);
  assert.strictEqual(createPageCache({}).getBudget(), DEFAULT_BUDGET);
});

t("add / touch / stats 账本正确", function () {
  const c = createPageCache({ budget: 100 });
  c.add(1, 10); c.add(2, 20); c.add(3, 30);
  assert.strictEqual(c.stats().pages, 3);
  assert.strictEqual(c.stats().bytes, 60);
  assert.deepStrictEqual(c.stats().lru, [1, 2, 3]);
  assert.strictEqual(c.touch(1), true);
  assert.deepStrictEqual(c.stats().lru, [2, 3, 1]);
  assert.strictEqual(c.touch(99), false); // 未登记的页 touch 无效
});

t("未超预算：enforce 不回收任何页", function () {
  const released = [];
  const c = createPageCache({ budget: 100, onRelease: n => released.push(n) });
  c.add(1, 40); c.add(2, 40);
  assert.deepStrictEqual(c.enforce(), []);
  assert.deepStrictEqual(released, []);
  assert.strictEqual(c.stats().bytes, 80);
});

t("超预算：按 LRU 从最老页回收", function () {
  const released = [];
  const c = createPageCache({ budget: 100, onRelease: n => released.push(n) });
  c.add(1, 40); c.add(2, 40); c.add(3, 40); // 120 > 100
  assert.deepStrictEqual(c.enforce(), [1]);
  assert.deepStrictEqual(released, [1]);
  assert.strictEqual(c.stats().pages, 2);
  assert.strictEqual(c.stats().bytes, 80);
  assert.deepStrictEqual(c.stats().lru, [2, 3]);
});

t("touch 改变淘汰对象（刚访问过的老页不被回收）", function () {
  const released = [];
  const c = createPageCache({ budget: 100, onRelease: n => released.push(n) });
  c.add(1, 40); c.add(2, 40); c.add(3, 40);
  c.touch(1); // lru 变成 2,3,1
  c.enforce();
  assert.deepStrictEqual(released, [2]);
  assert.deepStrictEqual(c.stats().lru, [3, 1]);
});

t("受保护页跳过，且永远保留最近使用的一页", function () {
  const released = [];
  const c = createPageCache({
    budget: 100,
    onRelease: n => released.push(n),
    isProtected: n => n === 1, // 模拟「第 1 页当前可见」
  });
  c.add(1, 40); c.add(2, 40); c.add(3, 40);
  assert.deepStrictEqual(c.enforce(), [2]);
  assert.deepStrictEqual(c.stats().lru, [1, 3]);
  assert.deepStrictEqual(released, [2]);
});

t("单页超预算也不抽空最近页（避免当前页变空白）", function () {
  const released = [];
  const c = createPageCache({ budget: 10, onRelease: n => released.push(n) });
  c.add(1, 100); c.add(2, 100);
  const freed = c.enforce();
  assert.deepStrictEqual(freed, [1]);
  assert.strictEqual(c.stats().pages, 1);
  assert.deepStrictEqual(c.stats().lru, [2]); // 最近页保留，即使仍超预算
  assert.strictEqual(c.stats().bytes, 100);
});

t("budget=0：回收所有非保护页，只留最近页", function () {
  const c = createPageCache({ budget: 0 });
  c.add(1, 1); c.add(2, 1); c.add(3, 1);
  assert.deepStrictEqual(c.enforce(), [1, 2]);
  assert.deepStrictEqual(c.stats().lru, [3]);
});

t("release 手动回收：触发回调、可重复调用安全", function () {
  const released = [];
  const c = createPageCache({ budget: 1000, onRelease: n => released.push(n) });
  c.add(1, 5); c.add(2, 5);
  assert.strictEqual(c.release(1), true);
  assert.strictEqual(c.release(1), false); // 已回收
  assert.strictEqual(c.release(99), false); // 不存在
  assert.deepStrictEqual(released, [1]);
  assert.strictEqual(c.stats().bytes, 5);
  assert.strictEqual(c.stats().pages, 1);
});

t("clear 清账本但不触发 onRelease（调用方自行清 DOM）", function () {
  const released = [];
  const c = createPageCache({ budget: 100, onRelease: n => released.push(n) });
  c.add(1, 10); c.add(2, 20);
  assert.deepStrictEqual(c.clear(), [1, 2]);
  assert.deepStrictEqual(released, []);
  assert.strictEqual(c.stats().pages, 0);
  assert.strictEqual(c.stats().bytes, 0);
  assert.deepStrictEqual(c.stats().lru, []);
});

t("同页重复 add 覆盖旧账，不重复计字节", function () {
  const c = createPageCache({ budget: 1000 });
  c.add(1, 10); c.add(1, 20);
  assert.strictEqual(c.stats().pages, 1);
  assert.strictEqual(c.stats().bytes, 20);
  assert.deepStrictEqual(c.stats().lru, [1]);
});

t("未配置 onRelease / isProtected 时不报错", function () {
  const c = createPageCache({ budget: 5 });
  c.add(1, 10); c.add(2, 10);
  assert.doesNotThrow(function () { c.enforce(); });
  assert.deepStrictEqual(c.stats().lru, [2]);
});

t("onRelease 回调内可安全读取 stats（重入安全）", function () {
  let seen = -1;
  let c;
  c = createPageCache({
    budget: 5,
    onRelease: function (n) { seen = c.stats().pages; },
  });
  c.add(1, 10); c.add(2, 10);
  c.enforce();
  assert.ok(seen === 1 || seen === 2, "回调内 stats 可读，实际=" + seen);
});

t("非法 size 按 0 计，不污染 total", function () {
  const c = createPageCache({ budget: 100 });
  c.add(1, NaN); c.add(2, -5); c.add(3, "20");
  assert.strictEqual(c.stats().bytes, 0);
  assert.strictEqual(c.stats().pages, 3);
});

console.log("\nPDF 页缓存单测：" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
