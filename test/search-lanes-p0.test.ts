import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeComposition } from '../src/app.ts';
import { NbSearchError } from '../src/errors.ts';
import { BraveSearchProvider } from '../src/providers/brave.ts';
import { FirecrawlSearchProvider } from '../src/providers/firecrawl-search.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/transport.ts';
import type { ProviderSearchRequest, SearchProvider } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('P0 results search adapters', () => {
  it('builds the Firecrawl web-only request and normalizes data.web', async () => {
    const transport = new CaptureTransport({ status: 200, body: { success: true, data: { web: [{ title: ' Firecrawl ', url: 'https://firecrawl.dev/docs', description: '  Search   docs ' }], news: [{ url: 'https://news.test' }], images: [] } } });
    const provider = new FirecrawlSearchProvider({ apiKey: 'firecrawl-secret', transport });

    await expect(provider.search(request())).resolves.toEqual([{ title: 'Firecrawl', url: 'https://firecrawl.dev/docs', snippet: 'Search docs' }]);
    expect(transport.requests).toEqual([{
      url: 'https://api.firecrawl.dev/v2/search', method: 'POST',
      headers: { Authorization: 'Bearer firecrawl-secret', 'Content-Type': 'application/json' },
      body: { query: 'query terms', limit: 2, sources: ['web'] }, response_type: 'json', max_response_bytes: 1_048_576,
      signal: expect.any(AbortSignal),
    }]);
    expect(transport.requests[0]?.body).not.toHaveProperty('scrapeOptions');
  });

  it('builds the Brave web search request and maps description and age', async () => {
    const transport = new CaptureTransport({ status: 200, body: { web: { results: [{ title: ' Brave ', url: 'https://search.brave.com/help', description: ' Private   search ', age: '2 hours ago' }] } } });
    const provider = new BraveSearchProvider({ apiKey: 'brave-secret', transport });

    await expect(provider.search(request())).resolves.toEqual([{ title: 'Brave', url: 'https://search.brave.com/help', snippet: 'Private search', published_at: '2 hours ago' }]);
    expect(transport.requests).toEqual([{
      url: 'https://api.search.brave.com/res/v1/web/search?q=query+terms&count=2', method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': 'brave-secret' }, response_type: 'json', max_response_bytes: 1_048_576,
      signal: expect.any(AbortSignal),
    }]);
  });

  it.each([
    ['400 characters', 'x'.repeat(400)],
    ['50 words', Array.from({ length: 50 }, () => 'word').join(' ')],
  ])('accepts a Brave query at the %s boundary', async (_label, query) => {
    const transport = new CaptureTransport({ status: 200, body: { web: { results: [] } } });
    const provider = new BraveSearchProvider({ apiKey: 'secret', transport });
    await expect(provider.search({ ...request(), query })).resolves.toEqual([]);
    expect(new URL(transport.requests[0]!.url).searchParams.get('q')).toBe(query);
  });

  it.each([
    ['401 characters', 'x'.repeat(401), { characters: 401, words: 1 }],
    ['51 words', Array.from({ length: 51 }, () => 'word').join(' '), { characters: 254, words: 51 }],
  ] as const)('rejects a Brave query beyond the %s boundary without transport', async (_label, query, counts) => {
    const transport = new CaptureTransport({ status: 200, body: { web: { results: [] } } });
    const provider = new BraveSearchProvider({ apiKey: 'secret', transport });
    await expect(provider.search({ ...request(), query })).rejects.toMatchObject({
      code: 'INVALID_INPUT', retryable: false, provider: 'brave', data: { ...counts, max_characters: 400, max_words: 50 },
    });
    expect(transport.requests).toEqual([]);
  });

  it.each([[20, 20], [21, 20]] as const)('maps Brave result limit %i to upstream count %i', async (limit, count) => {
    const transport = new CaptureTransport({ status: 200, body: { web: { results: [] } } });
    const provider = new BraveSearchProvider({ apiKey: 'secret', transport });
    await expect(provider.search({ ...request(), limit })).resolves.toEqual([]);
    expect(new URL(transport.requests[0]!.url).searchParams.get('count')).toBe(String(count));
  });

  it.each(providerCases())('%s returns an empty result list without fabricating rows', async (_name, makeProvider, emptyBody) => {
    const provider = makeProvider(new CaptureTransport({ status: 200, body: emptyBody }));
    await expect(provider.search(request())).resolves.toEqual([]);
  });

  it('treats a Brave response without a web group as an empty result list', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'secret', transport: new CaptureTransport({ status: 200, body: { type: 'search', query: { original: 'query terms' } } }) });
    await expect(provider.search(request())).resolves.toEqual([]);
  });

  it('still rejects a malformed Brave web group', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'secret', transport: new CaptureTransport({ status: 200, body: { web: { results: 'invalid' } } }) });
    await expect(provider.search(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'brave' });
  });

  it.each(providerCases().flatMap(([name, makeProvider]) => [401, 403, 408, 425, 429, 500, 503].map((status) => [name, status, makeProvider] as const)))('%s maps HTTP %s with status data', async (_name, status, makeProvider) => {
    const headers = status === 429 ? { 'retry-after': '3' } : undefined;
    const provider = makeProvider(new CaptureTransport({ status, body: {}, ...(headers === undefined ? {} : { headers }) }));
    const expected = status === 401 || status === 403
      ? { code: 'PROVIDER_AUTH', retryable: false }
      : status === 429
        ? { code: 'PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 3000 }
        : { code: 'PROVIDER_UNAVAILABLE', retryable: true };
    await expect(provider.search(request())).rejects.toMatchObject({ ...expected, data: { status } });
  });

  it.each(providerCases())('%s rejects malformed response content', async (_name, makeProvider) => {
    const provider = makeProvider(new CaptureTransport({ status: 200, body: '<not-json>' }));
    await expect(provider.search(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it.each(providerCases())('%s preserves typed malformed-JSON transport failures', async (_name, makeProvider) => {
    const provider = makeProvider(new RejectingTransport(new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider returned invalid JSON (HTTP 200).', true)));
    await expect(provider.search(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, provider: _name });
  });

  it.each(providerCases())('%s propagates cancellation from the transport signal', async (_name, makeProvider) => {
    const controller = new AbortController();
    const provider = makeProvider(new HangingTransport());
    const pending = provider.search(request(controller.signal));
    const reason = new NbSearchError('CANCELLED', 'cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it.each([
    ['firecrawl', 'firecrawl.search', { NB_SEARCH_FIRECRAWL_API_KEY: 'secret' }],
    ['brave', 'brave.search', { NB_SEARCH_BRAVE_API_KEY: 'secret' }],
  ] as const)('%s times out through the runtime deadline', async (_name, lane, env) => {
    const root = await temporaryRoot();
    const app = createRuntimeComposition(env, { cwd: root, homeDirectory: root, transport: new HangingTransport(), config: { home: root, jobs_root: join(root, 'jobs'), execution: { retry_count: 0 } } });
    await expect(app.runtime.search({ action: 'run', query: 'timeout', lane, execution: 'sync', timeout_ms: 100 })).resolves.toMatchObject({
      status: 'timed_out', output: { status: 'timed_out', lane_outcomes: [{ lane, state: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } }] },
    });
  });

  it('registers both lanes without changing defaults or presets and gates missing credentials before transport', async () => {
    const root = await temporaryRoot();
    let calls = 0;
    const transport: HttpTransport = { async send<T>() { calls += 1; return { status: 200, body: {} as T }; } };
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, transport });
    const capabilities = await app.runtime.capabilities();
    expect(capabilities.search.default_lane).toBeUndefined();
    expect(capabilities.search.presets).toEqual([]);
    expect(capabilities.search.lanes.find((lane) => lane.id === 'firecrawl.search')).toMatchObject({ output: { channel: 'results', schema_id: 'nb-search.results@1' }, availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' });
    expect(capabilities.search.lanes.find((lane) => lane.id === 'brave.search')).toMatchObject({ output: { channel: 'results', schema_id: 'nb-search.results@1' }, availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' });
    await expect(app.runtime.search({ action: 'run', query: 'no key', lane: 'firecrawl.search', execution: 'sync' })).resolves.toMatchObject({ status: 'failed', error: { code: 'LANE_NOT_CONFIGURED' } });
    await expect(app.runtime.search({ action: 'run', query: 'no key', lane: 'brave.search', execution: 'sync' })).resolves.toMatchObject({ status: 'failed', error: { code: 'LANE_NOT_CONFIGURED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['firecrawl.search', { NB_SEARCH_FIRECRAWL_API_KEY: 'secret' }, { success: true, data: { web: [] } }],
    ['brave.search', { NB_SEARCH_BRAVE_API_KEY: 'secret' }, { web: { results: [] } }],
  ] as const)('%s reports business-empty results as an empty lane outcome', async (lane, env, body) => {
    const root = await temporaryRoot();
    const app = createRuntimeComposition(env, { cwd: root, homeDirectory: root, transport: new CaptureTransport({ status: 200, body }), config: { home: root, jobs_root: join(root, 'jobs'), execution: { retry_count: 0 } } });
    await expect(app.runtime.search({ action: 'run', query: 'empty', lane, execution: 'sync' })).resolves.toMatchObject({
      status: 'empty', output: { status: 'empty', results: [], lane_outcomes: [{ lane, state: 'empty', result_count: 0 }] },
    });
  });

  it('loads the Brave credential and optional base URL from canonical environment names', async () => {
    const root = await temporaryRoot();
    const transport = new CaptureTransport({ status: 200, body: { web: { results: [] } } });
    const app = createRuntimeComposition({ NB_SEARCH_BRAVE_API_KEY: 'brave-secret', NB_SEARCH_BRAVE_BASE_URL: 'https://proxy.test/search-api' }, { cwd: root, homeDirectory: root, transport });
    expect((await app.runtime.capabilities()).search.lanes.find((lane) => lane.id === 'brave.search')?.availability).toBe('ready');
    await app.runtime.search({ action: 'run', query: 'proxy', lane: 'brave.search', execution: 'sync' });
    expect(transport.requests[0]?.url).toBe('https://proxy.test/search-api/res/v1/web/search?q=proxy&count=8');
  });
});

class CaptureTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly response: HttpResponse) {}
  async send<T>(requestValue: HttpRequest): Promise<HttpResponse<T>> { this.requests.push(requestValue); return this.response as HttpResponse<T>; }
}

class RejectingTransport implements HttpTransport {
  constructor(private readonly error: unknown) {}
  async send<T>(_request: HttpRequest): Promise<HttpResponse<T>> { throw this.error; }
}

class HangingTransport implements HttpTransport {
  async send<T>(requestValue: HttpRequest): Promise<HttpResponse<T>> {
    return await new Promise<HttpResponse<T>>((_resolve, reject) => {
      if (requestValue.signal.aborted) reject(requestValue.signal.reason);
      else requestValue.signal.addEventListener('abort', () => reject(requestValue.signal.reason), { once: true });
    });
  }
}

function providerCases(): readonly [string, (transport: HttpTransport) => SearchProvider, unknown][] {
  return [
    ['firecrawl', (transport) => new FirecrawlSearchProvider({ apiKey: 'secret', transport }), { success: true, data: { web: [] } }],
    ['brave', (transport) => new BraveSearchProvider({ apiKey: 'secret', transport }), { web: { results: [] } }],
  ];
}

function request(signal = new AbortController().signal): ProviderSearchRequest { return { query: 'query terms', limit: 2, signal }; }
async function temporaryRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'nb-search-p0-results-')); roots.push(root); return root; }
