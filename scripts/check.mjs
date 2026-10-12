#!/usr/bin/env node
// Static checks on the built site (run `npm test`, which builds first).
// Verifies what search engines, link previews and the lead layer depend on is
// present in the delivered HTML itself, not added later by JavaScript.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://practice.aggelosmouzakitis.com';

// lead-capture.js is used unchanged from aggelosmouzakitis.com (repo
// aggelosmouzakitispersonal, built from lead-capture.jsx). If it is updated
// there, copy it over and update this hash.
const LEAD_CAPTURE_SHA256 = '9acfede619e7e49f03e1b0c2d85e5b6bb989db68f67b1fc048a2c4af7914bed7';
// @emailjs/browser 4.4.1 dist/email.min.js, from the npm tarball whose integrity
// matched the registry (sha512-DGSlP9sPvyFba3to2A50kDtZ+pXVp/0rhmqs2LmbMS3I5J8FSOgLwzY2Xb4qfKlOVHh29EAutLYwe5yuEZmEFg==).
const EMAILJS_SHA256 = '052f6916a21ba5be140366439e81b84ad11363c84dfba2a06f208c7b4a6f6d5f';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  (' + detail + ')' : ''}`);
}
const read = (p) => fs.readFileSync(path.join(DIST, p), 'utf8');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Rendered text, roughly: inline tags join their text, other tags separate it.
const text = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<\/?(?:span|a|strong|em|b|i)\b[^>]*>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');
function meta(html, attr, key) {
  const m = html.match(new RegExp(`<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content="([^"]*)">`));
  return m ? m[1] : null;
}

const html = read('index.html');
const indexable = /<meta name="robots" content="index, follow/.test(html);
const body = text(html.slice(html.indexOf('<body')));

// ── Document ────────────────────────────────────────────────────────────────
check('<html lang="en">', /<html lang="en"/.test(html));
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
check('title present, 30–65 characters', title.length >= 30 && title.length <= 65, `${title.length}: ${title}`);
const desc = meta(html, 'name', 'description') || '';
check('meta description 120–160 characters', desc.length >= 120 && desc.length <= 160, `${desc.length}: ${desc}`);
check('canonical is the production URL', html.includes(`<link rel="canonical" href="${SITE}/">`));
check('production build is indexable (robots index, follow)', indexable);
check('viewport meta', html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
check('Content-Security-Policy meta', /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/.test(html));

// ── Social previews ─────────────────────────────────────────────────────────
const og = (k) => meta(html, 'property', 'og:' + k);
const tw = (k) => meta(html, 'name', 'twitter:' + k);
check('og:url = canonical', og('url') === `${SITE}/`);
check('og:type, og:title, og:description, og:site_name, og:locale', ['type', 'title', 'description', 'site_name', 'locale'].every((k) => og(k)));
const ogImage = og('image') || '';
check('og:image is an absolute production URL to a file in dist/', ogImage.startsWith(`${SITE}/`) && fs.existsSync(path.join(DIST, ogImage.slice(SITE.length))), ogImage);
check('og:image dimensions 1200×630, type, alt', og('image:width') === '1200' && og('image:height') === '630' && og('image:type') === 'image/jpeg' && !!og('image:alt'));
check('twitter:card summary_large_image with title, description, image, alt', tw('card') === 'summary_large_image' && tw('title') && tw('description') && tw('image') === ogImage && tw('image:alt'));
const jpg = fs.readFileSync(path.join(DIST, 'social', 'practice-growth-og.jpg'));
let w = 0, h = 0;
for (let i = 2; i < jpg.length;) {
  const marker = jpg[i + 1];
  const len = jpg.readUInt16BE(i + 2);
  if (marker >= 0xc0 && marker <= 0xc2) { h = jpg.readUInt16BE(i + 5); w = jpg.readUInt16BE(i + 7); break; }
  i += 2 + len;
}
check('social image file is 1200×630 and under 300 KB', w === 1200 && h === 630 && jpg.length < 300 * 1024, `${w}x${h}, ${jpg.length} bytes`);

// ── Structured data ─────────────────────────────────────────────────────────
let graph = [];
try {
  graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
} catch (e) { /* reported below */ }
const node = (t) => graph.find((n) => n['@type'] === t);
check('JSON-LD parses with WebPage and Person', node('WebPage') && node('Person'));
check('WebPage: url = canonical, about = the Person', node('WebPage') && node('WebPage').url === `${SITE}/` && node('WebPage').about['@id'] === node('Person')['@id']);
check('Person: name, url, jobTitle, sameAs', node('Person') && node('Person').name === 'Aggelos Mouzakitis' && node('Person').url && node('Person').jobTitle && node('Person').sameAs.length > 0);
check('no review, rating or result claims in structured data', !/"(Review|AggregateRating|review|aggregateRating|ratingValue)"/.test(JSON.stringify(graph)));

// ── Headings and content ────────────────────────────────────────────────────
const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], text: text(m[2]).trim() }));
check('exactly one H1', headings.filter((x) => x.level === 1).length === 1);
check('H1 is the hero headline', headings[0] && headings[0].level === 1 && headings[0].text === 'You’ve done the work. Where are the clients?', headings[0] && headings[0].text);
let skip = null;
headings.reduce((prev, cur) => { if (cur.level > prev + 1 && !skip) skip = cur; return cur.level; }, 1);
check('heading levels never skip', !skip, skip && `h${skip.level} "${skip.text}"`);
for (const phrase of [
  'Practice growth consulting for therapists',
  'Your practice has to pay the bills.',
  'A clearer route to a sustainable practice.',
  'I’m a therapist. I’ve also spent my career in growth.',
  'The Practice Growth X-Ray.',
  '€149',
  'The Clarity Guarantee',
  'Fair questions.',
  'Does the X-Ray guarantee new clients?',
  'Make your next move a clearer one.',
  'Request first. No payment on this page.'
]) check(`content in the HTML: "${phrase}"`, body.includes(phrase));
check('all six FAQ answers are in the HTML', (html.match(/class="faq-a"/g) || []).length === 6);

