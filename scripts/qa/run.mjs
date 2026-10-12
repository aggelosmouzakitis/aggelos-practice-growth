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
      // Headline: lines per sentence.
      out.h1 = Array.from(document.querySelectorAll('.hero-title > span')).map((s) => {
        const range = document.createRange();
        range.selectNodeContents(s);
        const tops = new Set(Array.from(range.getClientRects()).map((rc) => Math.round(rc.top)));
        return tops.size;
      });
      out.h1Size = getComputedStyle(document.querySelector('.hero-title')).fontSize;
      out.bodyText = parseFloat(getComputedStyle(document.querySelector('.prose p')).fontSize);
      return out;
    }, width);
    check(`[${width}] no horizontal scroll`, r.overflowX <= 0, `scrollWidth - clientWidth = ${r.overflowX}`);
    check(`[${width}] nothing outside the viewport`, r.outside.length === 0, r.outside.slice(0, 5).join(', '));
    check(`[${width}] no clipped text`, r.clipped.length === 0, r.clipped.slice(0, 5).join(', '));
    check(`[${width}] touch targets >= 44x44px`, r.small.length === 0, r.small.slice(0, 6).join(', '));
    check(`[${width}] no text under 12px`, r.tiny.length === 0, r.tiny.slice(0, 5).join(', '));
    check(`[${width}] body copy >= 17px`, r.bodyText >= 17, r.bodyText + 'px');
    const maxLines = width < 600 ? 2 : 1;
    check(`[${width}] headline: each sentence on <= ${maxLines} line(s)`, r.h1.every((n) => n <= maxLines), `lines ${r.h1.join('+')} at ${r.h1Size}`);
    check(`[${width}] no console errors or CSP violations`, problems.length === 0 && (await page.evaluate(() => window.__csp.length)) === 0, problems.concat(await page.evaluate(() => window.__csp)).join(' | '));
    await page.screenshot({ path: path.join(OUT, `page-${width}.png`), fullPage: true });
    await context.close();
  }
}

