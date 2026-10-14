# The Marketing Hot Seat: practice.aggelosmouzakitis.com

The one-page site for the Marketing Hot Seat, a weekly online marketing group for
therapists (€59/month). It's built from the approved Claude Design prototype
(`Marketing Hot Seat v2.dc.html`) as plain HTML, CSS and JavaScript, with no framework
and no runtime dependencies. The page lives at the root, `/`.

It's a separate site and Netlify project from the psychotherapy site
(aggelosmouzakitis.com, repo `aggelosmouzakitispersonal`). The only thing they share
is the lead layer, which is copied over unchanged (see below).

## Layout

| Path | What it is |
| --- | --- |
| `src/index.html` | The page: semantic markup, metadata, JSON-LD. `<!-- @… -->` comments are filled in by the build. |
| `src/partials/enquiry.html` | The enquiry form. The build expands it once per CTA (`hero`, `week`, `final`). |
| `src/css/site.css` | All styles. The prototype's inline styles became classes; the build inlines this file. |
| `src/js/main.js` | Behaviour: the logo's in-page link, the FAQ, the three forms. |
| `src/js/lead-capture.js` | **Unchanged** copy of the live site's lead layer (`window.submitLead`). |
| `src/js/vendor/emailjs-browser-4.4.1.min.js` | EmailJS browser SDK, self-hosted and pinned (verified against the npm registry). |
| `src/fonts/`, `src/img/` | The supplied fonts and portrait. The grain is derived (see Assets). |
| `src/icons/`, `src/social/` | Favicons and the 1200×630 social preview image. |
| `assets-source/` | Lossless master of the grain tile. Not deployed. |
| `scripts/build.mjs` | Builds `dist/`. Node built-ins only. |
| `scripts/check.mjs` | Static checks on `dist/` (metadata, structured data, headings, form contract, leftovers, file hashes). |
| `scripts/qa/run.mjs` | Browser QA with Playwright at 320/390/768/1024/1440 px, with faked lead endpoints. |
| `scripts/serve.mjs` | Local server for `dist/` that sends the same headers as Netlify. |
| `dist/` | The deployable site, committed so it can also be deployed without building. |

## Commands

```sh
npm run build    # src/ → dist/ (production: indexable)
npm test         # build + static checks
npm run serve    # http://127.0.0.1:8080 with Netlify's headers
npm run qa       # build + browser QA (needs Playwright and Chromium: npm i -g playwright)
npm run assets   # regenerate the grain and the icons (needs Pillow and Playwright)
```

`npm test` and `npm run qa` must both pass before a deploy. QA screenshots go to
`qa-output/`, which isn't committed.

## What the build does

- Adds a content hash to every image and script file name (`main.620eb43c69.js`)
  so they can be cached for a year. Fonts keep their versioned names.
- Inlines the stylesheet, which saves a render-blocking request.
- Expands the enquiry form three times, with the prototype's IDs (`hs-hero-email`, …).
- Keeps "€59/month" from breaking at the slash on narrow screens. It only touches
  visible text, never attributes or metadata.
- Writes a Content-Security-Policy `<meta>` that includes the hashes of the inline
  style and script. Scripts may only connect to EmailJS and the Apps Script web app.
- Writes `robots.txt` and `sitemap.xml` (the root URL only).
- Indexing depends on Netlify's `CONTEXT`. Only `production` is indexable. Deploy
  previews, branch deploys and `netlify dev` get `noindex, nofollow` in each page,
  plus an `X-Robots-Tag` header on every file (`dist/_headers`).
- Fails if any local link, image, `srcset` entry, `#fragment` or ARIA reference
  doesn't resolve, or if an inline `style=""` attribute appears (the CSP blocks it).

## SEO and structured data

- Title, description, canonical (`https://practice.aggelosmouzakitis.com/`), Open Graph
  and Twitter values are the approved ones; `scripts/check.mjs` holds the exact strings
  and fails if any of them changes.
