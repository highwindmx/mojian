# 生成 JSON 彩色图标 icon-json.ico（纯 Python，无第三方依赖）
# 设计：JSON 黄底圆角方块 + 黑色 { }。32x32 / 32bpp BGRA，标准 BMP ICO。
import struct, os

W = H = 32
OUT = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons', 'icon-json.ico')

# JSON 黄 (#F7D800) -> BGR
BG = (0x00, 0xD8, 0xF7)
FG = (0x00, 0x00, 0x00)  # 黑


def is_brace(x, y):
    # 左括号 { at x 10..14, 右括号 } at x 17..21, 纵向 8..23
    if 8 <= y <= 23:
        if x == 10 and 8 <= y <= 23:
            return True
        if y in (8, 23) and 10 <= x <= 14:
            return True
        if y == 15 and 10 <= x <= 12:  # 中左凸
            return True
        if x == 21 and 8 <= y <= 23:
            return True
        if y in (8, 23) and 17 <= x <= 21:
            return True
        if y == 15 and 19 <= x <= 21:  # 中右凸
            return True
    return False


def build_pixels():
    buf = bytearray()
    r = 5  # 圆角半径
    for y in range(H - 1, -1, -1):  # bottom-up
        for x in range(W):
            transparent = False
            in_corner = ((x < r and y < r) or (x >= W - r and y < r)
                         or (x < r and y >= H - r) or (x >= W - r and y >= H - r))
            if in_corner:
                cx = (r - 1) if x < r else (W - r)
                cy = (r - 1) if y < r else (H - r)
                if (cx - x) ** 2 + (cy - y) ** 2 > (r - 1) ** 2:
                    transparent = True
            if transparent:
                buf += bytes((0, 0, 0, 0))
            elif is_brace(x, y):
                buf += bytes((FG[0], FG[1], FG[2], 255))
            else:
                buf += bytes((BG[0], BG[1], BG[2], 255))
    return bytes(buf)


def main():
    pixels = build_pixels()
    and_mask = b'\x00' * ((W * H) // 8)  # 全不透明
    bmh = struct.pack('<IiiHHIIiiII', 40, W, H * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    img = bmh + pixels + and_mask
    icondir = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII',
                        W, H, 0, 0, 1, 32, len(img), 6 + 16)
    ico = icondir + entry + img
    with open(OUT, 'wb') as f:
        f.write(ico)
    print('wrote', os.path.abspath(OUT), len(ico), 'bytes')


if __name__ == '__main__':
    main()
