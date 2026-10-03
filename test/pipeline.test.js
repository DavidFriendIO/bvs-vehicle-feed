import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeKV, fakeClock, fakeSite, makeFetcher } from './helpers.js';
import { stageList, stageDetail, stageBuild, stageBackfill } from '../src/crawl.js';
import worker, { runStage } from '../src/index.js';

async function fullRun({ kv = new FakeKV(), clock = fakeClock(), site } = {}) {
  site = site || fakeSite({ clock });
  const fetcher = makeFetcher(site, clock);
  const deps = { kv, now: clock.now, fetcher, env: {} };
  const list = await stageList(deps);
  let runs = 0;
  while (JSON.parse((await kv.get('queue')) || '[]').length && runs++ < 40) await stageDetail(deps);
  const build = await stageBuild(deps);
  return { kv, clock, site, fetcher, deps, list, build, runs };
}
const q = async (kv) => JSON.parse(await kv.get('queue') || '[]');

test('first full run: 72 vehicles (6 synthetic pages x 12), every detail page fetched, feed built', async () => {
  const { list, build, kv, runs } = await fullRun();
  assert.equal(list.ok, true);
  assert.equal(list.found, 72);
  assert.equal(build.ok, true);
  assert.equal(build.items, 72);
  assert.ok(runs <= 18 * 2, 'fits in one or two nights');
  assert.equal((await kv.get('feed')).match(/<item>/g).length, 72);
});

test('Hilux 8092937 excluded while DEPOSIT TAKEN', async () => {
  const clock = fakeClock();
  const site = fakeSite({ clock });
  const { kv } = await fullRun({ clock, site });
  // the fixture list doesn't contain 8092937; put it in the index and queue it
  const idx = JSON.parse(await kv.get('index'));
  idx.ids.push({ id: '8092937', url: 'https://www.braintreevansales.co.uk/used-toyota-hilux-braintree-essex-8092937', listPrice: null, listMileage: null });
  await kv.put('index', JSON.stringify(idx));
  await kv.put('queue', JSON.stringify(['8092937']));
  await stageDetail({ kv, now: clock.now, fetcher: makeFetcher(site, clock), env: {} });
  const rec = JSON.parse(await kv.get('v:8092937'));
  assert.equal(rec.status, 'excluded');
  const b = await stageBuild({ kv, now: clock.now, env: {} });
  assert.ok(!(await kv.get('feed')).includes('8092937'));
  assert.equal(b.excluded, 1);
});

test('removing an ID from the stored index re-queues it', async () => {
  const { kv, deps } = await fullRun();
  const idx = JSON.parse(await kv.get('index'));
  const gone = idx.ids.pop().id;
  await kv.put('index', JSON.stringify(idx));
  const r = await stageList(deps);
  assert.ok(r.ok);
  assert.deepEqual(await q(kv), [gone]);
});

test('an ID missing from the live list leaves the feed after the next build', async () => {
  const { kv, clock, deps } = await fullRun();
  const idx = JSON.parse(await kv.get('index'));
  idx.ids.push({ id: '9999999', url: 'https://www.braintreevansales.co.uk/used-x-y-braintree-essex-9999999', listPrice: 1, listMileage: 1 });
  await kv.put('index', JSON.stringify(idx));
  await kv.put('v:9999999', JSON.stringify({ id: '9999999', status: 'ok', price: 1, make: 'X', model: 'Y', year: 2020, images: ['https://images.clickdealer.co.uk/vehicles/9999/9999999/large1/1.jpg'], features: [], vat: 'shown', url: idx.ids.at(-1).url }));
  await stageBuild(deps);
  assert.ok((await kv.get('feed')).includes('9999999'));
  const r = await stageList(deps);
  assert.equal(r.removed, 1);
  assert.equal(await kv.get('v:9999999'), null);
  await stageBuild(deps);
  assert.ok(!(await kv.get('feed')).includes('9999999'));
});

test('price change on the list page re-queues the vehicle', async () => {
  const { kv, deps } = await fullRun();
  const idx = JSON.parse(await kv.get('index'));
  idx.ids[0].listPrice += 100;
  await kv.put('index', JSON.stringify(idx));
  await stageList(deps);
  assert.deepEqual(await q(kv), [idx.ids[0].id]);
});

