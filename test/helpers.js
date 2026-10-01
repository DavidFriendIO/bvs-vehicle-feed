import fs from 'node:fs';
import { PoliteFetcher } from '../src/crawl.js';

export const raw = (name) => fs.readFileSync(new URL(`../fixtures/raw/${name}.html`, import.meta.url), 'utf8');

export class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

export function fakeClock(start = Date.parse('2026-10-02T00:05:00Z')) {
  const c = { t: start, now: () => c.t, sleep: async (ms) => { c.t += ms; } };
  return c;
}

const VEHICLES = ['7027496', '8092937', '8116122', '8128860', '8270075'];

/**
 * Fake braintreevansales.co.uk. Page 1 is the real fixture; pages 2-6 are page 1 with every
 * stock ID shifted so they are distinct. Detail pages: the five fixtures, or the Vito page
 * re-labelled for any other ID. `ids` can override the stock list.
 */
export function fakeSite({ clock, pages = 6, failList = null, status = {} } = {}) {
  const page1 = raw('list-page-1');
  const ids1 = [...new Set([...page1.matchAll(/braintree-essex-(\d+)/g)].map((m) => m[1]))];
  const shift = (html, p) => html.replace(/\d{7}/g, (d) => (ids1.includes(d) ? String(Number(d) + p * 1000) : d));
  const calls = [];
  const fetchFn = async (url) => {
    calls.push({ url, t: clock.now() });
    const u = new URL(url);
    let body = null;
    let st = 200;
    if (u.pathname === '/used-vans') body = page1.replace(/href="\/used-vans\/\d+"/g, (m) => m).replace(/(href="\/used-vans\/)6"/, '$16"');
    else if (u.pathname === '/search_page.php') {
      const p = Number(u.searchParams.get('p'));
      if (failList === p) st = 503;
      else body = shift(page1, p);
    } else {
      const id = /(\d+)$/.exec(u.pathname)?.[1];
      st = status[id] ?? 200;
      body = VEHICLES.includes(id) ? raw(id) : raw('8270075').replaceAll('8270075', id);
    }
    return { ok: st >= 200 && st < 300, status: st, text: async () => body };
  };
  return { fetchFn, calls, ids1, shift, page1 };
}

export function makeFetcher(site, clock) {
  return new PoliteFetcher({ fetchFn: site.fetchFn, now: clock.now, sleep: clock.sleep });
}
