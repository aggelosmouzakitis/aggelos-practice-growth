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

// The approved SEO and social values, exactly.
const TITLE = 'Marketing Hot Seat for Therapists | Aggelos Mouzakitis';
const DESCRIPTION = 'Join a weekly online marketing group for therapists. Get live coaching on SEO, referrals, content and what to focus on next. €59/month.';
const OG = {
  type: 'website',
  site_name: 'Aggelos Mouzakitis · Marketing',
  locale: 'en_GB',
  url: `${SITE}/`,
  title: 'You’re a therapist. Now you’re expected to know marketing, too.',
  description: 'The Marketing Hot Seat is a weekly online group where therapists get help deciding what’s worth doing to find more clients. €59/month.',
  image: `${SITE}/social/marketing-hot-seat-og.png`,
  'image:type': 'image/png',
  'image:width': '1200',
  'image:height': '630',
  'image:alt': 'The Marketing Hot Seat for therapists, with Aggelos Mouzakitis.'
};

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
check('title is the approved SEO title (30–65 characters)', title === TITLE && title.length >= 30 && title.length <= 65, `${title.length}: ${title}`);
const desc = meta(html, 'name', 'description') || '';
check('meta description is the approved one (120–160 characters)', desc === DESCRIPTION && desc.length >= 120 && desc.length <= 160, `${desc.length}: ${desc}`);
check('canonical is the production root', html.includes(`<link rel="canonical" href="${SITE}/">`) && (html.match(/rel="canonical"/g) || []).length === 1);
check('production build is indexable (robots index, follow)', indexable);
check('viewport meta', html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
check('Content-Security-Policy meta', /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/.test(html));

// ── Social previews ─────────────────────────────────────────────────────────
const og = (k) => meta(html, 'property', 'og:' + k);
const tw = (k) => meta(html, 'name', 'twitter:' + k);
for (const [k, v] of Object.entries(OG)) check(`og:${k} is the approved value`, og(k) === v, og(k));
check('og:image is a file in dist/', fs.existsSync(path.join(DIST, OG.image.slice(SITE.length))));
check('twitter:card summary_large_image with the og title, description, image and alt',
  tw('card') === 'summary_large_image' && tw('title') === OG.title && tw('description') === OG.description && tw('image') === OG.image && tw('image:alt') === OG['image:alt']);
const png = fs.readFileSync(path.join(DIST, 'social', 'marketing-hot-seat-og.png'));
const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.toString('latin1', 12, 16) === 'IHDR';
const w = isPng ? png.readUInt32BE(16) : 0;
const h = isPng ? png.readUInt32BE(20) : 0;
check('social image is a 1200×630 PNG under 300 KB', isPng && w === 1200 && h === 630 && png.length < 300 * 1024, `${w}x${h}, ${png.length} bytes`);

// ── Structured data ─────────────────────────────────────────────────────────
let graph = [];
try {
  graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
} catch (e) { /* reported below */ }
const node = (t) => graph.find((n) => n['@type'] === t) || null;
const [page, site, service, person, faqPage] = ['WebPage', 'WebSite', 'Service', 'Person', 'FAQPage'].map(node);
check('JSON-LD parses with WebPage, WebSite, Service, Person and FAQPage', page && site && service && person && faqPage);
check('WebPage: url = canonical, name and description = the SEO title and description',
  page && page.url === `${SITE}/` && page['@id'] === `${SITE}/#webpage` && page.name === TITLE && page.description === DESCRIPTION);
check('WebPage: part of the WebSite, about the Service, primary image = og:image',
  page && site && service && page.isPartOf['@id'] === site['@id'] && page.about['@id'] === service['@id'] && page.primaryImageOfPage.url === OG.image);
check('WebSite: production root, site name = og:site_name', site && site.url === `${SITE}/` && site['@id'] === `${SITE}/#website` && site.name === OG.site_name);
check('Service: The Marketing Hot Seat, provided by the Person', service && service.name === 'The Marketing Hot Seat' && service['@id'] === `${SITE}/#service` && person && service.provider['@id'] === person['@id']);
const offer = service && service.offers;
check('Offer: €59 per month at the production root',
  offer && offer['@type'] === 'Offer' && offer.url === `${SITE}/` && offer.price === '59' && offer.priceCurrency === 'EUR' &&
  offer.priceSpecification && offer.priceSpecification.price === '59' && offer.priceSpecification.priceCurrency === 'EUR' &&
  offer.priceSpecification.unitText === 'month' && offer.priceSpecification.billingDuration === 'P1M');
check('Person: name, url, jobTitle, sameAs', person && person.name === 'Aggelos Mouzakitis' && person.url && person.jobTitle && person.sameAs.length > 0);
const ldText = JSON.stringify(graph);
const ownUrls = [...ldText.matchAll(/"(https:\/\/practice\.aggelosmouzakitis\.com[^"]*)"/g)].map((m) => m[1]);
check('every structured-data URL on this site is under the production root (no /marketing-hot-seat/ path)',
  ownUrls.length > 0 && ownUrls.every((u) => u.startsWith(`${SITE}/`) && !u.includes('/marketing-hot-seat/')), ownUrls.filter((u) => u.includes('/marketing-hot-seat/')).join(', '));
check('no review, rating or result claims in structured data', !/"(Review|AggregateRating|review|aggregateRating|ratingValue)"/.test(ldText));

// The FAQ structured data must say exactly what the visible FAQ says.
const visibleFaq = [...html.matchAll(/<button class="faq-q"[^>]*><span>([\s\S]*?)<\/span>[\s\S]*?<div class="faq-a"[^>]*>([\s\S]*?)<\/div>/g)]
  .map((m) => ({ q: text(m[1]).trim(), a: text(m[2]).trim() }));
const ldFaq = faqPage ? faqPage.mainEntity.map((e) => ({ q: e.name, a: e.acceptedAnswer.text })) : [];
check('FAQPage: seven questions, matching the visible FAQ word for word, in order',
  visibleFaq.length === 7 && ldFaq.length === 7 && visibleFaq.every((v, i) => v.q === ldFaq[i].q && v.a === ldFaq[i].a),
  visibleFaq.map((v, i) => (ldFaq[i] && v.q === ldFaq[i].q && v.a === ldFaq[i].a ? '' : `#${i + 1} "${v.q}"`)).filter(Boolean).join(', '));

// ── Headings and content ────────────────────────────────────────────────────
const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], text: text(m[2]).trim() }));
check('exactly one H1', headings.filter((x) => x.level === 1).length === 1);
check('H1 is the hero headline', headings[0] && headings[0].level === 1 && headings[0].text === 'You’re a therapist. Now you’re expected to know marketing, too.', headings[0] && headings[0].text);
let skip = null;
headings.reduce((prev, cur) => { if (cur.level > prev + 1 && !skip) skip = cur; return cur.level; }, 1);
check('heading levels never skip', !skip, skip && `h${skip.level} "${skip.text}"`);
check('section headings in order', headings.filter((x) => x.level === 2).map((x) => x.text).join(' | ') === [
  'Will this just give me more things to do?',
  'What will we actually do in a session?',
  'What does a week look like?',
  'What can we work on?',
  'Who’s running this?',
  'Come to a session and see how it works.',
  'A few things you might be wondering',
  'Bring the thing you’ve been trying to work out alone.'
].join(' | '), headings.filter((x) => x.level === 2).map((x) => x.text).join(' | '));
for (const phrase of [
  'Marketing hot seats for therapists',
  'Should you make Instagram videos?',
  'Are directories like Psychology Today or Doctoranytime worth paying for?',
  'The Marketing Hot Seat is a weekly online group where you get help deciding what’s worth doing for your practice and how to go about it.',
  'I’m Aggelos Mouzakitis, a psychotherapist with 18+ years in marketing and product.',
  'After your first session, you can request a full refund of your first month’s €59. No questions asked.',
  'Recordings and summaries stay for seven days. There’s no growing archive to work through.',
  'Practise the parts that feel awkward',
  'I’ll send the session times and joining information so you can decide whether it fits.',
  'How do I do this when it feels uncomfortable?',
  'I’ll help you question the advice you’ve been given and work on changes you can use.',
  'Money-back guarantee',
  'Leave your email and I’ll send the session times and joining information.',
  'Get joining details · €59/month'
]) check(`content in the HTML: "${phrase}"`, body.includes(phrase));
check('all seven FAQ answers are in the HTML', (html.match(/class="faq-a"/g) || []).length === 7);

