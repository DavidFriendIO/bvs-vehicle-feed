import test from 'node:test';
import assert from 'node:assert/strict';
import { raw } from './helpers.js';
import { parseVehiclePage, parseListPage, parseTotalPages } from '../src/parse.js';

const p = (id) => parseVehiclePage(raw(id), id);

test('Vito: +VAT, minibus', () => {
  const r = p('8270075');
  assert.equal(r.status, 'ok');
  assert.deepEqual(
    [r.data.make, r.data.model, r.data.year, r.data.price, r.data.vat, r.data.mileage, r.data.colour, r.data.fuel, r.data.transmission, r.data.bodyType],
    ['Mercedes-Benz', 'Vito', 2023, 27650, 'plus', 62253, 'White', 'Diesel', 'Automatic', 'Minibus'],
  );
  assert.match(r.data.variant, /^2\.0 114 CDI SELECT Tourer Double Cab 5dr Diesel G-Tronic RWD L3 Euro 6 \(s\/s\) \(136 ps\)$/);
  assert.equal(r.data.images.length, 10);
  assert.equal(r.data.images[0], 'https://images.clickdealer.co.uk/vehicles/8270/8270075/large1/203101452.jpg');
  assert.equal(r.data.features.length, 15);
});

test('Land Cruiser: NO VAT found in own description only', () => {
  const r = p('8128860');
  assert.equal(r.data.price, 32950);
  assert.equal(r.data.vat, 'no');
});

test('Cullinan: no VAT wording -> shown. Other pages\' "NO VAT" links are ignored', () => {
  const r = p('7027496');
  assert.equal(r.data.price, 239950);
  assert.equal(r.data.vat, 'shown');
  assert.equal(p('8116122').data.vat, 'shown');
});

test('Dethleffs: motorhome', () => {
  const r = p('8116122');
  assert.equal(r.status, 'ok');
  assert.equal(r.data.bodyType, 'Motorhome');
  assert.equal(r.data.images[0], 'https://images.clickdealer.co.uk/vehicles/8116/8116122/large1/200737474.jpg');
  assert.equal(r.data.variant, '2.3 AUTO,4 BERTH,4 SEAT,1 OWNER,AS NEW');
});

test('Hilux: DEPOSIT TAKEN is excluded', () => {
  const r = p('8092937');
  assert.equal(r.status, 'excluded');
  assert.match(r.reason, /DEPOSIT TAKEN/);
});

test('broken page -> error, never half-filled', () => {
  assert.equal(parseVehiclePage('<html>nothing here</html>', '1').status, 'error');
  assert.equal(parseVehiclePage(raw('8270075').replace(/window\.CLICK_DATA/, 'x').replace('vehicle-price__block--price', 'zzz'), '1').status, 'error');
});

test('list page: 12 cards with price and mileage, 6 pages', () => {
  const html = raw('list-page-1');
  const cards = parseListPage(html);
  assert.equal(cards.length, 12);
  assert.equal(parseTotalPages(html), 6);
  const vito = cards.find((c) => c.id === '8270075');
  assert.equal(vito.listPrice, 27650);
  assert.equal(vito.listMileage, 62253);
  assert.equal(vito.url, 'https://www.braintreevansales.co.uk/used-mercedes-benz-vito-braintree-essex-8270075');
  assert.ok(cards.every((c) => c.listPrice > 0 && c.listMileage >= 0));
});

test('VAT: "no vat" only in the heading/derivative line is detected; similar-vehicle links are not', () => {
  const base = raw('7027496');
  const h2 = base.replace(/(<div class="vehicle-title-block__title">\s*<h1>[^<]*<\/h1>\s*<h2>)([^<]*)/, '$1$2.NO VAT');
  assert.notEqual(h2, base);
  assert.equal(parseVehiclePage(h2, '7027496').data.vat, 'no');
  const h1 = base.replace(/(<div class="vehicle-title-block__title">\s*<h1>)([^<]*)/, '$1$2 no Vat');
  assert.equal(parseVehiclePage(h1, '7027496').data.vat, 'no');
  const plus = h2.replace('&pound;239,950', '&pound;239,950+VAT');
  assert.equal(parseVehiclePage(plus, '7027496').data.vat, 'plus');
  assert.equal(parseVehiclePage(raw('7027496'), '7027496').data.vat, 'shown');
});

// ---------------------------------------------------------------- features
import fs from 'node:fs';
import { parseFeatures, descriptionFeatures } from '../src/parse.js';
const fixtureExists = (id) => fs.existsSync(new URL(`../fixtures/raw/${id}.html`, import.meta.url));

test('features: Key Features list is preferred when present', () => {
  const r = p('8270075').data;
  assert.equal(r.featuresSource, 'key_features');
  assert.equal(r.features[0], '17in Alloy Wheels - 20-Spoke Design');
});

test('features: 8116122 Dethleffs (Key Features empty on the page) falls back to the description equipment list', () => {
  const html = raw('8116122');
  assert.match(html, /<summary>Exterior<\/summary>\s*<div class="stats-ul">No features available\./);
  const r = p('8116122').data;
  assert.equal(r.featuresSource, 'description');
  assert.ok(r.features.length >= 10 && r.features.length <= 15, String(r.features.length));
  for (const want of ['AIRCON', 'pioneer stereo', 'sat-nav', 'bluetooth', 'fitted tracker', 'solar panel']) assert.ok(r.features.includes(want), want);
  // prose, sales chatter and the boilerplate paragraph must not leak in
  assert.ok(!r.features.some((f) => /px change|finance|deposit|plus many more|UK.s fastest|\bfrom its 1 owner\b/i.test(f)), r.features.join(' | '));
  assert.ok(r.features.every((f) => !f.includes(',') && f.length <= 60));
});

// Drop fixtures/8102623.html (Swift Bolero, saved from Chrome view-source, then npm run unwrap-fixtures) to enable this.
test('features: 8102623 Swift Bolero has vehicle options', { skip: !fixtureExists('8102623') && 'fixtures/raw/8102623.html not in the repo yet' }, () => {
  const r = p('8102623');
  assert.equal(r.status, 'ok');
  assert.ok(r.data.features.length > 0, 'no features parsed');
});

test('features: Key Features block removed entirely -> description list is used', () => {
  const html = raw('8270075').replace(/<div id="detail-key-features-modal"[\s\S]*?(?=<div id="detail-)/, '');
  assert.ok(!html.includes('detail-key-features-modal'));
  const r = parseVehiclePage(html, '8270075').data;
  assert.equal(r.featuresSource, 'description');
  assert.equal(r.features[0], '17in Alloy Wheels - 20-Spoke Design');
  assert.equal(r.features.length, 15);
});

test('features: <li> items and bullet lines in a description', () => {
  assert.deepEqual(descriptionFeatures('<p>Intro</p><ul><li>Sat nav</li><li>Heated seats</li><li>Tow bar</li></ul>'), ['Sat nav', 'Heated seats', 'Tow bar']);
  assert.deepEqual(descriptionFeatures('<p>Spec:<br>• Sat nav<br>• Heated seats<br>- Tow bar<br>Call us</p>'), ['Sat nav', 'Heated seats', 'Tow bar']);
  assert.deepEqual(descriptionFeatures('<p>A lovely van. Great value for money, call today.</p>'), []);
  assert.deepEqual(parseFeatures('<html></html>', '<p>nothing</p>'), { features: [], source: null });
});
