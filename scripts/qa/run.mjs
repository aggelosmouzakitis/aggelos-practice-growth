#!/usr/bin/env node
// Browser QA for dist/ (run `npm run qa`, which builds first). Needs Playwright
// with Chromium (a global install is fine). Screenshots go to qa-output/.
//
// Serves dist/ with the production headers (scripts/serve.mjs), so the CSP is
// enforced, and replaces the two lead endpoints with local fakes: nothing here
// sends a real lead. The fakes answer the way the real services do: the Apps
// Script web app redirects to script.googleusercontent.com, which returns
// {"ok":true}; EmailJS answers 200 "OK" (or an error status).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../assets/render.mjs';
import { startServer } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'qa-output');
const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}/`;
const WIDTHS = [320, 390, 768, 1024, 1440];
const { chromium } = loadPlaywright();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake lead endpoints ──────────────────────────────────────────────────────
// sheet: 'ok' | 'error' | 'unreadable' | 'down';  owner: 'ok' | 'error' | 'down'
async function fakeLeads(context, { sheet = 'ok', owner = 'ok', delay = 0 } = {}) {
  const calls = { sheet: [], owner: [] };
  const cors = { 'access-control-allow-origin': '*' };
  await context.route('https://script.google.com/**', async (route) => {
    const req = route.request();
    calls.sheet.push({ method: req.method(), contentType: req.headers()['content-type'], body: JSON.parse(req.postData() || '{}') });
    if (delay) await sleep(delay);
    if (sheet === 'down') return route.abort('failed');
    if (sheet === 'error') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"ok":false,"error":"Exception: test"}' });
    if (sheet === 'unreadable') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/html' }, body: '<html>Moved</html>' });
    if (sheet === 'redirect') return route.fulfill({ status: 302, headers: { ...cors, location: 'https://script.googleusercontent.com/macros/echo?user_content_key=qa&lib=qa' } });
    // What the browser ends with after the web app's redirect: {"ok":true}, readable cross-origin.
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"ok":true}' });
  });
  await context.route('https://script.googleusercontent.com/**', (route) =>
    route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"ok":true}' })
  );
  await context.route('https://api.emailjs.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' } });
    }
    calls.owner.push(JSON.parse(req.postData() || '{}'));
    if (delay) await sleep(delay);
    if (owner === 'down') return route.abort('failed');
    if (owner === 'error') return route.fulfill({ status: 400, headers: { ...cors, 'content-type': 'text/plain' }, body: 'The Public Key is invalid' });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/plain' }, body: 'OK' });
  });
  return calls;
}

// Records CSP violations and console errors for a page.
async function watch(page) {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource: net::ERR_(FAILED|TUNNEL_CONNECTION_FAILED)/.test(m.text()) && !/^\[lead\]/.test(m.text())) problems.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  return problems;
}

async function newPage(browser, width, opts = {}) {
  const mobile = width < 800;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    deviceScaleFactor: opts.dpr || 1,
    isMobile: mobile && !opts.desktopPointer,
    hasTouch: mobile && !opts.desktopPointer,
    reducedMotion: opts.reducedMotion || 'no-preference',
    javaScriptEnabled: opts.js !== false
  });
  const calls = opts.leads === false ? null : await fakeLeads(context, opts.leads || {});
  if (opts.blockLeadCapture) await context.route('**/js/lead-capture.*', (r) => r.abort('failed'));
  const page = await context.newPage();
  const problems = await watch(page);
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(BASE + (opts.query || ''), { waitUntil: 'load' });
  if (opts.js !== false) await page.evaluate(() => document.fonts.ready);
  return { context, page, calls, problems, requests };
}

async function loadAllLazy(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 25));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => Array.from(document.images).filter((i) => !i.closest('dialog')).every((i) => i.complete));
}

// ── 1. Layout at each width ──────────────────────────────────────────────────
async function layout(browser) {
  for (const width of WIDTHS) {
    const { context, page, problems } = await newPage(browser, width);
    await loadAllLazy(page);
    const r = await page.evaluate((vw) => {
      const out = { overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, outside: [], clipped: [], small: [], tiny: [] };
      const clips = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
        }
        return false;
      };
      const visible = (el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || el.closest('[hidden],dialog:not([open]),.sr-only,.grain')) return false;
        const b = el.getBoundingClientRect();
        return b.width > 1 && b.height > 1; // 1px boxes are visually hidden on purpose
      };
      const label = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        const b = el.getBoundingClientRect();
        if ((b.right > vw + 0.5 || b.left < -0.5) && !clips(el)) out.outside.push(label(el) + ` [${Math.round(b.left)}..${Math.round(b.right)}]`);
        if (/^(BUTTON|A|LABEL|H1|H2|H3|H4|P|LI|SPAN)$/.test(el.tagName) && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.clipped.push(label(el));
        const fs = parseFloat(getComputedStyle(el).fontSize);
        const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
        if (ownText && fs < 12) out.tiny.push(label(el) + ' ' + fs + 'px');
      }
      // Touch targets: every control and link, except links inside running text.
      // The hit area includes an ::after that extends the box (the desktop nav).
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea')) {
        if (!visible(el) || el.closest('p, .alert')) continue;
        const b = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        const extra = after.content !== 'none' && after.position === 'absolute' ? Math.max(0, -parseFloat(after.left) || 0) + Math.max(0, -parseFloat(after.right) || 0) : 0;
        if (b.height < 44 - 0.5 || b.width + extra < 44 - 0.5) out.small.push(label(el) + ` ${Math.round(b.width + extra)}x${Math.round(b.height)}`);
      }
      // Headline: lines per sentence, and its size.
      out.h1 = Array.from(document.querySelectorAll('.hero-title > span')).map((s) => {
        const range = document.createRange();
        range.selectNodeContents(s);
        const tops = new Set(Array.from(range.getClientRects()).map((rc) => Math.round(rc.top)));
        return tops.size;
      });
      out.h1Size = parseFloat(getComputedStyle(document.querySelector('.hero-title')).fontSize);
      // Running text: the smallest of the section paragraphs.
      out.bodyText = Math.min(...Array.from(document.querySelectorAll('.prose p, .intro-copy p, .card-text, .week-text, .faq-a > p, .cell-from-text')).map((p) => parseFloat(getComputedStyle(p).fontSize)));
      // Section order, as in the prototype.
      out.sections = Array.from(document.querySelectorAll('main > section')).map((s) => s.id).join(',');
      // Card layouts that change with the width (flex-basis switches).
      const tops = (sel) => new Set(Array.from(document.querySelectorAll(sel)).map((e) => Math.round(e.getBoundingClientRect().top))).size;
      out.rows = { questions: tops('.q'), week: tops('.week-step'), topics: tops('.topic'), sessions: tops('.session') };
      return out;
    }, width);
    check(`[${width}] no horizontal scroll`, r.overflowX <= 0, `scrollWidth - clientWidth = ${r.overflowX}`);
    check(`[${width}] nothing outside the viewport`, r.outside.length === 0, r.outside.slice(0, 5).join(', '));
    check(`[${width}] no clipped text`, r.clipped.length === 0, r.clipped.slice(0, 5).join(', '));
    check(`[${width}] touch targets >= 44x44px`, r.small.length === 0, r.small.slice(0, 6).join(', '));
    check(`[${width}] no text under 12px`, r.tiny.length === 0, r.tiny.slice(0, 5).join(', '));
    check(`[${width}] body copy >= 17px`, r.bodyText >= 17, r.bodyText + 'px');
    // The prototype's clamp(33px, 18px + 3.3vw, 66px). The first sentence keeps to one
    // line from 360px; at 320px it takes two balanced lines, as in the prototype.
    const h1Expected = Math.min(66, Math.max(33, 18 + 0.033 * width));
    const firstLines = width < 360 ? 2 : 1;
    check(`[${width}] headline at the prototype's size, "You’re a therapist." on ${firstLines} line(s)`, Math.abs(r.h1Size - h1Expected) < 0.5 && r.h1[0] <= firstLines && r.h1[1] <= 4, `${r.h1Size}px (expected ${h1Expected.toFixed(2)}), lines ${r.h1.join('+')}`);
    check(`[${width}] sections in the prototype's order`, r.sections === 'top,intro,compare,sessions,week,topics,about,price,faq,join', r.sections);
    // Rows of cards, from the content width: the two pairs of questions sit side by side
    // from 980px, and each pair puts its two questions side by side from 500px; the
    // week's steps share a row from 880px, the topics from 940px; sessions take two
    // columns from 2 × 460 + 16.
    const content = Math.min(1280, width - 2 * Math.min(64, Math.max(20, 0.044 * width)));
    const pair = content >= 980 ? (content - 12) / 2 : content;
    const perPair = pair >= 500 ? 1 : 2;
    const want = { questions: content >= 980 ? perPair : 2 * perPair, week: content >= 880 ? 1 : 3, topics: content >= 940 ? 1 : 3, sessions: content >= 936 ? 2 : 4 };
    check(`[${width}] card rows (questions ${want.questions}, week ${want.week}, topics ${want.topics}, sessions ${want.sessions})`, JSON.stringify(r.rows) === JSON.stringify(want), JSON.stringify(r.rows));
    check(`[${width}] no console errors or CSP violations`, problems.length === 0 && (await page.evaluate(() => window.__csp.length)) === 0, problems.concat(await page.evaluate(() => window.__csp)).join(' | '));
    await page.screenshot({ path: path.join(OUT, `page-${width}.png`), fullPage: true });
    await context.close();
  }
}

