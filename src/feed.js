import { SITE, STORE_CODE, DEALER_ADDRESS } from './config.js';

const tidy = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
export const esc = (v) =>
  tidy(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function engineOf(fuel) {
  const f = (fuel || '').toLowerCase();
  if (/plug/.test(f)) return 'plug_in_hybrid';
  if (/hybrid/.test(f)) return 'hybrid';
  if (/electric/.test(f)) return 'electric';
  if (/diesel/.test(f)) return 'diesel';
  if (/petrol|gasoline/.test(f)) return 'gasoline';
  return '';
}

export function bodyStyleOf(body) {
  const b = (body || '').toLowerCase();
  if (!b) return '';
  if (/motorhome|campervan/.test(b)) return '';
  if (/suv/.test(b)) return 'suv';
  if (/pick-?up/.test(b)) return 'truck';
  return 'van';
}

export const categoryOf = (body) => (/motorhome|campervan/i.test(body || '') ? '920' : '916');

const SLUG_ALIAS = { pick_up: 'pickup', box_van: 'box_van', refrigerated_van: 'refrigerated' };
export function bodySlug(body) {
  const s = (body || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return SLUG_ALIAS[s] || s;
}

export function priceBand(price) {
  if (price < 10000) return 'under_10k';
  if (price < 20000) return '10k_20k';
  if (price < 30000) return '20k_30k';
  return '30k_plus';
}

export function describe(v) {
  const bits = [v.mileage != null ? `${v.mileage.toLocaleString('en-GB')} miles` : '', v.colour, v.fuel, v.transmission]
    .map((x) => String(x || '').toLowerCase()).filter(Boolean);
  const vat = v.vat === 'plus' ? ' Price plus VAT.' : v.vat === 'no' ? ' No VAT to pay.' : '';
  const head = [v.year, v.make, v.model, v.variant].filter(Boolean).join(' ');
  return `${head}.${bits.length ? ' ' + bits.join(', ') + '.' : ''}${vat} Sold by ${DEALER_ADDRESS}.`;
}

export function vehicleUrl(v) {
  return v.url || `${SITE}/used-${slugify(v.make)}-${slugify(v.model)}-braintree-essex-${v.id}`;
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** One <item>. `v` is the stored detail record, `url` the canonical page URL. */
export function itemXml(v) {
  const link = vehicleUrl(v);
  const el = (name, value) => (value === '' || value == null || tidy(value) === '' ? null : `  <g:${name}>${esc(value)}</g:${name}>`);
  const lines = [
    el('id', v.id),
    el('link', link),
    `  <g:link_template>${esc(link)}?store={store_code}</g:link_template>`,
    el('image_link', v.images[0]),
    el('google_product_category', categoryOf(v.bodyType)),
    el('brand', v.make),
    el('model', v.model),
    el('year', v.year),
    el('condition', 'used'),
    el('price', `${v.price.toFixed(2)} GBP`),
    el('mileage', v.mileage != null ? `${v.mileage} miles` : ''),
    el('color', v.colour),
    el('engine', engineOf(v.fuel)),
    el('body_style', bodyStyleOf(v.bodyType)),
    el('description', describe(v)),
    el('vehicle_option', v.features.map((f) => tidy(f).replace(/,/g, '')).filter(Boolean).join(',')),
    el('custom_label_0', v.vat === 'plus' ? 'plus_vat' : v.vat === 'no' ? 'no_vat' : 'price_as_shown'),
    el('custom_label_1', bodySlug(v.bodyType)),
    el('custom_label_2', priceBand(v.price)),
    ...v.images.slice(1, 10).map((u) => el('additional_image_link', u)),
    `  <g:vehicle_fulfillment>\n    <g:option>in_store</g:option>\n    <g:store_code>${STORE_CODE}</g:store_code>\n  </g:vehicle_fulfillment>`,
  ].filter(Boolean);
  return `<item>\n${lines.join('\n')}\n</item>`;
}

/** records: stored `v:{id}` objects with status 'ok'. Sorted by price high to low, then ID. */
export function buildFeed(records) {
  const items = records
    .filter((r) => r && r.status === 'ok')
    .sort((a, b) => b.price - a.price || String(a.id).localeCompare(String(b.id)))
    .map(itemXml);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>Braintree Van Sales vehicle feed</title>
<link>${SITE}</link>
<description>Used vehicle stock for Google vehicle ads</description>
${items.join('\n')}
</channel>
</rss>
`;
}

/** Parser-regression signals over stored detail records (only those that would be in the feed). */
export function qualityCounts(records, sample = 20) {
  const ok = records.filter((r) => r && r.status === 'ok');
  const noOpt = ok.filter((r) => !(r.features || []).some((f) => tidy(f)));
  const fewImg = ok.filter((r) => (r.images || []).length < 3);
  return {
    items: ok.length,
    noVehicleOption: noOpt.length,
    fewerThan3Images: fewImg.length,
    noVehicleOptionIds: noOpt.slice(0, sample).map((r) => r.id),
    fewerThan3ImagesIds: fewImg.slice(0, sample).map((r) => r.id),
    optionsFromDescription: ok.filter((r) => r.featuresSource === 'description').length,
  };
}