// ── Images and links ────────────────────────────────────────────────────────
const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
check('every image has alt text, width and height', imgs.every((t) => /\salt="[^"]+"/.test(t) && /\swidth="\d+"/.test(t) && /\sheight="\d+"/.test(t)), imgs.find((t) => !/\salt="[^"]+"/.test(t)));
check('only the portrait loads eagerly; it has fetchpriority=high', imgs.filter((t) => !/loading="lazy"/.test(t)).length === 1 && /fetchpriority="high"/.test(imgs.find((t) => !/loading="lazy"/.test(t))));
const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], text: text(m[2]).trim(), label: (m[1].match(/aria-label="([^"]+)"/) || [])[1] }));
const vague = links.filter((l) => /^(click here|here|read more|more|link)$/i.test(l.label || l.text) || !(l.label || l.text));
check('links have descriptive text', vague.length === 0, vague.map((l) => l.attrs).join(' | '));
check('preloads only the two above-the-fold fonts', (html.match(/rel="preload"/g) || []).length === 2 && /archivo-black-v23-latin\.woff2/.test(html) && /inter-v20-latin\.woff2/.test(html));

// ── Lead capture contract ───────────────────────────────────────────────────
const leadFile = fs.readdirSync(path.join(DIST, 'js')).find((f) => /^lead-capture\.[0-9a-f]{10}\.js$/.test(f));
check('lead-capture.js is byte-identical to the live site’s', leadFile && sha256(path.join(DIST, 'js', leadFile)) === LEAD_CAPTURE_SHA256);
const ejsFile = fs.readdirSync(path.join(DIST, 'js', 'vendor')).find((f) => /^emailjs-browser-4\.4\.1\.min\.[0-9a-f]{10}\.js$/.test(f));
check('EmailJS SDK 4.4.1 is the verified npm build', ejsFile && sha256(path.join(DIST, 'js', 'vendor', ejsFile)) === EMAILJS_SHA256);
const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
check('scripts load deferred, in order: EmailJS, lead-capture, main', scripts.length === 3 && /emailjs/.test(scripts[0]) && /lead-capture/.test(scripts[1]) && /main/.test(scripts[2]), scripts.join(', '));
const mainFile = fs.readdirSync(path.join(DIST, 'js')).find((f) => /^main\.[0-9a-f]{10}\.js$/.test(f));
const main = fs.readFileSync(path.join(DIST, 'js', mainFile), 'utf8');
check('forms submit with source practice-growth-xray', main.includes("source: 'practice-growth-xray'"));
check('success is shown only when submitLead reports ok', /function \(ok\) \{\s*if \(ok\) \{\s*state\.status = 'sent'/.test(main));
for (const o of ['hero', 'xray', 'final']) {
  const cta = html.match(new RegExp(`<button[^>]*id="cta-${o}"[^>]*>`));
  const site = html.match(new RegExp(`<input[^>]*id="xr-${o}-site"[^>]*>`));
  const email = html.match(new RegExp(`<input[^>]*id="xr-${o}-email"[^>]*>`));
  const phone = html.match(new RegExp(`<input[^>]*id="xr-${o}-phone"[^>]*>`));
  check(`[${o}] CTA controls its form; website optional, email required, phone optional`,
    cta && /aria-expanded="false"/.test(cta[0]) && cta[0].includes(`aria-controls="form-${o}"`) && html.includes(`id="form-${o}" hidden`) &&
    site && !/\srequired/.test(site[0]) && email && /type="email"/.test(email[0]) && /\srequired/.test(email[0]) && phone && /type="tel"/.test(phone[0]) && !/\srequired/.test(phone[0]));
}

// ── Crawling files ──────────────────────────────────────────────────────────
const robots = read('robots.txt');
check('robots.txt allows crawling and lists the sitemap', /User-agent: \*\nAllow: \//.test(robots) && robots.includes(`Sitemap: ${SITE}/sitemap.xml`));
const sitemap = read('sitemap.xml');
check('sitemap.xml lists the canonical URL with a lastmod', sitemap.includes(`<loc>${SITE}/</loc>`) && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap));
check('production build has no noindex _headers file', indexable ? !fs.existsSync(path.join(DIST, '_headers')) : fs.existsSync(path.join(DIST, '_headers')));
check('404 page exists and is noindex', /<meta name="robots" content="noindex/.test(read('404.html')));
check('icons present', ['favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'].every((f) => fs.existsSync(path.join(DIST, f))));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