// ── 2. Header, skip link, FAQ ────────────────────────────────────────────────
async function interactions(browser) {
  // Skip link, logo (1440)
  {
    const { context, page } = await newPage(browser, 1440);
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => ({ cls: document.activeElement.className, top: document.activeElement.getBoundingClientRect().top }));
    check('first Tab shows the skip link', skip.cls === 'skip-link' && skip.top >= 0, JSON.stringify(skip));
    await page.keyboard.press('Enter');
    check('skip link moves focus to main', (await page.evaluate(() => document.activeElement.id)) === 'main');
    const header = await page.evaluate(() => ({
      links: Array.from(document.querySelectorAll('.site-header a')).map((a) => a.className),
      buttons: document.querySelectorAll('.site-header button').length
    }));
    check('header is the wordmark only, as in the prototype', header.links.join() === 'skip-link,brand' && header.buttons === 0, JSON.stringify(header));
    await page.evaluate(() => window.scrollTo(0, document.getElementById('faq').offsetTop));
    await page.locator('.site-footer .brand').click();
    await page.waitForFunction(() => window.scrollY < 5, null, { timeout: 4000 }).catch(() => {});
    check('footer logo returns to the top and focuses it', (await page.evaluate(() => window.scrollY)) < 5 && (await page.evaluate(() => document.activeElement.id)) === 'top');
    await context.close();
  }
  // FAQ
  {
    const { context, page } = await newPage(browser, 390);
    const q = (n) => page.locator('#faq-q' + n);
    const states = await page.evaluate(() => Array.from(document.querySelectorAll('.faq-q')).map((b) => b.getAttribute('aria-expanded') + ':' + !document.getElementById(b.getAttribute('aria-controls')).hidden));
    check('FAQ: seven questions, the first answer open, the others closed',
      states.length === 7 && states[0] === 'true:true' && states.slice(1).every((x) => x === 'false:false'), states.join(' '));
    await q(2).click();
    check('FAQ: opening a second answer keeps the first open', (await page.locator('#faq-a2').isVisible()) && (await page.locator('#faq-a1').isVisible()) && (await q(2).getAttribute('aria-expanded')) === 'true');
    await q(1).focus();
    await page.keyboard.press('Enter');
    check('FAQ: keyboard toggles an answer closed', (await q(1).getAttribute('aria-expanded')) === 'false' && !(await page.locator('#faq-a1').isVisible()));
    for (let n = 1; n <= 7; n++) if ((await q(n).getAttribute('aria-expanded')) !== 'true') await q(n).click();
    const all = await page.evaluate(() => Array.from(document.querySelectorAll('.faq-a')).every((a) => !a.hidden && a.getBoundingClientRect().height > 0));
    check('FAQ: every answer opens', all);
    const icon = await page.evaluate(() => getComputedStyle(document.querySelector('#faq-q2 .faq-icon')).transform);
    check('FAQ: open item shows the rotated + (×)', icon !== 'none', icon);
    await page.locator('#faq').screenshot({ path: path.join(OUT, 'faq-open-390.png') });
    await context.close();
  }
  // Find-in-page reaches a closed answer (hidden="until-found") and opens it.
  {
    const { context, page } = await newPage(browser, 1440);
    const found = await page.evaluate(() => {
      const panel = document.getElementById('faq-a6');
      panel.dispatchEvent(new Event('beforematch'));
      return { hidden: panel.hidden, expanded: document.getElementById('faq-q6').getAttribute('aria-expanded'), untilFound: document.getElementById('faq-a5').getAttribute('hidden') };
    });
    check('FAQ: closed answers are hidden="until-found" and open on find-in-page', found.untilFound === 'until-found' && !found.hidden && found.expanded === 'true', JSON.stringify(found));
    await context.close();
  }
  // Links out
  {
    const { context, page } = await newPage(browser, 1440);
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')));
    check('links: about, psychotherapy practice, confidentiality, refund email',
      ['https://aggelosmouzakitis.com/about/', 'https://aggelosmouzakitis.com/', 'https://aggelosmouzakitis.com/confidentiality/', 'mailto:aggelos.mouzakitis@gmail.com'].every((h) => hrefs.includes(h)), hrefs.join(' '));
    await context.close();
  }
}

