"""Generate OxoFlow's app icon and the .dmg window background.

Outputs:
  icon.png             1024 px macOS-style icon (squircle with Apple's margins)
  icon.ico             Windows icon, 16..256 px, nearly full-bleed
  dmg-background.png   660x400 background of the install window (+ @2x)
  ../site/img/icon.png website favicon and logo

Needs Pillow, fontTools and brotli (the fonts ship as woff2):
  uv pip install pillow fonttools brotli && python assets/make_brand.py
"""
import io
import math
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
IRIS = (139, 108, 255)    # #8b6cff, same brand gradient as the hub and the site
EMBER = (255, 122, 89)    # #ff7a59
ORCHID = (226, 102, 178)  # mid stop, keeps the blend from going muddy
INK = (14, 13, 18)
BARS = [0.30, 0.56, 0.92, 0.70, 0.42, 0.80, 0.50]


def diagonal(size, *stops):
    """Top-left -> bottom-right gradient through evenly spaced colour stops."""
    seed = Image.new("L", (2, 2))
    seed.putdata([0, 128, 128, 255])
    ramp = seed.resize(size, Image.BILINEAR, box=(0.5, 0.5, 1.5, 1.5))
    out = Image.new("RGB", size, stops[0])
    n = len(stops) - 1
    for i in range(1, n + 1):
        lo = 255 * (i - 1) / n
        band = ramp.point(lambda v, lo=lo: max(0, min(255, round((v - lo) * n))))
        out = Image.composite(Image.new("RGB", size, stops[i]), out, band)
    return out


def squircle(s, n=5.0):
    """Superellipse mask, close to Apple's continuous-corner icon shape."""
    pts = []
    for i in range(720):
        a = 2 * math.pi * i / 720
        c, d = math.cos(a), math.sin(a)
        x = math.copysign(abs(c) ** (2 / n), c)
        y = math.copysign(abs(d) ** (2 / n), d)
        pts.append(((x + 1) * s / 2, (y + 1) * s / 2))
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def glyph(s):
    """The tile: brand gradient, soft top light, white waveform."""
    tile = diagonal((s, s), IRIS, ORCHID, EMBER).convert("RGBA")
    light = Image.new("L", (s, s), 0)
    ImageDraw.Draw(light).ellipse((-s * 0.3, -s * 0.75, s * 1.3, s * 0.5), fill=38)
    light = light.filter(ImageFilter.GaussianBlur(s * 0.1))
    tile = Image.composite(Image.new("RGBA", (s, s), (255, 255, 255, 255)), tile, light)

    bars = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(bars)
    n = len(BARS)
    pad = s * 0.22
    inner = s - 2 * pad
    gap = inner / (n * 2 - 1)
    for i, h in enumerate(BARS):
        x0 = pad + i * 2 * gap
        bh = inner * 0.88 * h
        d.rounded_rectangle((x0, s / 2 - bh / 2, x0 + gap, s / 2 + bh / 2), radius=gap / 2, fill=255)
    shade = bars.filter(ImageFilter.GaussianBlur(s * 0.02)).point(lambda v: v * 0.35)
    shade = ImageChops.offset(shade, 0, round(s * 0.012))
    tile = Image.composite(Image.new("RGBA", (s, s), (60, 20, 60, 255)), tile, shade)
    tile = Image.composite(Image.new("RGBA", (s, s), (255, 255, 255, 255)), tile, bars)
    return tile


def app_icon(size=1024, body=0.805, shadow=True):
    """macOS grid: the shape is ~824/1024 with a soft drop shadow beneath."""
    k = 2
    S = size * k
    b = round(S * body)
    off = (S - b) // 2
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = squircle(b)
    if shadow:
        sh = Image.new("L", (S, S), 0)
        sh.paste(mask.point(lambda v: v * 0.45), (off, off + round(S * 0.012)))
        sh = sh.filter(ImageFilter.GaussianBlur(S * 0.014))
        out.paste(Image.new("RGBA", (S, S), (0, 0, 0, 255)), (0, 0), sh)
    tile = glyph(b)
    rim = Image.new("RGBA", (b, b), (255, 255, 255, 0))
    ImageDraw.Draw(rim).rectangle((0, 0, b, b), fill=(255, 255, 255, 40))
    inner = mask.filter(ImageFilter.MinFilter(9))
    tile = Image.composite(tile, Image.alpha_composite(tile, rim), inner)
    out.paste(tile, (off, off), mask)
    return out.resize((size, size), Image.LANCZOS)


