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
    expect(transport.requests[0]).toMatchObject({ url: 'https://api.tavily.com/search', headers: { 'Content-Type': 'application/json' }, body: { api_key: 'tavily-secret', query: 'query', max_results: 3, include_answer: false } });
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
    expect(tavilyTransport.requests[0]).toMatchObject({ body: { api_key: 'secret', query: 'query', max_results: 3, include_answer: 'advanced' } });
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
      { status: 200, body: '<html><form id="challenge-form">captcha</form></html>' },
      { status: 200, body: '<html>unknown layout</html>' },
      { status: 200, body: '<a class="result__a" href="javascript:alert(1)">Unsafe result</a>' },
    ]) await expect(new DuckDuckGoSearchProvider(new CaptureTransport(response)).search(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
    await expect(new DuckDuckGoSearchProvider(new CaptureTransport({ status: 429, body: '' })).search(request())).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true });
    await expect(new DuckDuckGoSearchProvider(new CaptureTransport({ status: 200, body: '<html>No results found</html>' })).search(request())).resolves.toEqual([]);
  });

  it('runs the keyless repository default without NB_SEARCH_* configuration through mocked network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-zero-config-'));
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ items: [{ full_name: 'example/project', html_url: 'https://github.com/example/project', description: 'a repository', updated_at: '2026-01-01' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root });
      const capabilities = await app.runtime.capabilities();
      expect(capabilities.search.default_lane).toBe('github.repositories');
      expect(capabilities.search.lanes.find((lane) => lane.id === 'github.repositories')?.availability).toBe('ready');
      expect(capabilities.search.lanes.find((lane) => lane.id === 'context7.docs')?.availability).toBe('ready');
      expect(await app.runtime.search({ action: 'run', query: 'example', execution: 'sync' })).toMatchObject({ status: 'succeeded', selection: { source: 'default', lanes: ['github.repositories'] }, output: { results: [{ url: 'https://github.com/example/project', title: 'example/project' }] } });
      expect(fetchMock.mock.calls[0]?.[0]).toContain('https://api.github.com/search/repositories?q=example');
    } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
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
