#!/usr/bin/env node
// Builds dist/ from src/. Node built-ins only, so Netlify needs no npm install.
//
//   node scripts/build.mjs                  production build (indexable)
//   node scripts/build.mjs --context=deploy-preview
//
// Netlify sets CONTEXT (production | deploy-preview | branch-deploy | dev). Only
// production is indexable: every other context gets <meta name="robots"
// content="noindex, nofollow"> and an X-Robots-Tag header on every file
// (dist/_headers), so previews and branch deploys never compete with the live page.
//
// Steps: fingerprint images and scripts (name.<hash>.ext, cached for a year);
// inline the stylesheet; expand the enquiry form partial once per CTA; add a
// Content-Security-Policy with the hashes of the inline script and style; write
// robots.txt and sitemap.xml; then verify every local reference resolves.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://practice.aggelosmouzakitis.com';

const argContext = process.argv.find((a) => a.startsWith('--context='));
const CONTEXT = (argContext ? argContext.split('=')[1] : process.env.CONTEXT) || 'production';
const INDEXABLE = CONTEXT === 'production';

// Where the page's scripts may connect: EmailJS (owner notification) and the Apps
// Script web app behind the Leads sheet, which answers through a redirect to
// script.googleusercontent.com (lead-capture.js).
const CONNECT_SRC = ['https://api.emailjs.com', 'https://script.google.com', 'https://script.googleusercontent.com'];

const PAGES = ['index.html', '404.html'];
const ENQUIRY_ORIGINS = ['hero', 'week', 'final'];

function fail(msg) {
  console.error('build: ' + msg);
  process.exit(1);
}
function sha256b64(text) {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function toUrl(p) {
  return '/' + path.relative(DIST, p).split(path.sep).join('/');
}

// ── 1. Clean ──────────────────────────────────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ── 2. Fingerprinted assets: /img/* and /js/* ───────────────────────────────
const assetMap = new Map(); // '/img/a.webp' -> '/img/a.1a2b3c4d5e.webp'
for (const dir of ['img', 'js']) {
  for (const file of walk(path.join(SRC, dir))) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    const ext = path.extname(rel);
    const hashed = rel.slice(0, -ext.length) + '.' + hash + ext;
    copy(file, path.join(DIST, hashed));
    assetMap.set('/' + rel, '/' + hashed);
  }
}

// ── 3. Stable-name files: fonts (versioned names), icons, social image ──────
for (const file of walk(path.join(SRC, 'fonts'))) copy(file, path.join(DIST, 'fonts', path.basename(file)));
for (const file of walk(path.join(SRC, 'icons'))) copy(file, path.join(DIST, path.basename(file)));
for (const file of walk(path.join(SRC, 'social'))) copy(file, path.join(DIST, 'social', path.basename(file)));

// Root-relative /img/ and /js/ references only, never the same path inside an
// absolute URL (the JSON-LD points at aggelosmouzakitis.com/img/...).
const ASSET_REF = /(?<=["'(\s,])\/(?:img|js)\/[A-Za-z0-9._\-/]+\.(?:webp|png|jpe?g|svg|js)(?=["')\s,])/g;
function rewriteAssets(text, where) {
  return text.replace(ASSET_REF, (ref) => {
    const hashed = assetMap.get(ref);
    if (!hashed) fail(`${where} references ${ref}, which is not in src/`);
    return hashed;
  });
}

// ── 4. Stylesheet: rewrite, minify (comments and whitespace only) ────────────
const cssSource = fs.readFileSync(path.join(SRC, 'css', 'site.css'), 'utf8');
const css = rewriteAssets(cssSource, 'site.css')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{};,])\s*/g, '$1')
  .replace(/;}/g, '}')
  .trim();

// ── 5. Pages ──────────────────────────────────────────────────────────────────
const enquiryPartial = fs.readFileSync(path.join(SRC, 'partials', 'enquiry.html'), 'utf8');

// Terms that must not break at their slash on narrow screens ("€59/ / month").
// Wrapped in visible text only: never inside tags (attributes), <title>, <script>
// (the JSON-LD) or <style>, so the source copy stays exactly as approved.
const NO_BREAK = ['€59/month'];
function noBreak(html) {
  let raw = null;
  return html
    .split(/(<[^>]+>)/)
    .map((chunk) => {
      if (chunk.startsWith('<')) {
        const m = chunk.match(/^<(\/?)(script|style|title|textarea)\b/i);
        if (m) raw = m[1] ? null : m[2].toLowerCase();
        return chunk;
      }
      if (raw) return chunk;
      return NO_BREAK.reduce((text, term) => text.split(term).join(`<span class="nb">${term}</span>`), chunk);
    })
    .join('');
}

