/* 端到端驱动：真实 PDF 模块 + mock Tauri → 旋转 → 手绘签章 → 放置 → 保存 → 重载 */
(function () {
  const log = [];
  function say(o) {
    log.push(o);
    try { fetch("/__report", { method: "POST", body: JSON.stringify(o) }); } catch (e) {}
  }
  function waitFor(fn, ms) {
    ms = ms || 8000;
    return new Promise(function (res, rej) {
      const t0 = Date.now();
      (function loop() {
        let v = null;
        try { v = fn(); } catch (e) {}
        if (v) return res(v);
        if (Date.now() - t0 > ms) return rej(new Error("waitFor 超时"));
        setTimeout(loop, 50);
      })();
    });
  }
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  window.addEventListener("error", function (e) { say({ step: "winerr", msg: String(e.message), src: String(e.filename) + ":" + e.lineno }); });
  window.addEventListener("unhandledrejection", function (e) { say({ step: "winrej", msg: String((e.reason && e.reason.stack) || e.reason) }); });
  window.addEventListener("load", async function () {
    try {
      say({ step: "boot", worker: pdfjsLib.GlobalWorkerOptions.workerSrc });
      // 探针页在子目录下，覆写 worker 路径（正式应用里 index.html 在根目录，相对路径本就正确）
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/src/vendor/pdfjs/pdf.worker.min.js";
      await window.PDFApp.open("C:/dbg/test.pdf");
      say({ step: "afterOpen", status: (document.getElementById("pdf-sb-left") || {}).textContent || "",
            pages: document.querySelectorAll("#pdf-pages .pdf-page").length,
            canvases: document.querySelectorAll("#pdf-pages canvas").length });
      const c0 = await waitFor(function () { return document.querySelector("#pdf-pages .pdf-page canvas"); });
      say({ step: "opened", canvas: [c0.width, c0.height], css: [c0.style.width, c0.style.height] });

      // 旋转本页
      document.querySelector('[data-pdf-action="rotate-right"]').click();
      await sleep(900);
      const c1 = document.querySelector("#pdf-pages .pdf-page canvas");
      say({ step: "rotated", canvas: [c1.width, c1.height], css: [c1.style.width, c1.style.height] });

      // 打开签章弹窗 → 手绘
      document.querySelector('[data-pdf-action="signature"]').click();
      await sleep(400);
      const pad = document.getElementById("pdf-sign-pad");
      if (!pad) throw new Error("找不到画板");
      const pr = pad.getBoundingClientRect();
      say({ step: "pad", rect: [pr.width, pr.height], bitmap: [pad.width, pad.height] });
      const mev = function (type, x, y) {
        pad.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
      };
      mev("mousedown", pr.left + 30, pr.top + 60);
      for (let i = 1; i <= 14; i++) mev("mousemove", pr.left + 30 + i * 18, pr.top + 60 + Math.sin(i / 2) * 16);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.getElementById("pdf-sign-ok").click();
      await waitFor(function () { return document.getElementById("pdf-pages").classList.contains("sig-placing"); });

      // 点击画布中心放置
      const c2 = document.querySelector("#pdf-pages .pdf-page canvas");
      const cr = c2.getBoundingClientRect();
      const clickX = cr.left + cr.width * 0.5, clickY = cr.top + cr.height * 0.5;
      c2.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: clickX, clientY: clickY }));
      const ov = await waitFor(function () { return document.querySelector(".pdf-sig-overlay"); });
      const or = ov.getBoundingClientRect();
      const info = {
        step: "placed",
        cssText: ov.style.cssText,
        status: (document.getElementById("pdf-sb-left") || {}).textContent || "",
        sheetOK: !!Array.from(document.styleSheets).find(function (s) { try { return s.href && s.href.indexOf("styles.css") >= 0; } catch (e) { return false; } }),
        overlay: { left: or.left - cr.left, top: or.top - cr.top, w: or.width, h: or.height,
                   transform: ov.style.transform || "(none)" },
        canvasBox: [cr.width, cr.height],
        dpr: c2.width / parseFloat(c2.style.width),
      };
      say(info);

      // 保存（写回 mock 捕获）
      await window.PDFApp.save();
      await waitFor(function () { return !document.querySelector(".pdf-sig-overlay"); }, 12000);
      await sleep(800);
      const c3 = document.querySelector("#pdf-pages .pdf-page canvas");
      say({ step: "reloaded", canvas: [c3.width, c3.height], css: [c3.style.width, c3.style.height],
            title: document.title });

      // 重载后画布上是否真的出现墨迹（内容流写入 = 渲染器一定画出来）
      const dpr = c3.width / parseFloat(c3.style.width);
      const cx = Math.round((or.left - cr.left + or.width / 2) * dpr);
      const cy = Math.round((or.top - cr.top + or.height / 2) * dpr);
      const d = c3.getContext("2d").getImageData(Math.max(0, cx - 6), Math.max(0, cy - 6), 13, 13).data;
      let dark = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) { total++; if (d[i] < 150 && d[i + 1] < 150 && d[i + 2] < 150) dark++; }
      say({ step: "done", probeAt: [cx, cy], darkPixels: dark, sampled: total });
      document.title = "E2E-OK";
    } catch (e) {
      say({ step: "error", error: String((e && e.stack) || e) });
      document.title = "E2E-ERR";
    }
  });
})();
