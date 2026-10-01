import { PoliteFetcher, stageList, stageBackfill, describeError } from './crawl.js';

/**
 * Nightly crawl for GitHub Actions: list -> detail (capped) -> build.
 * Returns { ok, results }. ok is false if the list crawl, the detail stage or the build raised an alert
 * (blocked, failed page, safety rule), so the workflow run turns red.
 */
export async function runCrawl({ kv, env = {}, fetchFn, sleep, now = Date.now, log = console.log, maxDetail = 64, maxMs = 90 * 60 * 1000, alertFetch }) {
  const fetcher = new PoliteFetcher({ fetchFn, sleep, now });
  const logged = fetcher.fetchFn;
  fetcher.fetchFn = async (url, init) => {
    const t0 = now();
    try {
      const res = await logged(url, init);
      log(`GET ${url} -> ${res.status}${res.headers?.get?.('cf-mitigated') ? ' (cf-mitigated: ' + res.headers.get('cf-mitigated') + ')' : ''} in ${now() - t0} ms`);
      return res;
    } catch (e) {
      log(`GET ${url} -> threw ${describeError(e)}`);
      throw e;
    }
  };
  const deps = { kv, env, now, fetcher, alertFetch, onProgress: log, maxDetail, maxMs };
  const results = {};

  results.list = await stageList(deps);
  log(`list: ${JSON.stringify(results.list)}`);
  if (!results.list.ok) return { ok: false, results };

  results.backfill = await stageBackfill(deps);
  log(`detail+build: ${JSON.stringify(results.backfill)}`);
  return { ok: results.backfill.ok, results };
}
