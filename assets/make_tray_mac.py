"""macOS menu-bar icons (stdlib only): five rounded bars like the app logo.

  trayTemplate.png / @2x            idle   (template: macOS tints it for light/dark menu bars)
  tray-loadingTemplate.png / @2x    model loading (same shape, faded)
  tray-rec-mac.png / @2x            listening (coloured, not a template)

Run: python3 assets/make_tray_mac.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
BARS = [(0.28, 0.38), (0.40, 0.80), (0.52, 0.55), (0.64, 0.95), (0.76, 0.32)]  # (x centre, height) in 0..1


def png(path, w, h, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def coverage(px, py, size):
    """Anti-aliased coverage of pixel (px, py) by the bars (4x4 supersampling)."""
    bw = 0.075 * size      # bar width
    hit = 0
    for sy in range(4):
        for sx in range(4):
            x = px + (sx + 0.5) / 4
            y = py + (sy + 0.5) / 4
            for cx, hgt in BARS:
                half = hgt * size * 0.42
                cy = size / 2
                # capsule: rectangle with round ends
                dx = abs(x - cx * size)
                if dx > bw / 2:
                    continue
                top, bot = cy - half + bw / 2, cy + half - bw / 2
                yy = min(max(y, top), bot)
                if (x - cx * size) ** 2 + (y - yy) ** 2 <= (bw / 2) ** 2:
                    hit += 1
                    break
    return hit / 16


def draw(size, colour, alpha_scale):
    out = []
    for y in range(size):
        for x in range(size):
            a = coverage(x, y, size) * alpha_scale
            r, g, b = colour(x / size) if callable(colour) else colour
            out += [r, g, b, int(round(a * 255))]
    return out


def ember(t):  # iris -> ember, left to right
    a, b = (139, 108, 255), (255, 106, 69)
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


for name, colour, alpha in (("trayTemplate", (0, 0, 0), 1.0), ("tray-loadingTemplate", (0, 0, 0), 0.45), ("tray-rec-mac", ember, 1.0)):
    for scale, suffix in ((1, ""), (2, "@2x")):
        size = 18 * scale
        png(os.path.join(HERE, f"{name}{suffix}.png"), size, size, draw(size, colour, alpha))
        print("wrote", f"{name}{suffix}.png")
