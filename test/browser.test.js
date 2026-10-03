// Drives a real Chromium against a local fake "Cloudflare" site. Skipped if no Chrome/Chromium is found.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { raw } from './helpers.js';
import { createBrowserFetch } from '../src/browserFetch.js';
import { parseListPage, parseVehiclePage } from '../src/parse.js';

const CANDIDATES = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const exe = CANDIDATES.find((p) => fs.existsSync(p));
const skip = exe ? false : 'no Chrome/Chromium available';

function server() {
  const srv = http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    const send = (code, body, h = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...h }); res.end(body); };
    if (req.url === '/used-vans') return send(200, raw('list-page-1'));
    if (req.url === '/vehicle') return send(200, raw('8270075'));
    if (req.url === '/challenge') {
      if (/cf_ok=1/.test(cookie)) return send(200, raw('8270075'));
      return send(403, '<html><head><title>Just a moment...</title></head><body><script>setTimeout(function(){document.cookie="cf_ok=1; path=/";location.reload();},1500)</script></body></html>', { 'cf-mitigated': 'challenge' });
    }
    if (req.url === '/blocked') return send(403, '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>');
    send(404, 'no');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function withBrowser(opts, fn) {
  const { srv, base } = await server();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const bf = await createBrowserFetch({ profileDir, executablePath: exe, headless: true, extraArgs: ['--no-sandbox'], ...opts });
  try { return await fn(bf, base); } finally { await bf.close(); srv.close(); }
}

test('browser: loads pages and the existing parsers work on the response HTML', { skip }, async () => {
  await withBrowser({}, async (bf, base) => {
    const list = await bf.fetchFn(`${base}/used-vans`);
    assert.equal(list.status, 200);
    assert.equal(list.source, 'response');
    assert.equal(parseListPage(await list.text()).length, 12);
    const veh = await bf.fetchFn(`${base}/vehicle`);
    const p = parseVehiclePage(await veh.text(), '8270075');
    assert.equal(p.status, 'ok');
    assert.equal(p.data.price, 27650);
    assert.equal(p.data.images.length, 10);
  });
});

test('browser: page.content() (live DOM) also parses to the same data', { skip }, async () => {
  const prev = process.env.HTML_SOURCE;
  process.env.HTML_SOURCE = 'content';
  try {
    await withBrowser({}, async (bf, base) => {
      const veh = await bf.fetchFn(`${base}/vehicle`);
      assert.equal(veh.source, 'content');
      const a = parseVehiclePage(await veh.text(), '8270075');
      const b = parseVehiclePage(raw('8270075'), '8270075');
      assert.equal(a.status, 'ok');
      assert.deepEqual(a.data, b.data);
      const list = await bf.fetchFn(`${base}/used-vans`);
      assert.deepEqual(parseListPage(await list.text()), parseListPage(raw('list-page-1')));
    });
  } finally { if (prev === undefined) delete process.env.HTML_SOURCE; else process.env.HTML_SOURCE = prev; }
});

test('browser: waits for a challenge to clear, then returns the real page', { skip }, async () => {
  const lines = [];
  await withBrowser({ log: (m) => lines.push(m) }, async (bf, base) => {
    const r = await bf.fetchFn(`${base}/challenge`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cf-mitigated'), null);
    assert.equal(parseVehiclePage(await r.text(), '8270075').status, 'ok');
    assert.ok(lines.some((l) => /challenge cleared/.test(l)), lines.join('|'));
  });
});

test('browser: a challenge that never clears is reported as blocked (403 + cf-mitigated)', { skip }, async () => {
  await withBrowser({ challengeWaitMs: 2500 }, async (bf, base) => {
    const r = await bf.fetchFn(`${base}/blocked`);
    assert.equal(r.status, 403);
    assert.equal(r.ok, false);
    assert.equal(r.headers.get('cf-mitigated'), 'challenge');
  });
});