test('vehicle not fetched for >7 days is re-queued', async () => {
  const { kv, deps, clock } = await fullRun();
  clock.t += 8 * 24 * 3600 * 1000;
  const r = await stageList(deps);
  assert.equal(r.stale, 72);
});

test('safety rule: a crawl returning 10 IDs deletes nothing and alerts', async () => {
  const { kv, clock, deps, site } = await fullRun();
  const before = [...kv.m.keys()].filter((k) => k.startsWith('v:')).length;
  const idxBefore = await kv.get('index');
  // Site now shows 1 page of 10 stock cards
  const cards = site.page1.split('<div class="listing ');
  const tiny = cards.slice(0, 11).join('<div class="listing ').replace(/href="\/used-vans\/\d+"/g, '');
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => tiny });
  const fetcher = makeFetcher({ fetchFn }, clock);
  const r = await stageList({ ...deps, fetcher });
  assert.equal(r.ok, false);
  assert.match(r.alerts[0], /<60%/);
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith('v:')).length, before);
  assert.equal(await kv.get('index'), idxBefore);
  const log = JSON.parse(await kv.get('log'));
  assert.ok(log.at(-1).alerts.length >= 1);
});

test('a failed list page changes nothing and stops the stage', async () => {
  const { kv, clock, deps } = await fullRun();
  const idxBefore = await kv.get('index');
  const site = fakeSite({ clock, failList: 3 });
  const fetcher = makeFetcher(site, clock);
  const r = await stageList({ ...deps, fetcher });
  assert.equal(r.ok, false);
  assert.equal(await kv.get('index'), idxBefore);
  assert.equal(site.calls.length, 3, 'stopped at the failing page');
});

test('429/5xx on a detail page stops the stage and keeps the queue', async () => {
  const clock = fakeClock();
  const site = fakeSite({ clock, status: { 8128860: 429 } });
  const kv = new FakeKV();
  const fetcher = makeFetcher(site, clock);
  const deps = { kv, now: clock.now, fetcher, env: {} };
  await stageList(deps);
  await kv.put('queue', JSON.stringify(['8116122', '8128860', '8270075']));
  const r = await stageDetail(deps);
  assert.equal(r.ok, false);
  assert.deepEqual(await q(kv), ['8128860', '8270075']);
});

test('detail page that fails to parse -> status error, retried by next list crawl', async () => {
  const clock = fakeClock();
  const kv = new FakeKV();
  const site = fakeSite({ clock });
  const orig = site.fetchFn;
  site.fetchFn = async (u) => (/8270075$/.test(u) ? { ok: true, status: 200, text: async () => '<html>changed</html>' } : orig(u));
  const fetcher = makeFetcher(site, clock);
  const deps = { kv, now: clock.now, fetcher, env: {} };
  await stageList(deps);
  await kv.put('queue', JSON.stringify(['8270075']));
  await stageDetail(deps);
  assert.equal(JSON.parse(await kv.get('v:8270075')).status, 'error');
  await stageBuild(deps);
  assert.ok(!(await kv.get('feed') || '').includes('8270075'));
  await stageList(deps);
  assert.ok((await q(kv)).includes('8270075'));
});

test('build safety rule: <60% of previous feed keeps the old feed', async () => {
  const { kv, deps } = await fullRun();
  const old = await kv.get('feed');
  for (const k of [...kv.m.keys()].filter((k) => k.startsWith('v:')).slice(0, 40)) await kv.delete(k);
  const r = await stageBuild(deps);
  assert.equal(r.ok, false);
  assert.equal(await kv.get('feed'), old);
});

test('rate limit: never concurrent, >=20s apart, <=70 requests', async () => {
  const { fetcher, site, clock, kv } = await fullRun();
  const t = site.calls.map((c) => c.t);
  assert.ok(t.length > 6 && t.length <= 70 + 60, 'list crawl + details');
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 20000, `gap ${i}: ${t[i] - t[i - 1]}`);
  const log = JSON.parse(await kv.get('log'));
  assert.ok(log.length >= 1 && log[0].requests.length > 0);
});

