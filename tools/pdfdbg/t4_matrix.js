/* 验证签章矩阵：内容流 cm 栈 → 页面坐标角点 → pdf.js 旋转视口 → 屏幕角点
 * 判据：屏幕包围盒尺寸 == 签章 w×h（正立），中心 == 点击位置投影。 */
const L = require("../../src/vendor/pdf-lib/pdf-lib.min.js");
const zlib = require("zlib");
const { makePng } = require("./mkpng");

// [x y 1]·M 行向量约定；mul(A,B) 表示"先 A 后 B"
function mul(A, B) {
  return [
    A[0]*B[0] + A[1]*B[2], A[0]*B[1] + A[1]*B[3],
    A[2]*B[0] + A[3]*B[2], A[2]*B[1] + A[3]*B[3],
    A[4]*B[0] + A[5]*B[2] + B[4], A[4]*B[1] + A[5]*B[3] + B[5],
  ];
}
function apply(m, p) { return [p[0]*m[0] + p[1]*m[2] + m[4], p[0]*m[1] + p[1]*m[3] + m[5]]; }

function viewportMatrix(viewBox, rot, sc) {
  let rA, rB, rC, rD;
  switch (rot) {
    case 180: rA = -1; rB = 0; rC = 0; rD = 1; break;
    case 90:  rA = 0;  rB = 1; rC = 1;  rD = 0; break;
    case 270: rA = 0;  rB = -1; rC = -1; rD = 0; break;
    default:  rA = 1;  rB = 0; rC = 0;  rD = -1; break;
  }
  const cx = (viewBox[2] + viewBox[0]) / 2, cy = (viewBox[3] + viewBox[1]) / 2;
  let m = [rA*sc, rB*sc, rC*sc, rD*sc,
           -rA*sc*cx - rC*sc*cy, -rB*sc*cx - rD*sc*cy];
  const cs = [[viewBox[0],viewBox[1]],[viewBox[2],viewBox[1]],[viewBox[0],viewBox[3]],[viewBox[2],viewBox[3]]].map(p=>apply(m,p));
  const minX = Math.min(...cs.map(p=>p[0])), minY = Math.min(...cs.map(p=>p[1]));
  m[4] -= minX; m[5] -= minY;     // 平移到 0（pdf.js 的 offsetX/Y 效果）
  return m;
}
function cornersOf(txt) {
  const stack = []; let ctm = [1,0,0,1,0,0]; const out = [];
  const tk = txt.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (t === "q") stack.push(ctm.slice());
    else if (t === "Q") { if (stack.length) ctm = stack.pop(); }
    else if (t === "cm") { ctm = mul(tk.slice(i-6, i).map(Number), ctm); }
    else if (t === "Do") for (const c of [[0,0],[1,0],[0,1],[1,1]]) out.push(apply(ctm, c));
  }
  return out;
}
async function build(fileRot, rot, cx, cy, w, h) {
  const doc = await L.PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: L.rgb(0.9, 0.9, 0.9) });
  if (fileRot) page.setRotation(L.degrees(fileRot));
  const img = await doc.embedPng(makePng(40, 20, () => [255, 0, 0]));
  const rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const bx = cx - (w/2 * cos - h/2 * sin), by = cy - (w/2 * sin + h/2 * cos);
  page.drawImage(img, { x: bx, y: by, width: w, height: h, rotate: L.degrees(rot) });
  const d2 = await L.PDFDocument.load(await doc.save({ useObjectStreams: false }));
  const p2 = d2.getPages()[0];
  const { Contents } = p2.node.normalizedEntries();
  let txt = "";
  for (let i = 0; i < Contents.size(); i++) {
    let raw = Buffer.from(d2.context.lookup(Contents.get(i)).getContents());
    try { raw = zlib.inflateSync(raw); } catch (e) {}
    txt += "\n" + raw.toString("latin1");
  }
  return { txt, pw: p2.getWidth(), ph: p2.getHeight() };
}
(async () => {
  const cases = [
    { n: "A 无/Rotate rot=0",        fr: 0,   rot: 0 },
    { n: "B /Rotate90  rot=90",      fr: 90,  rot: 90 },
    { n: "C /Rotate90  rot=0(对照)", fr: 90,  rot: 0 },
    { n: "D /Rotate270 rot=270",     fr: 270, rot: 270 },
    { n: "E /Rotate180 rot=180",     fr: 180, rot: 180 },
    { n: "F /Rotate90  rot=0 且在页内+90", fr: 90, rot: 180 },
  ];
  const W = 120, H = 40, CX = 160, CY = 220;
  for (const c of cases) {
    const { txt, pw, ph } = await build(c.fr, c.rot, CX, CY, W, H);
    const vm = viewportMatrix([0, 0, pw, ph], c.fr, 1);
    const scr = cornersOf(txt).map(p => apply(vm, p));
    const xs = scr.map(p => p[0]), ys = scr.map(p => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const ccx = (Math.max(...xs) + Math.min(...xs)) / 2, ccy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const exp = apply(vm, [CX, CY]);
    const okW = Math.abs(bw - W) < 0.5 && Math.abs(bh - H) < 0.5;
    const okC = Math.abs(ccx - exp[0]) < 0.5 && Math.abs(ccy - exp[1]) < 0.5;
    console.log(`${c.n}\n   屏幕包围盒 ${bw.toFixed(1)}×${bh.toFixed(1)} 中心(${ccx.toFixed(1)},${ccy.toFixed(1)}) 期望中心(${exp[0].toFixed(1)},${exp[1].toFixed(1)}) → ${okW&&okC ? "正立且对位 ✓" : "✗"}`);
  }
})();
