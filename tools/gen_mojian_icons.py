"""Mojian icon series generator (SimHei standard).

Pipeline (sandbox-friendly, zero third-party deps):
  1. Edge headless renders tools/icon_master.html?bg=RRGGBB at 1024x1024
     -> src-tauri/icons/_icon_png/master_<type>.png   (done outside, see README)
  2. This script: decode each master (pure Python), box-filter downscale to
     16/24/32/48/64/128/256, apply analytic rounded-rect alpha (radius 22.5%),
     assemble PNG-frame ICO per type.

Standard (locked 2026-10-27, see user skill "mojian-icon"):
  - glyph: white SimHei U+58A8, ink bbox ~= 68.75% of canvas (font-size 800/1024)
  - shape: rounded square, corner radius 22.5%, corners fully transparent
  - frames: 16/24/32/48/64/128/256 (PNG-embedded ICO)
  - colors: md/icon #29292B, html #6A6F76, svg #295691, pdf #B93434,
            epub #E963A8, json #F0AF0A
"""
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "..", "src-tauri", "icons")
PNG_DIR = os.path.join(ICON_DIR, "_icon_png")

SIZES = [16, 24, 32, 48, 64, 128, 256]
RADIUS_RATIO = 0.225

# type -> ico filename, bg hex (sampled from originals)
TYPES = [
    ("md", "icon-md.ico", "29292B"),
    ("html", "icon-html.ico", "6A6F76"),
    ("svg", "icon-svg.ico", "295691"),
    ("pdf", "icon-pdf.ico", "B93434"),
    ("epub", "icon-epub.ico", "E963A8"),
    ("json", "icon-json.ico", "F0AF0A"),
]


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


# ------------------------------------------------------------ downscale (box)
def downscale(src_w, src_h, px, target):
    scale = src_w / target
    out = bytearray(target * target * 4)
    for ty in range(target):
        y0 = int(ty * scale)
        y1 = max(y0 + 1, int((ty + 1) * scale))
        for tx in range(target):
            x0 = int(tx * scale)
            x1 = max(x0 + 1, int((tx + 1) * scale))
            r = g = b = a = n = 0
            for y in range(y0, y1):
                base = y * src_w * 4
                for x in range(x0, x1):
                    i = base + x * 4
                    al = px[i + 3]
                    r += px[i] * al
                    g += px[i + 1] * al
                    b += px[i + 2] * al
                    a += al
                    n += 1
            if a:
                oi = (ty * target + tx) * 4
                out[oi] = r // a
                out[oi + 1] = g // a
                out[oi + 2] = b // a
                out[oi + 3] = a // n
    return out


# ------------------------------------------------- analytic rounded-rect alpha
def apply_round_alpha(size, rgba):
    """Rounded square coverage, radius RADIUS_RATIO*size, 1px AA.

    Pixel center (x+.5, y+.5); distance to rounded-rect boundary:
    d = sqrt(max(|u|-q,0)^2 + max(|v|-q,0)^2) - r, q = size/2 - r.
    coverage = clamp(0.5 - d, 0, 1).
    """
    r = size * RADIUS_RATIO
    q = size / 2.0 - r
    for y in range(size):
        v = abs(y + 0.5 - size / 2.0)
        dy = max(v - q, 0.0)
        for x in range(size):
            u = abs(x + 0.5 - size / 2.0)
            dx = max(u - q, 0.0)
            d = (dx * dx + dy * dy) ** 0.5 - r
            cov = 0.5 - d
            if cov <= 0:
                oi = (y * size + x) * 4
                rgba[oi] = rgba[oi + 1] = rgba[oi + 2] = rgba[oi + 3] = 0
            elif cov < 1:
                oi = (y * size + x) * 4
                a = int(cov * 255)
                rgba[oi + 3] = a
    return rgba


# ---------------------------------------------------------------- PNG encode
def encode_png(w, h, rgba):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, body):
        c = struct.pack(">I", len(body)) + typ + body
        c += struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", comp) + chunk(b"IEND", b""))


# ------------------------------------------------------------------ ICO pack
def decode_png_data(d):
    """Minimal IHDR+first-IDAT decode for a small PNG -> returns raw scanlines."""
    pos = 8
    idat = bytearray()
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    return zlib.decompress(bytes(idat))


def pack_ico(frames):
    ico = bytearray()
    ico += struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    for s, data in frames:
        w = 0 if s >= 256 else s
        ico += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in frames:
        ico += data
    return bytes(ico)


def build(master_path, out_ico):
    w, h, px = decode_png(master_path)
    if w != 1024 or h != 1024:
        print("WARN: %s is %dx%d (expect 1024)" % (master_path, w, h))
    frames = []
    for s in SIZES:
        buf = downscale(w, h, px, s)
        buf = apply_round_alpha(s, buf)
        frames.append((s, encode_png(s, s, buf)))
    ico = pack_ico(frames)
    open(out_ico, "wb").write(ico)
    # verify: frame list + corner transparency + bg pixel
    d = open(out_ico, "rb").read()
    cnt = struct.unpack("<H", d[4:6])[0]
    ok = True
    for i in range(cnt):
        size, off = struct.unpack("<II", d[6 + i * 16 + 8:6 + i * 16 + 16])
        if d[off:off + 8] != b"\x89PNG\r\n\x1a\n":
            ok = False
    # corner alpha check on 256 frame (extract its PNG, sample (2,2))
    for i in range(cnt):
        size, off = struct.unpack("<II", d[6 + i * 16 + 8:6 + i * 16 + 16])
        w = d[6 + i * 16]
        if w == 0:  # 256 frame
            corner = decode_png_data(d[off:off + size])
            return size, cnt, ok and corner[0] == 0
    return size, cnt, ok


def main():
    for typ, out_name, _bg in TYPES:
        master = os.path.join(PNG_DIR, "master_%s.png" % typ)
        if not os.path.isfile(master):
            print("MISSING master:", master)
            return 1
        size, cnt, ok = build(master, os.path.join(ICON_DIR, out_name))
        print("%-5s -> %-16s %6d bytes, %d frames, png-ok=%s" % (typ, out_name, size, cnt, ok))
    return 0


if __name__ == "__main__":
    sys.exit(main())
