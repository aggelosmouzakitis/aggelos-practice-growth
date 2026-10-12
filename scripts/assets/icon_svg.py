"""Write src/icons/icon.svg: "A." from the wordmark, as outlines from the self-hosted
Inter Tight (weight 750, as in the header), cream with the peach dot on the page's
dark colour. scripts/assets/render.mjs rasterises it into the PNG and ICO icons.

Run from the repository root:  python3 -I scripts/assets/icon_svg.py [path-to-fonttools-site-packages]
Needs fontTools and brotli (to read woff2).
"""
import os
import re
import sys

if len(sys.argv) > 1:
    sys.path.insert(0, sys.argv[1])

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FONT = os.path.join(ROOT, 'src', 'fonts', 'inter-tight-v9-latin.woff2')
OUT = os.path.join(ROOT, 'src', 'icons', 'icon.svg')

SIZE = 512
CAP = 300          # cap height of the "A" in the 512 box
TRACK = -0.035     # the wordmark's letter-spacing (em)

font = instancer.instantiateVariableFont(TTFont(FONT), {'wght': 750})
upm = font['head'].unitsPerEm
cap_height = font['OS/2'].sCapHeight
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
scale = CAP / cap_height


def outline(ch, x0):
    name = cmap[ord(ch)]
    pen = SVGPathPen(glyphs)
    # font units are y-up; SVG is y-down. Baseline at y=0 for now.
    glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x0, 0)))
    bounds = BoundsPen(glyphs)
    glyphs[name].draw(bounds)
    return pen.getCommands(), glyphs[name].width * scale, bounds.bounds


a_path, a_adv, a_b = outline('A', 0)
dot_x = a_adv + TRACK * upm * scale
dot_path, dot_adv, d_b = outline('.', dot_x)

# Visible extent: from the A's left edge to the dot's right edge; centre it.
left = a_b[0] * scale
right = dot_x + d_b[2] * scale
width = right - left
tx = (SIZE - width) / 2 - left
ty = (SIZE + CAP) / 2  # baseline so the cap height is centred

def tidy(d):
    # A tenth of a unit in a 512 box is far below a pixel at any icon size.
    return re.sub(r'-?\d+\.\d+', lambda m: ('%.1f' % float(m.group())).rstrip('0').rstrip('.'), d)


a_path, dot_path = tidy(a_path), tidy(dot_path)

svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">'
    '<rect width="{s}" height="{s}" fill="#252321"/>'
    '<g transform="translate({tx:.2f} {ty:.2f})">'
    '<path fill="#F3F0E8" d="{a}"/>'
    '<path fill="#DDA58F" d="{d}"/>'
    '</g></svg>\n'
).format(s=SIZE, tx=tx, ty=ty, a=a_path, d=dot_path)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(svg)
print('%s  %d bytes' % (os.path.relpath(OUT, ROOT), len(svg)))