def font(name, px):
    """Load a woff2 shipped with the app through fontTools (Pillow can't read woff2)."""
    f = TTFont(os.path.join(HERE, "fonts", name))
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, px)


def glow(canvas, center, radius, color, alpha):
    w, h = canvas.size
    m = Image.new("L", (w, h), 0)
    x, y = center
    ImageDraw.Draw(m).ellipse((x - radius, y - radius, x + radius, y + radius), fill=alpha)
    m = m.filter(ImageFilter.GaussianBlur(radius * 0.55))
    return Image.composite(Image.new("RGB", (w, h), color), canvas, m)


def dmg_background(scale=1):
    """660x400 window. Icons sit at (180,215) and (480,215), 128 px.

    Over a background picture Finder draws the icon labels in black, whatever
    the system appearance, so they sit on a light frosted card.
    """
    W, H = 660 * scale, 400 * scale
    u = lambda v: round(v * scale)  # noqa: E731
    bg = Image.new("RGB", (W, H), INK)
    bg = glow(bg, (u(90), u(40)), u(260), IRIS, 120)
    bg = glow(bg, (u(600), u(400)), u(250), EMBER, 95)

    card = Image.new("L", (W, H), 0)
    ImageDraw.Draw(card).rounded_rectangle((u(60), u(118), u(600), u(340)), radius=u(26), fill=255)
    bg = Image.composite(diagonal((W, H), (226, 220, 250), (240, 222, 240), (252, 226, 214)), bg, card.point(lambda v: v * 0.94))
    edge = Image.new("L", (W, H), 0)
    ImageDraw.Draw(edge).rounded_rectangle((u(60), u(118), u(600), u(340)), radius=u(26), outline=255, width=max(1, u(1)))
    bg = Image.composite(Image.new("RGB", (W, H), (255, 255, 255)), bg, edge.point(lambda v: v * 0.6))

    d = ImageDraw.Draw(bg)
    title = font("instrument-serif-italic.woff2", u(40))
    sub = font("figtree-2.woff2", u(14))
    t = "Bienvenue dans OxoFlow"
    d.text((W / 2, u(56)), t, font=title, fill=(250, 247, 255), anchor="mm")
    d.text((W / 2, u(92)), "Glisse l’icône dans le dossier Applications", font=sub, fill=(200, 196, 214), anchor="mm")

    # Gradient arrow between the two icons.
    arrow = Image.new("L", (W, H), 0)
    a = ImageDraw.Draw(arrow)
    y = u(205)
    a.rounded_rectangle((u(270), y - u(3), u(388), y + u(3)), radius=u(3), fill=255)
    a.polygon([(u(386), y - u(14)), (u(408), y), (u(386), y + u(14))], fill=255)
    arrow = arrow.filter(ImageFilter.GaussianBlur(scale * 0.4))
    bg = Image.composite(diagonal((W, H), IRIS, ORCHID, EMBER), bg, arrow)

    d = ImageDraw.Draw(bg)
    foot = font("figtree-2.woff2", u(11))
    d.text((W / 2, u(372)), "Dictée vocale 100 % locale · rien ne quitte ton Mac", font=foot, fill=(150, 146, 166), anchor="mm")
    return bg


def main():
    icon = app_icon(1024)
    icon.save(os.path.join(HERE, "icon.png"))
    win = app_icon(256, body=0.94, shadow=False)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [win.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(os.path.join(HERE, "icon.ico"), format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    # Website favicon and nav logo: tight crop, no shadow, like the Windows icon.
    app_icon(512, body=0.94, shadow=False).save(os.path.join(HERE, "..", "site", "img", "icon.png"))
    dmg_background(1).save(os.path.join(HERE, "dmg-background.png"))
    dmg_background(2).save(os.path.join(HERE, "dmg-background@2x.png"))
    print("brand assets written to", HERE)


if __name__ == "__main__":
    main()
