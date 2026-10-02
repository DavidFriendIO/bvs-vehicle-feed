import fs from 'node:fs';

/** Parse a .env file: KEY=value lines, # comments, optional quotes, optional `export `. Handles BOM and CRLF. */
export function parseEnv(text) {
  const out = {};
  for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

/** Load `file` into `target` without overriding values that are already set. Returns false if the file is missing. */
export function loadEnvFile(file, target = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  for (const [k, v] of Object.entries(parseEnv(text))) if (!target[k] && v) target[k] = v;
  return true;
}

/** Plain-English problems with the Cloudflare settings, or []. */
export function checkCloudflareEnv(env) {
  const problems = [];
  const need = { CF_ACCOUNT_ID: 'Account ID', CF_API_TOKEN: 'API token', CF_KV_NAMESPACE_ID: 'KV namespace ID' };
  for (const [k, label] of Object.entries(need)) if (!env[k]) problems.push(`${k} is empty. Paste your Cloudflare ${label} after the = sign in the .env file.`);
  for (const k of ['CF_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID']) {
    if (env[k] && !/^[0-9a-f]{32}$/i.test(env[k])) problems.push(`${k} doesn't look right: it should be exactly 32 letters/numbers with no spaces (yours is ${env[k].length} characters).`);
  }
  if (env.CF_API_TOKEN && /\s/.test(env.CF_API_TOKEN)) problems.push('CF_API_TOKEN contains a space. Copy just the token, with nothing else on the line.');
  return problems;
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
