"""Generate OxoFlow icons: a cream waveform on a dark rounded square.
Outputs icon.ico (16..256), icon.png (512), tray.png / tray-rec.png (32 px).
Run: python assets/make_icon.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DARK = (26, 26, 26, 255)        # #1a1a1a
CREAM = (255, 255, 235, 255)    # #ffffeb
RED = (248, 113, 113, 255)      # #f87171
BARS = [0.28, 0.55, 0.92, 0.70, 0.40, 0.80, 0.50]  # relative heights of the waveform bars


def render(size, bg=DARK, fg=CREAM, dot=None, rounded=True):
    s = size * 4  # supersample for smooth edges
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=bg)
    n = len(BARS)
    pad = s * 0.18
    inner = s - 2 * pad
    gap = inner / (n * 2 - 1)
    bar_w = gap
    cy = s / 2
    for i, h in enumerate(BARS):
        x0 = pad + i * 2 * gap
        bh = inner * 0.9 * h
        d.rounded_rectangle((x0, cy - bh / 2, x0 + bar_w, cy + bh / 2), radius=int(bar_w / 2), fill=fg)
    if dot:
        r = s * 0.13
        d.ellipse((s - pad * 0.55 - 2 * r, pad * 0.55, s - pad * 0.55, pad * 0.55 + 2 * r), fill=dot)
    return im.resize((size, size), Image.LANCZOS)


def main():
    big = render(512)
    big.save(os.path.join(HERE, "icon.png"))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(sz) for sz in sizes]
    frames[-1].save(os.path.join(HERE, "icon.ico"), format="ICO", sizes=[(sz, sz) for sz in sizes],
                    append_images=frames[:-1])
    render(32).save(os.path.join(HERE, "tray.png"))
    render(32, dot=RED).save(os.path.join(HERE, "tray-rec.png"))
    render(32, bg=(113, 113, 110, 255)).save(os.path.join(HERE, "tray-loading.png"))
    # Overlay "pill" logo: cream bars without background, for the renderer.
    render(64, rounded=False).save(os.path.join(HERE, "wave.png"))
    print("icons written to", HERE)


if __name__ == "__main__":
    main()
