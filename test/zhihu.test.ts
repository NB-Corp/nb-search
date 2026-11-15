import { describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { defaultConfiguration } from '../src/config-sources.ts';
import { describeConfiguredLaneGuidance } from '../src/lane-guidance.ts';
import { KeyScheduler } from '../src/key-scheduler.ts';
import { ProviderRegistry, builtInProviderRegistrations } from '../src/provider-registry.ts';
import { ZhihuProvider, type ZhihuOptions } from '../src/index.ts';
import type { HttpRequest, HttpTransport } from '../src/transport.ts';

const now = () => new Date('2026-11-15T06:00:00.789Z');
const signal = new AbortController().signal;
const request = { query: '  中文检索  ', limit: 3, request_time_utc: now().toISOString(), signal };
const item = { Title: '知乎回答', Url: 'https://www.zhihu.com/question/123/answer/456?utm_source=example#section', ContentText: '<p>First <b>hand</b> evidence.</p>', ContentType: 'answer', AuthorName: 'AuthorName', VoteUpCount: 120, CommentCount: 15, EditTime: 1_700_000_000, CreatedTime: 1_600_000_000 };
const found = { Code: 0, Message: 'ok', Data: { Items: [item] } };
const quota = (remaining: number, api = 'zhihu_search') => ({ Code: 0, Data: [{ APIID: api, APIName: 'Search', TotalQuota: 100, TotalUsed: 100 - remaining, RemainingQuota: remaining }] });
function harness(options: ZhihuOptions = {}, clock = now, responder: (input: HttpRequest) => unknown | Promise<unknown> = () => found, baseUrl?: string) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = { async send<T>(input: HttpRequest) { requests.push(input); return { status: 200, body: await responder(input) as T }; } };
  const provider = new ZhihuProvider({ apiKey: 'YOUR_API_KEY', transport, clock, options, ...(baseUrl === undefined ? {} : { baseUrl }) });
  return { provider, requests, transport };
}
const isQuota = (input: HttpRequest) => new URL(input.url).pathname.endsWith('/quota');
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe('Zhihu built-in wire contract', () => {
  it('registers the exact opt-in descriptor and classifies configured operations', () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    expect(registry.requireDescriptor('zhihu')).toEqual({
      provider_id: 'zhihu', adapter_version: '1', activation: { credential: 'required', endpoint: 'optional' },
      option_keys: ['allow_paid', 'search_db', 'zhida_model', 'search_path', 'global_search_path', 'synthesis_path', 'quota_path'],
      query_operations: [
        { operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
        { operation_id: 'global', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
        { operation_id: 'synthesis', output: { channel: 'typed', schema_id: 'nb-search.synthesis@1' }, built_in_async: true },
      ], fetch_operations: [],
    });
    const config = defaultConfiguration('.');
    expect(Object.values(config.provider_instances).some((instance) => instance.provider_id === 'zhihu')).toBe(false);
    config.provider_instances = { ...config.provider_instances, 'zhihu.default': { provider_id: 'zhihu', enabled: true, options: {} } };
    config.lanes = Object.fromEntries(['search', 'global', 'synthesis'].map((operation_id) => [`zhihu.${operation_id}`, { provider_instance_id: 'zhihu.default', operation_id, cost: 'cheap' as const, latency: 'medium' as const }]));
    expect(describeConfiguredLaneGuidance(config).map((entry) => entry.group)).toEqual(['specialist', 'specialist', 'research']);
  });
  it('sends official search parameters, fresh headers, and normalized results with metadata/date', async () => {
    let time = now().getTime();
    const { provider, requests } = harness({ allow_paid: true }, () => new Date(time));
    expect(await provider.search({ ...request, limit: 99 })).toEqual([{ title: '知乎回答', url: 'https://www.zhihu.com/question/123/answer/456', snippet: '[answer · AuthorName · votes:120 · comments:15] First hand evidence.', published_at: '2023-11-14T22:13:20.000Z' }]);
    expect(requests[0]).toMatchObject({ url: 'https://developer.zhihu.com/api/v1/content/zhihu_search?Query=%E4%B8%AD%E6%96%87%E6%A3%80%E7%B4%A2&Count=10', method: 'GET', headers: { Authorization: 'Bearer YOUR_API_KEY', 'X-Request-Timestamp': '1794722400', Accept: 'application/json' } });
    time += 5000; await provider.search({ ...request, limit: 0 });
    expect(new URL(requests[1]!.url).searchParams.get('Count')).toBe('1');
    expect(requests[1]!.headers?.['X-Request-Timestamp']).toBe('1794722405');
    expect(provider.redactions).toEqual(['YOUR_API_KEY', 'Bearer YOUR_API_KEY']);
  });
  it('maps empty results, skips unsafe URLs, falls back to CreatedTime and omits invalid dates', async () => {
    const { provider } = harness({ allow_paid: true }, now, () => ({ Code: 0, Data: { Items: [{ Url: 'javascript:alert(1)' }, { Title: 'T', Url: 'https://example.test/one', CreatedTime: 1_600_000_000 }, { Url: 'https://example.test/two', EditTime: -1 }] } }));
    expect(await provider.search(request)).toEqual([{ title: 'T', url: 'https://example.test/one', published_at: '2020-09-13T12:26:40.000Z' }, { title: '', url: 'https://example.test/two' }]);
    expect(await harness({ allow_paid: true }, now, () => ({ Code: 0, Data: { Items: [] } })).provider.global(request)).toEqual([]);
  });
  it.each(['x', ' '.repeat(3), 'x'.repeat(101)])('rejects invalid trimmed query before any HTTP call: %s', async (query) => {
    const { provider, requests } = harness();
    await expect(provider.search({ ...request, query })).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    await expect(provider.global({ ...request, query })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toEqual([]);
  });
  it('preserves prefixes for all defaults and validates global count/SearchDB', async () => {
    const { provider, requests } = harness({}, now, (input) => isQuota(input) ? quota(100, new URL(input.url).searchParams.get('APIIDs')!) : input.method === 'POST' ? { choices: [{ message: { content: 'Answer' } }] } : found, 'https://relay.example.test/raw/70');
    await provider.search(request); await provider.global({ ...request, limit: 100 }); await provider.synthesize(request);
    expect(requests.map((input) => new URL(input.url).pathname)).toEqual(['/raw/70/api/v1/quota', '/raw/70/api/v1/content/zhihu_search', '/raw/70/api/v1/quota', '/raw/70/api/v1/content/global_search', '/raw/70/api/v1/quota', '/raw/70/v1/chat/completions']);
    expect(new URL(requests[3]!.url).searchParams.get('SearchDB')).toBe('all');
    expect(new URL(requests[3]!.url).searchParams.get('Count')).toBe('20');
    const custom = harness({ allow_paid: true, search_db: 'realtime' }); await custom.provider.global({ ...request, limit: -1 });
    expect(custom.requests[0]!.url).toContain('Count=1&SearchDB=realtime');
  });
  it('supports custom operation/quota paths without stripping the base prefix', async () => {
    const { provider, requests } = harness({ search_path: '/content', global_search_path: '/global', synthesis_path: '/chat', quota_path: '/quota', search_db: 'static', zhida_model: 'custom-model' }, now, (input) => isQuota(input) ? quota(99, new URL(input.url).searchParams.get('APIIDs')!) : input.method === 'POST' ? { choices: [{ message: { content: 'text' } }] } : found, 'https://relay.example.test/v1/zhihu/');
    await provider.search(request); await provider.global(request); await provider.synthesize(request);
    expect(requests.map((input) => new URL(input.url).pathname)).toEqual(['/v1/zhihu/quota', '/v1/zhihu/content', '/v1/zhihu/quota', '/v1/zhihu/global', '/v1/zhihu/quota', '/v1/zhihu/chat']);
    expect(requests[5]!.body).toMatchObject({ model: 'custom-model' });
  });
  it('projects OpenAI completions and only structured, normalized supporting URLs', async () => {
    const { provider, requests } = harness({ allow_paid: true, zhida_model: 'zhida-thinking-1p5' }, now, () => ({ citations: ['https://source.example.test/a?utm_source=example', 'javascript:alert(1)'], choices: [{ message: { content: ' A synthesis with https://unstructured.example.test/ignored ', search_results: [{ url: 'https://source.example.test/a' }, { url: 'https://source.example.test/b', title: 'B' }] } }] }));
    expect(await provider.synthesize(request)).toEqual({ text: 'A synthesis with https://unstructured.example.test/ignored', supporting_urls: [{ url: 'https://source.example.test/a', source: 'provider-grounding' }, { url: 'https://source.example.test/b', title: 'B', source: 'provider-grounding' }], citation_status: { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false } });
    expect(requests[0]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { model: 'zhida-thinking-1p5', messages: [{ role: 'user', content: request.query }], stream: false } });
    const plain = harness({ allow_paid: true }, now, () => ({ choices: [{ message: { content: 'plain' } }] }));
    expect(await plain.provider.synthesize(request)).toMatchObject({ supporting_urls: [] });
    await expect(harness({ allow_paid: true }, now, () => ({ choices: [] })).provider.synthesize(request)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });
  it.each([
    [20001, 'PROVIDER_AUTH', false], [30001, 'PROVIDER_RATE_LIMIT', true], [40003, 'PROVIDER_RATE_LIMIT', true],
    [30002, 'PROVIDER_RATE_LIMIT', false], [30003, 'PROVIDER_UNAVAILABLE', false], [10001, 'INVALID_INPUT', false],
    [90001, 'PROVIDER_UNAVAILABLE', true], [12345, 'PROVIDER_UNAVAILABLE', false],
  ])('maps envelope code %s', async (Code, code, retryable) => {
    await expect(harness({ allow_paid: true }, now, () => ({ Code, Message: 'upstream details' })).provider.search(request)).rejects.toMatchObject({ code, retryable, provider: 'zhihu' });
  });
  it.each([
    { allow_paid: 'true' }, { search_db: 'unknown' }, { zhida_model: '' }, { search_path: '//example.test' },
    { global_search_path: '/a/../b' }, { synthesis_path: '/chat?key=x' }, { quota_path: '/a/%2f/b' }, { unknown: true },
  ])('validates options at the configuration boundary: %j', (options) => {
    expect(() => harness(options as ZhihuOptions)).toThrow(/invalid|string/);
  });
  it.each([
    { search_path: '/shared', global_search_path: '/shared' },
    { search_path: '/shared', synthesis_path: '/shared' },
    { search_path: '/shared', quota_path: '/shared' },
  ])('rejects ambiguous operation paths before any HTTP dispatch: %j', (options) => {
    expect(() => harness(options)).toThrow(/distinct endpoints/);
  });
  it('rejects collisions after URL prefix resolution as well as literal path collisions', () => {
    expect(() => harness({ global_search_path: '/zhihu_search' }, now, undefined, 'https://relay.example.test/api/v1/content/zhihu_search')).toThrow(/distinct endpoints/);
  });
  it.each(['ftp://relay.example.test', 'https://user:pass@relay.example.test', 'https://relay.example.test/?query=x', 'https://relay.example.test/#fragment'])('rejects unsafe base URLs: %s', (baseUrl) => {
    expect(() => harness({}, now, undefined, baseUrl)).toThrow(/HTTP/);
  });
});

describe('Zhihu free-quota reservations', () => {
  it.each([quota(0), { Code: 0, Data: [] }, { Code: 0, Data: [{ APIID: 'zhihu_search', RemainingQuota: '10' }] }, { Code: 20001 }])('fails closed before billing on exhausted/unreadable quota %j', async (body) => {
    const { provider, requests } = harness({}, now, () => body);
    await expect(provider.search(request)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', message: 'zhihu daily free quota is exhausted or unverified.', retryable: false, provider: 'zhihu' });
    expect(requests).toHaveLength(1); expect(isQuota(requests[0]!)).toBe(true);
  });
  it('fails closed on a quota network failure and never sends a billable request', async () => {
    const { provider, requests } = harness({}, now, () => { throw new TypeError('connection failed'); });
    await expect(provider.search(request)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: false });
    expect(requests).toHaveLength(1);
  });
  it('generates the billable timestamp after the quota precheck completes', async () => {
    let time = now().getTime();
    const { provider, requests } = harness({}, () => new Date(time), (input) => { if (isQuota(input)) { time += 5000; return quota(100); } return found; });
    await provider.search(request);
    expect(requests[0]!.headers?.['X-Request-Timestamp']).toBe(String(Math.floor(now().getTime() / 1000)));
    expect(requests[1]!.headers?.['X-Request-Timestamp']).toBe(String(Math.floor(time / 1000)));
  });
  it('reuses high balances within 60s, refreshes stale/low balances, and tracks each API separately', async () => {
    let time = now().getTime();
    const { provider, requests } = harness({}, () => new Date(time), (input) => isQuota(input) ? quota(35, new URL(input.url).searchParams.get('APIIDs')!) : found);
    await provider.search(request); await provider.search(request); await provider.search(request); await provider.search(request);
    expect(requests.filter(isQuota)).toHaveLength(2); // 35 -> 34 -> 33 -> 32 triggers refresh.
    time += 60_000; await provider.search(request); await provider.global(request);
    expect(requests.filter(isQuota)).toHaveLength(4);
  });
  it('coalesces concurrent prechecks and reserves synchronously so one remaining call cannot be overspent', async () => {
    const quotaGate = deferred(); const started = deferred(); const billGate = deferred();
    const { provider, requests } = harness({}, now, async (input) => { if (isQuota(input)) { started.resolve(); await quotaGate.promise; return quota(1); } await billGate.promise; return found; });
    const first = provider.search(request); const second = provider.search(request);
    const secondCheck = expect(second).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: false });
    await started.promise; quotaGate.resolve(); await secondCheck; billGate.resolve(); await first;
    expect(requests.filter(isQuota)).toHaveLength(1); expect(requests.filter((input) => !isQuota(input))).toHaveLength(1);
  });
  it('subtracts in-flight reservations from a low-quota refresh', async () => {
    const billGate = deferred(); const started = deferred();
    const { provider, requests } = harness({}, now, async (input) => { if (isQuota(input)) return quota(1); started.resolve(); await billGate.promise; return found; });
    const first = provider.search(request); await started.promise;
    await expect(provider.search(request)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    billGate.resolve(); await first;
    expect(requests.filter(isQuota)).toHaveLength(2); expect(requests.filter((input) => !isQuota(input))).toHaveLength(1);
  });
  it('retains a reservation when the earlier call completes during a quota refresh', async () => {
    const billGate = deferred(); const billStarted = deferred(); const quotaGate = deferred(); const quotaStarted = deferred();
    let quotaCalls = 0;
    const { provider, requests } = harness({}, now, async (input) => {
      if (isQuota(input)) { if (++quotaCalls === 2) { quotaStarted.resolve(); await quotaGate.promise; } return quota(1); }
      billStarted.resolve(); await billGate.promise; return found;
    });
    const first = provider.search(request); await billStarted.promise;
    const second = provider.search(request); const blocked = expect(second).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: false });
    await quotaStarted.promise; billGate.resolve(); await first; quotaGate.resolve(); await blocked;
    expect(requests.filter((input) => !isQuota(input))).toHaveLength(1);
  });
  it('pins Code=30002 to zero for the Beijing day, then prechecks again at midnight', async () => {
    let time = Date.parse('2026-11-15T15:59:59Z'); let billed = 0;
    const { provider, requests } = harness({}, () => new Date(time), (input) => isQuota(input) ? quota(100) : ++billed === 1 ? { Code: 30002 } : found);
    await expect(provider.search(request)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: false });
    await expect(provider.search(request)).rejects.toMatchObject({ message: 'zhihu daily free quota is exhausted or unverified.' });
    expect(requests).toHaveLength(2);
    time += 1000; await provider.search(request);
    expect(requests).toHaveLength(4); expect(isQuota(requests[2]!)).toBe(true);
    expect(requests[3]!.headers?.['X-Request-Timestamp']).toBe(String(time / 1000));
  });
  it('requires a new precheck if the quota response arrives after Beijing midnight', async () => {
    let time = Date.parse('2026-11-15T15:59:59Z'); let quotaCalls = 0;
    const { provider, requests } = harness({}, () => new Date(time), (input) => { if (isQuota(input)) { if (++quotaCalls === 1) time += 1000; return quota(10); } return found; });
    await provider.search(request);
    expect(requests.filter(isQuota)).toHaveLength(2);
  });
  it('guards the actual scheduler key and each retry rather than rotating between precheck and billing', async () => {
    const requests: HttpRequest[] = []; let billed = 0;
    const transport: HttpTransport = { async send<T>(input: HttpRequest) {
      requests.push(input);
      if (isQuota(input)) return { status: 200, body: quota(input.headers?.['Authorization'] === 'Bearer YOUR_API_KEY' ? 100 : 0) as T };
      return { status: ++billed === 1 ? 500 : 200, body: found as T };
    } };
    const scheduler = new KeyScheduler('zhihu.default', { provider_id: 'zhihu', enabled: true, options: {} }, { credential_slot_id: 'zhihu.default', provider_id: 'zhihu', value: 'YOUR_API_KEY', values: ['YOUR_API_KEY', 'ANOTHER_API_KEY'], worker_grant: { kind: 'environment', name: 'NB_SEARCH_ZHIHU_API_KEY' } }, transport, now);
    const provider = new ZhihuProvider({ apiKey: 'YOUR_API_KEY', transport: scheduler, clock: now });
    await provider.search(request);
    await expect(provider.search(request)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    expect(requests.map((input) => input.headers?.['Authorization'])).toEqual(['Bearer YOUR_API_KEY', 'Bearer YOUR_API_KEY', 'Bearer YOUR_API_KEY', 'Bearer ANOTHER_API_KEY']);
    expect(requests.filter((input) => !isQuota(input))).toHaveLength(2);
  });
  it('keeps paid-mode calls usable after a free-quota usage inspection', async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = { async send<T>(input: HttpRequest) {
      requests.push(input);
      return { status: 200, body: (isQuota(input) ? { Code: 0, Data: [{ APIID: 'zhihu_search', RemainingQuota: 0 }, { APIID: 'global_search', RemainingQuota: 0 }] } : input.method === 'POST' ? { choices: [{ message: { content: 'Answer' } }] } : found) as T };
    } };
    const scheduler = new KeyScheduler('zhihu.default', { provider_id: 'zhihu', enabled: true, options: { allow_paid: true } }, { credential_slot_id: 'zhihu.default', provider_id: 'zhihu', value: 'YOUR_API_KEY', worker_grant: { kind: 'environment', name: 'NB_SEARCH_ZHIHU_API_KEY' } }, transport, now);
    const provider = new ZhihuProvider({ apiKey: 'YOUR_API_KEY', transport: scheduler, options: { allow_paid: true }, clock: now });
    await provider.synthesize(request);
    expect(await scheduler.usage()).toMatchObject([{ state: 'exhausted', usage: { remaining: 0 } }]);
    await provider.search(request); await provider.synthesize(request);
    expect(requests).toHaveLength(4); expect(requests.filter(isQuota)).toHaveLength(1);
  });
  it('executes all three configured runtime ports without adding default lanes', async () => {
    const transport: HttpTransport = { async send<T>(input: HttpRequest) { return { status: 200, body: (isQuota(input) ? quota(100, new URL(input.url).searchParams.get('APIIDs')!) : input.method === 'POST' ? { choices: [{ message: { content: 'Synthesis' } }] } : found) as T }; } };
    const app = createRuntimeComposition({ NB_SEARCH_ZHIHU_API_KEY: 'YOUR_API_KEY' }, { transport, now, config: {
      provider_instances: { 'zhihu.default': { provider_id: 'zhihu', credential_slot_id: 'zhihu.default', enabled: true, options: {} } },
      credential_slots: { 'zhihu.default': { provider_id: 'zhihu', env: 'NB_SEARCH_ZHIHU_API_KEY' } },
      lanes: Object.fromEntries(['search', 'global', 'synthesis'].map((operation_id) => [`zhihu.${operation_id}`, { provider_instance_id: 'zhihu.default', operation_id, latency: 'medium', cost: 'cheap' }])),
    } });
    for (const operation of ['search', 'global', 'synthesis']) expect(await app.runtime.search({ action: 'run', query: '中文检索', lane: `zhihu.${operation}` })).toMatchObject({ status: 'succeeded', output: { channel: operation === 'synthesis' ? 'typed' : 'results' } });
  });
});
