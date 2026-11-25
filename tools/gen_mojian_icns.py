"""Generate macOS icon.icns from the 1024px master PNG.

Reuses the pure-Python PNG codec / box downscale / rounded-rect alpha from
gen_mojian_icons.py (zero third-party deps).

Input:  src-tauri/icons/_icon_png/master_icon.png  (1024x1024, SimHei 墨, bg #29292B)
Output: src-tauri/icons/icon.icns

ICNS layout: magic "icns" + total length (big-endian) + entries of
(4-byte type, 4-byte length incl. header, PNG bytes). PNG-encoded entries:
  ic07 = 128x128, ic08 = 256x256, ic09 = 512x512, ic10 = 1024x1024
These are the modern types macOS Finder / Dock use; no legacy is32/ih32 needed.

Regenerate master first (see tools/gen_mojian_icons.py docstring):
  msedge.exe --headless=new --disable-gpu --window-size=1024,1024 \
    --screenshot=src-tauri/icons/_icon_png/master_icon.png \
    "file:///.../tools/icon_master.html?bg=29292B"
"""
import os
import struct
import sys

from gen_mojian_icons import decode_png, downscale, apply_round_alpha, encode_png

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "..", "src-tauri", "icons")
MASTER = os.path.join(ICON_DIR, "_icon_png", "master_icon.png")
OUT = os.path.join(ICON_DIR, "icon.icns")

# (ICNS type code, pixel size)
ENTRIES = [("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024)]


def build():
    w, h, px = decode_png(MASTER)
    if w != 1024 or h != 1024:
        print("WARN master is %dx%d (expect 1024)" % (w, h))

    chunks = bytearray()
    for typ, size in ENTRIES:
        buf = downscale(w, h, px, size)
        buf = apply_round_alpha(size, buf)
        png = encode_png(size, size, buf)
        chunks += typ.encode("ascii") + struct.pack(">I", len(png) + 8) + png
        print("%s %4dx%-4d %6d bytes" % (typ, size, size, len(png)))

    total = 8 + len(chunks)
    icns = b"icns" + struct.pack(">I", total) + bytes(chunks)
    open(OUT, "wb").write(icns)

    # verify header + every entry's declared length
    d = open(OUT, "rb").read()
    assert d[:4] == b"icns"
    assert struct.unpack(">I", d[4:8])[0] == len(d)
    pos = 8
    while pos < len(d):
        t = d[pos:pos + 4].decode("ascii")
        ln = struct.unpack(">I", d[pos + 4:pos + 8])[0]
        assert d[pos + 8:pos + 16] == b"\x89PNG\r\n\x1a\n", t
        pos += ln
    assert pos == len(d)
    print("icon.icns: %d bytes, %d entries, OK" % (len(d), len(ENTRIES)))
    return 0


if __name__ == "__main__":
    sys.exit(build())
