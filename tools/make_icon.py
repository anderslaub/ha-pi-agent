#!/usr/bin/env python3
"""Draws the integration icon: custom_components/pi_agent/brand/icon.png and icon@2x.png (python3 tools/make_icon.py).
Home Assistant shows the brand/ images of custom integrations; logo and dark variants fall back to the icon."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

N = 2048  # draw big, scale down for smooth edges
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
u = lambda v: int(v * N)

# speech bubble: rounded square with a tail at the bottom left
BUBBLE = (3, 169, 244, 255)   # Home Assistant blue
d.rounded_rectangle([u(.06), u(.06), u(.94), u(.80)], radius=u(.20), fill=BUBBLE)
d.polygon([(u(.22), u(.74)), (u(.44), u(.74)), (u(.16), u(.96))], fill=BUBBLE)

def bezier(*pts, n=60):
    """points along a Bezier curve through control points (in 0..1 units)"""
    from math import comb
    k = len(pts) - 1
    out = []
    for i in range(n + 1):
        t = i / n
        x = sum(comb(k, j) * (1 - t) ** (k - j) * t ** j * pts[j][0] for j in range(k + 1))
        y = sum(comb(k, j) * (1 - t) ** (k - j) * t ** j * pts[j][1] for j in range(k + 1))
        out.append((u(x), u(y)))
    return out

def stroke(points, w):
    """a round brush along the points"""
    for x, y in points:
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill="white")

W = u(.085)
# pi: the bar, a left leg that sweeps out to the left, a right leg with a small curl to the right
stroke(bezier((.25, .31), (.50, .27), (.75, .28), n=120), W)
stroke(bezier((.41, .30), (.41, .52), (.38, .60), (.31, .65), n=120), W)
stroke(bezier((.60, .29), (.585, .55), (.60, .66), (.73, .62), n=120), W)

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "custom_components/pi_agent/brand"
out.mkdir(parents=True, exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(out / "icon@2x.png", optimize=True)
img.resize((256, 256), Image.LANCZOS).save(out / "icon.png", optimize=True)
print("ok")
