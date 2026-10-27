"""Build icon-json.ico from a single master PNG screenshot (1024px).

Pipeline (sandbox-friendly, zero third-party deps):
  1. Edge headless screenshots tools/_json_icon.html at 1024x1024
     -> src-tauri/icons/_json_png/json_master.png   (done outside this script)
  2. This script: decode PNG (pure Python), box-filter downscale to
     16/24/32/48/64/128/256, write PNG frames, assemble PNG-frame ICO.
"""
import os
import struct
import zlib
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "..", "src-tauri", "icons")
PNG_DIR = os.path.join(ICON_DIR, "_json_png")
MASTER = os.path.join(PNG_DIR, "json_master.png")
OUT = os.path.join(ICON_DIR, "icon-json.ico")

SIZES = [16, 24, 32, 48, 64, 128, 256]


# ---------------------------------------------------------------- PNG decode
def decode_png(path):
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", "not a png: " + path
    pos = 8
    width = height = None
    bitdepth = colortype = None
    idat = bytearray()
    palette = None
    trns = None
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            width, height, bitdepth, colortype = struct.unpack(">IIBB", body[:10])
        elif typ == b"PLTE":
            palette = body
        elif typ == b"tRNS":
            trns = body
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    assert bitdepth == 8 and colortype in (2, 6), (
        "expect 8-bit RGB/RGBA, got depth=%d color=%d" % (bitdepth, colortype))
    bpp = 4 if colortype == 6 else 3
    raw = zlib.decompress(bytes(idat))
    stride = width * bpp
    out = bytearray(height * width * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:  # sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:  # up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:  # avg
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:  # paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        obase = y * width * 4
        if colortype == 6:
            out[obase:obase + width * 4] = line
        else:
            # RGB -> RGBA (opaque)
            for x in range(width):
                si = x * 3
                di = obase + x * 4
                out[di] = line[si]
                out[di + 1] = line[si + 1]
                out[di + 2] = line[si + 2]
                out[di + 3] = 255
        prev = line
    return width, height, out


# ------------------------------------------------------------ downscale (box)
def downscale(src_w, src_h, px, target):
    """Box-filter downscale RGBA buffer to target x target. Returns (w,h,buf)."""
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
                    alpha = px[i + 3]
                    # premultiply to avoid halo on transparent edges
                    r += px[i] * alpha
                    g += px[i + 1] * alpha
                    b += px[i + 2] * alpha
                    a += alpha
                    n += 1
            if a:
                oi = (ty * target + tx) * 4
                out[oi] = r // a
                out[oi + 1] = g // a
                out[oi + 2] = b // a
                out[oi + 3] = a // n
    return target, target, out


# ---------------------------------------------------------------- PNG encode
def encode_png(w, h, rgba):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter none
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


def main():
    w, h, px = decode_png(MASTER)
    print("master: %dx%d" % (w, h))
    if w != 1024 or h != 1024:
        print("WARN: master not 1024, continuing anyway")
    frames = []
    for s in SIZES:
        sw, sh, buf = downscale(w, h, px, s)
        png = encode_png(sw, sh, buf)
        p = os.path.join(PNG_DIR, "json_%d.png" % s)
        open(p, "wb").write(png)
        frames.append((s, png))
        print("frame %3d: %d bytes" % (s, len(png)))
    ico = pack_ico(frames)
    open(OUT, "wb").write(ico)
    print("wrote", os.path.normpath(OUT), len(ico), "bytes,", len(frames), "frames")
    # verify
    d = open(OUT, "rb").read()
    cnt = struct.unpack("<H", d[4:6])[0]
    for i in range(cnt):
        e = d[6 + i * 16: 6 + i * 16 + 16]
        fw = e[0] or 256
        size, off = struct.unpack("<II", e[8:16])
        ok = d[off:off + 8] == b"\x89PNG\r\n\x1a\n"
        print("verify %dx%d size=%d png=%s" % (fw, fw, size, ok))
    return 0


if __name__ == "__main__":
    sys.exit(main())
