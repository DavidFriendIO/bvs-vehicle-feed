import {
  USER_AGENT, REQUEST_GAP_MS, DETAIL_BATCH, STALE_MS, SAFETY_RATIO, listUrl, DEFAULT_LIST_PAGES, ALERT_TO,
} from './config.js';
import { parseListPage, parseTotalPages, parseVehiclePage } from './parse.js';
import { buildFeed } from './feed.js';

const jget = async (kv, key, fallback = null) => {
  const raw = await kv.get(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};
const jput = (kv, key, value) => kv.put(key, JSON.stringify(value));

export class StageAbort extends Error {}

/**
 * Polite fetcher: strictly one request at a time, >= gapMs between the end of one
 * request and the start of the next, every request recorded in `requests`.
 */
export class PoliteFetcher {
  constructor({ fetchFn = fetch, sleep, now = Date.now, gapMs = REQUEST_GAP_MS, requests = [] } = {}) {
    this.fetchFn = fetchFn;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now;
    this.gapMs = gapMs;
    this.requests = requests;
    this.lastEnd = null;
    this.chain = Promise.resolve();
  }

  get(url) {
    const run = async () => {
      if (this.lastEnd != null) {
        const wait = this.gapMs - (this.now() - this.lastEnd);
        if (wait > 0) await this.sleep(wait);
      }
      const entry = { t: new Date(this.now()).toISOString(), url };
      this.requests.push(entry);
      try {
        const res = await this.fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' });
        entry.status = res.status;
        const text = res.ok ? await res.text() : '';
        return { status: res.status, ok: res.ok, text };
      } catch (e) {
        entry.status = 0;
        entry.error = String(e.message || e);
        return { status: 0, ok: false, text: '' };
      } finally {
        this.lastEnd = this.now();
        entry.endedAt = new Date(this.lastEnd).toISOString();
      }
    };
    const p = this.chain.then(run, run); // serialised: one in flight at a time
    this.chain = p.catch(() => {});
    return p;
  }
}

const throttled = (r) => r.status === 429 || r.status >= 500 || r.status === 0;

// ------------------------------------------------------------------ logging

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

/** Merge a stage summary into tonight's entry in `log` (last 14 nights kept). */
export async function recordRun(kv, now, stage, summary, requests = [], alerts = []) {
  const log = await jget(kv, 'log', []);
  const day = dayKey(now);
  let entry = log.find((e) => e.date === day);
  if (!entry) { entry = { date: day, stages: {}, requests: [], alerts: [] }; log.push(entry); }
  const at = new Date(now).toISOString();
  entry.stages[stage] = { ...(entry.stages[stage] || {}), ...summary, at };
  entry.requests = [...entry.requests, ...requests].slice(-120);
  entry.alerts = [...entry.alerts, ...alerts.map((message) => ({ at, stage, message }))].slice(-30);
  log.sort((a, b) => a.date.localeCompare(b.date));
  await jput(kv, 'log', log.slice(-14));
  const last = await jget(kv, 'lastRun', {});
  last[stage] = { at, ...summary };
  await jput(kv, 'lastRun', last);
}

export async function sendAlert(env, fetchFn, subject, body) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ALERT_FROM || 'BVS Feed <onboarding@resend.dev>', to: [ALERT_TO], subject, text: body }),
    });
    return res.ok;
  } catch { return false; }
}

// ------------------------------------------------------------ lock (KV, best effort)

const LOCK_MS = 10 * 60 * 1000;
export async function withLock(kv, now, fn) {
  const held = await jget(kv, 'lock', null);
  if (held && held.until > now()) return { skipped: `another stage is running (${held.stage})` };
  await kv.put('lock', JSON.stringify({ until: now() + LOCK_MS, stage: 'running' }), { expirationTtl: 600 });
  try { return await fn(); } finally { await kv.delete('lock'); }
}

// ------------------------------------------------------------------ stage 1

export async function stageList(deps) {
  const { kv, now = Date.now } = deps;
  const fetcher = deps.fetcher;
  const alerts = [];
  const finish = async (summary) => {
    await recordRun(kv, now(), 'list', summary, fetcher.requests.splice(0), alerts);
    if (alerts.length) await sendAlert(deps.env || {}, deps.alertFetch || fetch, 'BVS feed: list crawl alert', alerts.join('\n'));
    return { alerts, ...summary };
  };

  const prev = await jget(kv, 'index', null);
  const found = new Map();
  let pages = DEFAULT_LIST_PAGES;
  for (let n = 1; n <= pages; n++) {
    const r = await fetcher.get(listUrl(n));
    if (!r.ok) {
      alerts.push(`List page ${n} failed (HTTP ${r.status}). Index and feed left unchanged.`);
      return finish({ ok: false, pagesFetched: n - 1, reason: `page ${n} HTTP ${r.status}` });
    }
    if (n === 1) pages = parseTotalPages(r.text);
    const cards = parseListPage(r.text);
    if (!cards.length) {
      alerts.push(`List page ${n} returned no vehicle cards (template change?). Index and feed left unchanged.`);
      return finish({ ok: false, pagesFetched: n, reason: `page ${n} parsed 0 cards` });
    }
    for (const c of cards) if (!found.has(c.id)) found.set(c.id, c);
  }

  const prevIds = prev?.ids || [];
  if (prevIds.length && found.size < SAFETY_RATIO * prevIds.length) {
    alerts.push(`List crawl found only ${found.size} vehicles vs ${prevIds.length} in the previous index (<60%). Nothing deleted.`);
    return finish({ ok: false, found: found.size, previous: prevIds.length, reason: 'safety rule: <60% of previous index' });
  }

  const prevById = new Map(prevIds.map((e) => [e.id, e]));
  const queue = new Set(await jget(kv, 'queue', []));
  const counts = { new: 0, priceChanged: 0, stale: 0, retry: 0, removed: 0 };

  for (const [id, c] of found) {
    const old = prevById.get(id);
    const rec = await jget(kv, `v:${id}`, null);
    let why = null;
    if (!old) why = 'new';
    else if (old.listPrice !== c.listPrice) why = 'priceChanged';
    else if (!rec) why = 'retry';
    else if (rec.status === 'error') why = 'retry';
    else if (!rec.fetchedAt || now() - Date.parse(rec.fetchedAt) > STALE_MS) why = 'stale';
    if (why) { queue.add(id); counts[why]++; }
  }
  for (const id of prevById.keys()) {
    if (!found.has(id)) {
      await kv.delete(`v:${id}`);
      queue.delete(id);
      counts.removed++;
    }
  }
  for (const id of queue) if (!found.has(id)) queue.delete(id);

  await jput(kv, 'index', { crawledAt: new Date(now()).toISOString(), ids: [...found.values()] });
  await jput(kv, 'queue', [...queue]);
  return finish({ ok: true, found: found.size, queued: queue.size, ...counts });
}

