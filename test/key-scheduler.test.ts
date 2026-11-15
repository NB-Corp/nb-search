import { describe, expect, it, vi } from 'vitest';
import { createNbSearchRuntime, type HttpRequest, type HttpResponse, type HttpTransport } from '../src/index.ts';
import { parseCredentialKeys, resolveConfiguration } from '../src/config-sources.ts';
import { KeyScheduler } from '../src/key-scheduler.ts';
import type { ProviderInstanceConfig } from '../src/config-schema.ts';

const signal = new AbortController().signal;
const request: HttpRequest = { url: 'https://api.tavily.com/search', method: 'POST', body: { api_key: 'alpha', query: 'test' }, signal };
function scheduler(keys: string[], strategy: 'round-robin' | 'priority', send: HttpTransport['send'], now = () => new Date('2026-01-01T00:00:00Z')) {
  const instance: ProviderInstanceConfig = { provider_id: 'tavily', enabled: true, key_strategy: strategy, options: {} };
  return new KeyScheduler('tavily.default', instance, { credential_slot_id: 'tavily.default', provider_id: 'tavily', value: keys[0]!, values: keys, worker_grant: { kind: 'environment', name: 'NB_SEARCH_TAVILY_API_KEY' } }, { send }, now);
}
function ok<T>(): HttpResponse<T> { return { status: 200, body: { results: [] } as T }; }

