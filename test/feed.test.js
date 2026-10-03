import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { raw } from './helpers.js';
import { parseVehiclePage } from '../src/parse.js';
import { buildFeed, esc, itemXml } from '../src/feed.js';

const draft = fs.readFileSync(new URL('../reference/bvs-vehicle-feed-draft.xml', import.meta.url), 'utf8');
const draftItem = (id) => draft.match(new RegExp(`<item>\\s*<g:id>${id}</g:id>[\\s\\S]*?</item>`))[0];
const field = (xml, name) => xml.match(new RegExp(`<g:${name}>([^<]*)</g:${name}>`))?.[1] ?? null;
const rec = (id) => ({ ...parseVehiclePage(raw(id), id).data, status: 'ok' });

test('acceptance: items match the draft on the checked fields', () => {
  const expect = {
    8270075: { price: '27650.00 GBP', mileage: '62253 miles', custom_label_0: 'plus_vat', google_product_category: '916', body_style: 'van' },
    8128860: { price: '32950.00 GBP', custom_label_0: 'no_vat' },
    8116122: { google_product_category: '920', body_style: null },
    7027496: { price: '239950.00 GBP', custom_label_0: 'price_as_shown', engine: 'gasoline' },
  };
  for (const [id, fields] of Object.entries(expect)) {
    const mine = itemXml(rec(id));
    for (const [k, v] of Object.entries(fields)) {
      assert.equal(field(mine, k), v, `${id} ${k}`);
      assert.equal(field(draftItem(id), k), v, `${id} ${k} (draft sanity)`);
    }
  }
});

test('all other shared fields match the draft, except hand-edited text', () => {
  for (const id of ['8270075', '8128860', '8116122', '7027496']) {
    const mine = itemXml(rec(id)), d = draftItem(id);
    for (const k of ['id', 'link', 'link_template', 'brand', 'model', 'year', 'condition', 'price', 'mileage', 'engine', 'body_style', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'google_product_category', 'store_code', 'option']) {
      assert.equal(field(mine, k), field(d, k), `${id} ${k}`);
    }
    // images: same photos in the same order (large1/large2 size choice aside)
    const imgs = (x) => [...x.matchAll(/<g:(?:additional_)?image_link>[^<]*\/(\d+)\.jpg</g)].map((m) => m[1]);
    assert.deepEqual(imgs(mine), imgs(d), `${id} images`);
  }
});

test('description format', () => {
  assert.equal(
    field(itemXml(rec('8270075')), 'description'),
    '2023 Mercedes-Benz Vito 2.0 114 CDI SELECT Tourer Double Cab 5dr Diesel G-Tronic RWD L3 Euro 6 (s/s) (136 ps). 62,253 miles, white, diesel, automatic. Price plus VAT. Sold by Braintree Van Sales, 263 Rayne Road, Braintree CM7 2QF.',
  );
  assert.match(field(itemXml(rec('8128860')), 'description'), /No VAT to pay\. Sold by/);
});

test('empty values are left out, escaping and no tabs/newlines', () => {
  const v = { ...rec('8116122'), colour: '', model: 'A & B <x>\t\nz' };
  const x = itemXml(v);
  assert.ok(!x.includes('<g:color>'));
  assert.ok(!x.includes('<g:body_style>'));
  assert.match(x, /<g:model>A &amp; B &lt;x&gt; z<\/g:model>/);
  assert.ok(!/\t/.test(x));
  assert.equal(esc('a\u0001b'), 'ab');
  assert.ok(!/<g:vehicle_option>[^<]*,,/.test(itemXml(rec('8270075'))));
});

test('feed is well-formed XML (xmllint)', () => {
  const xml = buildFeed(['8270075', '8128860', '8116122', '7027496'].map(rec));
  assert.equal((xml.match(/<item>/g) || []).length, 4);
  fs.writeFileSync(new URL('../.test-feed.xml', import.meta.url), xml);
  try {
    execFileSync('xmllint', ['--noout', new URL('../.test-feed.xml', import.meta.url).pathname]);
  } catch (e) {
    if (e.code === 'ENOENT') return; // xmllint not installed here
    throw e;
  } finally {
    fs.rmSync(new URL('../.test-feed.xml', import.meta.url), { force: true });
  }
});

import { qualityCounts } from '../src/feed.js';
test('qualityCounts: no vehicle_option and fewer than 3 images', () => {
  const recs = [
    { id: '1', status: 'ok', features: ['a'], images: ['x', 'y', 'z'] },
    { id: '2', status: 'ok', features: [], images: ['x', 'y', 'z'] },
    { id: '3', status: 'ok', features: [' '], images: ['x'], featuresSource: 'description' },
    { id: '4', status: 'excluded', features: [], images: [] },
  ];
  const q = qualityCounts(recs);
  assert.equal(q.items, 3);
  assert.equal(q.noVehicleOption, 2);
  assert.deepEqual(q.noVehicleOptionIds, ['2', '3']);
  assert.equal(q.fewerThan3Images, 1);
  assert.deepEqual(q.fewerThan3ImagesIds, ['3']);
  assert.equal(q.optionsFromDescription, 1);
});
