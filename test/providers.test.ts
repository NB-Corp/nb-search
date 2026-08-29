import { describe, expect, it } from 'vitest';

import { ExaProvider, TavilyProvider, resolveSearchUrl } from '../src/providers.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';

describe('provider ports', () => {
  it('builds the Exa request and maps highlights and typed provenance metadata', async () => {
    const transport = new CaptureTransport({
      status: 200,
      body: {
        resolvedSearchType: 'deep',
        results: [{
          title: 'Example', url: 'https://example.test', highlights: ['first', 'second'],
          publishedDate: '2026-01-01', score: 0.9,
        }],
      },
    });
    const provider = new ExaProvider({ apiKey: 'exa-secret', baseUrl: 'https://proxy.test/v1', transport });
    const results = await provider.search(request());

    expect(transport.requests[0]).toMatchObject({
      url: 'https://proxy.test/v1/search',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'exa-secret' },
      body: {
        query: 'query', numResults: 3, type: 'auto', contents: { highlights: { maxCharacters: 1200 } },
      },
    });
    expect(results[0]).toMatchObject({
      snippet: 'first … second', published_at: '2026-01-01', score: 0.9,
      metadata: { resolved_search_type: 'deep' },
    });
  });

  it('builds the Tavily request, maps content, and normalizes /search once', async () => {
    const transport = new CaptureTransport({
      status: 200,
      body: { results: [{ title: 'T', url: 'https://t.test', content: 'body', published_date: '2026-02-01' }] },
    });
    const provider = new TavilyProvider({ apiKey: 'tavily-secret', transport });
    const results = await provider.search(request());

    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.tavily.com/search', headers: { 'Content-Type': 'application/json' },
      body: { api_key: 'tavily-secret', query: 'query', max_results: 3, include_answer: false },
    });
    expect(results[0]).toMatchObject({ snippet: 'body', published_at: '2026-02-01' });
    expect(resolveSearchUrl('https://api.tavily.com/search/')).toBe('https://api.tavily.com/search');
  });

  it.each([
    [401, 'PROVIDER_AUTH', false],
    [429, 'PROVIDER_RATE_LIMIT', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
  ] as const)('maps HTTP %s to %s', async (status, code, retryable) => {
    const provider = new TavilyProvider({
      apiKey: 'secret', transport: new CaptureTransport({ status, body: {} }),
    });
    await expect(provider.search(request())).rejects.toMatchObject({ code, retryable, provider: 'tavily' });
  });

  it('redacts credentials and configured endpoints from provider diagnostics', async () => {
    const transport: JsonTransport = {
      async send() { throw new Error('request https://private.test/search failed with api_key=my-secret'); },
    };
    const provider = new TavilyProvider({ apiKey: 'my-secret', baseUrl: 'https://private.test', transport });
    let caught: unknown;
    try { await provider.search(request()); } catch (error) { caught = error; }
    expect(JSON.stringify(caught)).not.toMatch(/my-secret|private\.test/);
  });
});

class CaptureTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  constructor(private readonly response: JsonResponse) {}
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    this.requests.push(request);
    return this.response as JsonResponse<T>;
  }
}

function request() {
  return { query: 'query', limit: 3, signal: new AbortController().signal };
}
