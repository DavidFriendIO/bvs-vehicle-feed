import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv, loadEnvFile, checkCloudflareEnv, localDate } from '../src/env.js';

test('parseEnv: comments, quotes, CRLF, BOM, spaces, export', () => {
  const t = '﻿# comment\r\nCF_ACCOUNT_ID = abc123 \r\nCF_API_TOKEN="tok en"\r\nexport X=1 # note\r\n\r\nBAD LINE\r\nEMPTY=\r\n';
  assert.deepEqual(parseEnv(t), { CF_ACCOUNT_ID: 'abc123', CF_API_TOKEN: 'tok en', X: '1', EMPTY: '' });
});

test('loadEnvFile: missing file is fine; real environment variables win', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
  assert.equal(loadEnvFile(f, {}), false);
  fs.writeFileSync(f, 'A=file\nB=file\n');
  const target = { A: 'real' };
  assert.equal(loadEnvFile(f, target), true);
  assert.deepEqual(target, { A: 'real', B: 'file' });
});

test('checkCloudflareEnv: plain-English problems', () => {
  const good = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_KV_NAMESPACE_ID: 'B'.repeat(32), CF_API_TOKEN: 'x'.repeat(40) };
  assert.deepEqual(checkCloudflareEnv(good), []);
  assert.equal(checkCloudflareEnv({}).length, 3);
  assert.match(checkCloudflareEnv({ ...good, CF_ACCOUNT_ID: 'short' })[0], /32 letters\/numbers.*5 characters/);
  assert.match(checkCloudflareEnv({ ...good, CF_API_TOKEN: 'a b' })[0], /space/);
});

test('localDate is YYYY-MM-DD in local time', () => {
  assert.equal(localDate(new Date(2026, 9, 2, 23, 59)), '2026-10-02');
});

test('scripts/crawl.js: no .env -> clear message, exit 2, log file written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  const logFile = path.join(dir, 'sub', 'crawl.log');
  const r = spawnSync(process.execPath, ['scripts/crawl.js'], {
    cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
    env: { PATH: process.env.PATH, LOG_FILE: logFile, CF_ACCOUNT_ID: '', CF_API_TOKEN: '', CF_KV_NAMESPACE_ID: '' },
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /CF_ACCOUNT_ID is empty/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /crawl started/);
});
