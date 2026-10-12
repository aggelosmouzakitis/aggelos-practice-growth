// lead-capture.jsx — the site's one lead-capture layer.
//
// Every form calls window.submitLead(record, done). A form only describes the
// lead (source, detail, name, email, notes, its own body) and, if it sends the
// person something, which template and fields; spreadsheet posting, the owner
// notification, EmailJS bootstrapping, timeouts and error reporting live here.
//
// Three independent operations per lead, each settled on its own — one failing
// never cancels, delays or hides the others (the equivalent of
// Promise.allSettled):
//   1. sheet  POST the normalized row to the Apps Script web app, which appends
//             it to the "Leads" tab (scripts/leads-apps-script.gs).
//   2. owner  the owner notification, through ONE EmailJS template for every
//             form (LEAD_OWNER_TEMPLATE).
//   3. reply  only when record.reply is given: an email to the person, e.g. a
//             diagnostic result (template_gcj2lrd, To: {{user_email}}).
//
// done(ok, result) — result is { ok, sheet, owner, reply, detail } with each
// status 'ok' | 'failed' | 'skipped', and for the sheet also 'unconfirmed'
// (the request went out but its answer could not be read). ok means the lead
// is confirmed somewhere: the sheet answered {"ok":true}, or EmailJS accepted
// the owner email. Nothing reports a success it did not get: a timeout is a
// failure, and an unconfirmed sheet write alone is not a success.
//
// ── EmailJS templates (what each one is, from the code and delivered mail) ──
//   template_6mv5hou  OWNER notification — the canonical one for every form.
//                     EmailJS's stock "Contact Us" layout: Subject
//                     "Contact Us: {{title}}", and a body that prints
//                     {{message}}, so the full notification of any form reads
//                     correctly with no dashboard change (title = subject).
//                     Recommended in the dashboard: Subject {{{subject}}}
//                     (content/emails/EMAILJS.md).
//   template_gcj2lrd  USER result email (To: {{user_email}}), sent directly;
//                     the Work & Life Check's result (content/emails/…).
//   template_wdsrbdo  the old tools notification. No longer sent: its body
//                     ignores {{message}}, and it may still carry the retired
//                     Focus Area auto-reply (see d0e3717).
//   template_fdba9kr  the retired Focus Area's copy of wdsrbdo, with gcj2lrd as
//                     its Auto-Reply. Not sent.
// Service service_i4xq7vg, public key bfBcHLXj2nKaev_lT.
//
// ── Diagnostics ─────────────────────────────────────────────────────────────
// Every lead logs one line to the console ([lead] …); failures also send a
// lead_capture_error event to GA4. Add ?leaddebug=1 to any page to see each
// operation's outcome on screen after a submission.

var LEAD_SHEET_URL = 'https://script.google.com/macros/s/AKfycbyfbiW4nURPv6d2W9uErRFTt2vB27rs5kPyDW-C_Az5WiUMtWcxZMPjxt524ikuQN4m/exec';
var LEAD_EMAILJS_SERVICE = 'service_i4xq7vg';
var LEAD_EMAILJS_PUBLIC_KEY = 'bfBcHLXj2nKaev_lT';
var LEAD_OWNER_TEMPLATE = 'template_6mv5hou';
var LEAD_TIMEOUT_MS = 15000;

// Each source: its label, the tag that sorts the inbox, and its subject line.
function leadStr(v) {
  return v == null ? '' : String(v).trim();
}
var LEAD_SOURCES = {
  'contact': {
    tag: 'CONTACT',
    label: 'Contact form',
    subject: function (r) {
      return 'New website enquiry — ' + (leadStr(r.name) || leadStr(r.email));
    }
  },
  'clarity-tool': {
    tag: 'TOOL',
    label: 'Clarity tool',
    subject: function (r) {
      return '[TOOL] ' + (leadStr(r.detailLabel) || leadStr(r.detail)) + ' — ' + (leadStr(r.name) || leadStr(r.email) || 'no name given');
    }
  },
  'work-life-check': {
    tag: 'TOOL',
    label: 'Work & Life Check',
    subject: function (r) {
      return '[Work & Life Check] ' + (leadStr(r.detailLabel) || leadStr(r.detail)) + ' — ' + leadStr(r.email);
    }
  }
};
function leadSource(id) {
  return LEAD_SOURCES[id] || {
    tag: 'SITE',
    label: id || 'Website',
    subject: null
  };
}

// "New website enquiry — Maria Papadopoulou"
function leadSubject(rec) {
  if (leadStr(rec.subject)) return leadStr(rec.subject);
  var src = leadSource(rec.source);
  if (src.subject) return src.subject(rec);
  return '[' + src.tag + '] ' + (leadStr(rec.detailLabel) || leadStr(rec.detail) || src.label) + ' — ' + (leadStr(rec.name) || leadStr(rec.email) || 'no name given');
}

