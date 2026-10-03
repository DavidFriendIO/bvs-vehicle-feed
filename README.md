# bvs-vehicle-feed

Cloudflare Worker that crawls braintreevansales.co.uk nightly (politely: one request at a time, 20 s apart) and publishes a Google Merchant Center vehicle ads XML feed at `/feed/{FEED_TOKEN}.xml`.

**The Worker only serves the feed.** braintreevansales.co.uk sits behind Cloudflare Bot Management, which returns 403 to plain HTTP clients from any IP (Workers, GitHub runners, a home connection). The crawl therefore drives the PC's installed Google Chrome through `playwright-core` (`channel: "chrome"`, no browser download; persistent profile in `chrome-profile/` so the Cloudflare clearance cookie is reused; window minimised off-screen): `src/browserFetch.js` loads each page with `page.goto`, waits up to 30 s for a challenge to clear, and hands the HTML to the existing parsers. `run-crawl.bat` runs `scripts/crawl.js` (list, up to 80 detail pages 20 s apart, build) and stores state and the feed in the Worker's `BVS_FEED` KV through the Cloudflare API. Settings come from `.env` (copy `.env.example`). `run-crawl.bat probe` loads `/used-vans` plus one vehicle in a visible Chrome and reports whether the data was found. Step-by-step set-up, including the daily Task Scheduler job: [WINDOWS-SETUP.md](WINDOWS-SETUP.md). Output is appended to `logs/crawl-YYYY-MM-DD.log`. The Worker has no cron triggers.

The HTML handed to the parsers is the server's own response body (what the fixtures are), with `page.content()` (the live DOM) as the fallback; `HTML_SOURCE=content` forces the DOM. Images, media, fonts and third-party analytics requests are blocked, but each page load still fetches the site's own scripts and styles, which Chrome caches in the profile.

`.github/workflows/crawl.yml` is manual-only (probe or crawl, under `xvfb-run`) and is kept for testing, though GitHub's runners are blocked too; it needs repository secrets `CF_ACCOUNT_ID`, `CF_API_TOKEN` (Workers KV Storage: Edit), `CF_KV_NAMESPACE_ID`.

Routes: `GET /feed/{token}.xml`, `GET /status/{token}` (includes lock state and skipped runs), `GET` or `POST /run/{token}?stage=list|detail|build|backfill` (waits and returns the JSON result; `&async=1` returns at once but background work is cut off about 30 s later; `&force=1` clears a stale lock first). Running `list`/`detail`/`backfill` on the Worker will hit the block; they remain for testing. `GET /debug/{token}?url=<encoded url>[&redirect=manual][&ua=none]` does one fetch with the crawler's headers and returns status, final URL, response headers and the first 2,000 characters of the body (or the full error). Everything else is 404.

`backfill` loops detail fetches (20 s apart) until the queue is empty or about 12 minutes pass, then builds, and streams progress to the page: keep the tab open until it says `done`. If you close it early, the run stops and the queue is kept; open the URL again to carry on.

Needs the **Workers Paid** plan: the list and build stages make more than 50 KV operations and the parsers use more than the free plan's 10 ms CPU.

## Rotate `FEED_TOKEN`
Cloudflare dashboard > Workers > bvs-vehicle-feed > Settings > Variables and Secrets > edit `FEED_TOKEN` (any new 32-character random string) > Deploy. The old URL stops working immediately. Update the feed URL in Merchant Center.

## Develop
`npm test` runs the parsers, feed builder and crawl stages against `fixtures/`. The fixtures were saved from Chrome's view-source; `npm run unwrap-fixtures` converts `fixtures/*.html` to raw HTML in `fixtures/raw/`, which is what the tests read. `reference/bvs-vehicle-feed-draft.xml` is the hand-built output the feed format follows.

## What the parsers rely on (fix these first if ClickDealer changes its templates)

**List page** (`parseListPage`, `parseTotalPages`)
- Cards: `<div class="listing ... veh-{ID} ...">`; the vehicle link inside is `href="/used-...-braintree-essex-{ID}"`.
- Price: text of `.listing-price__price` (the `£` figure; the inner `.reserved-price` is ignored). Mileage: second `.vehicle-spec__stat` in the card's first `ul.vehicle-spec`.
- Page count: highest `href="/used-vans/{N}"` in the pagination (falls back to 6, capped at 10).

**Vehicle page** (`parseVehiclePage`)
- Make/model: `window.CLICK_DATA.vehicle.manufacturer` / `.range` (falls back to `.vehicle-title-block__title h1`). Mileage and colour also come from it.
- Variant: `.vehicle-title-block__title h2`.
- Price text: first `.vehicle-price__amount` after `.vehicle-price__block--price`.
- Year, colour, fuel, transmission, body type: `.dt-spec-list` items (`.dt-spec-list__label` / `.dt-spec-list__stat`): Year, Colour, Fuel Type, Transmission, Body Style.
- Images: `a.rsImg` hrefs (main gallery, `large1`), falling back to `a.group4` (lightbox, `large2`), then `og:image`.
- "No VAT" text: the main price, `.vehicle-title-block__title` h1 and h2, and `#detail-description-modal` only. Other vehicles' links elsewhere on the page also say "NO VAT", so never search the whole page.
- Features: `.list-stat` items inside `#detail-key-features-modal`.

A page that fails any required field (title, year, price block) is stored as `status: error`, never as a partial item, and is retried by the next list crawl.

## Known differences from the hand-built draft
- Descriptions and features come straight from the page, so wording differs (the draft's features were hand-picked; the Worker takes the first 15 from Key Features). Colour is as shown on the page (e.g. "Tempest Grey").
- Image size: the draft mixes `large1` and `large2`. The Worker uses the main gallery's `large1` URLs for every vehicle.
- Items are sorted by price, high to low.