// ── 2. Navigation, menu, spy, FAQ, dialog ────────────────────────────────────
async function interactions(browser) {
  // Compact menu (390)
  {
    const { context, page } = await newPage(browser, 390);
    const btn = page.locator('#menu-btn');
    await btn.click();
    check('menu opens (aria-expanded, visible, label Close)',
      (await btn.getAttribute('aria-expanded')) === 'true' && (await page.locator('#site-menu').isVisible()) && (await page.locator('.menu-btn-label').textContent()) === 'Close');
    await page.screenshot({ path: path.join(OUT, 'menu-open-390.png') });
    await page.keyboard.press('Escape');
    check('Escape closes the menu and returns focus to its button',
      (await btn.getAttribute('aria-expanded')) === 'false' && !(await page.locator('#site-menu').isVisible()) && (await page.evaluate(() => document.activeElement.id)) === 'menu-btn');
    await btn.click();
    await page.locator('#site-menu a[href="#faq"]').click();
    await page.waitForFunction(() => Math.abs(document.getElementById('faq').getBoundingClientRect().top) < 2, null, { timeout: 4000 }).catch(() => {});
    const st = await page.evaluate(() => ({ top: document.getElementById('faq').getBoundingClientRect().top, active: document.activeElement.id, open: document.getElementById('menu-btn').getAttribute('aria-expanded') }));
    check('menu link closes the menu, scrolls to the section and focuses it', Math.abs(st.top) < 2 && st.active === 'faq' && st.open === 'false', JSON.stringify(st));
    await btn.click();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(100);
    check('menu closes when the window reaches desktop width', (await btn.getAttribute('aria-expanded')) === 'false');
    await context.close();
  }
  // Desktop nav, spy, skip link (1440)
  {
    const { context, page } = await newPage(browser, 1440);
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => ({ cls: document.activeElement.className, top: document.activeElement.getBoundingClientRect().top }));
    check('first Tab shows the skip link', skip.cls === 'skip-link' && skip.top >= 0, JSON.stringify(skip));
    await page.keyboard.press('Enter');
    check('skip link moves focus to main', (await page.evaluate(() => document.activeElement.id)) === 'main');
    await page.locator('.nav-wide a[href="#about"]').click();
    await page.waitForFunction(() => Math.abs(document.getElementById('about').getBoundingClientRect().top) < 2, null, { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);
    const about = await page.evaluate(() => ({
      top: Math.round(document.getElementById('about').getBoundingClientRect().top),
      focus: document.activeElement.id,
      current: Array.from(document.querySelectorAll('.nav-link[aria-current="location"]')).map((a) => a.textContent)
    }));
    check('desktop nav scrolls to About, focuses it, marks it current', about.top === 0 && about.focus === 'about' && about.current.join() === 'About', JSON.stringify(about));
    await page.evaluate(() => window.scrollTo(0, document.getElementById('faq').offsetTop - 100));
    await page.waitForTimeout(300);
    check('scroll spy follows the FAQ section', (await page.evaluate(() => Array.from(document.querySelectorAll('.nav-link[aria-current]')).map((a) => a.textContent).join())) === 'FAQ');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    check('scroll spy clears at the top', (await page.locator('.nav-link[aria-current]').count()) === 0);
    await page.locator('.brand').first().click();
    check('logo returns to top', (await page.evaluate(() => window.scrollY)) < 5);
    await context.close();
  }
  // FAQ
  {
    const { context, page } = await newPage(browser, 390);
    const q = (n) => page.locator('#faq-q' + n);
    check('FAQ: first answer open, others closed',
      (await q(1).getAttribute('aria-expanded')) === 'true' && (await page.locator('#faq-a1').isVisible()) && !(await page.locator('#faq-a2').isVisible()));
    await q(2).click();
    check('FAQ: opening a second answer keeps the first open', (await page.locator('#faq-a2').isVisible()) && (await page.locator('#faq-a1').isVisible()) && (await q(2).getAttribute('aria-expanded')) === 'true');
    await q(1).focus();
    await page.keyboard.press('Enter');
    check('FAQ: keyboard toggles an answer closed', (await q(1).getAttribute('aria-expanded')) === 'false' && !(await page.locator('#faq-a1').isVisible()));
    const icon = await page.evaluate(() => getComputedStyle(document.querySelector('#faq-q2 .faq-icon')).transform);
    check('FAQ: open item shows the rotated + (×)', icon !== 'none', icon);
    await context.close();
  }
  // Report dialog, desktop and phone
  for (const width of [1440, 390]) {
    const { context, page } = await newPage(browser, width);
    const opener = page.locator('#report-open');
    await opener.scrollIntoViewIfNeeded();
    await opener.click();
    await page.waitForFunction(() => { const i = document.querySelector('#report-stage img'); return i.complete && i.naturalWidth > 0; });
    await page.evaluate(() => document.querySelector('#report-stage img').decode().catch(() => {}));
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => {
      const img = document.querySelector('#report-stage img').getBoundingClientRect();
      return { open: document.getElementById('report-dialog').open, focus: document.activeElement.id, locked: document.documentElement.classList.contains('has-dialog'), w: Math.round(img.width), h: Math.round(img.height), bottom: Math.round(img.bottom), vh: innerHeight, vw: innerWidth };
    });
    check(`[${width}] report dialog opens with focus on Close, page scroll locked`, fit.open && fit.focus === 'report-close' && fit.locked, JSON.stringify(fit));
    check(`[${width}] report fits the screen when opened`, fit.w <= fit.vw - 24 && fit.bottom <= fit.vh, JSON.stringify(fit));
    await page.screenshot({ path: path.join(OUT, `dialog-fit-${width}.png`) });
    await page.locator('#report-stage img').click({ position: { x: Math.round(fit.w * 0.7), y: Math.round(fit.h * 0.55) } });
    const z = await page.evaluate(() => {
      const st = document.getElementById('report-stage');
      return { zoomed: document.getElementById('report-dialog').classList.contains('is-zoomed'), pressed: document.getElementById('report-zoom').getAttribute('aria-pressed'), imgW: Math.round(st.querySelector('img').getBoundingClientRect().width), sl: st.scrollLeft, sTop: st.scrollTop, canScroll: st.scrollHeight > st.clientHeight };
    });
    check(`[${width}] tapping the report zooms to full size, centred on the tap`, z.zoomed && z.pressed === 'true' && z.imgW === 1086 && z.canScroll && z.sTop > 0 && (width > 1100 || z.sl > 0), JSON.stringify(z));
    await page.screenshot({ path: path.join(OUT, `dialog-zoom-${width}.png`) });
    await page.locator('#report-zoom').click();
    check(`[${width}] Zoom button returns to fit`, !(await page.evaluate(() => document.getElementById('report-dialog').classList.contains('is-zoomed'))));
    await page.keyboard.press('Escape');
    // The dialog's close event is queued as a task; give it a moment.
    await page.waitForFunction(() => !document.documentElement.classList.contains('has-dialog'), null, { timeout: 1000 }).catch(() => {});
    const closed = await page.evaluate(() => ({ open: document.getElementById('report-dialog').open, focus: document.activeElement.id, locked: document.documentElement.classList.contains('has-dialog'), pad: document.body.style.paddingRight }));
    check(`[${width}] Escape closes the dialog, focus back on the report, scroll unlocked`, !closed.open && closed.focus === 'report-open' && !closed.locked && closed.pad === '', JSON.stringify(closed));
    await opener.click();
    await page.mouse.click(fit.vw - 6, fit.vh - 6);
    check(`[${width}] clicking the dimmed area closes the dialog`, !(await page.evaluate(() => document.getElementById('report-dialog').open)));
    await context.close();
  }
}

