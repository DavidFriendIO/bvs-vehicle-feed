// Does Chrome get through? Loads /used-vans and one vehicle page and reports whether the data was found.
//   node scripts/probe.js        (or: run-crawl.bat probe)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_URL_1, REQUEST_GAP_MS } from '../src/config.js';
import { createBrowserFetch } from '../src/browserFetch.js';
import { parseListPage, parseTotalPages, parseVehiclePage } from '../src/parse.js';
import { loadEnvFile } from '../src/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(root, '.env'));
const env = process.env;
const say = (m) => console.log(m);

const bf = await createBrowserFetch({
  profileDir: env.CHROME_PROFILE_DIR || path.join(root, 'chrome-profile'),
  executablePath: env.CHROME_PATH || undefined,
  show: env.SHOW_BROWSER !== '0', // the probe shows Chrome by default so you can see what is happening
  headless: env.HEADLESS === '1',
  log: say,
});

let listOk = false, vehicleOk = false;
try {
  say(`\n=== 1. ${LIST_URL_1}`);
  const r1 = await bf.fetchFn(LIST_URL_1);
  const html1 = await r1.text();
  const cards = r1.ok ? parseListPage(html1) : [];
  say(`status: ${r1.status} | HTML from: ${r1.source} | cf-mitigated: ${r1.headers.get('cf-mitigated') || '-'} | ${html1.length} characters`);
  say(`first 300 characters: ${JSON.stringify(html1.slice(0, 300))}`);
  say(`vehicle cards found: ${cards.length}${cards.length ? ` (pages: ${parseTotalPages(html1)})` : ''}`);
  listOk = r1.ok && cards.length > 0;

  say(`\nwaiting ${REQUEST_GAP_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));

  const target = cards[0]?.url || 'https://www.braintreevansales.co.uk/used-mercedes-benz-vito-braintree-essex-8270075';
  say(`\n=== 2. ${target}`);
  const r2 = await bf.fetchFn(target);
  const html2 = await r2.text();
  say(`status: ${r2.status} | HTML from: ${r2.source} | cf-mitigated: ${r2.headers.get('cf-mitigated') || '-'} | ${html2.length} characters`);
  say(`first 300 characters: ${JSON.stringify(html2.slice(0, 300))}`);
  const p = r2.ok ? parseVehiclePage(html2, /(\d+)$/.exec(target)[1]) : { status: 'error', reason: 'page not loaded' };
  if (p.data) {
    const d = p.data;
    say(`vehicle data found: YES | ${d.year} ${d.make} ${d.model} | price ${d.priceText} | ${d.mileage} miles | ${d.images.length} images | ${d.features.length} features | status ${p.status}${p.reason ? ' (' + p.reason + ')' : ''}`);
  } else say(`vehicle data found: NO (${p.reason})`);
  vehicleOk = Boolean(p.data);
} finally {
  await bf.close();
}
say(`\nRESULT: list page ${listOk ? 'OK' : 'FAILED'}, vehicle page ${vehicleOk ? 'OK' : 'FAILED'}`);
process.exit(listOk && vehicleOk ? 0 : 1);