test('PoliteFetcher serialises overlapping calls', async () => {
  const clock = fakeClock();
  let inFlight = 0, max = 0;
  const fetchFn = async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { ok: true, status: 200, text: async () => '' }; };
  const f = makeFetcher({ fetchFn }, clock);
  await Promise.all([f.get('a'), f.get('b'), f.get('c')]);
  assert.equal(max, 1);
});

test('HTTP routes', async () => {
  const kv = new FakeKV();
  await kv.put('feed', '<?xml version="1.0"?><rss><item></item></rss>');
  const env = { FEED_TOKEN: 'a'.repeat(32), BVS_FEED: kv };
  const ctx = { waitUntil() {} };
  const get = (p, m = 'GET') => worker.fetch(new Request('https://w.example' + p, { method: m }), env, ctx);
  const ok = await get(`/feed/${env.FEED_TOKEN}.xml`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'application/xml; charset=utf-8');
  assert.equal((await get('/feed/wrong.xml')).status, 404);
  assert.equal((await get('/')).status, 404);
  assert.equal((await get(`/feed/${env.FEED_TOKEN}`)).status, 404);
  const st = await (await get(`/status/${env.FEED_TOKEN}`)).json();
  assert.equal(st.itemsInFeed, 1);
  assert.equal((await get(`/run/${env.FEED_TOKEN}?stage=nope`)).status, 400, 'GET accepted');
  assert.equal((await get(`/run/${env.FEED_TOKEN}?stage=nope`, 'POST')).status, 400);
  await kv.delete('feed');
  const run = await (await get(`/run/${env.FEED_TOKEN}?stage=build&wait=1`, 'POST')).json();
  assert.equal(run.ok, true);
  assert.equal((await worker.fetch(new Request('https://w.example/'), { BVS_FEED: kv }, ctx)).status, 404, 'no token configured');
});

test('stage lock blocks overlapping stages', async () => {
  const kv = new FakeKV();
  const clock = fakeClock();
  await kv.put('lock', JSON.stringify({ until: clock.t + 60000, stage: 'x' }));
  const r = await runStage('build', { BVS_FEED: kv }, { now: clock.now });
  assert.match(r.skipped, /holds the lock \(x/);
});

test('backfill: loops detail fetches until the queue is empty, then builds', async () => {
  const clock = fakeClock();
  const kv = new FakeKV();
  const site = fakeSite({ clock });
  const deps = { kv, now: clock.now, fetcher: makeFetcher(site, clock), env: {} };
  await stageList(deps);
  const msgs = [];
  const r = await stageBackfill({ ...deps, onProgress: (m) => msgs.push(m), maxMs: 10 * 3600 * 1000 });
  assert.equal(r.queueLeft, 0);
  assert.equal(r.stopped, 'queue empty');
  assert.equal(r.build.items, 72);
  assert.equal((await kv.get('feed')).match(/<item>/g).length, 72);
  const t = site.calls.map((c) => c.t);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 20000);
  assert.match(msgs.at(-1), /^done: 72 items/);
});

test('backfill: stops at the time limit, keeps the queue, still builds', async () => {
  const clock = fakeClock();
  const kv = new FakeKV();
  const site = fakeSite({ clock });
  const deps = { kv, now: clock.now, fetcher: makeFetcher(site, clock), env: {} };
  await stageList(deps);
  const r = await stageBackfill({ ...deps, maxMs: 12 * 60 * 1000 });
  assert.equal(r.stopped, 'time limit');
  assert.ok(r.queueLeft > 0 && r.queueLeft < 72);
  assert.ok(r.attempted >= 30 && r.attempted <= 40, `attempted ${r.attempted}`);
  assert.ok(r.build.ok);
});