// ── 3. Enquiry forms ─────────────────────────────────────────────────────────
const LABELS = {
  hero: "Hero: Find out what's holding you back",
  xray: 'X-Ray section: Request my X-Ray',
  final: 'Closing section: Enquire about the X-Ray'
};

async function forms(browser) {
  // Each CTA, desktop pointer: full success path and the exact payloads.
  for (const origin of ['hero', 'xray', 'final']) {
    const { context, page, calls, problems } = await newPage(browser, 1440);
    const cta = page.locator('#cta-' + origin);
    await cta.scrollIntoViewIfNeeded();
    await cta.click();
    await page.waitForTimeout(120);
    const opened = await page.evaluate((o) => ({ exp: document.getElementById('cta-' + o).getAttribute('aria-expanded'), vis: !document.getElementById('form-' + o).hidden, focus: document.activeElement.id }), origin);
    check(`[${origin}] CTA expands its inline form and focuses the first field`, opened.exp === 'true' && opened.vis && opened.focus === `xr-${origin}-site`, JSON.stringify(opened));
    const p = `#xr-${origin}`;
    await page.locator(`#form-${origin} .submit`).click();
    const empty = await page.evaluate((o) => ({ err: document.getElementById(`xr-${o}-email-err`).textContent, inv: document.getElementById(`xr-${o}-email`).getAttribute('aria-invalid'), desc: document.getElementById(`xr-${o}-email`).getAttribute('aria-describedby'), focus: document.activeElement.id }), origin);
    check(`[${origin}] empty email: error, aria-invalid, focus on email, nothing sent`,
      empty.err === 'Enter your email address so I can reply.' && empty.inv === 'true' && empty.desc === `xr-${origin}-email-err` && empty.focus === `xr-${origin}-email` && calls.sheet.length + calls.owner.length === 0, JSON.stringify(empty));
    await page.locator(`${p}-email`).fill('name@');
    check(`[${origin}] invalid email: live format error`, (await page.locator(`${p}-email-err`).textContent()) === 'Enter a valid email address, like name@example.com.');
    await page.locator(`${p}-site`).fill(' https://example-therapy.ie/about ');
    await page.locator(`${p}-email`).fill('qa.test@example.com');
    check(`[${origin}] valid email clears the error`, !(await page.locator(`${p}-email-err`).isVisible()) && (await page.locator(`${p}-email`).getAttribute('aria-invalid')) === 'false');
    await page.locator(`${p}-phone`).fill('+353 1 555 0100');
    await page.locator(`#form-${origin} .submit`).click();
    await page.waitForFunction((o) => !document.querySelector(`#form-${o} .enquiry-sent`).hidden, origin, { timeout: 5000 }).catch(() => {});
    const sent = await page.evaluate((o) => ({
      visible: !document.querySelector(`#form-${o} .enquiry-sent`).hidden,
      title: document.getElementById(`xr-${o}-done`).textContent,
      to: document.querySelector(`#form-${o} [data-sent-to]`).textContent,
      focus: document.activeElement.id,
      leadLast: window.leadLast && { ok: window.leadLast.ok, sheet: window.leadLast.sheet, owner: window.leadLast.owner }
    }), origin);
    check(`[${origin}] success shown only after confirmation, focus on the thank-you`,
      sent.visible && sent.title === 'Thanks. Your request has been sent.' && sent.to === 'qa.test@example.com' && sent.focus === `xr-${origin}-done` && sent.leadLast && sent.leadLast.sheet === 'ok' && sent.leadLast.owner === 'ok', JSON.stringify(sent));
    const s = calls.sheet[0] && calls.sheet[0].body;
    const o = calls.owner[0];
    check(`[${origin}] one sheet row: source practice-growth-xray, detail, subject, fields`,
      calls.sheet.length === 1 && calls.sheet[0].contentType.startsWith('text/plain') && s.source === 'practice-growth-xray' && s.detail === 'xray-request-' + origin &&
      s.detail_label === 'Practice Growth X-Ray request' && s.email === 'qa.test@example.com' && s.subject === '[X-Ray] Practice Growth X-Ray request: qa.test@example.com' &&
      s.website === 'https://example-therapy.ie/about' && s.phone === '+353 1 555 0100' && s.cta === LABELS[origin] &&
      s.notes === `Website/profile: https://example-therapy.ie/about | Phone: +353 1 555 0100 | CTA: ${LABELS[origin]}` &&
      s.detail_extra === `website=https://example-therapy.ie/about; phone=+353 1 555 0100; cta=${origin}` && s.page_url === BASE && s.lead === '1',
      s ? `source=${s.source} detail=${s.detail} cta=${s.cta}` : 'no sheet call');
    const tp = o && o.template_params;
    check(`[${origin}] one owner email via EmailJS: service, template, key, params`,
      calls.owner.length === 1 && o.service_id === 'service_i4xq7vg' && o.template_id === 'template_6mv5hou' && o.user_id === 'bfBcHLXj2nKaev_lT' && o.lib_version === '4.4.1' &&
      tp.subject === '[X-Ray] Practice Growth X-Ray request: qa.test@example.com' && tp.reply_to === 'qa.test@example.com' && tp.source === 'practice-growth-xray' &&
      tp.website === 'https://example-therapy.ie/about' && tp.phone === '+353 1 555 0100' && /Practice Growth X-Ray request\n\nWebsite or directory profile:\nhttps:\/\/example-therapy.ie\/about/.test(tp.message) && /Form opened from:\n/.test(tp.message),
      o ? `template=${o.template_id} lib=${o.lib_version}` : 'no EmailJS call');
    check(`[${origin}] no console errors or CSP violations`, problems.length === 0 && (await page.evaluate(() => window.__csp.length)) === 0, problems.join(' | '));
    if (origin === 'xray') await page.locator(`#form-${origin} .enquiry`).screenshot({ path: path.join(OUT, 'form-sent.png') });
    await cta.click();
    await cta.click();
    check(`[${origin}] reopening after a sent request starts a fresh form`,
      (await page.locator(`#form-${origin} form`).isVisible()) && (await page.locator(`${p}-email`).inputValue()) === '');
    await context.close();
  }

  // Phone: touch behaviour, keyboard hints, Enter, Escape, close, sending state.
  {
    const { context, page, calls } = await newPage(browser, 390, { leads: { delay: 900 } });
    const cta = page.locator('#cta-hero');
    await cta.click();
    await page.waitForTimeout(150);
    const touch = await page.evaluate(() => ({ focus: document.activeElement.id, bottom: document.querySelector('#form-hero .enquiry').getBoundingClientRect().top < innerHeight }));
    check('[phone] touch opens the form without raising the keyboard (focus on its title)', touch.focus === 'xr-hero-title' && touch.bottom, JSON.stringify(touch));
    const attrs = await page.evaluate(() => ['site', 'email', 'phone'].map((k) => {
      const i = document.getElementById('xr-hero-' + k);
      return [k, i.type, i.inputMode, i.autocomplete, i.getAttribute('enterkeyhint'), i.required, parseFloat(getComputedStyle(i).fontSize), Math.round(i.getBoundingClientRect().height)].join(':');
    }));
    check('[phone] fields: url/email/tel keyboards, autocomplete, 16px text (no iOS zoom), 52px tall',
      attrs[0] === 'site:text:url:url:next:false:16:52' && attrs[1] === 'email:email:email:email:send:true:16:52' && attrs[2] === 'phone:tel:tel:tel:send:false:16:52', attrs.join(' | '));
    await page.locator('#xr-hero-site').fill('practice.example');
    await page.locator('#xr-hero-site').press('Enter');
    check('[phone] Enter in the website field moves to email instead of submitting',
      (await page.evaluate(() => document.activeElement.id)) === 'xr-hero-email' && !(await page.locator('#xr-hero-email-err').isVisible()) && calls.sheet.length === 0);
    await page.locator('#xr-hero-email').fill('phone.qa@example.com');
    await page.locator('#xr-hero-email').press('Enter');
    await page.waitForTimeout(150);
    const sending = await page.evaluate(() => ({
      aria: document.querySelector('#form-hero .submit').getAttribute('aria-disabled'),
      label: document.querySelector('#form-hero .submit-sending').hidden === false && document.querySelector('#form-hero .submit-label').hidden,
      live: document.querySelector('#form-hero [data-live]').textContent
    }));
    check('[phone] while sending: button disabled, "Sending…", announced', sending.aria === 'true' && sending.label && sending.live === 'Sending your request', JSON.stringify(sending));
    await page.locator('#form-hero .enquiry-close').click();
    check('[phone] the form cannot be closed mid-send', await page.locator('#form-hero').isVisible());
    await page.evaluate(() => document.querySelector('#form-hero .submit').click());
    await page.waitForFunction(() => !document.querySelector('#form-hero .enquiry-sent').hidden, null, { timeout: 5000 }).catch(() => {});
    check('[phone] a second press while sending sends nothing more; then success', calls.sheet.length === 1 && calls.owner.length === 1 && (await page.locator('#xr-hero-done').isVisible()));
    await page.screenshot({ path: path.join(OUT, 'form-sent-390.png') });
    // Escape and Close return focus to the CTA
    await page.locator('#cta-xray').scrollIntoViewIfNeeded();
    await page.locator('#cta-xray').click();
    await page.locator('#xr-xray-email').focus();
    await page.keyboard.press('Escape');
    check('[phone] Escape in a form closes it and returns focus to its CTA',
      !(await page.locator('#form-xray').isVisible()) && (await page.evaluate(() => document.activeElement.id)) === 'cta-xray' && (await page.locator('#cta-xray').getAttribute('aria-expanded')) === 'false');
    await page.locator('#cta-final').scrollIntoViewIfNeeded();
    await page.locator('#cta-final').click();
    await page.locator('#xr-final-email').fill('draft@example.com');
    await page.locator('#form-final .enquiry-close').click();
    check('[phone] Close returns focus to the CTA', (await page.evaluate(() => document.activeElement.id)) === 'cta-final');
    await page.locator('#cta-final').click();
    check('[phone] a closed draft keeps what was typed', (await page.locator('#xr-final-email').inputValue()) === 'draft@example.com');
    await page.locator('#form-final .enquiry').screenshot({ path: path.join(OUT, 'form-open-390.png') });
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
    await page.locator('#cta-xray').scrollIntoViewIfNeeded();
    await page.locator('#cta-xray').click();
    await page.locator('#xr-xray-site').fill('my-site.example');
    await page.locator('#xr-xray-email').fill('outcome@example.com');
    await page.locator('#form-xray .submit').click();
    await page.waitForFunction(() => window.leadLast, null, { timeout: 20000 });
    await page.waitForTimeout(50);
    const st = await page.evaluate(() => ({
      failed: !document.querySelector('#form-xray [data-alert="failed"]').hidden,
      sent: !document.querySelector('#form-xray .enquiry-sent').hidden,
      kept: document.getElementById('xr-xray-email').value + '|' + document.getElementById('xr-xray-site').value,
      button: document.querySelector('#form-xray .submit').getAttribute('aria-disabled')
    }));
    if (c.expect === 'failed') {
      check(`outcome: ${c.name} → failure message, details kept, no success`, st.failed && !st.sent && st.kept === 'outcome@example.com|my-site.example' && st.button === null, JSON.stringify(st));
      if (c.name === 'both services down') await page.locator('#form-xray .enquiry').screenshot({ path: path.join(OUT, 'form-failed-390.png') });
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
    await page.locator('#xr-hero-email').fill('redirect@example.com');
    await page.locator('#form-hero .submit').click();
    await page.waitForFunction(() => window.leadLast, null, { timeout: 20000 });
    const csp = await page.evaluate(() => window.__csp);
    check('CSP allows the Apps Script redirect to script.googleusercontent.com', followed.includes('requested') && csp.length === 0 && !followed.some((e) => /csp|blocked/i.test(e || '')), `followed: ${followed.join(', ')}; csp: ${csp.join(', ')}; ${problems.join(' | ')}`);
    await context.close();
  }

  // lead-capture.js missing: nothing sent, the unavailable message.
  {
    const { context, page, calls } = await newPage(browser, 390, { blockLeadCapture: true });
    await page.locator('#cta-hero').click();
    await page.locator('#xr-hero-email').fill('nobody@example.com');
    await page.locator('#form-hero .submit').click();
    await page.waitForTimeout(100);
    check('lead-capture.js missing → "Enquiry connection missing", nothing sent',
      (await page.locator('#form-hero [data-alert="unavailable"]').isVisible()) && !(await page.locator('#xr-hero-done').isVisible()) && calls.sheet.length + calls.owner.length === 0);
    await context.close();
  }

  // ?leaddebug=1 panel renders under the CSP.
  {
    const { context, page, problems } = await newPage(browser, 1440, { query: '?leaddebug=1' });
    await page.locator('#cta-hero').click();
    await page.locator('#xr-hero-email').fill('debug@example.com');
    await page.locator('#form-hero .submit').click();
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
    await page.locator('.nav-wide a[href="#faq"]').click();
    const y = await page.evaluate(() => Math.round(document.getElementById('faq').getBoundingClientRect().top));
    check('reduced motion: no transitions, in-page links jump instantly', parseFloat(d) < 0.01 && Math.abs(y) < 2, `transition ${d}, faq top ${y}`);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, 390, { js: false, leads: false });
    const r = await page.evaluate(() => ({
      faq: Array.from(document.querySelectorAll('.faq-a')).every((a) => a.getBoundingClientRect().height > 0),
      note: document.querySelectorAll('.noscript-note').length,
      menuBtn: getComputedStyle(document.getElementById('menu-btn')).display
    }));
    check('without JavaScript: all FAQ answers readable, email fallback shown, dead menu button hidden', r.faq && r.note === 3 && r.menuBtn === 'none', JSON.stringify(r));
    await context.close();
  }
  {
    const { context, page, requests } = await newPage(browser, 390, { dpr: 3 });
    await page.waitForTimeout(300);
    const initial = requests.filter((u) => u.startsWith(BASE));
    // Chrome starts lazy images within ~1250px of the viewport, which on a phone
    // includes the workshop photo; the report, further down, must wait.
    const lazy = initial.filter((u) => /xray-report/.test(u));
    const allLazy = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter((i) => !i.closest('.portrait')).every((i) => i.loading === 'lazy'));
    check('phone first load: below-the-fold images lazy, report not requested', lazy.length === 0 && allLazy, lazy.join(', '));
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
