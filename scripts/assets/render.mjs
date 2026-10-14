#!/usr/bin/env node
// Rasterises the derived images with Chromium (Playwright), from the repo root:
//   node scripts/assets/render.mjs        the icons
//   node scripts/assets/render.mjs --og   the icons and the social preview
//   - src/icons/icon.svg  -> favicon.ico (16/32/48), apple-touch-icon.png (180),
//                            icon-192.png, icon-512.png
//   - scripts/assets/og.html -> src/social/marketing-hot-seat-og.png (1200x630)
// The committed social preview is the approved design export, so it is only
// re-rendered on request (--og), after a change to og.html. Output is committed;
// the Netlify build never runs this. Needs Playwright with a Chromium (a global
// install is fine: npm i -g playwright).

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICONS = path.join(ROOT, 'src', 'icons');

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch (e) {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

// An .ico whose entries are PNGs (supported by every browser that reads .ico).
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const svg = fs.readFileSync(path.join(ICONS, 'icon.svg'), 'utf8');
    const svgUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    async function rasterise(size) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<html><body style="margin:0"><img src="${svgUrl}" width="${size}" height="${size}" style="display:block"></body></html>`);
      await page.waitForFunction(() => document.images[0] && document.images[0].complete);
      return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size } });
    }
    const out = {};
    for (const size of [16, 32, 48, 180, 192, 512]) out[size] = await rasterise(size);
    fs.writeFileSync(path.join(ICONS, 'favicon.ico'), ico([16, 32, 48].map((size) => ({ size, data: out[size] }))));
    fs.writeFileSync(path.join(ICONS, 'apple-touch-icon.png'), out[180]);
    fs.writeFileSync(path.join(ICONS, 'icon-192.png'), out[192]);
    fs.writeFileSync(path.join(ICONS, 'icon-512.png'), out[512]);

    for (const f of ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
      console.log(`src/icons/${f}  ${fs.statSync(path.join(ICONS, f)).size} bytes`);
    }
    if (!process.argv.includes('--og')) return;

    const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await og.goto(pathToFileURL(path.join(ROOT, 'scripts', 'assets', 'og.html')).href);
    await og.waitForSelector('body[data-ready]');
    await og.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
    const overflow = await og.evaluate(() => document.body.getAttribute('data-overflow'));
    if (overflow) console.warn(`og.html: a headline line is ${overflow}px, wider than its column`);
    fs.mkdirSync(path.join(ROOT, 'src', 'social'), { recursive: true });
    const png = path.join(ROOT, 'src', 'social', 'marketing-hot-seat-og.png');
    await og.screenshot({ path: png, type: 'png' });
    const size = fs.statSync(png).size;
    console.log(`src/social/marketing-hot-seat-og.png  ${size} bytes`);
    // Some link previews (WhatsApp) drop images over about 300 KB; npm test checks it.
    if (size >= 300 * 1024) console.warn('  over 300 KB, which some link previews refuse: npm test will fail until it is smaller');
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
