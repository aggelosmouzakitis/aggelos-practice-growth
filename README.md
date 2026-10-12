# Practice Growth: practice.aggelosmouzakitis.com

The one-page site for Practice Growth consulting for independent therapists. It's
built from the approved Claude Design prototype (`Practice Growth.dc.html` and
`Enquiry Form.dc.html`) as plain HTML, CSS and JavaScript, with no framework and no
runtime dependencies.

It's a separate site and Netlify project from the psychotherapy site
(aggelosmouzakitis.com, repo `aggelosmouzakitispersonal`). The only thing they share
is the lead layer, which is copied over unchanged (see below).

## Layout

| Path | What it is |
| --- | --- |
| `src/index.html` | The page: semantic markup, metadata, JSON-LD. `<!-- @… -->` comments are filled in by the build. |
| `src/partials/enquiry.html` | The enquiry form. The build expands it once per CTA (`hero`, `xray`, `final`). |
| `src/css/site.css` | All styles. The prototype's inline styles became classes; the build inlines this file. |
| `src/js/main.js` | Behaviour: menu, in-page navigation, scroll spy, FAQ, report dialog, the three forms. |
| `src/js/lead-capture.js` | **Unchanged** copy of the live site's lead layer (`window.submitLead`). |
| `src/js/vendor/emailjs-browser-4.4.1.min.js` | EmailJS browser SDK, self-hosted and pinned (verified against the npm registry). |
| `src/fonts/`, `src/img/` | The supplied fonts and photographs. The report image and the grain are derived (see Assets). |
| `src/icons/`, `src/social/` | Favicons and the 1200×630 social preview image, derived from the page's own design. |
| `assets-source/` | Lossless masters (report photograph, grain tile). Not deployed. |
| `scripts/build.mjs` | Builds `dist/`. Node built-ins only. |
| `scripts/check.mjs` | Static checks on `dist/` (metadata, headings, structured data, form contract, file hashes). |
| `scripts/qa/run.mjs` | Browser QA with Playwright at 320/390/768/1024/1440 px, with faked lead endpoints. |
| `scripts/serve.mjs` | Local server for `dist/` that sends the same headers as Netlify. |
| `dist/` | The deployable site, committed so it can also be deployed without building. |

## Commands

```sh
npm run build    # src/ → dist/ (production: indexable)
npm test         # build + static checks
npm run serve    # http://127.0.0.1:8080 with Netlify's headers
npm run qa       # build + browser QA (needs Playwright and Chromium: npm i -g playwright)
npm run assets   # regenerate derived images (needs Pillow; the icons/OG step needs Playwright)
```

`npm test` and `npm run qa` must both pass before a deploy. QA screenshots go to
`qa-output/`, which isn't committed.

## What the build does

- Adds a content hash to every image and script file name (`main.620eb43c69.js`)
  so they can be cached for a year. Fonts keep their versioned names.
- Inlines the stylesheet, which saves a render-blocking request.
- Expands the enquiry form three times, with the prototype's IDs (`xr-hero-email`, …).
- Keeps "X-Ray" and "3–5" from breaking at the hyphen or dash on narrow screens. It
  only touches visible text, never attributes or metadata.
- Writes a Content-Security-Policy `<meta>` that includes the hashes of the inline
  style and script. Scripts may only connect to EmailJS and the Apps Script web app.
- Writes `robots.txt` and `sitemap.xml`.
- Indexing depends on Netlify's `CONTEXT`. Only `production` is indexable. Deploy
  previews, branch deploys and `netlify dev` get `noindex, nofollow` in each page,
  plus an `X-Robots-Tag` header on every file (`dist/_headers`).
- Fails if any local link, image, `srcset` entry, `#fragment` or ARIA reference
  doesn't resolve, or if an inline `style=""` attribute appears (the CSP blocks it).

## Lead capture

