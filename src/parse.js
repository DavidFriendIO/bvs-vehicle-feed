import { SITE, MAX_IMAGES, MAX_FEATURES, DEFAULT_LIST_PAGES, MAX_LIST_PAGES } from './config.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };

export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const clean = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (s) => {
  const m = /[\d,]+(?:\.\d+)?/.exec(s || '');
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

/** Slice from `start` marker to the next `end` marker (or to the end of the page). */
function section(html, start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = end ? html.indexOf(end, i + start.length) : -1;
  return html.slice(i, j < 0 ? undefined : j);
}

// ---------------------------------------------------------------- list page

/**
 * Stock-list page -> cards. Each card is `<div class="listing ... veh-{ID} ...">`.
 * Price/mileage are null when they can't be read.
 */
export function parseListPage(html) {
  const re = /<div class="listing [^"]*\bveh-(\d+)\b[^"]*"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push({ id: m[1], at: m.index });
  const out = [];
  const seen = new Set();
  starts.forEach((s, k) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const card = html.slice(s.at, starts[k + 1]?.at ?? s.at + 20000);
    const link = new RegExp(`href="(/used-[a-z0-9-]+-braintree-essex-${s.id})"`).exec(card);
    const url = link ? SITE + link[1] : null;
    if (!url) return;
    const priceBlock = /class="listing-price__price"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<!--)/.exec(card);
    const priceText = priceBlock ? clean(priceBlock[1].replace(/<div class="reserved-price">[\s\S]*?<\/div>/, '')) : '';
    const pm = /£\s*([\d,]+)/.exec(priceText);
    const specUl = /<ul class="vehicle-spec">([\s\S]*?)<\/ul>/.exec(card);
    const stats = specUl ? [...specUl[1].matchAll(/vehicle-spec__stat">([\s\S]*?)<\/span>/g)].map((x) => clean(x[1])) : [];
    const mileage = /^\d[\d,]*$/.test(stats[1] || '') ? Number(stats[1].replace(/,/g, '')) : null;
    out.push({ id: s.id, url, listPrice: pm ? Number(pm[1].replace(/,/g, '')) : null, listMileage: mileage });
  });
  return out;
}

/** Number of list pages, from the pagination links on page 1. */
export function parseTotalPages(html) {
  const ns = [...html.matchAll(/href="\/used-vans\/(\d+)"/g)].map((m) => Number(m[1]));
  const n = ns.length ? Math.max(...ns) : DEFAULT_LIST_PAGES;
  return Math.min(Math.max(n, 1), MAX_LIST_PAGES);
}

// ------------------------------------------------------------- vehicle page

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

function clickData(html) {
  const i = html.indexOf('window.CLICK_DATA');
  if (i < 0) return null;
  const j = html.indexOf('</script>', i);
  const raw = html.slice(html.indexOf('=', i) + 1, j).trim().replace(/;$/, '');
  try { return JSON.parse(raw).vehicle || null; } catch { return null; }
}

function specList(html) {
  const blk = section(html, '<ul class="dt-spec-list">', '</ul>').replace(/<!--[\s\S]*?-->/g, '');
  const spec = {};
  for (const m of blk.matchAll(/dt-spec-list__label">([^<]*)<\/span\s*>\s*<span\s+class="dt-spec-list__stat">([\s\S]*?)<\/span>/g)) {
    spec[clean(m[1]).toLowerCase()] = clean(m[2]);
  }
  return spec;
}

/**
 * Parse one vehicle page. Returns { status: 'ok'|'excluded'|'error', reason?, data? }.
 * `data` is the stored detail record (without fetchedAt).
 */
export function parseVehiclePage(html, id) {
  try {
    const cd = clickData(html);
    const spec = specList(html);

    const h1 = /<div class="vehicle-title-block__title">\s*<h1>([\s\S]*?)<\/h1>\s*<h2>([\s\S]*?)<\/h2>/.exec(html);
    if (!h1 && !cd) return { status: 'error', reason: 'title not found' };
    const variant = h1 ? clean(h1[2]) : cd?.advert || '';
    const titleName = h1 ? clean(h1[1]) : '';
    let make = cd?.manufacturer || '';
    let model = cd?.range || '';
    if ((!make || !model) && titleName) {
      const [a, ...rest] = titleName.split(' ');
      make = make || titleCase(a);
      model = model || titleCase(rest.join(' '));
    }
    if (!make || !model) return { status: 'error', reason: 'make/model not found' };

    const year = /^\d{4}$/.test(spec.year || '') ? Number(spec.year) : null;
    if (!year) return { status: 'error', reason: 'year not found' };

    const mileage = Number.isFinite(cd?.mileage) ? cd.mileage : num(spec.mileage);

    // Price: only the main price block.
    const pb = /vehicle-price__block--price[\s\S]*?<div class="vehicle-price__amount">([\s\S]*?)<\/div>/.exec(html);
    if (!pb) return { status: 'error', reason: 'price block not found' };
    const priceText = clean(pb[1]);

    // Main gallery (royalSlider, large1); the lightbox list (a.group4, large2) is the fallback.
    const images = [];
    for (const cls of ['rsImg', 'group4']) {
      const re = new RegExp(`<a class="${cls}"[^>]*href="(https://images\\.clickdealer\\.co\\.uk/vehicles/[^"]+)"`, 'g');
      for (const m of html.matchAll(re)) {
        if (!images.includes(m[1])) images.push(m[1]);
        if (images.length >= MAX_IMAGES) break;
      }
      if (images.length) break;
    }
    if (!images.length) {
      const og = /og:image" content="(https:\/\/images\.clickdealer\.co\.uk\/[^"]+)"/.exec(html);
      if (og) images.push(og[1]);
    }

    const descHtml = section(html, '<div id="detail-description-modal"', '<div id="detail-');
    const description = clean(descHtml.replace(/<h2>[\s\S]*?<\/h2>/, ''));

    const featHtml = section(html, '<div id="detail-key-features-modal"', '<div id="detail-');
    const features = [];
    for (const m of featHtml.matchAll(/list-stat">([\s\S]*?)<\/div>/g)) {
      const f = clean(m[1]).replace(/,/g, '');
      if (f && !features.includes(f)) features.push(f);
      if (features.length >= MAX_FEATURES) break;
    }

    const pm = /£\s*([\d,]+(?:\.\d+)?)/.exec(priceText);
    const price = pm ? Number(pm[1].replace(/,/g, '')) : null;
    let vat = 'shown';
    if (/\+\s*vat/i.test(priceText)) vat = 'plus';
    else if (/no vat/i.test(priceText) || /no vat/i.test(variant) || /no vat/i.test(description)) vat = 'no';

    const data = {
      id: String(id), make, model, variant, year, price, vat, priceText, mileage,
      colour: spec.colour || cd?.colour || '', fuel: spec['fuel type'] || '',
      transmission: spec.transmission || '', bodyType: spec['body style'] || '',
      images, features,
    };

    if (price == null) return { status: 'excluded', reason: `no numeric price: ${priceText || 'blank'}`, data };
    if (!images.length) return { status: 'excluded', reason: 'no images', data };
    return { status: 'ok', data };
  } catch (e) {
    return { status: 'error', reason: `parse exception: ${e.message}` };
  }
}
