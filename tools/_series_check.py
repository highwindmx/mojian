"""Series-wide font check: IoU of each icon's glyph vs a SimHei reference."""
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _font_match import decode_png, glyph_mask, norm_mask, iou  # noqa: E402

TMP = r"C:\Users\KaishengMao\AppData\Local\Temp\_ser"
SER = ["simhei_ref", "md", "html", "svg", "pdf", "epub", "json", "icon"]
CELL = 256
COLS = 4


def build_html(out_html):
    cells = []
    cells.append('<div class="cell"><span style="font-family:SimHei">墨</span></div>')
    for n in SER[1:]:
        cells.append('<div class="cell"><img src="%s.png"></div>' % n)
    html = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#000;overflow:hidden}
.cell{width:256px;height:256px;display:inline-block;background:#000;
color:#fff;font-size:200px;line-height:256px;text-align:center;vertical-align:top;
overflow:hidden}
.cell img{width:256px;height:256px;display:block}
</style></head><body>%s</body></html>""" % ("".join(cells))
    # file:// 相对图片基于 html 所在目录
    open(out_html, "w", encoding="utf-8").write(html)
    print("html: %d cells -> %dx%d" % (len(cells), COLS * CELL, 2 * CELL))


def white_mask(w, h, rgba, thr=190):
    """接近白色的像素视为字（对彩色底图标稳健；纯亮度阈值会被黄/粉底骗过）。"""
    m = bytearray(w * h)
    for i in range(w * h):
        r = rgba[i * 4]; g = rgba[i * 4 + 1]; b = rgba[i * 4 + 2]
        a = rgba[i * 4 + 3]
        m[i] = 1 if (r > thr and g > thr and b > thr and a > 128) else 0
    xs = [i % w for i in range(w * h) if m[i]]
    ys = [i // w for i in range(w * h) if m[i]]
    if not xs:
        return None
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    crop = [[0] * (x1 - x0 + 1) for _ in range(y1 - y0 + 1)]
    for yy in range(y1 - y0 + 1):
        for xx in range(x1 - x0 + 1):
            crop[yy][xx] = m[(y0 + yy) * w + x0 + xx]
    return crop


def analyze(shot):
    w, h, px = decode_png(shot)
    print("shot %dx%d" % (w, h))
    masks = {}
    for idx, name in enumerate(SER):
        cx = (idx % COLS) * CELL
        cy = (idx // COLS) * CELL
        sub = bytearray(CELL * CELL * 4)
        for y in range(CELL):
            so = ((cy + y) * w + cx) * 4
            sub[y * CELL * 4:(y + 1) * CELL * 4] = px[so:so + CELL * 4]
        g = white_mask(CELL, CELL, sub)
        masks[name] = norm_mask(g) if g else None
    ref = masks["simhei_ref"]
    print("=== IoU vs SimHei 参照（白色判定）===")
    for n in SER[1:]:
        m = masks[n]
        print("  %-5s %.4f" % (n, iou(ref, m) if m else -1))


if __name__ == "__main__":
    html = os.path.join(TMP, "_series.html")
    build_html(html)
    if len(sys.argv) > 1:
        analyze(sys.argv[1])