// The identical lines at the top of every owner notification.
function leadHeader(rec, when) {
  var src = leadSource(rec.source);
  var pad = function (k) {
    return (k + ':').padEnd(12, ' ');
  };
  return ['── SUBMISSION ──', pad('Source') + src.label, pad('Detail') + (leadStr(rec.detailLabel) || leadStr(rec.detail) || '—'), pad('Name') + (leadStr(rec.name) || '—'), pad('Email') + (leadStr(rec.email) || '—'), pad('Page') + (rec.pageUrl || '—'), pad('Submitted') + when.toISOString(), '', ''].join('\n');
}

// Later objects win; missing ones are skipped.
function leadMerge() {
  var out = {};
  for (var i = 0; i < arguments.length; i++) {
    var o = arguments[i];
    if (!o) continue;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  }
  return out;
}

// Only the fields that have a value.
function leadCompact(o) {
  var out = {};
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && leadStr(o[k]) !== '') out[k] = o[k];
  return out;
}

// "2026-09-30 16:56 UTC": unambiguous for whoever reads it, wherever they are.
function leadTime(when) {
  return when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// One answer or a timeout, never both, never neither.
function leadSettle(ms, timeoutStatus, timeoutDetail, run) {
  return new Promise(function (resolve) {
    var settled = false;
    var end = function (status, detail) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          status: status,
          detail: detail || ''
        });
      }
    };
    var timer = setTimeout(function () {
      end(timeoutStatus, timeoutDetail);
    }, ms);
    try {
      run(end);
    } catch (err) {
      end('failed', String(err && err.message || err));
    }
  });
}

// 1. The spreadsheet. The body is JSON sent as text/plain, a CORS "simple
// request": no preflight (which Apps Script cannot answer), and the script
// still parses it from e.postData.contents. Apps Script answers with a redirect
// to script.googleusercontent.com, whose JSON is readable cross-origin, so
// {"ok":true} confirms the row. One request only — never retried, so a lead is
// never written twice. If the answer cannot be read, the row was most likely
// written anyway: 'unconfirmed'.
function leadPostToSheet(payload) {
  return leadSettle(LEAD_TIMEOUT_MS, 'unconfirmed', 'no answer within ' + LEAD_TIMEOUT_MS / 1000 + 's', function (end) {
    if (typeof fetch !== 'function') {
      end('failed', 'fetch unavailable');
      return;
    }
    fetch(LEAD_SHEET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try {
          j = JSON.parse(t);
        } catch (e) {
          j = null;
        }
        if (j && j.ok === true) end('ok', 'row appended');else if (j && j.ok === false) end('failed', 'script error: ' + (j.error || 'unknown'));else end('unconfirmed', 'HTTP ' + res.status + ', unreadable answer');
      });
    }).catch(function (err) {
      var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      end(offline ? 'failed' : 'unconfirmed', (offline ? 'offline: ' : 'answer not readable: ') + String(err && err.message || err));
    });
  });
}

// 2 and 3. One EmailJS send. EmailJS answers { status, text } either way.
function leadEmail(template, params) {
  return leadSettle(LEAD_TIMEOUT_MS, 'failed', 'no answer from EmailJS within ' + LEAD_TIMEOUT_MS / 1000 + 's', function (end) {
    var ejs = typeof window !== 'undefined' ? window.emailjs : null;
    if (!ejs || typeof ejs.send !== 'function') {
      end('failed', 'EmailJS SDK not loaded');
      return;
    }
    ejs.send(LEAD_EMAILJS_SERVICE, template, params, {
      publicKey: LEAD_EMAILJS_PUBLIC_KEY
    }).then(function (res) {
      end('ok', template + ': ' + (res && res.status || '') + ' ' + (res && res.text || ''));
    }).catch(function (err) {
      end('failed', template + ': ' + (err && err.status || '') + ' ' + (err && (err.text || err.message) || String(err)));
    });
  });
}

