import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeKV, fakeClock, fakeSite } from './helpers.js';
import { CfKV } from '../src/cfkv.js';
import { runCrawl } from '../src/runner.js';

/** Minimal Cloudflare KV REST API. */
function fakeCfApi() {
  const store = new Map();
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname + u.search, auth: init.headers?.Authorization, ct: init.headers?.['Content-Type'] });
    const m = /\/namespaces\/ns1\/(values|keys)(?:\/(.*))?$/.exec(u.pathname);
    if (!m) return new Response('bad', { status: 400 });
    if (m[1] === 'keys') {
      const prefix = u.searchParams.get('prefix') || '';
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get('cursor') || 0);
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? String(start + 2) : '';
      return Response.json({ success: true, result: page.map((name) => ({ name })), result_info: { cursor: next } });
    }
    const key = decodeURIComponent(m[2]);
    if (init.method === 'GET') return store.has(key) ? new Response(store.get(key)) : Response.json({ success: false }, { status: 404 });
    if (init.method === 'PUT') { store.set(key, init.body); return Response.json({ success: true }); }
    if (init.method === 'DELETE') { store.delete(key); return Response.json({ success: true }); }
    return new Response('?', { status: 405 });
  };
  return { fetchFn, store, calls };
}

test('CfKV: get/put/delete/list against the REST API, cached writes, paged list', async () => {
  const api = fakeCfApi();
  const kv = new CfKV({ accountId: 'acc', apiToken: 'tok', namespaceId: 'ns1', fetchFn: (u, i) => api.fetchFn(u.replace('/accounts/acc/storage/kv', '/accounts/acc/storage/kv'), i) });
  assert.equal(await kv.get('missing'), null);
  await kv.put('v:1', '{"a":1}');
  await kv.put('v:2', 'two');
  await kv.put('v:3', 'three');
  await kv.put('feed', '<xml/>');
  assert.equal(await kv.get('v:1'), '{"a":1}');
  await kv.delete('v:2');
  assert.equal(await kv.get('v:2'), null);
  const names = [];
  let cursor;
  do { const p = await kv.list({ prefix: 'v:', cursor }); names.push(...p.keys.map((k) => k.name)); cursor = p.list_complete ? undefined : p.cursor; } while (cursor);
  assert.deepEqual(names.sort(), ['v:1', 'v:3']);
  assert.ok(api.calls.every((c) => c.auth === 'Bearer tok'));
  assert.ok(api.calls.some((c) => c.method === 'PUT' && c.ct === 'text/plain'));
  assert.throws(() => new CfKV({ accountId: 'a' }), /required/);
  await kv.put('lock', '1', { expirationTtl: 300 });
  assert.ok(api.calls.at(-1).path.includes('expiration_ttl=300'));
});

test('runCrawl: list -> capped detail -> build, state readable by the Worker afterwards', async () => {
  const clock = fakeClock();
  const site = fakeSite({ clock });
  const kv = new FakeKV();
  const lines = [];
  const r = await runCrawl({ kv, fetchFn: site.fetchFn, sleep: clock.sleep, now: clock.now, log: (m) => lines.push(m), maxDetail: 30, maxMs: 10 * 3600 * 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.results.backfill.stopped, 'request cap');
  assert.ok(r.results.backfill.attempted >= 30 && r.results.backfill.attempted <= 32);
  assert.ok((await kv.get('feed')).includes('<item>'));
  assert.ok(JSON.parse(await kv.get('queue')).length > 0, 'rest of the queue waits for tomorrow');
  assert.ok(JSON.parse(await kv.get('lastRun')).build.ok);
  const t = site.calls.map((c) => c.t);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 20000);
  assert.ok(lines.some((l) => /^GET https:\/\/www\.braintreevansales\.co\.uk\/used-vans -> 200/.test(l)));
});

test('runCrawl: blocked site -> not ok, nothing deleted, index untouched', async () => {
  const clock = fakeClock();
  const site = fakeSite({ clock });
  const kv = new FakeKV();
  await runCrawl({ kv, fetchFn: site.fetchFn, sleep: clock.sleep, now: clock.now, log() {}, maxDetail: 100, maxMs: 10 * 3600 * 1000 });
  const idx = await kv.get('index');
  const feed = await kv.get('feed');
  const blocked = async () => ({ ok: false, status: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }), text: async () => 'Just a moment...' });
  const r = await runCrawl({ kv, fetchFn: blocked, sleep: clock.sleep, now: clock.now, log() {} });
  assert.equal(r.ok, false);
  assert.match(r.results.list.reason, /blocked by Cloudflare/);
  assert.equal(await kv.get('index'), idx);
  assert.equal(await kv.get('feed'), feed);
});

test('runCrawl: detail pages blocked mid-run -> not ok, queue kept', async () => {
  const clock = fakeClock();
  const site = fakeSite({ clock });
  const kv = new FakeKV();
  const orig = site.fetchFn;
  const fetchFn = async (u, i) => (/braintree-essex-\d+$/.test(u) ? { ok: false, status: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }), text: async () => '' } : orig(u, i));
  const r = await runCrawl({ kv, fetchFn, sleep: clock.sleep, now: clock.now, log() {}, maxDetail: 50 });
  assert.equal(r.ok, false);
  assert.match(r.results.backfill.stopped, /blocked by Cloudflare/);
  assert.equal(JSON.parse(await kv.get('queue')).length, 72);
});
