"""Derive the optimised images in src/img/ from the lossless masters in assets-source/.

Run from the repository root:  python3 -I scripts/assets/images.py
Needs Pillow with WebP support. Output is committed, so the Netlify build never runs this.

- xray-report-example-{560,800,1086}.webp: the report photograph at three widths for
  srcset. 1086 px is the master's full width and is also what the enlarge dialog shows,
  so it gets the higher quality (it is read up close); the smaller ones are inline only.
- grain.webp: the supplied grain tile (grain.png, opaque grayscale noise) rebuilt as black
  with alpha = 255 - grey. Drawn at opacity .06 with normal blending, that is the same
  arithmetic as the prototype's grain.png at opacity .06 with mix-blend-mode: multiply
  (base * (1 - .06 * (1 - grey))), without a fixed blend layer over the page. The alpha
  is quantised to 16 levels: at most 1/255 away from the original on any colour.
"""
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'assets-source')
OUT = os.path.join(ROOT, 'src', 'img')

REPORT_WIDTHS = {560: 82, 800: 82, 1086: 86}  # width -> WebP quality
GRAIN_LEVELS = 16


def report():
    master = Image.open(os.path.join(SRC, 'xray-report-example.webp')).convert('RGB')
    for width, quality in REPORT_WIDTHS.items():
        im = master
        if width != master.width:
            im = master.resize((width, round(master.height * width / master.width)), Image.LANCZOS)
        path = os.path.join(OUT, 'xray-report-example-%d.webp' % width)
        im.save(path, 'WEBP', quality=quality, method=6)
        print('%s  %dx%d  %d bytes' % (os.path.relpath(path, ROOT), im.width, im.height, os.path.getsize(path)))


def grain():
    grey = Image.open(os.path.join(SRC, 'grain.png')).convert('L')
    step = 255 / (GRAIN_LEVELS - 1)
    alpha = grey.point(lambda v: round(round((255 - v) / step) * step))
    black = Image.new('L', grey.size, 0)
    tile = Image.merge('RGBA', (black, black, black, alpha))
    path = os.path.join(OUT, 'grain.webp')
    tile.save(path, 'WEBP', lossless=True, quality=100, method=6)
    print('%s  %dx%d  %d bytes' % (os.path.relpath(path, ROOT), tile.width, tile.height, os.path.getsize(path)))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    report()
    grain()
    sys.exit(0)
