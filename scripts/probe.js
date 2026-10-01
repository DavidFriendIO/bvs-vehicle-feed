// Is GitHub's runner challenged by braintreevansales.co.uk? Prints status and the first 300 chars of two pages.
import { SITE, LIST_URL_1, REQUEST_GAP_MS } from '../src/config.js';
import { fetchInit } from '../src/crawl.js';
import { parseListPage } from '../src/parse.js';

const show = async (url) => {
  console.log(`\n=== GET ${url}`);
  try {
    const res = await fetch(url, fetchInit());
    const text = await res.text();
    console.log(`status: ${res.status} ${res.statusText} | final: ${res.url} | cf-mitigated: ${res.headers.get('cf-mitigated') || '-'} | server: ${res.headers.get('server') || '-'}`);
    console.log(`first 300 chars: ${JSON.stringify(text.slice(0, 300))}`);
    const challenged = res.headers.has('cf-mitigated') || /Just a moment|you have been blocked/i.test(text.slice(0, 5000));
    return { ok: res.ok && !challenged, text };
  } catch (e) {
    console.log(`THREW ${e.name}: ${e.message}${e.cause ? ' (cause: ' + e.cause.message + ')' : ''}`);
    return { ok: false, text: '' };
  }
};

const list = await show(LIST_URL_1);
const first = list.ok ? parseListPage(list.text)[0]?.url : null;
console.log(`\nwaiting ${REQUEST_GAP_MS / 1000}s...`);
await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
const veh = await show(first || `${SITE}/used-mercedes-benz-vito-braintree-essex-8270075`);
console.log(`\nRESULT: list page ${list.ok ? 'OK' : 'BLOCKED/FAILED'}, vehicle page ${veh.ok ? 'OK' : 'BLOCKED/FAILED'}`);
process.exit(list.ok && veh.ok ? 0 : 1);
