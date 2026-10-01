import { PoliteFetcher, fetchInit, describeError, stageList, stageDetail, stageBuild, stageBackfill, BACKFILL_MS, withLock, listAll } from './crawl.js';

const CRON_STAGE = {
  '5 0 * * *': 'list',
  '*/10 1-3 * * *': 'detail',
  '30 4 * * *': 'build',
};
const STAGES = { list: stageList, detail: stageDetail, build: stageBuild, backfill: stageBackfill };

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function runStage(stage, env, deps = {}) {
  const kv = env.BVS_FEED;
  const now = deps.now || Date.now;
  return withLock(kv, now, () => {
    const fetcher = deps.fetcher || new PoliteFetcher({ now, sleep: deps.sleep });
    return STAGES[stage]({ kv, env, now, fetcher, alertFetch: deps.alertFetch, onProgress: deps.onProgress, maxMs: deps.maxMs });
  }, stage === 'backfill' ? BACKFILL_MS + 3 * 60 * 1000 : undefined);
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const notFound = () => new Response('Not found', { status: 404 });

/** One fetch with the crawler's exact headers; returns everything useful for diagnosis. */
export async function debugFetch(target, { redirect = 'follow', ua = 'bvs', fetchFn } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const init = fetchInit();
  init.redirect = redirect;
  if (ua === 'none') delete init.headers['User-Agent'];
  const started = Date.now();
  try {
    const res = await doFetch(target, init);
    const text = await res.text();
    return {
      ok: res.ok, requested: target, redirectMode: redirect, sentHeaders: init.headers,
      status: res.status, statusText: res.statusText, finalUrl: res.url, redirected: res.redirected,
      headers: Object.fromEntries(res.headers.entries()), bodyLength: text.length, body: text.slice(0, 2000),
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false, requested: target, redirectMode: redirect, sentHeaders: init.headers, ms: Date.now() - started,
      error: { summary: describeError(e), name: e?.name, message: e?.message, cause: e?.cause ? String(e.cause?.message ?? e.cause) : undefined, stack: e?.stack },
    };
  }
}

async function status(kv) {
  const get = async (k, d) => { const r = await kv.get(k); try { return r ? JSON.parse(r) : d; } catch { return d; } };
  const records = [];
  for (const k of await listAll(kv, 'v:')) { const r = await get(k, null); if (r) records.push(r); }
  const feed = await kv.get('feed');
  const queue = await get('queue', []);
  const index = await get('index', null);
  const log = await get('log', []);
  return {
    lastRun: await get('lastRun', {}),
    indexCrawledAt: index?.crawledAt ?? null,
    idsInIndex: index?.ids?.length ?? 0,
    itemsInFeed: feed ? (feed.match(/<item>/g) || []).length : 0,
    queueLength: queue.length,
    excluded: records.filter((r) => r.status === 'excluded').map((r) => ({ id: r.id, reason: r.reason })),
    errors: records.filter((r) => r.status === 'error').map((r) => ({ id: r.id, reason: r.reason })),
    recentAlerts: log.flatMap((e) => e.alerts || []).slice(-10),
    nights: log.length,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = env.FEED_TOKEN;
    if (!token) return notFound();
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'feed' && parts[1].endsWith('.xml')) {
      if (!safeEqual(parts[1].slice(0, -4), token)) return notFound();
      const xml = await env.BVS_FEED.get('feed');
      if (!xml) return new Response('Feed not built yet', { status: 503 });
      return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    }
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'status' && safeEqual(parts[1], token)) {
      return json(await status(env.BVS_FEED));
    }
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'debug' && safeEqual(parts[1], token)) {
      const target = url.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) return json({ error: 'give ?url=<encoded http(s) url>; optional &redirect=manual|follow, &ua=none' }, 400);
      return json(await debugFetch(target, { redirect: url.searchParams.get('redirect') === 'manual' ? 'manual' : 'follow', ua: url.searchParams.get('ua') || 'bvs' }));
    }
    if ((request.method === 'GET' || request.method === 'POST') && parts.length === 2 && parts[0] === 'run' && safeEqual(parts[1], token)) {
      const stage = url.searchParams.get('stage');
      if (!STAGES[stage]) return json({ error: 'stage must be list, detail, build or backfill' }, 400);
      if (stage === 'backfill') {
        // Stream progress: keep the tab open until it says "done". Closing it stops the run
        // (the queue is kept, so just open the URL again to carry on).
        const { readable, writable } = new TransformStream();
        const w = writable.getWriter();
        const enc = new TextEncoder();
        const say = (m) => w.write(enc.encode(`${new Date().toISOString().slice(11, 19)} ${m}\n`)).catch(() => {});
        say('backfill started; keep this tab open (about 12 minutes max)');
        ctx.waitUntil(
          runStage('backfill', env, { onProgress: say })
            .then((r) => say(r.skipped ? `skipped: ${r.skipped}` : `result: ${JSON.stringify(r)}`))
            .catch((e) => say(`failed: ${e.message}`))
            .finally(() => w.close().catch(() => {})),
        );
        return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      const job = runStage(stage, env);
      if (url.searchParams.get('wait') === '1') return json(await job);
      ctx.waitUntil(job.catch((e) => console.error('manual run failed', e)));
      return json({ started: stage, note: 'Running in the background; check /status/{token}' }, 202);
    }
    return notFound();
  },

  async scheduled(event, env, ctx) {
    const stage = CRON_STAGE[event.cron];
    if (!stage) { console.error('unknown cron', event.cron); return; }
    ctx.waitUntil(
      runStage(stage, env).then(
        (r) => console.log(JSON.stringify({ stage, ...r })),
        (e) => console.error(`stage ${stage} failed`, e),
      ),
    );
  },
};
