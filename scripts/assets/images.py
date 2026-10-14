"""Derive the optimised images from the lossless masters in assets-source/.

Run from the repository root:  python3 -I scripts/assets/images.py [og]
Needs Pillow with WebP support. Output is committed, so the Netlify build never runs this.

- grain.webp: the supplied grain tile (grain.png, opaque grayscale noise) rebuilt as black
  with alpha = 255 - grey. Drawn at opacity .06 with normal blending, that is the same
  arithmetic as the prototype's grain.png at opacity .06 with mix-blend-mode: multiply
  (base * (1 - .06 * (1 - grey))), without a fixed blend layer over the page. The alpha
  is quantised to 16 levels: at most 1/255 away from the original on any colour.
- og: recompresses src/social/marketing-hot-seat-og.png losslessly. An opaque image
  loses its alpha channel (every pixel stays the same), which keeps it under the
  300 KB that some link previews accept.
"""
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'assets-source')
OUT = os.path.join(ROOT, 'src', 'img')
OG = os.path.join(ROOT, 'src', 'social', 'marketing-hot-seat-og.png')

GRAIN_LEVELS = 16


def grain():
    grey = Image.open(os.path.join(SRC, 'grain.png')).convert('L')
    step = 255 / (GRAIN_LEVELS - 1)
    alpha = grey.point(lambda v: round(round((255 - v) / step) * step))
    black = Image.new('L', grey.size, 0)
    tile = Image.merge('RGBA', (black, black, black, alpha))
    path = os.path.join(OUT, 'grain.webp')
    tile.save(path, 'WEBP', lossless=True, quality=100, method=6)
    print('%s  %dx%d  %d bytes' % (os.path.relpath(path, ROOT), tile.width, tile.height, os.path.getsize(path)))


def og():
    im = Image.open(OG)
    im.load()
    if im.mode == 'RGBA' and im.getchannel('A').getextrema() == (255, 255):
        im = im.convert('RGB')
    im.save(OG, 'PNG', optimize=True)
    print('%s  %dx%d %s  %d bytes' % (os.path.relpath(OG, ROOT), im.width, im.height, im.mode, os.path.getsize(OG)))


if __name__ == '__main__':
    if sys.argv[1:] == ['og']:
        og()
    else:
        os.makedirs(OUT, exist_ok=True)
        grain()
    sys.exit(0)
