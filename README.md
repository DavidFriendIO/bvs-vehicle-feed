# bvs-vehicle-feed

Cloudflare Worker that crawls braintreevansales.co.uk nightly (politely: one request at a time, 20 s apart) and publishes a Google Merchant Center vehicle ads XML feed at `/feed/{FEED_TOKEN}.xml`.

| Cron (UTC) | Stage |
|---|---|
| `5 0 * * *` | `list`: crawl the stock list, queue new/changed/stale vehicles, drop sold ones |
| `*/10 1-3 * * *` | `detail`: fetch up to 3 queued vehicle pages |
| `30 4 * * *` | `build`: write the XML to KV |

Routes: `GET /feed/{token}.xml`, `GET /status/{token}`, `POST /run/{token}?stage=list|detail|build` (add `&wait=1` to wait for the result). Everything else is 404.

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
- "No VAT" text: `#detail-description-modal` only. Other vehicles' links elsewhere on the page also say "NO VAT", so never search the whole page.
- Features: `.list-stat` items inside `#detail-key-features-modal`.

A page that fails any required field (title, year, price block) is stored as `status: error`, never as a partial item, and is retried by the next list crawl.

## Known differences from the hand-built draft
- Descriptions and features come straight from the page, so wording differs (the draft's features were hand-picked; the Worker takes the first 15 from Key Features). Colour is as shown on the page (e.g. "Tempest Grey").
- Image size: the draft mixes `large1` and `large2`. The Worker uses the main gallery's `large1` URLs for every vehicle.
- Items are sorted by price, high to low.
