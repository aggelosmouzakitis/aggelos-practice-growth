// main.js: the Marketing Hot Seat page's behaviour, in plain JavaScript.
//
// Ports the prototype's DCLogic component (Marketing Hot Seat v2.dc.html) to the
// static markup in index.html:
//   - in-page links (the logo): scroll to the top and move focus there
//   - FAQ: independent disclosures, first one open; browser find-in-page opens them
//   - three enquiry forms, one per CTA, submitting through window.submitLead
//     (lead-capture.js, unchanged from aggelosmouzakitis.com). Success is shown
//     only when submitLead reports ok: the sheet confirmed the row or EmailJS
//     accepted the owner email. This is an enquiry, not a checkout: the person
//     asks for the session times and joining details.
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  function media(q) {
    return window.matchMedia ? window.matchMedia(q) : { matches: false };
  }
  var reduceMotion = media('(prefers-reduced-motion: reduce)');
  var finePointer = media('(hover: hover) and (pointer: fine)');

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function each(sel, fn) {
    Array.prototype.forEach.call(doc.querySelectorAll(sel), fn);
  }

  // ── In-page navigation ─────────────────────────────────────────────────────
  // Scroll to the target and move focus to it (each target has tabindex="-1").
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
    goTo(id);
  });

  // ── FAQ ────────────────────────────────────────────────────────────────────
  // Several answers can be open at once, as in the prototype. Closed answers use
  // hidden="until-found", so find-in-page can still reach them; beforematch then
  // opens the item properly.
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

  // ── Enquiry forms ──────────────────────────────────────────────────────────
  // Where each form was opened from, for the Leads sheet and the owner email.
  var ORIGINS = {
    hero: 'Intro section: Get joining details · €59/month',
    week: 'Week section: Get joining details · €59/month',
    final: 'Closing section: Get joining details · €59/month'
  };
  var EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

  function setupEnquiry(origin) {
    var cta = doc.getElementById('cta-' + origin);
    var slot = doc.getElementById('join-' + origin);
    if (!cta || !slot) return;
    var box = slot.querySelector('.enquiry');
    var p = 'hs-' + origin;
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
    // time it appears, like a freshly mounted alert.
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
        if (window.console) console.warn('[Hot Seat enquiry] window.submitLead is unavailable: lead-capture.js did not load, so nothing was sent.');
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
        'Marketing Hot Seat enquiry',
        'Asked for: the session times and joining details', '',
        'Website or directory profile:', siteVal || '(not given)', '',
        'Email:', emailVal, '',
        'Phone number:', phoneVal || '(not given)', '',
        'Form opened from:', label
      ].join('\n');
      state.status = 'sending';
      state.tried = true;
      render();
      window.submitLead({
        source: 'marketing-hot-seat',
        detail: 'hot-seat-enquiry-' + origin,
        detailLabel: 'Marketing Hot Seat enquiry',
        email: emailVal,
        notes: 'Website/profile: ' + (siteVal || 'not given') + ' | Phone: ' + (phoneVal || 'not given') + ' | CTA: ' + label,
        body: body,
        when: when,
        subject: '[Hot Seat] New Marketing Hot Seat enquiry: ' + emailVal,
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

  ['hero', 'week', 'final'].forEach(setupEnquiry);
})();