// ── Nothing left of the X-Ray page ──────────────────────────────────────────
const leftovers = /x-?ray|practice growth|practice-growth|€149|clarity guarantee|wtf-friday/i;
const shipped = fs.readdirSync(DIST, { recursive: true }).filter((f) => fs.statSync(path.join(DIST, f)).isFile());
const textFiles = shipped.filter((f) => /\.(html|js|txt|xml|svg)$/.test(f) && !/lead-capture|vendor/.test(f));
const stale = textFiles.filter((f) => leftovers.test(fs.readFileSync(path.join(DIST, f), 'utf8'))).concat(shipped.filter((f) => leftovers.test(f)));
check('no X-Ray or Practice Growth text, file or asset in the deployed site', stale.length === 0, stale.join(', '));
check('no reference to a /marketing-hot-seat/ path (the page lives at /)', !textFiles.some((f) => /marketing-hot-seat\//.test(fs.readFileSync(path.join(DIST, f), 'utf8'))));

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
check('forms submit with source marketing-hot-seat', main.includes("source: 'marketing-hot-seat'"));
check('notification subject: [Hot Seat] New Marketing Hot Seat enquiry: <email>', main.includes("subject: '[Hot Seat] New Marketing Hot Seat enquiry: ' + emailVal"));
check('success is shown only when submitLead reports ok', /function \(ok\) \{\s*if \(ok\) \{\s*state\.status = 'sent'/.test(main));
for (const o of ['hero', 'week', 'final']) {
  const cta = html.match(new RegExp(`<button[^>]*id="cta-${o}"[^>]*>`));
  const site = html.match(new RegExp(`<input[^>]*id="hs-${o}-site"[^>]*>`));
  const email = html.match(new RegExp(`<input[^>]*id="hs-${o}-email"[^>]*>`));
  const phone = html.match(new RegExp(`<input[^>]*id="hs-${o}-phone"[^>]*>`));
  check(`[${o}] CTA controls its form; website optional, email required, phone optional`,
    cta && /aria-expanded="false"/.test(cta[0]) && cta[0].includes(`aria-controls="join-${o}"`) && html.includes(`id="join-${o}" hidden`) &&
    site && !/\srequired/.test(site[0]) && email && /type="email"/.test(email[0]) && /\srequired/.test(email[0]) && phone && /type="tel"/.test(phone[0]) && !/\srequired/.test(phone[0]));
}
check('no payment or checkout on the page', !/stripe|paypal|checkout|type="submit"[^>]*>[^<]*(?:pay|buy)/i.test(html));

// ── Crawling files ──────────────────────────────────────────────────────────
const robots = read('robots.txt');
check('robots.txt allows crawling and lists the sitemap', /User-agent: \*\nAllow: \//.test(robots) && robots.includes(`Sitemap: ${SITE}/sitemap.xml`));
const sitemap = read('sitemap.xml');
check('sitemap.xml lists only the canonical root, with a lastmod', sitemap.includes(`<loc>${SITE}/</loc>`) && (sitemap.match(/<loc>/g) || []).length === 1 && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap));
check('production build has no noindex _headers file', indexable ? !fs.existsSync(path.join(DIST, '_headers')) : fs.existsSync(path.join(DIST, '_headers')));
check('404 page exists and is noindex', /<meta name="robots" content="noindex/.test(read('404.html')));
check('icons present', ['favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'].every((f) => fs.existsSync(path.join(DIST, f))));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
