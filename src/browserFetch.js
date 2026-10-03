// Fetch pages through the PC's installed Google Chrome (driven by playwright-core), because the site's
// Cloudflare Bot Management blocks plain HTTP clients. Returns a fetch-shaped function for PoliteFetcher.
import { chromium } from 'playwright-core';

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;
const GOTO_TIMEOUT_MS = 45_000;
export const CHALLENGE_WAIT_MS = 30_000;
const SITE_HOST = /(^|\.)braintreevansales\.co\.uk$/i;
// Not needed for the HTML and not ours to load 70 times a night.
const SKIP_HOSTS = /(google-analytics|googletagmanager|doubleclick|googleadservices|facebook\.(com|net)|hotjar|clarity\.ms|youtube\.com)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chromeArgs({ show }) {
  return show
    ? ['--window-size=1280,900']
    : ['--window-position=-2400,-2400', '--window-size=1280,900', '--start-minimized'];
}

/**
 * @param {object} o
 * @param {string} o.profileDir  persistent Chrome profile (keeps the Cloudflare clearance cookie between runs)
 * @param {boolean} [o.show]     true = normal visible window (first run / if a manual "verify" box appears)
 * @param {string} [o.executablePath] override Chrome location (default: installed Chrome via channel "chrome")
 * @param {boolean} [o.headless] only for tests / CI
 */
export async function createBrowserFetch({ profileDir, show = false, executablePath, headless = false, log = () => {}, extraArgs = [], challengeWaitMs = CHALLENGE_WAIT_MS }) {
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
      headless,
      viewport: null,
      args: [...chromeArgs({ show }), ...extraArgs],
    });
  } catch (e) {
    if (/not found|executable doesn't exist|distribution 'chrome'/i.test(e.message)) {
      throw new Error(`Google Chrome was not found. Install it from https://www.google.com/chrome and try again.\n(${e.message.split('\n')[0]})`);
    }
    if (/user data directory is already in use|ProcessSingleton|profile.*in use/i.test(e.message)) {
      throw new Error('The crawl Chrome window is already open (another crawl running?). Close it, wait a minute and try again.');
    }
    throw e;
  }

  await context.route('**/*', (route) => {
    const req = route.request();
    if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
    let host = '';
    try { host = new URL(req.url()).hostname; } catch { /* ignore */ }
    if (host && !SITE_HOST.test(host) && SKIP_HOSTS.test(host)) return route.abort();
    return route.continue();
  });

  const page = context.pages()[0] || (await context.newPage());
  let lastDoc = null;
  page.on('response', (r) => {
    try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastDoc = r; } catch { /* frame gone */ }
  });

  // Still on a challenge/block page? Judged by the page title AND the latest document response, because the
  // title can be briefly empty while a reload is committing.
  const onChallenge = async () => {
    const title = await page.title().catch(() => 'Just a moment...'); // mid-navigation: assume still challenged
    if (CHALLENGE_TITLE.test(title)) return true;
    const d = lastDoc;
    try { return Boolean(d && (d.status() === 403 || d.headers()['cf-mitigated'])); } catch { return false; }
  };

  async function fetchFn(url) {
    lastDoc = null;
    let first;
    try {
      first = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    } catch (e) {
      throw new Error(`page.goto failed: ${e.message.split('\n')[0]}`);
    }
    let cleared = null;
    const mitigated0 = first?.headers()['cf-mitigated'];
    if (mitigated0 || first?.status() === 403 || (await onChallenge())) {
      const t0 = Date.now();
      cleared = false;
      while (Date.now() - t0 < challengeWaitMs) {
        await sleep(500);
        if (!(await onChallenge())) { cleared = true; break; }
      }
      log(`  Cloudflare challenge ${cleared ? 'cleared' : 'NOT cleared'} after ${Math.round((Date.now() - t0) / 1000)}s`);
      if (cleared) await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    const resp = lastDoc || first;
    const headers = { ...(resp?.headers() || {}) };
    let status = resp?.status() ?? 0;
    if (cleared === false) { status = 403; headers['cf-mitigated'] = headers['cf-mitigated'] || 'challenge'; }

    // Prefer the exact HTML the server sent (what the parsers were written against); fall back to the live DOM.
    // After a cleared challenge the page may still be settling, so let it finish and retry a few times.
    let html = '';
    let source = 'content';
    if (cleared !== false) {
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      for (let attempt = 0; attempt < 5 && !html; attempt++) {
        if (attempt) { await sleep(1000); await page.waitForLoadState('domcontentloaded').catch(() => {}); }
        if (status >= 200 && status < 300 && process.env.HTML_SOURCE !== 'content' && resp) {
          try { html = await resp.text(); source = 'response'; } catch { html = ''; }
        }
        if (!html) {
          try { html = await page.content(); source = 'content'; } catch { html = ''; }
        }
      }
      if (!html) throw new Error('could not read the page after it loaded');
    }
    return {
      ok: status >= 200 && status < 300, status, url: page.url(), source,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
      text: async () => html,
    };
  }

  return { fetchFn, page, context, close: () => context.close().catch(() => {}) };
}