- JSON-LD: `WebPage`, `WebSite`, `Person`, `Service` with an `Offer` (€59, billed
  monthly) and `FAQPage`. Every URL and `@id` is under the production root. The check
  compares the `FAQPage` entries with the visible FAQ word for word, so edit both
  together.

## Lead capture

All three CTAs ("Get joining details · €59/month", in the intro, the week section and
the closing section) open an inline form with three fields:

- website or directory profile (optional)
- email (required)
- phone (optional)

It's an enquiry, not a checkout: the person asks for the session times and joining
details, and nothing is paid on the page.

On submit, the form calls `window.submitLead` from `lead-capture.js`, the same file the
psychotherapy site uses. That function does two things:

- **Leads sheet**: posts one row to the Apps Script web app.
- **Owner email**: sends one EmailJS email, using `service_i4xq7vg` and `template_6mv5hou`.

Every lead carries `source: 'marketing-hot-seat'`, `detail: 'hot-seat-enquiry-<cta>'`
(`hero`, `week` or `final`), the detail label `Marketing Hot Seat enquiry` and the
subject `[Hot Seat] New Marketing Hot Seat enquiry: <email>`. The website, phone and
CTA go both into the row and into the email.

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

Netlify builds and publishes every push to `main` (production). The settings come
from `netlify.toml`: build command `node scripts/build.mjs`, publish directory
`dist`, Node 22.

First-time setup, for reference:

1. In Netlify, choose **Add new project** (or "Add new site"), then **Import an
   existing project**, then **GitHub**, and pick `aggelosmouzakitis/aggelos-practice-growth`.
2. Name the project `aggelos-practice-growth`. Your default address will then be
   `aggelos-practice-growth.netlify.app`, which is what the DNS record points to.
3. Production branch: `main`.
4. Go to **Domain management**, choose **Add a domain**, and enter
   `practice.aggelosmouzakitis.com`. Then set it as the primary domain.
5. In the same place, under **HTTPS**, wait for the Let's Encrypt certificate (usually
   a few minutes once DNS resolves).

DNS (name.com): a `CNAME` record for host `practice`, pointing to
`aggelos-practice-growth.netlify.app`. Don't use an `A` record or URL forwarding.

## After a deploy

- Open the page, submit a real request with `?leaddebug=1`, and check that the panel
  shows `sheet ok` and `owner ok`. Then check that the row appears in the Leads sheet
  (source `marketing-hot-seat`) and the email arrives with the `[Hot Seat]` subject.
- EmailJS: if **Account → Security** has a domain allow-list, it must include
  `practice.aggelosmouzakitis.com`. Otherwise the owner email will be refused
  from this domain, even though the sheet row is still written.
- Google Search Console: the property `https://practice.aggelosmouzakitis.com/`; submit
  `sitemap.xml` again so the new page is recrawled.
- Social previews cache the old image and text: refresh them with the LinkedIn Post
  Inspector and the Facebook Sharing Debugger, or check with opengraph.xyz.

## Assets

- `aggelos-home-square-{520,800}.webp` is the supplied portrait, shown in the hero.
- `grain.webp` is the supplied `grain.png` stored as black with alpha
  (`alpha = 255 − grey`) and drawn at opacity 0.06. That's the same arithmetic as the
  prototype's `mix-blend-mode: multiply`, without a fixed blend layer over the page. It's
  12.8 KB instead of 47 KB and within 1/255 of the original.
- `marketing-hot-seat-og.png` is the approved social image from the design export,
  re-encoded losslessly without its fully opaque alpha channel (`python3 -I
  scripts/assets/images.py og`): every pixel is the same, and the file is 294 KB
  instead of 705 KB, under the 300 KB that some link previews accept.
  `scripts/assets/og.html` composes the same image; `node scripts/assets/render.mjs --og`
  re-renders it after a change there.
- `icon.svg` is "A." from the wordmark, drawn from the Inter Tight outlines in the
  page's colours. The other icons are rasterised from it by `scripts/assets/render.mjs`.
- Inter, Inter Tight and Archivo Black are SIL Open Font License fonts. The licence
  metadata is embedded in each woff2 file.