test('backfill over HTTP streams progress (GET)', async () => {
  const clock = fakeClock();
  const kv = new FakeKV();
  const site = fakeSite({ clock });
  const env = { FEED_TOKEN: 'b'.repeat(32), BVS_FEED: kv };
  let pending;
  const ctx = { waitUntil: (p) => { pending = p; } };
  // seed index/queue with the three real fixtures only
  await kv.put('index', JSON.stringify({ ids: ['8116122', '8128860', '8270075'].map((id) => ({ id, url: `https://www.braintreevansales.co.uk/x-braintree-essex-${id}`, listPrice: 1 })) }));
  await kv.put('queue', JSON.stringify(['8116122', '8128860', '8270075']));
  const orig = globalThis.fetch;
  globalThis.fetch = site.fetchFn;
  try {
    const res = await worker.fetch(new Request(`https://w.example/run/${env.FEED_TOKEN}?stage=backfill`), env, ctx);
    const text = await res.text();
    await pending;
    assert.match(text, /backfill started/);
    assert.match(text, /done: 3 items/);
  } finally { globalThis.fetch = orig; }
});

test('PoliteFetcher never calls fetch with itself as `this` (Workers: "Illegal invocation")', async () => {
  const clock = fakeClock();
  let thisSeen = 'unset';
  const fetchFn = function () { thisSeen = this; return Promise.resolve({ ok: true, status: 200, text: async () => '' }); };
  const f = makeFetcher({ fetchFn }, clock);
  await f.get('https://x.example/');
  assert.ok(thisSeen === undefined || thisSeen === globalThis, 'fetch was called as a method of another object');
  // default (global fetch) path is also a plain call
  const orig = globalThis.fetch;
  let seen = 'unset';
  globalThis.fetch = function () { seen = this; return Promise.resolve({ ok: true, status: 200, text: async () => '' }); };
  try { await new (f.constructor)({ now: clock.now, sleep: clock.sleep }).get('https://x.example/'); } finally { globalThis.fetch = orig; }
  assert.ok(seen === undefined || seen === globalThis);
});

test('a throwing fetch records name and message in lastRun.reason and alerts', async () => {
  const clock = fakeClock();
  const kv = new FakeKV();
  const fetchFn = async () => { const e = new TypeError('Illegal invocation'); e.cause = new Error('socket closed'); throw e; };
  const r = await stageList({ kv, now: clock.now, fetcher: makeFetcher({ fetchFn }, clock), env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /page 1: fetch threw TypeError: Illegal invocation \(cause: Error: socket closed\)/);
  assert.match(r.alerts[0], /fetch threw TypeError: Illegal invocation/);
  const last = JSON.parse(await kv.get('lastRun'));
  assert.match(last.list.reason, /TypeError: Illegal invocation/);
  const log = JSON.parse(await kv.get('log'));
  assert.match(log[0].requests[0].error, /^TypeError: Illegal invocation/);
});

test('/debug returns status, final URL, headers, first 2000 chars; or the full error', async () => {
  const env = { FEED_TOKEN: 'c'.repeat(32), BVS_FEED: new FakeKV() };
  const ctx = { waitUntil() {} };
  const orig = globalThis.fetch;
  let init;
  globalThis.fetch = async (u, i) => { init = i; const r = new Response('x'.repeat(5000), { status: 200, headers: { 'x-a': 'b' } }); Object.defineProperty(r, 'url', { value: u + 'final' }); return r; };
  try {
    const call = (q, tok = env.FEED_TOKEN) => worker.fetch(new Request(`https://w.example/debug/${tok}?${q}`), env, ctx);
    const ok = await (await call('url=' + encodeURIComponent('https://www.braintreevansales.co.uk/used-vans'))).json();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.length, 2000);
    assert.equal(ok.bodyLength, 5000);
    assert.equal(ok.headers['x-a'], 'b');
    assert.equal(ok.finalUrl, 'https://www.braintreevansales.co.uk/used-vansfinal');
    assert.match(init.headers['User-Agent'], /BVS-Feed/);
    assert.equal(init.redirect, 'follow');
    await call('url=' + encodeURIComponent('https://x.example/') + '&redirect=manual&ua=none');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['User-Agent'], undefined);
    assert.equal((await call('url=ftp://x')).status, 400);
    assert.equal((await call('url=https://x', 'wrong')).status, 404);
    globalThis.fetch = async () => { throw new TypeError('boom', { cause: new Error('dns') }); };
    const bad = await (await call('url=https://x.example/')).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.error.name, 'TypeError');
    assert.match(bad.error.summary, /TypeError: boom \(cause: dns|Error: dns\)/);
  } finally { globalThis.fetch = orig; }
});

