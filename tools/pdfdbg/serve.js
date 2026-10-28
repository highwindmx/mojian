const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "../..");
const types = { ".html": "text/html;charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css;charset=utf-8",
  ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  if (req.url.startsWith("/__saved")) {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      fs.writeFileSync(path.join(__dirname, "saved.b64"), body);
      res.writeHead(200); res.end("ok");
    });
    return;
  }
  if (req.url.startsWith("/__report")) {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      fs.appendFileSync(path.join(__dirname, "report.txt"), body + "\n");
      res.writeHead(200); res.end("ok");
    });
    return;
  }
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(p, (e, buf) => {
    if (e) { res.writeHead(404); res.end("404"); return; }
    let body = buf;
    if (p.endsWith("e2e.html")) {
      // 用真实 index.html 当骨架（保留全部 DOM / 样式），剥掉脚本后注入 mock 与驱动
      let html = fs.readFileSync(path.join(root, "src/index.html"), "utf8");
      html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
      html = html.replace(/<head>/i, '<head>\n<base href="/src/">');
      const inject = [
        '<script src="/tools/pdfdbg/e2e_pdf.js"></script>',
        '<script>window.__TAURI__ = {',
        ' core: { invoke: async function (cmd, args) {',
        '   if (cmd === "read_file_base64") return { kind: "pdf", data: window.__PDF_B64__ };',
        '   if (cmd === "save_file_bytes") { await fetch("/__saved", { method: "POST", body: args.data }); return null; }',
        '   if (cmd === "load_signatures") return "[]";',
        '   return null;',
        ' } },',
        ' dialog: { open: async function(){return null;}, save: async function(){return null;},',
        '           message: async function(){return null;}, ask: async function(){return false;} }',
        '};</script>',
        '<script src="vendor/pdfjs/pdf.min.js"></script>',
        '<script src="vendor/pdf-lib/pdf-lib.min.js"></script>',
        '<script src="pdf.js"></script>',
        '<script src="/tools/pdfdbg/driver.js"></script>',
      ].join("\n");
      html = html.replace(/<\/body>/i, inject + "\n</body>");
      body = Buffer.from(html);
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
      res.end(body);
      return;
    }
    if (p.endsWith("probe.html")) {
      const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8"));
      body = Buffer.from(buf.toString("utf8").replace("window.__CASES__ || []", JSON.stringify(cases)));
    }
    res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
}).listen(8898, "127.0.0.1", () => console.log("serving on 8899"));