// ── The one entry point ──────────────────────────────────────────────────────
// rec: {
//   source       'contact' | 'clarity-tool' | 'work-life-check' | …
//   detail       machine identifier — interest, tool slug, result key
//   detailLabel  human version of the above
//   name, email  as captured (one full-name field; no splitting)
//   notes        short human summary — the sheet's Notes column
//   body         the form's own detailed text; the owner email prints the
//                header block, then this
//   message      optional: the owner email's complete text instead (no
//                header block), for a form with its own notification format
//   when         optional Date of the submission (default: now), so a form's
//                own text and the row carry the same time
//   subject      optional; otherwise the source's subject line
//   newsletter   true/false only where a form asks (none does today)
//   detailExtra  tool-specific fields, flattened, for the sheet's last column
//   params       extra fields for the owner email and the sheet's payload
//                (e.g. a diagnostic's scores)
//   reply        optional { template, params }: an email to the person
// }
function submitLead(rec, done) {
  rec = rec || {};
  var src = leadSource(rec.source);
  var when = rec.when instanceof Date ? rec.when : new Date();
  rec.pageUrl = rec.pageUrl || (typeof window !== 'undefined' ? window.location.href : '');
  var subject = leadSubject(rec);
  var message = leadStr(rec.message) || leadHeader(rec, when) + (leadStr(rec.body) || leadStr(rec.notes) || '');

  // The normalized row (the Apps Script's columns) …
  var payload = {
    lead: '1',
    submitted_at: when.toISOString(),
    source: rec.source || '',
    source_label: src.label,
    detail: leadStr(rec.detail),
    detail_label: leadStr(rec.detailLabel) || leadStr(rec.detail),
    name: leadStr(rec.name),
    email: leadStr(rec.email),
    notes: leadStr(rec.notes),
    page_url: rec.pageUrl,
    subject: subject,
    message: message,
    newsletter: rec.newsletter === true ? 'yes' : rec.newsletter === false ? 'no' : '',
    detail_extra: leadStr(rec.detailExtra)
  };
  // The older field names, which templates and earlier versions of the Apps
  // Script read (the script falls back to them), always sent alongside.
  var legacy = {
    from_name: leadStr(rec.name),
    from_email: leadStr(rec.email),
    reply_to: leadStr(rec.email),
    user_name: leadStr(rec.name),
    user_email: leadStr(rec.email),
    interest: leadStr(rec.detailLabel) || leadStr(rec.detail),
    source_page: rec.sourcePage || rec.pageUrl
  };
  // The sheet: the row plus everything the form described, as before; the
  // row's own fields win. The owner email: the same, the form's fields winning,
  // plus `title` and `time`, which the canonical template's stock layout
  // prints ("Contact Us: {{title}}", {{time}}). A field left empty is not sent
  // to the email at all, so no template prints a placeholder for it.
  var row = leadMerge(legacy, rec.params, payload);
  var owner = leadCompact(leadMerge({
    title: subject,
    time: leadTime(when)
  }, legacy, payload, rec.params));
  var jobs = [leadPostToSheet(row), leadEmail(LEAD_OWNER_TEMPLATE, owner), rec.reply && rec.reply.template ? leadEmail(rec.reply.template, rec.reply.params || {}) : Promise.resolve({
    status: 'skipped',
    detail: ''
  })];
  Promise.all(jobs).then(function (r) {
    var result = {
      source: rec.source,
      subject: subject,
      sheet: r[0].status,
      owner: r[1].status,
      reply: r[2].status,
      detail: {
        sheet: r[0].detail,
        owner: r[1].detail,
        reply: r[2].detail
      }
    };
    // Recorded = something confirmed it. An unreadable sheet answer does not
    // count: better a person resends (or uses the address the form offers)
    // than a lead lost behind a success message.
    result.ok = result.sheet === 'ok' || result.owner === 'ok';
    leadReport(result);
    if (typeof done === 'function') {
      try {
        done(result.ok, result);
      } catch (err) {
        try {
          console.error(err);
        } catch (e2) {/* noop */}
      }
    }
  });
}

// ── Reporting ────────────────────────────────────────────────────────────────
function leadReport(result) {
  try {
    if (typeof window !== 'undefined') window.leadLast = result;
    var line = '[lead] ' + result.source + ' · sheet ' + result.sheet + ' · owner ' + result.owner + ' · reply ' + result.reply;
    // Every operation that failed, or whose outcome is unknown, is reported.
    var problems = ['sheet', 'owner', 'reply'].filter(function (stage) {
      return result[stage] === 'failed' || result[stage] === 'unconfirmed';
    });
    if (!problems.length) console.info(line);else if (problems.some(function (stage) {
      return result[stage] === 'failed';
    })) console.error(line, result.detail);else console.warn(line, result.detail);
    problems.forEach(function (stage) {
      try {
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'lead_capture_error', {
            source: result.source,
            stage: stage,
            error_detail: (result[stage] + ': ' + result.detail[stage]).slice(0, 95)
          });
        }
      } catch (e) {/* analytics is optional */}
    });
  } catch (e) {/* reporting never breaks a submission */}
  leadDebugPanel(result);
}
function leadDebugOn() {
  try {
    return /[?&]leaddebug=1\b/.test(window.location.search) || window.localStorage.getItem('leaddebug') === '1';
  } catch (e) {
    return false;
  }
}

// ?leaddebug=1: each operation's outcome, on screen, for checking production.
function leadDebugPanel(result) {
  if (typeof document === 'undefined' || !leadDebugOn()) return;
  try {
    var el = document.getElementById('lead-debug');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'lead-debug';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-height:45vh;overflow:auto;margin:0;padding:14px 16px;background:#16231E;color:#F3F0E8;font:12.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;border-top:3px solid #047857';
      document.body.appendChild(el);
    }
    el.textContent = 'LEAD DEBUG · ' + new Date().toISOString() + '\n' + 'source   ' + result.source + '\nsubject  ' + result.subject + '\n' + 'sheet    ' + result.sheet + '  ' + result.detail.sheet + '\n' + 'owner    ' + result.owner + '  ' + result.detail.owner + '\n' + 'reply    ' + result.reply + '  ' + result.detail.reply + '\n' + 'ok       ' + result.ok;
  } catch (e) {/* noop */}
}
if (typeof window !== 'undefined') {
  window.submitLead = submitLead;
  window.LEAD_SOURCES = LEAD_SOURCES;
  window.LEAD_OWNER_TEMPLATE = LEAD_OWNER_TEMPLATE;
  window.leadSubject = leadSubject;
}
