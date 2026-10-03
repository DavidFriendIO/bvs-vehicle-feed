// Full crawl: list -> detail (up to MAX_DETAIL pages, 20 s apart) -> build.
// Run on a home PC by run-crawl.bat (the site blocks data-centre IPs), or by hand: node scripts/crawl.js
// Settings come from environment variables or a .env file in the repo root.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CfKV } from '../src/cfkv.js';
import { runCrawl } from '../src/runner.js';
import { createBrowserFetch } from '../src/browserFetch.js';
import { loadEnvFile, checkCloudflareEnv, localDate } from '../src/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const haveEnvFile = loadEnvFile(envFile);
const env = process.env;

const logFile = env.LOG_FILE || path.join(root, 'logs', `crawl-${localDate()}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = (m) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* keep going if the log can't be written */ }
};

async function main() {
  log(`===== crawl started ${new Date().toISOString()} (log: ${logFile})`);
  const problems = checkCloudflareEnv(env);
  if (problems.length) {
    log(haveEnvFile ? `Problem with the settings in ${envFile}:` : `Can't find the settings file ${envFile}. Copy .env.example to .env and fill it in (see WINDOWS-SETUP.md).`);
    problems.forEach((p) => log(`  - ${p}`));
    return 2;
  }
  const kv = new CfKV({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, namespaceId: env.CF_KV_NAMESPACE_ID });
  // The site blocks plain HTTP clients, so pages are loaded in the PC's installed Chrome.
  const browser = await createBrowserFetch({
    profileDir: env.CHROME_PROFILE_DIR || path.join(root, 'chrome-profile'),
    executablePath: env.CHROME_PATH || undefined,
    show: env.SHOW_BROWSER === '1',
    headless: env.HEADLESS === '1',
    log,
  });
  let ok;
  try {
    ({ ok } = await runCrawl({
      kv, env, log, fetchFn: browser.fetchFn,
      maxDetail: Number(env.MAX_DETAIL) || 80,
      maxMs: (Number(env.MAX_MINUTES) || 90) * 60 * 1000,
    }));
  } finally {
    await browser.close();
  }
  log(ok ? '===== FINISHED OK' : '===== FINISHED WITH A PROBLEM: see the lines above');
  return ok ? 0 : 1;
}

let code;
try { code = await main(); } catch (e) { log(`===== CRASHED: ${e.stack || e}`); code = 1; }
process.exit(code);