// ------------------------------------------------------------------ stage 2

export async function stageDetail(deps) {
  const { kv, now = Date.now } = deps;
  const fetcher = deps.fetcher;
  const queue = await jget(kv, 'queue', []);
  const index = await jget(kv, 'index', { ids: [] });
  const urls = new Map(index.ids.map((e) => [e.id, e.url]));
  const batch = queue.slice(0, DETAIL_BATCH);
  const s = { ok: true, attempted: 0, okCount: 0, excluded: 0, error: 0, queueLeft: queue.length };

  for (const id of batch) {
    const url = urls.get(id);
    if (!url) { queue.splice(queue.indexOf(id), 1); continue; }
    const r = await fetcher.get(url);
    s.attempted++;
    if (throttled(r)) {
      s.ok = false;
      s.reason = `HTTP ${r.status} on ${id}; stopped, queue kept`;
      break;
    }
    let rec;
    if (!r.ok) {
      rec = { id, url, status: 'error', reason: `HTTP ${r.status}` };
    } else {
      const p = parseVehiclePage(r.text, id);
      rec = p.status === 'error' ? { id, url, status: 'error', reason: p.reason } : { ...p.data, url, status: p.status, ...(p.reason ? { reason: p.reason } : {}) };
    }
    rec.fetchedAt = new Date(now()).toISOString();
    await jput(kv, `v:${id}`, rec);
    queue.splice(queue.indexOf(id), 1);
    await jput(kv, 'queue', queue);
    if (rec.status === 'ok') s.okCount++; else if (rec.status === 'excluded') s.excluded++; else s.error++;
  }
  s.queueLeft = queue.length;
  const alerts = !s.ok ? [`Detail fetch stopped: ${s.reason}`] : [];
  await recordRun(kv, now(), 'detail', accumulate(await currentDetail(kv, now), s), fetcher.requests.splice(0), alerts);
  if (alerts.length) await sendAlert(deps.env || {}, deps.alertFetch || fetch, 'BVS feed: detail fetch alert', alerts.join('\n'));
  return { alerts, ...s };
}

async function currentDetail(kv, now) {
  const log = await jget(kv, 'log', []);
  return log.find((e) => e.date === dayKey(now()))?.stages?.detail || {};
}
const accumulate = (prev, s) => ({
  ok: s.ok, reason: s.reason, queueLeft: s.queueLeft, runs: (prev.runs || 0) + 1,
  attempted: (prev.attempted || 0) + s.attempted, okCount: (prev.okCount || 0) + s.okCount,
  excluded: (prev.excluded || 0) + s.excluded, error: (prev.error || 0) + s.error,
});

// ------------------------------------------------------------------ stage 3

export async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export async function stageBuild(deps) {
  const { kv, now = Date.now } = deps;
  const records = [];
  for (const k of await listAll(kv, 'v:')) {
    const r = await jget(kv, k, null);
    if (r) records.push(r);
  }
  const ok = records.filter((r) => r.status === 'ok');
  const prevFeed = await kv.get('feed');
  const prevCount = prevFeed ? (prevFeed.match(/<item>/g) || []).length : 0;
  const alerts = [];
  let summary;
  if (prevCount && ok.length < SAFETY_RATIO * prevCount) {
    alerts.push(`Build would produce ${ok.length} items vs ${prevCount} in the last feed (<60%). Old feed kept.`);
    summary = { ok: false, items: ok.length, previousItems: prevCount, reason: 'safety rule: <60% of previous feed' };
  } else {
    await kv.put('feed', buildFeed(ok));
    summary = { ok: true, items: ok.length, excluded: records.filter((r) => r.status === 'excluded').length, errors: records.filter((r) => r.status === 'error').length };
  }
  await recordRun(kv, now(), 'build', summary, [], alerts);
  if (alerts.length) await sendAlert(deps.env || {}, deps.alertFetch || fetch, 'BVS feed: build alert', alerts.join('\n'));
  return { alerts, ...summary };
}
