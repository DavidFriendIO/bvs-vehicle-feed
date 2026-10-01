/**
 * Cloudflare KV over the REST API, with the same get/put/delete/list surface the stages use.
 * Writes are cached in memory for the run, so reads straight after a write never see stale data
 * (KV is eventually consistent across the network).
 */
export class CfKV {
  constructor({ accountId, apiToken, namespaceId, fetchFn }) {
    if (!accountId || !apiToken || !namespaceId) throw new Error('CF_ACCOUNT_ID, CF_API_TOKEN and CF_KV_NAMESPACE_ID are all required');
    this.base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
    this.headers = { Authorization: `Bearer ${apiToken}` };
    this.fetchFn = fetchFn || ((...a) => fetch(...a));
    this.cache = new Map(); // key -> string | null (deleted)
  }

  async call(method, path, init = {}) {
    const doFetch = this.fetchFn;
    const res = await doFetch(this.base + path, { method, ...init, headers: { ...this.headers, ...(init.headers || {}) } });
    return res;
  }

  async get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const res = await this.call('GET', `/values/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.text();
  }

  async put(key, value, opts = {}) {
    const q = opts.expirationTtl ? `?expiration_ttl=${opts.expirationTtl}` : '';
    const res = await this.call('PUT', `/values/${encodeURIComponent(key)}${q}`, { body: value, headers: { 'Content-Type': 'text/plain' } });
    if (!res.ok) throw new Error(`KV put ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    this.cache.set(key, value);
  }

  async delete(key) {
    const res = await this.call('DELETE', `/values/${encodeURIComponent(key)}`);
    if (!res.ok && res.status !== 404) throw new Error(`KV delete ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    this.cache.set(key, null);
  }

  async list({ prefix = '', cursor } = {}) {
    const q = new URLSearchParams({ prefix, limit: '1000' });
    if (cursor) q.set('cursor', cursor);
    const res = await this.call('GET', `/keys?${q}`);
    if (!res.ok) throw new Error(`KV list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const names = new Set((body.result || []).map((k) => k.name));
    const next = body.result_info?.cursor || '';
    // overlay this run's writes/deletes
    if (!next) for (const [k, v] of this.cache) if (k.startsWith(prefix)) (v === null ? names.delete(k) : names.add(k));
    return { keys: [...names].map((name) => ({ name })), list_complete: !next, cursor: next || undefined };
  }
}
