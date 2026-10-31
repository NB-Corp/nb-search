import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { DuckDuckGoSearchProvider } from '../src/providers/duckduckgo.ts';
import { FetchJsonTransport } from '../src/transport.ts';
import type { ProviderInstanceConfig } from '../src/config-schema.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import { ExaProvider, TavilyProvider, resolveSearchUrl } from '../src/providers.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';

describe('provider wire adapters', () => {
  it('builds the Exa results request and maps highlights and metadata', async () => {
    const transport = new CaptureTransport({ status: 200, body: { resolvedSearchType: 'deep', results: [{ title: 'Example', url: 'https://example.test', highlights: ['first', 'second'], publishedDate: '2026-01-01', score: 0.9 }] } });
    const provider = new ExaProvider({ apiKey: 'exa-secret', baseUrl: 'https://proxy.test/v1', transport });
    const results = await provider.search(request());
    expect(transport.requests[0]).toMatchObject({ url: 'https://proxy.test/v1/search', headers: { 'Content-Type': 'application/json', 'x-api-key': 'exa-secret' }, body: { query: 'query', numResults: 3, type: 'auto', contents: { highlights: { maxCharacters: 1200 } } } });
    expect(results[0]).toMatchObject({ snippet: 'first … second', published_at: '2026-01-01', score: 0.9, metadata: { resolved_search_type: 'deep' } });
  });

  it('builds the Tavily results request and normalizes the endpoint once', async () => {
    const transport = new CaptureTransport({ status: 200, body: { results: [{ title: 'T', url: 'https://t.test', content: 'body', published_date: '2026-02-01' }] } });
    const provider = new TavilyProvider({ apiKey: 'tavily-secret', transport });
    const results = await provider.search(request());
    expect(transport.requests[0]).toMatchObject({ url: 'https://api.tavily.com/search', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tavily-secret' }, body: { query: 'query', max_results: 3, include_answer: false, include_published_date: true } });
    expect(results[0]).toMatchObject({ snippet: 'body', published_at: '2026-02-01' });
    expect(resolveSearchUrl('https://api.tavily.com/search/')).toBe('https://api.tavily.com/search');
  });

  it('adapts Exa and Tavily synthesis wire responses to schema-bound typed JSON', async () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const exaTransport = new CaptureTransport({ status: 200, body: { resolvedSearchType: 'deep', output: { content: 'exa text' }, results: [] } });
    const exa = registry.create('exa.default', instance('exa'), context('exa', exaTransport));
    await expect(exa.query['synthesis']!.execute(queryRequest())).resolves.toEqual({ channel: 'typed', data: { text: 'exa text', supporting_urls: [], resolved_type: 'deep', citation_status: { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false } } });
    expect(exaTransport.requests[0]).toMatchObject({ body: { query: 'query', numResults: 3, type: 'deep' } });

    const tavilyTransport = new CaptureTransport({ status: 200, body: { answer: 'tavily text', results: [{ title: 'Source', url: 'https://source.test', content: 'body' }] } });
    const tavily = registry.create('tavily.default', instance('tavily'), context('tavily', tavilyTransport));
    await expect(tavily.query['synthesis']!.execute(queryRequest())).resolves.toEqual({ channel: 'typed', data: { text: 'tavily text', supporting_urls: [{ url: 'https://source.test', title: 'Source', source: 'provider-result' }], citation_status: { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false } } });
    expect(tavilyTransport.requests[0]).toMatchObject({ headers: { Authorization: 'Bearer secret' }, body: { query: 'query', max_results: 3, include_answer: 'advanced', include_published_date: true } });
  });

  it.each([[401, 'PROVIDER_AUTH', false], [429, 'PROVIDER_RATE_LIMIT', true], [500, 'PROVIDER_UNAVAILABLE', true], [503, 'PROVIDER_UNAVAILABLE', true]] as const)('maps HTTP %s to %s', async (status, code, retryable) => {
    const provider = new TavilyProvider({ apiKey: 'secret', transport: new CaptureTransport({ status, body: {} }) });
    await expect(provider.search(request())).rejects.toMatchObject({ code, retryable, provider: 'tavily' });
  });

  it('preserves retry metadata and redacts credentials/endpoints from diagnostics', async () => {
    const limited = new TavilyProvider({ apiKey: 'secret', transport: new CaptureTransport({ status: 429, body: {}, headers: { 'retry-after': '7' } }) });
    await expect(limited.search(request())).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 7000 });
    const transport: JsonTransport = { async send() { throw new Error('request https://private.test/search failed with api_key=my-secret'); } };
    const provider = new TavilyProvider({ apiKey: 'my-secret', baseUrl: 'https://private.test', transport });
    let caught: unknown;
    try { await provider.search(request()); } catch (error) { caught = error; }
    expect(JSON.stringify(caught)).not.toMatch(/my-secret|private\.test/);
  });

  it('parses keyless DuckDuckGo HTML results and unmasks redirect links using a mocked fetch', async () => {
    const page = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Futm_source%3Dddg&amp;rut=1">Example &amp; Guide</a><a class="result__snippet">Helpful <b>documentation</b>.</a></div>';
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new DuckDuckGoSearchProvider(new FetchJsonTransport());
      expect(await provider.search({ ...request(), freshness: 'pw' })).toEqual([{ title: 'Example & Guide', url: 'https://example.com/guide', snippet: 'Helpful documentation.' }]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://html.duckduckgo.com/html/?q=query&df=w');
    } finally { vi.unstubAllGlobals(); }
  });

  it('reports a DuckDuckGo challenge, rate limit, and unsupported markup instead of an empty result', async () => {
    for (const response of [
      { status: 202, body: '<form id="challenge-form" class="anomaly-modal">captcha</form>' },
      { status: 202, body: '<div class="no-results">No results found</div>' },
      { status: 200, body: '<html><form id="challenge-form">captcha</form><div class="no-results">No results found</div></html>' },
      { status: 200, body: '<html>unknown layout</html>' },
      { status: 200, body: '<html>No results found</html>' },
      { status: 200, body: '<a class="result__a" href="javascript:alert(1)">Unsafe result</a>' },
    ]) await expect(new DuckDuckGoSearchProvider(new CaptureTransport(response)).search(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'duckduckgo' });
    await expect(new DuckDuckGoSearchProvider(new CaptureTransport({ status: 429, body: '', headers: { 'Retry-After': '7' } })).search(request())).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 7000 });
    await expect(new DuckDuckGoSearchProvider(new CaptureTransport({ status: 200, body: '<div class="no-results">No results found</div>' })).search(request())).resolves.toEqual([]);
    await expect(new DuckDuckGoSearchProvider(new CaptureTransport({ status: 200, body: '<a class="result__a" href="https://example.com/captcha">CAPTCHA guide</a><a class="result__snippet">How CAPTCHA works.</a>' })).search(request())).resolves.toEqual([{ title: 'CAPTCHA guide', url: 'https://example.com/captcha', snippet: 'How CAPTCHA works.' }]);
  });

  it('runs the keyless general-web default without NB_SEARCH_* configuration through mocked network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-zero-config-'));
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('<a class="result__a" href="https://example.com/astronomy">Astronomy guide</a><a class="result__snippet">Explore the universe.</a>', { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root });
      const capabilities = await app.runtime.capabilities();
      expect(capabilities.search.default_lane).toBe('duckduckgo.search');
      expect(capabilities.search.lanes.find((lane) => lane.id === 'duckduckgo.search')?.availability).toBe('ready');
      expect(capabilities.search.lanes.find((lane) => lane.id === 'context7.docs')?.availability).toBe('ready');
      expect(await app.runtime.search({ action: 'run', query: 'astronomy', execution: 'sync' })).toMatchObject({ status: 'succeeded', selection: { source: 'default', lanes: ['duckduckgo.search'] }, output: { results: [{ url: 'https://example.com/astronomy', title: 'Astronomy guide', snippet: 'Explore the universe.' }] } });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://html.duckduckgo.com/html/?q=astronomy');
    } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
  });

  it('preserves configured defaults, explicit choices and disabled search without fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-explicit-default-'));
    const transport = new CaptureTransport({ status: 200, body: { items: [{ full_name: 'example/project', html_url: 'https://github.com/example/project', description: 'a repository', updated_at: '2026-01-01' }] } });
    try {
      const options = { cwd: root, homeDirectory: root, transport };
      const configured = createRuntimeComposition({}, { ...options, config: { defaults: { search_lane: 'github.repositories' } } });
      expect(await configured.runtime.search({ action: 'run', query: 'example' })).toMatchObject({ status: 'succeeded', selection: { source: 'default', lanes: ['github.repositories'] } });
      const app = createRuntimeComposition({}, options);
      expect(await app.runtime.search({ action: 'run', query: 'example', lane: 'github.repositories' })).toMatchObject({ status: 'succeeded', selection: { source: 'lane', lanes: ['github.repositories'] } });
      for (const config of [
        { defaults: { search_lane: null } },
        { defaults: { search_lane: 'exa.search' } },
        { provider_instances: { 'duckduckgo.default': { enabled: false } } },
      ]) expect(await createRuntimeComposition({}, { ...options, config }).runtime.search({ action: 'run', query: 'example' })).toMatchObject({ status: 'failed' });
      expect(await app.runtime.search({ action: 'run', query: 'example', lane: 'exa.search' })).toMatchObject({ status: 'failed' });
      expect(transport.requests).toHaveLength(2);
      expect(transport.requests.every((value) => value.url.startsWith('https://api.github.com/'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves the official Tavily crawl and research-task protocols in typed lanes', async () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const crawlTransport = new CaptureTransport({ status: 200, body: { base_url: 'https://docs.example/', results: [{ url: 'https://docs.example/guide', raw_content: '# Guide\n\nA fact.' }], request_id: 'crawl-1' } });
    const crawl = registry.create('tavily.default', instance('tavily'), context('tavily', crawlTransport));
    await expect(crawl.query['crawl']!.execute({ ...queryRequest(), query: 'docs.example' })).resolves.toMatchObject({ channel: 'typed', data: { capability: 'crawl', documents: [{ url: 'https://docs.example/guide', content: '# Guide\n\nA fact.', representation: 'markdown' }], request_id: 'crawl-1' } });
    expect(crawlTransport.requests[0]).toMatchObject({ url: 'https://api.tavily.com/crawl', method: 'POST', headers: { Authorization: 'Bearer secret' }, body: { url: 'https://docs.example/', limit: 3, format: 'markdown', extract_depth: 'basic', timeout: 150, include_usage: true } });
    expect(crawlTransport.requests[0]?.body).not.toHaveProperty('api_key');
    const requests: JsonRequest[] = [];
    const transport: JsonTransport = { async send<T>(value: JsonRequest): Promise<JsonResponse<T>> {
      requests.push(value);
      return { status: 200, body: (value.method === 'POST' ? { request_id: 'task/1' } : { status: 'completed', content: 'A supported fact.', sources: [{ title: 'Evidence', url: 'https://docs.example/evidence' }], model: 'auto' }) as T };
    } };
    const research = registry.create('tavily.default', instance('tavily'), context('tavily', transport));
    await expect(research.query['research']!.execute(queryRequest())).resolves.toMatchObject({ channel: 'typed', data: { capability: 'research-task', task_id: 'task/1', content: 'A supported fact.', sources: [{ url: 'https://docs.example/evidence', source: 'provider-grounding' }], citation_status: { semantic_verification: false } } });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ url: 'https://api.tavily.com/research', method: 'POST', headers: { Authorization: 'Bearer secret' }, body: { input: 'query', model: 'auto', stream: false, output_length: 'standard' } });
    expect(requests[1]).toMatchObject({ url: 'https://api.tavily.com/research/task%2F1', method: 'GET', headers: { Authorization: 'Bearer secret' } });
    expect(requests[0]?.body).not.toHaveProperty('api_key');
    const failed = registry.create('tavily.default', instance('tavily'), context('tavily', { async send<T>(value: JsonRequest): Promise<JsonResponse<T>> { return { status: 200, body: (value.method === 'POST' ? { request_id: 'task-2' } : { status: 'failed' }) as T }; } }));
    await expect(failed.query['research']!.execute(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, data: { task_status: 'failed' } });
  });
});

class CaptureTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  constructor(private readonly response: JsonResponse) {}
  async send<T>(requestValue: JsonRequest): Promise<JsonResponse<T>> { this.requests.push(requestValue); return this.response as JsonResponse<T>; }
}

function instance(providerId: string): ProviderInstanceConfig { return { provider_id: providerId, enabled: true, credential_slot_id: `${providerId}.default`, options: {} }; }
function context(providerId: string, transport: JsonTransport) { return { credential: { credential_slot_id: `${providerId}.default`, provider_id: providerId, value: 'secret', worker_grant: { kind: 'environment' as const, name: 'TEST_KEY' } }, transports: { http: transport }, clock: () => new Date('2026-01-01T00:00:00.000Z') }; }
function request() { return { query: 'query', limit: 3, signal: new AbortController().signal }; }
function queryRequest() { return { query: 'query', limit: 3, request_time_utc: '2026-01-01T00:00:00.000Z', signal: new AbortController().signal }; }
