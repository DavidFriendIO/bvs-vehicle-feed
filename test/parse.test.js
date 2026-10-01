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