// ── 3. Enquiry forms ─────────────────────────────────────────────────────────
const LABELS = {
  hero: 'Intro section: Get joining details · €59/month',
  week: 'Week section: Get joining details · €59/month',
  final: 'Closing section: Get joining details · €59/month'
};
const SUBJECT = '[Hot Seat] New Marketing Hot Seat enquiry: ';

async function forms(browser) {
  // Each CTA, desktop pointer: full success path and the exact payloads.
  for (const origin of ['hero', 'week', 'final']) {
    const { context, page, calls, problems } = await newPage(browser, 1440);
    const cta = page.locator('#cta-' + origin);
    await cta.scrollIntoViewIfNeeded();
    await cta.click();
    await page.waitForTimeout(120);
    const opened = await page.evaluate((o) => ({ exp: document.getElementById('cta-' + o).getAttribute('aria-expanded'), vis: !document.getElementById('join-' + o).hidden, focus: document.activeElement.id }), origin);
    check(`[${origin}] CTA expands its inline form and focuses the first field`, opened.exp === 'true' && opened.vis && opened.focus === `hs-${origin}-site`, JSON.stringify(opened));
    const p = `#hs-${origin}`;
    await page.locator(`#join-${origin} .submit`).click();
    const empty = await page.evaluate((o) => ({ err: document.getElementById(`hs-${o}-email-err`).textContent, inv: document.getElementById(`hs-${o}-email`).getAttribute('aria-invalid'), desc: document.getElementById(`hs-${o}-email`).getAttribute('aria-describedby'), focus: document.activeElement.id }), origin);
    check(`[${origin}] empty email: error, aria-invalid, focus on email, nothing sent`,
      empty.err === 'Enter your email address so I can reply.' && empty.inv === 'true' && empty.desc === `hs-${origin}-email-err` && empty.focus === `hs-${origin}-email` && calls.sheet.length + calls.owner.length === 0, JSON.stringify(empty));
    await page.locator(`${p}-email`).fill('name@');
    check(`[${origin}] invalid email: live format error`, (await page.locator(`${p}-email-err`).textContent()) === 'Enter a valid email address, like name@example.com.');
    await page.locator(`${p}-site`).fill(' https://example-therapy.ie/about ');
    await page.locator(`${p}-email`).fill('qa.test@example.com');
    check(`[${origin}] valid email clears the error`, !(await page.locator(`${p}-email-err`).isVisible()) && (await page.locator(`${p}-email`).getAttribute('aria-invalid')) === 'false');
    await page.locator(`${p}-phone`).fill('+353 1 555 0100');
    await page.locator(`#join-${origin} .submit`).click();
    await page.waitForFunction((o) => !document.querySelector(`#join-${o} .enquiry-sent`).hidden, origin, { timeout: 5000 }).catch(() => {});
    const sent = await page.evaluate((o) => ({
      visible: !document.querySelector(`#join-${o} .enquiry-sent`).hidden,
      title: document.getElementById(`hs-${o}-done`).textContent,
      to: document.querySelector(`#join-${o} [data-sent-to]`).textContent,
      text: document.querySelector(`#join-${o} .sent-text`).textContent,
      focus: document.activeElement.id,
      leadLast: window.leadLast && { ok: window.leadLast.ok, sheet: window.leadLast.sheet, owner: window.leadLast.owner }
    }), origin);
    check(`[${origin}] success shown only after confirmation, focus on the thank-you`,
      sent.visible && sent.title === 'Thanks. Your request has been sent.' && sent.to === 'qa.test@example.com' && sent.text === 'I’ll reply to qa.test@example.com with the session times and joining details.' && sent.focus === `hs-${origin}-done` && sent.leadLast && sent.leadLast.sheet === 'ok' && sent.leadLast.owner === 'ok', JSON.stringify(sent));
    const s = calls.sheet[0] && calls.sheet[0].body;
    const o = calls.owner[0];
    check(`[${origin}] one sheet row: source marketing-hot-seat, detail, subject, fields`,
      calls.sheet.length === 1 && calls.sheet[0].contentType.startsWith('text/plain') && s.source === 'marketing-hot-seat' && s.detail === 'hot-seat-enquiry-' + origin &&
      s.detail_label === 'Marketing Hot Seat enquiry' && s.email === 'qa.test@example.com' && s.subject === SUBJECT + 'qa.test@example.com' &&
      s.website === 'https://example-therapy.ie/about' && s.phone === '+353 1 555 0100' && s.cta === LABELS[origin] &&
      s.notes === `Website/profile: https://example-therapy.ie/about | Phone: +353 1 555 0100 | CTA: ${LABELS[origin]}` &&
      s.detail_extra === `website=https://example-therapy.ie/about; phone=+353 1 555 0100; cta=${origin}` && s.page_url === BASE && s.lead === '1',
      s ? `source=${s.source} detail=${s.detail} cta=${s.cta}` : 'no sheet call');
    const tp = o && o.template_params;
    check(`[${origin}] one owner email via EmailJS: service, template, key, params`,
      calls.owner.length === 1 && o.service_id === 'service_i4xq7vg' && o.template_id === 'template_6mv5hou' && o.user_id === 'bfBcHLXj2nKaev_lT' && o.lib_version === '4.4.1' &&
      tp.subject === SUBJECT + 'qa.test@example.com' && tp.title === SUBJECT + 'qa.test@example.com' && tp.reply_to === 'qa.test@example.com' && tp.source === 'marketing-hot-seat' &&
      tp.website === 'https://example-therapy.ie/about' && tp.phone === '+353 1 555 0100' && tp.cta === LABELS[origin] &&
      tp.message.includes('Marketing Hot Seat enquiry\nAsked for: the session times and joining details\n\nWebsite or directory profile:\nhttps://example-therapy.ie/about\n\nEmail:\nqa.test@example.com\n\nPhone number:\n+353 1 555 0100\n\nForm opened from:\n' + LABELS[origin]),
      o ? `template=${o.template_id} lib=${o.lib_version}` : 'no EmailJS call');
    check(`[${origin}] no console errors or CSP violations`, problems.length === 0 && (await page.evaluate(() => window.__csp.length)) === 0, problems.join(' | '));
    if (origin === 'week') await page.locator(`#join-${origin} .enquiry`).screenshot({ path: path.join(OUT, 'form-sent.png') });
    await cta.click();
    await cta.click();
    check(`[${origin}] reopening after a sent request starts a fresh form`,
      (await page.locator(`#join-${origin} form`).isVisible()) && (await page.locator(`${p}-email`).inputValue()) === '');
    await context.close();
  }

  // Phone: touch behaviour, keyboard hints, Enter, Escape, close, sending state.
  {
    const { context, page, calls } = await newPage(browser, 390, { leads: { delay: 900 } });
    const cta = page.locator('#cta-hero');
    await cta.click();
    await page.waitForTimeout(150);
    const touch = await page.evaluate(() => ({ focus: document.activeElement.id, bottom: document.querySelector('#join-hero .enquiry').getBoundingClientRect().top < innerHeight }));
    check('[phone] touch opens the form without raising the keyboard (focus on its title)', touch.focus === 'hs-hero-title' && touch.bottom, JSON.stringify(touch));
    const attrs = await page.evaluate(() => ['site', 'email', 'phone'].map((k) => {
      const i = document.getElementById('hs-hero-' + k);
      return [k, i.type, i.inputMode, i.autocomplete, i.getAttribute('enterkeyhint'), i.required, parseFloat(getComputedStyle(i).fontSize), Math.round(i.getBoundingClientRect().height)].join(':');
    }));
    check('[phone] fields: url/email/tel keyboards, autocomplete, 16px text (no iOS zoom), 52px tall',
      attrs[0] === 'site:text:url:url:next:false:16:52' && attrs[1] === 'email:email:email:email:send:true:16:52' && attrs[2] === 'phone:tel:tel:tel:send:false:16:52', attrs.join(' | '));
    await page.locator('#hs-hero-site').fill('practice.example');
    await page.locator('#hs-hero-site').press('Enter');
    check('[phone] Enter in the website field moves to email instead of submitting',
      (await page.evaluate(() => document.activeElement.id)) === 'hs-hero-email' && !(await page.locator('#hs-hero-email-err').isVisible()) && calls.sheet.length === 0);
    await page.locator('#hs-hero-email').fill('phone.qa@example.com');
    await page.locator('#hs-hero-email').press('Enter');
    await page.waitForTimeout(150);
    const sending = await page.evaluate(() => ({
      aria: document.querySelector('#join-hero .submit').getAttribute('aria-disabled'),
      label: document.querySelector('#join-hero .submit-sending').hidden === false && document.querySelector('#join-hero .submit-label').hidden,
      live: document.querySelector('#join-hero [data-live]').textContent
    }));
    check('[phone] while sending: button disabled, "Sending…", announced', sending.aria === 'true' && sending.label && sending.live === 'Sending your request', JSON.stringify(sending));
    await page.locator('#join-hero .enquiry-close').click();
    check('[phone] the form cannot be closed mid-send', await page.locator('#join-hero').isVisible());
    await page.evaluate(() => document.querySelector('#join-hero .submit').click());
    await page.waitForFunction(() => !document.querySelector('#join-hero .enquiry-sent').hidden, null, { timeout: 5000 }).catch(() => {});
    check('[phone] a second press while sending sends nothing more; then success', calls.sheet.length === 1 && calls.owner.length === 1 && (await page.locator('#hs-hero-done').isVisible()));
    await page.screenshot({ path: path.join(OUT, 'form-sent-390.png') });
    // Escape and Close return focus to the CTA
    await page.locator('#cta-week').scrollIntoViewIfNeeded();
    await page.locator('#cta-week').click();
    await page.locator('#hs-week-email').focus();
    await page.keyboard.press('Escape');
    check('[phone] Escape in a form closes it and returns focus to its CTA',
      !(await page.locator('#join-week').isVisible()) && (await page.evaluate(() => document.activeElement.id)) === 'cta-week' && (await page.locator('#cta-week').getAttribute('aria-expanded')) === 'false');
    await page.locator('#cta-final').scrollIntoViewIfNeeded();
    await page.locator('#cta-final').click();
    await page.locator('#hs-final-email').fill('draft@example.com');
    await page.locator('#join-final .enquiry-close').click();
    check('[phone] Close returns focus to the CTA', (await page.evaluate(() => document.activeElement.id)) === 'cta-final');
    await page.locator('#cta-final').click();
    check('[phone] a closed draft keeps what was typed', (await page.locator('#hs-final-email').inputValue()) === 'draft@example.com');
    await page.locator('#join-final .enquiry').screenshot({ path: path.join(OUT, 'form-open-390.png') });
    await context.close();
  }

  // Outcomes that must not show success, and the ones that should.
  const cases = [
    { name: 'both services down', leads: { sheet: 'down', owner: 'down' }, expect: 'failed' },
    { name: 'sheet error + EmailJS error', leads: { sheet: 'error', owner: 'error' }, expect: 'failed' },
    { name: 'sheet unreadable (unconfirmed) + EmailJS error', leads: { sheet: 'unreadable', owner: 'error' }, expect: 'failed' },
    { name: 'sheet down, EmailJS accepted', leads: { sheet: 'down', owner: 'ok' }, expect: 'sent' },
    { name: 'sheet confirmed, EmailJS error', leads: { sheet: 'ok', owner: 'error' }, expect: 'sent' }
  ];
  for (const c of cases) {
    const { context, page } = await newPage(browser, 390, { leads: c.leads });
    await page.locator('#cta-week').scrollIntoViewIfNeeded();
    await page.locator('#cta-week').click();
    await page.locator('#hs-week-site').fill('my-site.example');
    await page.locator('#hs-week-email').fill('outcome@example.com');
    await page.locator('#join-week .submit').click();
    await page.waitForFunction(() => window.leadLast, null, { timeout: 20000 });
    await page.waitForTimeout(50);
    const st = await page.evaluate(() => ({
      failed: !document.querySelector('#join-week [data-alert="failed"]').hidden,
      sent: !document.querySelector('#join-week .enquiry-sent').hidden,
      kept: document.getElementById('hs-week-email').value + '|' + document.getElementById('hs-week-site').value,
      button: document.querySelector('#join-week .submit').getAttribute('aria-disabled')
    }));
    if (c.expect === 'failed') {
      check(`outcome: ${c.name} → failure message, details kept, no success`, st.failed && !st.sent && st.kept === 'outcome@example.com|my-site.example' && st.button === null, JSON.stringify(st));
      if (c.name === 'both services down') await page.locator('#join-week .enquiry').screenshot({ path: path.join(OUT, 'form-failed-390.png') });
    } else {
      check(`outcome: ${c.name} → success`, st.sent && !st.failed, JSON.stringify(st));
    }
    await context.close();
  }

  // The web app's real answer is a redirect to script.googleusercontent.com: the CSP
  // must let the browser follow it (here the redirected request then fails at the
  // sandbox's network, after the CSP check, so the owner email carries the lead).
  {
    const { context, page, problems } = await newPage(browser, 390, { leads: { sheet: 'redirect' } });
    const followed = [];
    page.on('requestfailed', (r) => { if (r.url().startsWith('https://script.googleusercontent.com/')) followed.push(r.failure() && r.failure().errorText); });
    page.on('request', (r) => { if (r.url().startsWith('https://script.googleusercontent.com/')) followed.push('requested'); });
    await page.locator('#cta-hero').click();
    await page.locator('#hs-hero-email').fill('redirect@example.com');
    await page.locator('#join-hero .submit').click();
    await page.waitForFunction(() => window.leadLast, null, { timeout: 20000 });
    const csp = await page.evaluate(() => window.__csp);
    check('CSP allows the Apps Script redirect to script.googleusercontent.com', followed.includes('requested') && csp.length === 0 && !followed.some((e) => /csp|blocked/i.test(e || '')), `followed: ${followed.join(', ')}; csp: ${csp.join(', ')}; ${problems.join(' | ')}`);
    await context.close();
  }

  // lead-capture.js missing: nothing sent, the unavailable message.
  {
    const { context, page, calls } = await newPage(browser, 390, { blockLeadCapture: true });
    await page.locator('#cta-hero').click();
    await page.locator('#hs-hero-email').fill('nobody@example.com');
    await page.locator('#join-hero .submit').click();
    await page.waitForTimeout(100);
    check('lead-capture.js missing → "Enquiry connection missing", nothing sent',
      (await page.locator('#join-hero [data-alert="unavailable"]').isVisible()) && !(await page.locator('#hs-hero-done').isVisible()) && calls.sheet.length + calls.owner.length === 0);
    await context.close();
  }

  // ?leaddebug=1 panel renders under the CSP.
  {
    const { context, page, problems } = await newPage(browser, 1440, { query: '?leaddebug=1' });
    await page.locator('#cta-hero').click();
    await page.locator('#hs-hero-email').fill('debug@example.com');
    await page.locator('#join-hero .submit').click();
    await page.waitForSelector('#lead-debug', { timeout: 5000 }).catch(() => {});
    const txt = await page.locator('#lead-debug').textContent().catch(() => '');
    check('?leaddebug=1 shows each operation under the CSP', /sheet\s+ok/.test(txt) && /owner\s+ok/.test(txt) && /ok\s+true/.test(txt) && (await page.evaluate(() => window.__csp.length)) === 0, problems.join(' | '));
    await context.close();
  }
}

