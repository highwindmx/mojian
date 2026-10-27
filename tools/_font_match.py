"""Font-matching for the Mojian icon glyph: render candidates, compute IoU vs original.

Grid: N cells of 256x256 (4 per row), cell 0 = original md-icon 256 frame,
others = white glyph on black in candidate fonts. Screenshot via Edge, then
pure-Python decode + binarize + bbox-normalize + IoU.
"""
import base64
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = r"C:\Users\KaishengMao\AppData\Local\Temp"

CANDIDATES = [
    ("STXinwei", "STXinwei"),
    ("STXingkai", "STXingkai"),
    ("STLiti", "STLiti"),
    ("LiSu", "LiSu"),
    ("KaiTi", "KaiTi"),
    ("STKaiti", "STKaiti"),
    ("FangSong", "FangSong"),
    ("SimHei", "SimHei"),
    ("YouYuan", "YouYuan"),
    ("STZhongsong", "STZhongsong"),
    ("STHupo", "STHupo"),
    ("MicrosoftYaHei", "Microsoft YaHei"),
    ("SimSun", "SimSun"),
]

CELL = 256


# ---------------------------------------------------------------- png decode
def decode_png(path):
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", path
    pos = 8
    width = height = None
    colortype = None
    idat = bytearray()
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            width, height, _bd, colortype = struct.unpack(">IIBB", body[:10])
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    bpp = 4 if colortype == 6 else 3
    raw = zlib.decompress(bytes(idat))
    stride = width * bpp
    out = bytearray(height * width * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa = abs(b - c); pb = abs(a - c); pc = abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        obase = y * width * 4
        if colortype == 6:
            out[obase:obase + width * 4] = line
        else:
            for x in range(width):
                si = x * 3; di = obase + x * 4
                out[di] = line[si]; out[di + 1] = line[si + 1]
                out[di + 2] = line[si + 2]; out[di + 3] = 255
        prev = line
    return width, height, out


def glyph_mask(w, h, rgba, thr=128):
    """Binarized luminance mask + bbox crop."""
    m = bytearray(w * h)
    for i in range(w * h):
        r = rgba[i * 4]; g = rgba[i * 4 + 1]; b = rgba[i * 4 + 2]
        a = rgba[i * 4 + 3]
        lum = (r * 299 + g * 587 + b * 114) // 1000
        m[i] = 1 if (lum > thr and a > 128) else 0
    xs = [i % w for i in range(w * h) if m[i]]
    ys = [i // w for i in range(w * h) if m[i]]
    if not xs:
        return None
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    crop = [[0] * bw for _ in range(bh)]
    for yy in range(bh):
        row = y0 + yy
        for xx in range(bw):
            crop[yy][xx] = m[row * w + x0 + xx]
    return crop


def norm_mask(crop, n=64):
    """Box-resample bbox-cropped mask to n x n."""
    bh = len(crop); bw = len(crop[0])
    out = [[0] * n for _ in range(n)]
    for ty in range(n):
        y0 = ty * bh // n; y1 = max(y0 + 1, (ty + 1) * bh // n)
        for tx in range(n):
            x0 = tx * bw // n; x1 = max(x0 + 1, (tx + 1) * bw // n)
            s = 0; c = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    s += crop[y][x]; c += 1
            out[ty][tx] = 1 if s * 2 >= c else 0
    return out


def iou(a, b):
    inter = sum(1 for y in range(len(a)) for x in range(len(a[0])) if a[y][x] and b[y][x])
    union = sum(1 for y in range(len(a)) for x in range(len(a[0])) if a[y][x] or b[y][x])
    return inter / union if union else 0.0


def build_html(orig_png_path, out_html):
    b64 = base64.b64encode(open(orig_png_path, "rb").read()).decode()
    cells = ['<div class="cell"><img src="data:image/png;base64,%s"></div>' % b64]
    for _, fam in CANDIDATES:
        cells.append(
            '<div class="cell"><span style="font-family:\'%s\'">墨</span></div>' % fam)
    html = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#000;overflow:hidden}
.cell{width:256px;height:256px;display:inline-block;background:#000;
color:#fff;font-size:200px;line-height:256px;text-align:center;vertical-align:top;
font-family:serif;overflow:hidden}
.cell img{width:256px;height:256px;display:block}
</style></head><body>%s</body></html>""" % ("".join(cells))
    open(out_html, "w", encoding="utf-8").write(html)
    rows = (len(cells) + 3) // 4
    print("html written: %d cells, grid 4x%d" % (len(cells), rows))
    return rows


def main():
    orig_png = os.path.join(TMP, "_cmp_md.png")
    shot = os.path.join(TMP, "_fontgrid.png")
    html_path = os.path.join(TMP, "_fontgrid.html")
    rows = build_html(orig_png, html_path)
    cols = 4
    print("SCREENSHOT_CMD: edge --window-size=%d,%d file:///%s --screenshot=%s"
          % (cols * CELL, rows * CELL, html_path.replace("\\", "/"), shot))
    # if shot exists (passed as arg), analyze
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        w, h, px = decode_png(sys.argv[1])
        print("shot: %dx%d" % (w, h))
        masks = []
        names = ["ORIGINAL"] + [n for n, _ in CANDIDATES]
        for idx, name in enumerate(names):
            cx = (idx % cols) * CELL
            cy = (idx // cols) * CELL
            sub = bytearray(CELL * CELL * 4)
            for y in range(CELL):
                so = ((cy + y) * w + cx) * 4
                sub[y * CELL * 4:(y + 1) * CELL * 4] = px[so:so + CELL * 4]
            g = glyph_mask(CELL, CELL, sub)
            if g is None:
                print("%-16s EMPTY" % name)
                masks.append((name, None))
                continue
            masks.append((name, norm_mask(g)))
        base = dict(masks)["ORIGINAL"]
        ranked = []
        for name, m in masks:
            if name == "ORIGINAL" or m is None:
                continue
            ranked.append((iou(base, m), name))
        ranked.sort(reverse=True)
        print("=== IoU vs ORIGINAL ===")
        for score, name in ranked:
            print("  %.4f  %s" % (score, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
