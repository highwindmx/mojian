const fs = require("fs");
const L = require("../../src/vendor/pdf-lib/pdf-lib.min.js");
(async () => {
  const doc = await L.PDFDocument.create();
  const page = doc.addPage([400, 560]);                    // 竖版，便于观察旋转
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 560, color: L.rgb(1, 1, 1) });
  page.drawRectangle({ x: 20, y: 500, width: 120, height: 40, color: L.rgb(0, 0, 0.6) }); // 顶部标记
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  fs.writeFileSync("tools/pdfdbg/e2e.pdf", bytes);
  fs.writeFileSync("tools/pdfdbg/e2e_pdf.js", "window.__PDF_B64__ = " + JSON.stringify(bytes.toString("base64")) + ";");
  console.log("e2e.pdf", bytes.length, "bytes");
  console.log("raw /Rotate:", (bytes.toString("latin1").match(/\/Rotate\s*-?\d+/g) || []));
})();
