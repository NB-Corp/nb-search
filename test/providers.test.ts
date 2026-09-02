import { describe, expect, it } from 'vitest';
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
