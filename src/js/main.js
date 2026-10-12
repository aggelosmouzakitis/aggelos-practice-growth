// main.js: the Practice Growth page's behaviour, in plain JavaScript.
//
// Ports the prototype's DCLogic components (Practice Growth.dc.html and
// Enquiry Form.dc.html) to the static markup in index.html:
//   - compact menu (below 1080px): toggle, Escape, closes at desktop width
//   - in-page links: close the menu first, then scroll and move focus
//   - scroll spy: aria-current on the desktop nav, same band as the prototype
//   - FAQ: independent disclosures, first one open; browser find-in-page opens them
//   - report dialog: enlarge, zoom to full size for small screens, focus restore
//   - three enquiry forms, one per CTA, submitting through window.submitLead
//     (lead-capture.js, unchanged from aggelosmouzakitis.com). Success is shown
//     only when submitLead reports ok: the sheet confirmed the row or EmailJS
//     accepted the owner email.
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  function media(q) {
    return window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener: null };
  }
  function onMediaChange(mq, fn) {
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
    else if (typeof mq.addListener === 'function') mq.addListener(fn);
  }
  var reduceMotion = media('(prefers-reduced-motion: reduce)');
  var desktop = media('(min-width: 1080px)');
  var finePointer = media('(hover: hover) and (pointer: fine)');

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function each(sel, fn) {
    Array.prototype.forEach.call(doc.querySelectorAll(sel), fn);
  }

  var dialog = doc.getElementById('report-dialog');
  function dialogOpen() { return !!(dialog && dialog.hasAttribute('open')); }

  // ── Compact menu ───────────────────────────────────────────────────────────
  var menuBtn = doc.getElementById('menu-btn');
  var menu = doc.getElementById('site-menu');
  var menuLabel = menuBtn ? menuBtn.querySelector('.menu-btn-label') : null;

  function menuIsOpen() {
    return !!menuBtn && menuBtn.getAttribute('aria-expanded') === 'true';
  }
  function setMenu(open, returnFocus) {
    if (!menuBtn || !menu) return;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;
    if (menuLabel) menuLabel.textContent = open ? 'Close' : 'Menu';
    if (!open && returnFocus) focusEl(menuBtn);
  }
  if (menuBtn) {
    menuBtn.addEventListener('click', function () { setMenu(!menuIsOpen()); });
  }
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || dialogOpen() || !menuIsOpen()) return;
    setMenu(false, true);
  });
  onMediaChange(desktop, function () {
    if (desktop.matches && menuIsOpen()) setMenu(false);
  });

  // ── In-page navigation ─────────────────────────────────────────────────────
  // The menu closes first so the layout has settled, then the page scrolls and
  // focus moves to the section (each target has tabindex="-1").
  function goTo(id) {
    var el = doc.getElementById(id);
    if (!el) return;
    var top = id === 'top' ? 0 : el.getBoundingClientRect().top + window.pageYOffset;
    try {
      window.scrollTo({ top: top, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    } catch (e) {
      window.scrollTo(0, top);
    }
    focusEl(el);
  }
  doc.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-scroll]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var id = (a.getAttribute('href') || '').slice(1);
    if (!id || !doc.getElementById(id)) return;
    e.preventDefault();
    if (menuIsOpen()) {
      setMenu(false);
      window.requestAnimationFrame(function () { goTo(id); });
    } else {
      goTo(id);
    }
  });

  // ── Scroll spy ─────────────────────────────────────────────────────────────
  // The section crossing a band near the middle of the viewport is current.
  (function () {
    if (!('IntersectionObserver' in window)) return;
    var ids = ['reality', 'approach', 'about', 'xray', 'faq', 'enquire'];
    var links = {};
    each('.nav-link[data-spy]', function (a) { links[a.getAttribute('data-spy')] = a; });
    var seen = {};
    var active = '';
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { seen[en.target.id] = en.isIntersecting; });
      var cur = '';
      for (var i = 0; i < ids.length; i++) {
        if (seen[ids[i]]) { cur = ids[i]; break; }
      }
      if (cur === active) return;
      active = cur;
      Object.keys(links).forEach(function (k) {
        if (k === cur) links[k].setAttribute('aria-current', 'location');
        else links[k].removeAttribute('aria-current');
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    ids.forEach(function (id) {
      var el = doc.getElementById(id);
      if (el) io.observe(el);
    });
  })();

  // ── FAQ ────────────────────────────────────────────────────────────────────
  // Several answers can be open at once (the prototype's faqMultiple default).
  // Closed answers use hidden="until-found", so find-in-page can still reach
  // them; beforematch then opens the item properly.
  each('.faq-q', function (btn) {
    var panel = doc.getElementById(btn.getAttribute('aria-controls'));
    if (!panel) return;
    function set(open) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', 'until-found');
    }
    btn.addEventListener('click', function () {
      set(btn.getAttribute('aria-expanded') !== 'true');
    });
    panel.addEventListener('beforematch', function () { set(true); });
  });

  // ── Report dialog ──────────────────────────────────────────────────────────
  (function () {
    var opener = doc.getElementById('report-open');
    var closeBtn = doc.getElementById('report-close');
    var zoomBtn = doc.getElementById('report-zoom');
    var stage = doc.getElementById('report-stage');
    var img = stage ? stage.querySelector('img') : null;
    if (!dialog || !opener || !stage || !img) return;

    var zoomed = false;
    var warmed = false;

    // Fetch the full-size image as soon as someone shows intent, so the dialog
    // opens with it ready (the dialog's own img is lazy while closed).
    function warm() {
      if (warmed) return;
      warmed = true;
      var pre = new Image();
      pre.decoding = 'async';
      pre.src = img.currentSrc || img.src;
    }
    ['pointerenter', 'focus', 'touchstart'].forEach(function (type) {
      opener.addEventListener(type, warm, { passive: true });
    });

    function setZoom(on, point) {
      zoomed = on;
      dialog.classList.toggle('is-zoomed', on);
      if (zoomBtn) {
        zoomBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        var z = zoomBtn.querySelector('.z');
        if (z) z.textContent = on ? '−' : '+';
      }
      if (!on) {
        stage.scrollTop = 0;
        stage.scrollLeft = 0;
        return;
      }
      // Keep the point that was tapped under the finger; from the button, show
      // the top of the report, centred.
      var fx = point ? point.x : 0.5;
      var fy = point ? point.y : 0;
      stage.scrollLeft = Math.max(0, fx * stage.scrollWidth - stage.clientWidth / 2);
      stage.scrollTop = Math.max(0, fy * stage.scrollHeight - stage.clientHeight / 2);
    }

    // While the dialog is open the page behind it does not scroll. Where the
    // scrollbar takes space, its width is kept as padding so nothing moves.
    function lockScroll(on) {
      if (on) {
        var bar = window.innerWidth - root.clientWidth;
        root.classList.add('has-dialog');
        if (bar > 0) doc.body.style.paddingRight = bar + 'px';
      } else {
        root.classList.remove('has-dialog');
        doc.body.style.paddingRight = '';
      }
    }

    function open() {
      warm();
      setZoom(false);
      lockScroll(true);
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
        focusEl(closeBtn);
      }
    }
    function close() {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else if (dialog.hasAttribute('open')) {
        dialog.removeAttribute('open');
        closed();
      }
    }
    function closed() {
      lockScroll(false);
      setZoom(false);
      focusEl(opener);
    }

    opener.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (zoomBtn) zoomBtn.addEventListener('click', function () { setZoom(!zoomed); });
    dialog.addEventListener('close', closed);
    // A click on the dimmed area around the report closes it, as in the prototype.
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog || e.target === stage) close();
    });
    img.addEventListener('click', function (e) {
      if (zoomed) {
        setZoom(false);
        return;
      }
      var r = img.getBoundingClientRect();
      var point = r.width && r.height ? {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      } : null;
      setZoom(true, point);
    });
  })();

  // ── Enquiry forms ──────────────────────────────────────────────────────────
  var ORIGINS = {
    hero: "Hero: Find out what's holding you back",
    xray: 'X-Ray section: Request my X-Ray',
    final: 'Closing section: Enquire about the X-Ray'
  };
  var EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

  function setupEnquiry(origin) {
    var cta = doc.getElementById('cta-' + origin);
    var slot = doc.getElementById('form-' + origin);
    if (!cta || !slot) return;
    var box = slot.querySelector('.enquiry');
    var p = 'xr-' + origin;
    var form = box.querySelector('form');
    var title = doc.getElementById(p + '-title');
    var site = doc.getElementById(p + '-site');
    var email = doc.getElementById(p + '-email');
    var phone = doc.getElementById(p + '-phone');
    var emailErr = doc.getElementById(p + '-email-err');
    var done = doc.getElementById(p + '-done');
    var sentView = box.querySelector('.enquiry-sent');
    var sentTo = box.querySelector('[data-sent-to]');
    var submit = form.querySelector('.submit');
    var submitLabel = submit.querySelector('.submit-label');
    var submitSending = submit.querySelector('.submit-sending');
    var submitArrow = submit.querySelector('.submit-arrow');
    var live = form.querySelector('[data-live]');
    var alerts = {
      failed: form.querySelector('[data-alert="failed"]'),
      unavailable: form.querySelector('[data-alert="unavailable"]')
    };
    var closeBtn = box.querySelector('.enquiry-close');

    var state = { status: 'idle', tried: false, touched: false };

    function emailError() {
      var v = email.value.trim();
      if (!v) return 'Enter your email address so I can reply.';
      if (!EMAIL_RE.test(v)) return 'Enter a valid email address, like name@example.com.';
      return '';
    }

    // Re-inserting an alert's content makes screen readers announce it each
    // time it appears, like the prototype's freshly mounted alert.
    function showAlert(el, show) {
      if (!el) return;
      if (!show) { el.hidden = true; return; }
      var wasHidden = el.hidden;
      el.hidden = false;
      if (wasHidden) {
        var kids = Array.prototype.slice.call(el.childNodes);
        kids.forEach(function (k) { el.removeChild(k); });
        kids.forEach(function (k) { el.appendChild(k); });
      }
    }

    function render() {
      var err = emailError();
      var showErr = !!err && (state.tried || (state.touched && email.value.trim() !== ''));
      if (showErr) {
        if (emailErr.textContent !== err) emailErr.textContent = err;
        emailErr.hidden = false;
        email.setAttribute('aria-invalid', 'true');
        email.setAttribute('aria-describedby', emailErr.id);
      } else {
        emailErr.hidden = true;
        emailErr.textContent = '';
        email.setAttribute('aria-invalid', 'false');
        email.removeAttribute('aria-describedby');
      }
      var sending = state.status === 'sending';
      if (sending) submit.setAttribute('aria-disabled', 'true');
      else submit.removeAttribute('aria-disabled');
      submitLabel.hidden = sending;
      submitSending.hidden = !sending;
      submitArrow.hidden = sending;
      live.textContent = sending ? 'Sending your request' : '';
      showAlert(alerts.failed, state.status === 'failed');
      showAlert(alerts.unavailable, state.status === 'unavailable');
      var sent = state.status === 'sent';
      form.hidden = sent;
      sentView.hidden = !sent;
    }

    function reset() {
      form.reset();
      state = { status: 'idle', tried: false, touched: false };
      render();
    }

    function open() {
      // A request already sent starts over; a draft keeps what was typed.
      if (state.status === 'sent') reset();
      else if (state.status !== 'idle') { state.status = 'idle'; state.tried = false; state.touched = false; render(); }
      slot.hidden = false;
      cta.setAttribute('aria-expanded', 'true');
      if (finePointer.matches) {
        // As in the prototype: straight into the first field.
        window.setTimeout(function () { site.focus(); }, 40);
      } else {
        // Touch: bring the form into view and move focus to its title, without
        // raising the on-screen keyboard over it before the person chooses a field.
        focusEl(title);
        window.requestAnimationFrame(function () {
          var r = box.getBoundingClientRect();
          var vh = window.innerHeight || root.clientHeight;
          if (r.top < 0 || r.bottom > vh) {
            try {
              box.scrollIntoView({ block: r.height > vh ? 'start' : 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
            } catch (e) {
              box.scrollIntoView(true);
            }
          }
        });
      }
    }

    function close(returnFocus) {
      if (state.status === 'sending') return;
      slot.hidden = true;
      cta.setAttribute('aria-expanded', 'false');
      if (returnFocus) focusEl(cta);
    }

    cta.addEventListener('click', function () {
      if (slot.hidden) open();
      else close(false);
    });
    closeBtn.addEventListener('click', function () { close(true); });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close(true);
      }
    });

    email.addEventListener('input', render);
    email.addEventListener('blur', function () { state.touched = true; render(); });
    // Enter in the optional first field moves on to the email address instead
    // of submitting a form that still has no email in it.
    site.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        email.focus();
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.status === 'sending') return;
      if (emailError()) {
        state.tried = true;
        render();
        email.focus();
        return;
      }
      if (typeof window.submitLead !== 'function') {
        if (window.console) console.warn('[X-Ray enquiry] window.submitLead is unavailable: lead-capture.js did not load, so nothing was sent.');
        state.status = 'unavailable';
        state.tried = true;
        render();
        return;
      }
      var label = ORIGINS[origin] || origin;
      var siteVal = site.value.trim();
      var emailVal = email.value.trim();
      var phoneVal = phone.value.trim();
      var when = new Date();
      var body = [
        'Practice Growth X-Ray request', '',
        'Website or directory profile:', siteVal || '(not given)', '',
        'Email:', emailVal, '',
        'Phone number:', phoneVal || '(not given)', '',
        'Form opened from:', label
      ].join('\n');
      state.status = 'sending';
      state.tried = true;
      render();
      window.submitLead({
        source: 'practice-growth-xray',
        detail: 'xray-request-' + origin,
        detailLabel: 'Practice Growth X-Ray request',
        email: emailVal,
        notes: 'Website/profile: ' + (siteVal || 'not given') + ' | Phone: ' + (phoneVal || 'not given') + ' | CTA: ' + label,
        body: body,
        when: when,
        subject: '[X-Ray] Practice Growth X-Ray request: ' + emailVal,
        params: { website: siteVal, phone: phoneVal, cta: label },
        detailExtra: 'website=' + siteVal + '; phone=' + phoneVal + '; cta=' + origin
      }, function (ok) {
        if (ok) {
          state.status = 'sent';
          sentTo.textContent = emailVal;
          render();
          focusEl(done);
        } else {
          state.status = 'failed';
          render();
        }
      });
    });

    render();
  }

  ['hero', 'xray', 'final'].forEach(setupEnquiry);
})();