All three CTAs ("Find out what's holding you back", "Request my X-Ray", "Enquire about
the X-Ray") open an inline form with three fields:

- website or directory profile (optional)
- email (required)
- phone (optional)

On submit, the form calls `window.submitLead` from `lead-capture.js`, the same file the
psychotherapy site uses. That function does two things:

- **Leads sheet**: posts one row to the Apps Script web app.
- **Owner email**: sends one EmailJS email, using `service_i4xq7vg` and `template_6mv5hou`.

Every lead carries `source: 'practice-growth-xray'`, `detail: 'xray-request-<cta>'`
and the subject `[X-Ray] Practice Growth X-Ray request: <email>`. The website, phone
and CTA go both into the row and into the email.

The thank-you message appears only when `submitLead` reports `ok`: either the sheet
confirmed the row or EmailJS accepted the email. A timeout, an error, or a sheet answer
that can't be read all show the failure message instead. That message gives the direct
email address and keeps everything the person typed.

Add `?leaddebug=1` to the URL to see each operation's outcome on screen after a submission.

**Updating `lead-capture.js`**: it's generated from `lead-capture.jsx` in
`aggelosmouzakitispersonal`. To update it, copy the new `lead-capture.js` into
`src/js/`, then update `LEAD_CAPTURE_SHA256` in `scripts/check.mjs`. The check
fails until the two match, so the copy can't drift by accident.

**Adding analytics or another third-party script**: add its origins to the CSP in
`scripts/build.mjs` (`script-src`/`connect-src`), or the browser will block it.

## Deploying (Netlify)

1. In Netlify, choose **Add new project** (or "Add new site"), then **Import an
   existing project**, then **GitHub**, and pick `aggelosmouzakitis/aggelos-practice-growth`.
2. Name the project `aggelos-practice-growth`. Your default address will then be
   `aggelos-practice-growth.netlify.app`, which is what the DNS record points to.
3. You don't need to change the build settings; they come from `netlify.toml`
   (build command `node scripts/build.mjs`, publish directory `dist`, Node 22).
   Production branch: `main`.
4. Go to **Domain management**, choose **Add a domain**, and enter
   `practice.aggelosmouzakitis.com`. Then set it as the primary domain.
5. In the same place, under **HTTPS**, wait for the Let's Encrypt certificate (usually
   a few minutes once DNS resolves).

DNS (name.com): a `CNAME` record for host `practice`, pointing to
`aggelos-practice-growth.netlify.app`. Don't use an `A` record or URL forwarding.

## After the first deploy

- Open the page, submit a real request with `?leaddebug=1`, and check that the panel
  shows `sheet ok` and `owner ok`. Then check that the row appears in the Leads sheet
  (source `practice-growth-xray`) and the email arrives.
- EmailJS: if **Account → Security** has a domain allow-list, add
  `practice.aggelosmouzakitis.com` to it. Otherwise the owner email will be refused
  from this domain, even though the sheet row is still written.
- Google Search Console: add the property `https://practice.aggelosmouzakitis.com/`
  (or verify the whole domain with DNS), then submit `sitemap.xml`.
- Test the link preview with the LinkedIn Post Inspector or opengraph.xyz.

## Assets

- `xray-report-example-{560,800,1086}.webp` are made from the lossless master
  `assets-source/xray-report-example.webp`. The enlarge dialog uses the 1086px one at
  higher quality.
- `grain.webp` is the supplied `grain.png` stored as black with alpha
  (`alpha = 255 − grey`) and drawn at opacity 0.06. That's the same arithmetic as the
  prototype's `mix-blend-mode: multiply`, without a fixed blend layer over the page. It's
  12.8 KB instead of 47 KB and within 1/255 of the original.
- `icon.svg` is "A." from the wordmark, drawn from the Inter Tight outlines in the
  page's colours. The other icons and the social image are rasterised from it and from
  `scripts/assets/og.html` by `scripts/assets/render.mjs`.
- Inter, Inter Tight and Archivo Black are SIL Open Font License fonts. The licence
  metadata is embedded in each woff2 file.
