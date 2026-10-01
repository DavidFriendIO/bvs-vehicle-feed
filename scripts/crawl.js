// Nightly crawl, run by .github/workflows/crawl.yml. State and the feed live in the Worker's KV namespace.
import { CfKV } from '../src/cfkv.js';
import { runCrawl } from '../src/runner.js';

const env = process.env;
const kv = new CfKV({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, namespaceId: env.CF_KV_NAMESPACE_ID });
const stamp = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const { ok } = await runCrawl({
  kv, env, log: stamp,
  maxDetail: Number(env.MAX_DETAIL) || 64,
  maxMs: (Number(env.MAX_MINUTES) || 90) * 60 * 1000,
});
process.exit(ok ? 0 : 1);