function csp(scriptHashes, styleHashes) {
  return [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)].join(' '),
    ["style-src 'self'", ...styleHashes.map((h) => `'sha256-${h}'`)].join(' '),
    "img-src 'self'",
    "font-src 'self'",
    'connect-src ' + CONNECT_SRC.join(' '),
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ');
}

const builtPages = {};
for (const page of PAGES) {
  let html = fs.readFileSync(path.join(SRC, page), 'utf8');

  html = html.replace(/<!-- @enquiry (\w+) -->/g, (m, origin) => {
    if (!ENQUIRY_ORIGINS.includes(origin)) fail(`${page}: unknown enquiry origin "${origin}"`);
    return enquiryPartial.replace(/\{\{o\}\}/g, origin).trimEnd();
  });

  html = noBreak(html);
  html = rewriteAssets(html, page); // before the stylesheet goes in: its URLs are already hashed
  html = html.replace('<!-- @css -->', `<style>${css}</style>`);
  html = html.replace(
    '<!-- @robots -->',
    INDEXABLE
      ? '<meta name="robots" content="index, follow, max-image-preview:large">'
      : '<meta name="robots" content="noindex, nofollow">'
  );
  if (!INDEXABLE) html = html.replace(/<meta name="robots" content="[^"]*">/g, '<meta name="robots" content="noindex, nofollow">');

  // Hash the inline <script> (not the JSON-LD data block, which never runs) and <style>.
  const scriptHashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha256b64(m[1]));
  const styleHashes = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => sha256b64(m[1]));
  html = html.replace(
    '<!-- @csp -->',
    `<meta http-equiv="Content-Security-Policy" content="${csp(scriptHashes, styleHashes)}">`
  );

  if (/<!-- @/.test(html)) fail(`${page}: unexpanded build placeholder`);
  if (/\sstyle="/i.test(html)) fail(`${page}: inline style attribute (blocked by the CSP); use a class`);

  fs.writeFileSync(path.join(DIST, page), html);
  builtPages[page] = html;
}

// ── 6. robots.txt, sitemap.xml, preview headers ──────────────────────────────
function lastmod() {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!dirty) {
      const d = execFileSync('git', ['log', '-1', '--format=%cs', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim()
        || execFileSync('git', ['log', '-1', '--format=%cs'], { cwd: ROOT, encoding: 'utf8' }).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    }
  } catch (e) { /* no git: fall through */ }
  return new Date().toISOString().slice(0, 10);
}

fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
fs.writeFileSync(
  path.join(DIST, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url>\n    <loc>${SITE}/</loc>\n    <lastmod>${lastmod()}</lastmod>\n  </url>\n` +
    '</urlset>\n'
);
if (!INDEXABLE) {
  fs.writeFileSync(path.join(DIST, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n');
}

// ── 7. Verify every local reference ──────────────────────────────────────────
const problems = [];
function checkLocal(ref, page, html) {
  if (ref.startsWith('#')) {
    const id = ref.slice(1);
    if (id && !new RegExp(`\\sid="${id}"`).test(html)) problems.push(`${page}: #${id} has no target`);
    return;
  }
  if (!ref.startsWith('/') || ref.startsWith('//')) return;
  const clean = ref.split(/[?#]/)[0];
  const file = clean.endsWith('/') ? path.join(DIST, clean, 'index.html') : path.join(DIST, clean);
  if (clean !== '/' && !fs.existsSync(file)) problems.push(`${page}: ${ref} does not exist in dist/`);
}
for (const [page, html] of Object.entries(builtPages)) {
  for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) checkLocal(m[1], page, html);
  for (const m of html.matchAll(/\ssrcset="([^"]+)"/g)) {
    for (const part of m[1].split(',')) checkLocal(part.trim().split(/\s+/)[0], page, html);
  }
  for (const m of html.matchAll(/url\(([^)]+)\)/g)) checkLocal(m[1].replace(/['"]/g, ''), page, html);
  for (const m of html.matchAll(/\saria-(?:controls|labelledby|describedby)="([^"]+)"/g)) {
    for (const id of m[1].split(/\s+/)) {
      if (!new RegExp(`\\sid="${id}"`).test(html)) problems.push(`${page}: aria reference #${id} has no target`);
    }
  }
}
if (problems.length) fail('\n  ' + problems.join('\n  '));

const files = walk(DIST);
const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`build: ${CONTEXT} (${INDEXABLE ? 'indexable' : 'noindex'}), ${files.length} files, ${(total / 1024).toFixed(0)} KB in dist/`);
console.log(`build: index.html ${(Buffer.byteLength(builtPages['index.html']) / 1024).toFixed(1)} KB (CSS inlined ${(css.length / 1024).toFixed(1)} KB)`);