describe('provider key scheduling', () => {
  it('parses ordered multi-key env lists and retains legacy single-key binding', () => {
    expect(parseCredentialKeys(' alpha, beta ')).toEqual(['alpha', 'beta']);
    expect(() => parseCredentialKeys('alpha,,beta')).toThrow(/distinct nonempty/);
    expect(() => parseCredentialKeys('alpha,alpha')).toThrow(/distinct nonempty/);
    const multi = resolveConfiguration({ env: { NB_SEARCH_TAVILY_API_KEY: 'alpha, beta' }, config: { provider_instances: { 'tavily.default': { key_strategy: 'priority', balance_ttl_ms: 300_000 } } } });
    expect(multi.secret_bindings.get('tavily.default')).toMatchObject({ value: 'alpha', values: ['alpha', 'beta'] });
    expect(multi.config.provider_instances['tavily.default']).toMatchObject({ key_strategy: 'priority', balance_ttl_ms: 300_000 });
    expect(resolveConfiguration({ env: { NB_SEARCH_TAVILY_API_KEY: 'alpha' } }).secret_bindings.get('tavily.default')?.values).toEqual(['alpha']);
    expect(() => resolveConfiguration({ env: {}, config: { provider_instances: { 'tavily.default': { key_strategy: 'random' as never } } } })).toThrow(/key_strategy/);
  });
  it('round robins across calls, including query/fetch credential positions', async () => {
    const keys: string[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => { keys.push((input.body as { api_key: string }).api_key); return ok<T>(); };
    const pool = scheduler(['alpha', 'beta'], 'round-robin', send);
    await pool.send(request); await pool.send(request); await pool.send(request);
    expect(keys).toEqual(['alpha', 'beta', 'alpha']);
  });
  it('priority uses first key until auth failure then quarantines it', async () => {
    const keys: string[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => { const key = (input.body as { api_key: string }).api_key; keys.push(key); return key === 'alpha' ? { status: 401, body: {} as T } : ok<T>(); };
    const pool = scheduler(['alpha', 'beta'], 'priority', send);
    expect((await pool.send(request)).status).toBe(200);
    await pool.send(request);
    expect(keys).toEqual(['alpha', 'beta', 'beta']);
  });
  it('cools a 429 key using Retry-After and restores it after the window', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z'); const keys: string[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => { const key = (input.body as { api_key: string }).api_key; keys.push(key); return key === 'alpha' && keys.length === 1 ? { status: 429, body: {} as T, headers: { 'Retry-After': '3' } } : ok<T>(); };
    const pool = scheduler(['alpha', 'beta'], 'priority', send, () => new Date(now));
    await pool.send(request); await pool.send(request); now += 3_000; await pool.send(request);
    expect(keys).toEqual(['alpha', 'beta', 'beta', 'alpha']);
  });
  it('retries 5xx and connection failures exponentially within a bound before rotating', async () => {
    const keys: string[] = []; let count = 0;
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => { keys.push((input.body as { api_key: string }).api_key); count++; return count <= 3 ? { status: 503, body: {} as T } : ok<T>(); };
    const pool = scheduler(['alpha', 'beta'], 'priority', send);
    expect((await pool.send(request)).status).toBe(200);
    expect(keys).toEqual(['alpha', 'alpha', 'alpha', 'beta']);
    let failed = 0;
    const network: HttpTransport['send'] = async <T>(input: HttpRequest) => { failed++; if (failed < 3) throw new (await import('../src/errors.ts')).NbSearchError('PROVIDER_UNAVAILABLE', 'Provider connection failed.', true); return ok<T>(); };
    await scheduler(['alpha'], 'priority', network).send(request);
    expect(failed).toBe(3);
  });
  it('does not retry 400 responses or send non-credential requests with a key', async () => {
    const send = vi.fn(async <T>(_request: HttpRequest): Promise<HttpResponse<T>> => ({ status: 400, body: {} as T }));
    const pool = scheduler(['alpha', 'beta'], 'priority', { send }.send as HttpTransport['send']);
    expect((await pool.send(request)).status).toBe(400);
    await pool.send({ ...request, body: { query: 'without key' } });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rotates after 403 or 402 and never queries usage as part of failure recovery', async () => {
    for (const failure of [403, 402]) {
      const keys: string[] = [];
      const send: HttpTransport['send'] = async <T>(input: HttpRequest) => { expect(input.method).toBe('POST'); const key = (input.body as { api_key: string }).api_key; keys.push(key); return key === 'alpha' ? { status: failure, body: {} as T } : ok<T>(); };
      const pool = scheduler(['alpha', 'beta'], 'priority', send);
      expect((await pool.send(request)).status).toBe(200);
      await pool.send(request);
      expect(keys).toEqual(['alpha', 'beta', 'beta']);
    }
  });
  it('retries injected transport connection TypeErrors', async () => {
    let calls = 0;
    const send: HttpTransport['send'] = async <T>() => { if (++calls === 1) throw new TypeError('connection reset'); return ok<T>(); };
    expect((await scheduler(['alpha'], 'priority', send).send(request)).status).toBe(200);
    expect(calls).toBe(2);
  });
  it('caches usage for 10 minutes and never polls during ordinary dispatch; refresh updates exhaustion', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z'); let usageCalls = 0; const searched: string[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => {
      if (input.method === 'GET') { usageCalls++; const auth = input.headers?.['Authorization']; return { status: 200, body: { key: { usage: auth === 'Bearer alpha' && usageCalls < 3 ? 10 : 2, limit: 10 } } as T }; }
      searched.push((input.body as { api_key: string }).api_key); return ok<T>();
    };
    const pool = scheduler(['alpha', 'beta'], 'priority', send, () => new Date(now));
    await pool.send(request); await pool.send(request); expect(usageCalls).toBe(0);
    expect(await pool.usage()).toMatchObject([{ key_index: 1, state: 'exhausted', usage: { remaining: 0 } }, { key_index: 2, state: 'ready' }]);
    await pool.send(request); await pool.usage(); expect(usageCalls).toBe(2);
    now += 600_000; await pool.usage(); expect(usageCalls).toBe(4);
    await pool.usage(true); expect(usageCalls).toBe(6);
    expect(searched).toEqual(['alpha', 'alpha', 'beta']);
    expect((await pool.usage())[0]).toMatchObject({ state: 'ready', usage: { remaining: 8 } });
  });
  it('shares rotation across real Tavily search body and fetch Authorization ports', async () => {
    const keys: string[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => {
      if (input.url.endsWith('/search')) { keys.push(input.headers?.['Authorization'] ?? 'missing'); return { status: 200, body: { results: [{ url: 'https://example.org', title: 'Example', content: 'Found' }] } as T }; }
      keys.push(input.headers?.['Authorization'] ?? 'missing'); return { status: 200, body: { results: [{ url: 'https://example.org', raw_content: 'Fetched article content' }] } as T };
    };
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_TAVILY_API_KEY: 'alpha,beta' }, http_transport: { send } });
    expect(await runtime.search({ action: 'run', query: 'example', lane: 'tavily.search' })).toMatchObject({ status: 'succeeded' });
    expect(await runtime.fetch({ url: 'https://example.org', pipeline: 'tavily.extract' })).toMatchObject({ status: 'succeeded' });
    expect(keys).toEqual(['Bearer alpha', 'Bearer beta']);
  });
  it('queries Firecrawl team credits only when asked and skips unsupported Exa usage', async () => {
    const requests: string[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => { requests.push(input.url); return { status: 200, body: { success: true, data: { remainingCredits: 9, planCredits: 100 } } as T }; };
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_FIRECRAWL_API_KEY: 'one,two', NB_SEARCH_EXA_API_KEY: 'exa' }, http_transport: { send } });
    expect(await runtime.keyUsage({ provider_instance_id: 'exa.default' })).toEqual([]);
    expect(await runtime.keyUsage({ provider_instance_id: 'firecrawl.default' })).toMatchObject([{ usage: { scope: 'team', remaining: 9 } }, { usage: { scope: 'team', remaining: 9 } }]);
    expect(requests).toEqual(['https://api.firecrawl.dev/v2/team/credit-usage', 'https://api.firecrawl.dev/v2/team/credit-usage']);
  });
  it.each(['tavily', 'firecrawl', 'zhihu'])('preserves %s usage URL prefixes', async (provider_id) => {
    const requests: HttpRequest[] = [];
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => {
      requests.push(input);
      return { status: 200, body: (provider_id === 'tavily' ? { key: { usage: 3, limit: 10 } } : provider_id === 'firecrawl' ? { success: true, data: { remainingCredits: 7 } } : { Code: 0, Data: [{ APIID: 'zhihu_search', RemainingQuota: 7 }] }) as T };
    };
    const pool = new KeyScheduler(`${provider_id}.default`, { provider_id, enabled: true, base_url: 'https://relay.example.test/raw/69', options: {} }, { credential_slot_id: `${provider_id}.default`, provider_id, value: 'YOUR_API_KEY', worker_grant: { kind: 'environment', name: 'TEST_KEY' } }, { send }, () => new Date('2026-11-15T15:59:59Z'));
    expect(await pool.usage()).toMatchObject([{ usage: { remaining: 7 } }]);
    expect(requests[0]!.url).toBe(`https://relay.example.test/raw/69${provider_id === 'tavily' ? '/usage' : provider_id === 'firecrawl' ? '/v2/team/credit-usage' : '/api/v1/quota'}`);
    if (provider_id === 'zhihu') expect(requests[0]!.headers).toMatchObject({ Authorization: 'Bearer YOUR_API_KEY', Accept: 'application/json', 'X-Request-Timestamp': String(Date.parse('2026-11-15T15:59:59Z') / 1000) });
  });
  it('parses official Zhihu request meters and preserves the legacy credits summary', async () => {
    let now = Date.parse('2026-11-15T15:59:59Z'); let calls = 0;
    const send: HttpTransport['send'] = async <T>() => { calls++; return { status: 200, body: { Code: 0, Data: { Items: [
      { api_id: 'global_search', api_name: 'Global', total_quota: 20, total_used: 19, remaining_quota: 1 },
      { APIID: 'zhihu_search', APIName: 'Zhihu', TotalQuota: 10, TotalUsed: 10, RemainingQuota: 0 },
      { APIID: 'zhida_openai', APIName: 'Zhida', TotalQuota: 5, TotalUsed: 2, RemainingQuota: 3 },
    ] } } as T }; };
    const pool = new KeyScheduler('zhihu.default', { provider_id: 'zhihu', enabled: true, options: {} }, { credential_slot_id: 'zhihu.default', provider_id: 'zhihu', value: 'YOUR_API_KEY', worker_grant: { kind: 'environment', name: 'TEST_KEY' } }, { send }, () => new Date(now));
    expect(pool.supportsUsage).toBe(true);
    const usage = await pool.usage();
    expect(usage).toEqual([{ provider_instance_id: 'zhihu.default', provider_id: 'zhihu', key_index: 1, state: 'ready', usage: { scope: 'key', unit: 'credits', used: 10, limit: 10, remaining: 0, checked_at: '2026-11-15T15:59:59.000Z', meters: [
      { id: 'global_search', label: 'Global', unit: 'requests', used: 19, limit: 20, remaining: 1, reset_at: '2026-11-15T16:00:00.000Z', reset_timezone: 'Asia/Shanghai' },
      { id: 'zhihu_search', label: 'Zhihu', unit: 'requests', used: 10, limit: 10, remaining: 0, reset_at: '2026-11-15T16:00:00.000Z', reset_timezone: 'Asia/Shanghai' },
      { id: 'zhida_openai', label: 'Zhida', unit: 'requests', used: 2, limit: 5, remaining: 3, reset_at: '2026-11-15T16:00:00.000Z', reset_timezone: 'Asia/Shanghai' },
    ] } }]);
    await pool.usage(); expect(calls).toBe(1);
    now += 1000;
    expect((await pool.usage())[0]!.usage!.meters![0]!.reset_at).toBe('2026-11-16T16:00:00.000Z');
    expect(calls).toBe(2);
  });
  it.each([
    [{ APIID: 'zhihu_search', RemainingQuota: 0 }, { APIID: 'global_search', RemainingQuota: 0 }],
    [{ APIID: 'zhihu_search', RemainingQuota: 0 }],
    [{ APIID: 'global_search', RemainingQuota: 2 }],
  ])('only exhausts a Zhihu key when both search meters are zero: %j', async (...rows) => {
    const send: HttpTransport['send'] = async <T>() => ({ status: 200, body: { Code: 0, Data: rows } as T });
    const pool = new KeyScheduler('zhihu.default', { provider_id: 'zhihu', enabled: true, options: {} }, { credential_slot_id: 'zhihu.default', provider_id: 'zhihu', value: 'YOUR_API_KEY', worker_grant: { kind: 'environment', name: 'TEST_KEY' } }, { send });
    expect((await pool.usage())[0]).toMatchObject({ state: rows.length === 2 ? 'exhausted' : 'ready', usage: { remaining: rows[0]!.RemainingQuota } });
  });
  it.each([{ Code: 20001 }, { Code: 0, Data: [] }, { Code: 0, Data: [{ APIID: 'zhihu_search', RemainingQuota: -1 }] }])('reports unreadable Zhihu meters as invalid_response', async (body) => {
    const pool = new KeyScheduler('zhihu.default', { provider_id: 'zhihu', enabled: true, options: {} }, { credential_slot_id: 'zhihu.default', provider_id: 'zhihu', value: 'YOUR_API_KEY', worker_grant: { kind: 'environment', name: 'TEST_KEY' } }, { async send<T>() { return { status: 200, body: body as T }; } });
    expect(await pool.usage()).toMatchObject([{ usage_error: 'invalid_response' }]);
  });
  it('exposes local SDK usage without disclosing raw key material', async () => {
    const send: HttpTransport['send'] = async <T>(input: HttpRequest) => input.method === 'GET' ? { status: 200, body: { key: { usage: 3, limit: 10 } } as T } : ok<T>();
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_TAVILY_API_KEY: 'alpha,beta' }, http_transport: { send } });
    const usage = await runtime.keyUsage({ provider_instance_id: 'tavily.default' });
    expect(usage).toHaveLength(2); expect(usage[0]).toMatchObject({ provider_instance_id: 'tavily.default', usage: { remaining: 7 } });
    expect(JSON.stringify(usage)).not.toMatch(/alpha|beta/);
  });
});
