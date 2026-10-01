# bvs-vehicle-feed

Cloudflare Worker that crawls braintreevansales.co.uk nightly (politely: one request at a time, 20 s apart) and publishes a Google Merchant Center vehicle ads XML feed at `/feed/{FEED_TOKEN}.xml`.

**The Worker only serves the feed.** braintreevansales.co.uk sits behind Cloudflare Bot Management and challenges Worker requests (403, `cf-mitigated: challenge`), so the crawl runs in GitHub Actions instead (`.github/workflows/crawl.yml`, `scripts/crawl.js`). It runs the same stages, 20 s apart: `list` (queue new/changed/stale vehicles, drop sold ones), `detail` (fetch queued pages, capped per run) and `build` (write the XML), and stores state and the feed in the Worker's `BVS_FEED` KV through the Cloudflare API. The Worker has no cron triggers.

GitHub setup: Settings > Secrets and variables > Actions > repository secrets `CF_ACCOUNT_ID`, `CF_API_TOKEN` (Workers KV Storage: Edit), `CF_KV_NAMESPACE_ID`, and optionally `RESEND_API_KEY`. Actions > crawl > Run workflow: `probe` checks that GitHub isn't challenged; `crawl` runs everything (set `max_detail` to 80 for the first fill). The schedule is `0 1 * * *` UTC. GitHub pauses schedules after 60 days without repo activity.

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