test('skipped runs are recorded; /status shows lock state; force clears a stale lock', async () => {
  const kv = new FakeKV();
  const env = { FEED_TOKEN: 'd'.repeat(32), BVS_FEED: kv };
  const ctx = { waitUntil() {} };
  await kv.put('lock', JSON.stringify({ stage: 'list', startedAt: '2026-10-02T00:05:00.000Z', until: Date.now() + 120000 }));
  const call = (p, m = 'GET') => worker.fetch(new Request('https://w.example' + p, { method: m }), env, ctx);
  let st = await (await call(`/status/${env.FEED_TOKEN}`)).json();
  assert.equal(st.lock.stage, 'list');
  assert.ok(st.lock.secondsLeft > 100);
  const skipped = await (await call(`/run/${env.FEED_TOKEN}?stage=build`, 'POST')).json();
  assert.match(skipped.skipped, /holds the lock \(list/);
  st = await (await call(`/status/${env.FEED_TOKEN}`)).json();
  assert.match(st.lastRun.build.skipped, /holds the lock/);
  assert.ok(st.lastRun.build.skippedAt);
  const forced = await (await call(`/run/${env.FEED_TOKEN}?stage=build&force=1`, 'POST')).json();
  assert.equal(forced.ok, true);
  st = await (await call(`/status/${env.FEED_TOKEN}`)).json();
  assert.equal(st.lock, null);
  // expired lock is ignored
  await kv.put('lock', JSON.stringify({ stage: 'list', until: Date.now() - 1000 }));
  assert.equal((await (await call(`/status/${env.FEED_TOKEN}`)).json()).lock, null);
});

test('a lock left by a killed run is released by the TTL; a normal run always releases it', async () => {
  const kv = new FakeKV();
  const clock = fakeClock();
  await runStage('build', { BVS_FEED: kv }, { now: clock.now });
  assert.equal(await kv.get('lock'), null);
  await assert.rejects(runStage('build', { BVS_FEED: { ...kv, get: kv.get.bind(kv), put: kv.put.bind(kv), delete: kv.delete.bind(kv), list: async () => { throw new Error('kv down'); } } }, { now: clock.now }));
  assert.equal(await kv.get('lock'), null, 'finally block ran');
});

test('Cloudflare challenge is detected and stops the detail stage; list reports it', async () => {
  const clock = fakeClock();
  const kv = new FakeKV();
  const blocked = async () => ({ ok: false, status: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }), text: async () => 'Just a moment...' });
  const r = await stageList({ kv, now: clock.now, fetcher: makeFetcher({ fetchFn: blocked }, clock), env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /blocked by Cloudflare \(HTTP 403, cf-mitigated: challenge\)/);
  const interstitial = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '<html><head><title>Just a moment...</title>' });
  const f = makeFetcher({ fetchFn: interstitial }, clock);
  assert.equal((await f.get('https://x/')).ok, false);
});

test('build summary and /status carry the quality counts', async () => {
  const { kv, build } = await fullRun();
  assert.equal(typeof build.noVehicleOption, 'number');
  assert.equal(typeof build.fewerThan3Images, 'number');
  assert.equal(build.noVehicleOptionIds.length <= 20, true);
  const rec = JSON.parse(await kv.get('v:8270075'));
  rec.features = []; rec.images = rec.images.slice(0, 2);
  await kv.put('v:8270075', JSON.stringify(rec));
  const env = { FEED_TOKEN: 'e'.repeat(32), BVS_FEED: kv };
  const st = await (await worker.fetch(new Request(`https://w.example/status/${env.FEED_TOKEN}`), env, { waitUntil() {} })).json();
  assert.equal(st.quality.noVehicleOption >= 1, true);
  assert.ok(st.quality.noVehicleOptionIds.includes('8270075'));
  assert.ok(st.quality.fewerThan3ImagesIds.includes('8270075'));
  assert.equal(st.lastRun.build.noVehicleOption, build.noVehicleOption);
});