// ── 4. Reduced motion, no JavaScript, loading ─────────────────────────────────
async function environment(browser) {
  {
    const { context, page } = await newPage(browser, 1440, { reducedMotion: 'reduce' });
    const d = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionDuration);
    await page.evaluate(() => window.scrollTo(0, document.getElementById('faq').offsetTop));
    await page.locator('.site-footer .brand').click();
    const y = await page.evaluate(() => Math.round(window.scrollY));
    check('reduced motion: no transitions, the logo link jumps to the top instantly', parseFloat(d) < 0.01 && y < 2, `transition ${d}, scrollY ${y}`);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, 390, { js: false, leads: false });
    const r = await page.evaluate(() => ({
      faq: Array.from(document.querySelectorAll('.faq-a')).every((a) => a.getBoundingClientRect().height > 0),
      icons: Array.from(document.querySelectorAll('.faq-icon')).every((i) => getComputedStyle(i).display === 'none'),
      note: document.querySelectorAll('.noscript-note').length,
      forms: Array.from(document.querySelectorAll('.form-slot')).every((f) => f.getBoundingClientRect().height === 0)
    }));
    check('without JavaScript: all FAQ answers readable, email fallback by each CTA, forms stay closed', r.faq && r.icons && r.note === 3 && r.forms, JSON.stringify(r));
    await context.close();
  }
  {
    const { context, page, requests } = await newPage(browser, 390, { dpr: 3 });
    await page.waitForTimeout(300);
    const initial = requests.filter((u) => u.startsWith(BASE));
    const imgs = initial.filter((u) => /\/img\//.test(u)).map((u) => u.split('/').pop().replace(/\.[0-9a-f]{10}\./, '.'));
    check('phone first load: one portrait at the size it is shown, plus the grain tile', imgs.sort().join() === 'aggelos-home-square-520.webp,grain.webp' || imgs.sort().join() === 'aggelos-home-square-800.webp,grain.webp', imgs.join(', '));
    const fonts = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/fonts/')).map((e) => e.name.split('/').pop() + ':' + e.initiatorType));
    check('fonts: Archivo Black and Inter preloaded, Inter Tight loaded on use', fonts.some((f) => f.startsWith('archivo-black') && f.endsWith(':link')) && fonts.some((f) => f.startsWith('inter-v20') && f.endsWith(':link')), fonts.join(', '));
    const lcp = await page.evaluate(() => new Promise((resolve) => {
      new PerformanceObserver((l) => { const e = l.getEntries().pop(); resolve(e ? (e.element ? e.element.tagName + '.' + e.element.className : e.url) + ' @' + Math.round(e.startTime) + 'ms' : 'none'); }).observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => resolve('none'), 1500);
    }));
    const cls = await page.evaluate(() => new Promise((resolve) => {
      let v = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) v += e.value; }).observe({ type: 'layout-shift', buffered: true });
      setTimeout(() => resolve(v), 800);
    }));
    check('phone first load: no layout shift', cls < 0.01, `CLS ${cls.toFixed(4)}, LCP element ${lcp}`);
    const bytes = await page.evaluate(() => performance.getEntriesByType('resource').reduce((n, e) => n + (e.transferSize || e.encodedBodySize || 0), 0) + (performance.getEntriesByType('navigation')[0].transferSize || 0));
    check('phone first load: total bytes', true, `${(bytes / 1024).toFixed(0)} KB over ${initial.length} requests (uncompressed local server)`);
    await context.close();
  }
  // Preview contexts: noindex in the page and an X-Robots-Tag header on every file.
  {
    const { context, page } = await newPage(browser, 1440, { leads: false });
    const res = await page.request.get(BASE);
    const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]').content);
    check('production build: indexable, no X-Robots-Tag header', /^index, follow/.test(robots) && !res.headers()['x-robots-tag'], `${robots}; header ${res.headers()['x-robots-tag'] || 'none'}`);
    await context.close();
  }
  // The social image and the icons are served.
  {
    const { context, page } = await newPage(browser, 390, { leads: false });
    const og = await page.request.get(BASE + 'social/marketing-hot-seat-og.png');
    const icons = await Promise.all(['favicon.ico', 'icon.svg', 'apple-touch-icon.png'].map((f) => page.request.get(BASE + f).then((r) => r.status())));
    check('social image and icons are served', og.status() === 200 && og.headers()['content-type'] === 'image/png' && icons.every((s) => s === 200), `og ${og.status()} ${og.headers()['content-type']}; icons ${icons.join(',')}`);
    const nf = await page.request.get(BASE + 'marketing-hot-seat/');
    check('/marketing-hot-seat/ is not a page (404); the page lives at /', nf.status() === 404);
    await context.close();
  }
}

const server = await startServer(PORT);
const browser = await chromium.launch();
try {
  await layout(browser);
  await interactions(browser);
  await forms(browser);
  await environment(browser);
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in qa-output/`);
process.exit(failed.length ? 1 : 0);
