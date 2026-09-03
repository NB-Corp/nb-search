import { describe, expect, it } from 'vitest';

import { loadConfiguration } from '../src/config.ts';
import { NbSearchError } from '../src/errors.ts';
import { Context7DocsProvider } from '../src/providers/context7.ts';
import { GitHubRepositoriesProvider } from '../src/providers/github.ts';
import { ZhipuSearchProvider } from '../src/providers/zhipu.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';

const clock = () => new Date('2026-01-01T00:00:00.000Z');

describe('Context7 docs adapter', () => {
  it('resolves a library then returns stable typed documentation context', async () => {
    const transport = new QueueTransport([
      { status: 200, body: { results: [{ id: '/colinhacks/zod', title: ' Zod ', description: ' Schema validation ' }] } },
      { status: 200, body: { codeSnippets: [{ codeTitle: 'Parse', codeDescription: 'Validate input', codeLanguage: 'ts', codeId: 'https://github.com/colinhacks/zod/blob/main/README.md', codeList: [{ language: 'ts', code: 'schema.parse(value);' }] }], infoSnippets: [{ pageId: 'https://zod.dev/basics', breadcrumb: 'Basics', content: 'Use parse.' }] } },
    ]);
    const provider = new Context7DocsProvider({ apiKey: 'context-secret', transport, clock });
    const result = await provider.execute(queryRequest());
    expect(result).toEqual({ channel: 'typed', data: { library: { id: '/colinhacks/zod', title: 'Zod', description: 'Schema validation' }, content: '### Parse\n\nValidate input\n\n```ts\nschema.parse(value);\n```\n\n---\n\n### Basics\n\nUse parse.', sources: [{ url: 'https://github.com/colinhacks/zod/blob/main/README.md', title: 'Parse' }, { url: 'https://zod.dev/basics', title: 'Basics' }] } });
    expect(transport.requests).toHaveLength(2);
    expect(new URL(transport.requests[0]!.url)).toMatchObject({ pathname: '/api/v2/libs/search' });
    expect(Object.fromEntries(new URL(transport.requests[0]!.url).searchParams)).toEqual({ libraryName: 'query', query: 'query' });
    const contextUrl = new URL(transport.requests[1]!.url);
    expect(contextUrl.pathname).toBe('/api/v2/context');
    expect(Object.fromEntries(contextUrl.searchParams)).toEqual({ libraryId: '/colinhacks/zod', query: 'query', type: 'json' });
    expect(transport.requests[0]!.headers).toMatchObject({ Authorization: 'Bearer context-secret', Accept: 'application/json', 'X-Context7-Source': 'nb-search' });
  });

  it('returns an empty typed value without a context call when no library matches', async () => {
    const transport = new QueueTransport([{ status: 200, body: { results: [] } }]);
    await expect(new Context7DocsProvider({ transport }).execute(queryRequest())).resolves.toEqual({ channel: 'typed', data: { library: null, content: '' } });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.headers).not.toHaveProperty('Authorization');
  });

  it.each(httpFailures)('maps HTTP $status failures', async ({ status, code, retryable }) => {
    const provider = new Context7DocsProvider({ transport: new QueueTransport([{ status, body: {} }]), clock });
    await expect(provider.execute(queryRequest())).rejects.toMatchObject({ code, retryable, provider: 'context7', data: { status } });
  });

  it.each(httpFailures)('maps context lookup HTTP $status failures', async ({ status, code, retryable }) => {
    const provider = new Context7DocsProvider({ transport: new QueueTransport([libraryResponse(), { status, body: {} }]), clock });
    await expect(provider.execute(queryRequest())).rejects.toMatchObject({ code, retryable, provider: 'context7', data: { status } });
  });

  it('rejects malformed content from either Context7 stage and explicit upstream failures', async () => {
    await expect(new Context7DocsProvider({ transport: new QueueTransport([{ status: 200, body: '{' }]) }).execute(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'context7' });
    await expect(new Context7DocsProvider({ transport: new QueueTransport([libraryResponse(), { status: 200, body: '{' }]) }).execute(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'context7' });
    await expect(new Context7DocsProvider({ transport: new QueueTransport([{ status: 200, body: { results: [], error: 'quota_exhausted' } }]) }).execute(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it('propagates caller cancellation during library search', async () => {
    await expect(cancelled((signal) => new Context7DocsProvider({ transport: new QueueTransport([]) }).execute(queryRequest(signal)))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('propagates timeout from the Context7 context lookup', async () => {
    const transport = new QueueTransport([libraryResponse()]);
    await expect(timeout((signal) => new Context7DocsProvider({ transport }).execute(queryRequest(signal)))).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(transport.requests).toHaveLength(2);
  });

  it('propagates caller cancellation from the Context7 context lookup', async () => {
    const transport = new QueueTransport([libraryResponse()]);
    await expect(cancelled((signal) => new Context7DocsProvider({ transport }).execute(queryRequest(signal)))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transport.requests).toHaveLength(2);
  });

  it('is ready without a key', () => {
    const app = loadConfiguration({}, new QueueTransport([]), configOptions());
    expect(app.lanes['context7.docs']).toMatchObject({ availability: 'ready', issues: [], execution_modes: ['sync', 'async'] });
  });
});

describe('Zhipu search adapter', () => {
  it('builds the search_std request and normalizes results', async () => {
    const transport = new QueueTransport([{ status: 200, body: { search_result: [{ title: ' Result ', link: 'https://example.test/path?utm_source=x', content: ' useful  snippet ', publish_date: '2026-02-03' }] } }]);
    const provider = new ZhipuSearchProvider({ apiKey: 'zhipu-secret', transport, baseUrl: 'https://proxy.test/api', clock });
    await expect(provider.search(searchRequest())).resolves.toEqual([{ title: 'Result', url: 'https://example.test/path', snippet: 'useful snippet', published_at: '2026-02-03' }]);
    expect(transport.requests[0]).toMatchObject({ url: 'https://proxy.test/api/paas/v4/web_search', method: 'POST', headers: { Authorization: 'Bearer zhipu-secret', Accept: 'application/json', 'Content-Type': 'application/json' }, body: { search_query: 'query', search_engine: 'search_std', search_intent: false, count: 3 } });
  });

  it('clamps Zhipu count to the upstream maximum for limits above ten', async () => {
    const transport = new QueueTransport([{ status: 200, body: { search_result: [] } }]);
    await expect(new ZhipuSearchProvider({ apiKey: 'key', transport }).search(searchRequest(undefined, 75))).resolves.toEqual([]);
    expect(transport.requests[0]!.body).toEqual({ search_query: 'query', search_engine: 'search_std', search_intent: false, count: 50 });
  });

  it('returns an empty result set', async () => {
    await expect(new ZhipuSearchProvider({ apiKey: 'key', transport: new QueueTransport([{ status: 200, body: { search_result: [] } }]) }).search(searchRequest())).resolves.toEqual([]);
  });

  it.each(httpFailures)('maps HTTP $status failures', async ({ status, code, retryable }) => {
    const provider = new ZhipuSearchProvider({ apiKey: 'key', transport: new QueueTransport([{ status, body: {} }]), clock });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code, retryable, provider: 'zhipu', data: { status } });
  });

  it('rejects malformed and explicit upstream failures', async () => {
    await expect(new ZhipuSearchProvider({ apiKey: 'key', transport: new QueueTransport([{ status: 200, body: '{' }]) }).search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'zhipu' });
    await expect(new ZhipuSearchProvider({ apiKey: 'key', transport: new QueueTransport([{ status: 200, body: { code: 1001, message: 'rejected' } }]) }).search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it('propagates Zhipu timeout aborts', async () => {
    await expect(timeout((signal) => new ZhipuSearchProvider({ apiKey: 'key', transport: new QueueTransport([]) }).search(searchRequest(signal)))).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });

  it('propagates Zhipu caller cancellation', async () => {
    await expect(cancelled((signal) => new ZhipuSearchProvider({ apiKey: 'key', transport: new QueueTransport([]) }).search(searchRequest(signal)))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('requires a credential for readiness', () => {
    const transport = new QueueTransport([]);
    const app = loadConfiguration({}, transport, configOptions());
    expect(app.lanes['zhipu.search']).toMatchObject({ availability: 'unavailable', issues: ['LANE_NOT_CONFIGURED'], execution_modes: [] });
    expect(transport.requests).toHaveLength(0);
    const configured = loadConfiguration({ NB_SEARCH_ZHIPU_API_KEY: 'key', NB_SEARCH_ZHIPU_BASE_URL: 'https://proxy.test/api' }, new QueueTransport([]), configOptions());
    expect(configured.lanes['zhipu.search']).toMatchObject({ availability: 'ready', issues: [], execution_modes: ['sync', 'async'] });
    expect(configured.resolved.config.provider_instances['zhipu.default']?.base_url).toBe('https://proxy.test/api');
  });
});

describe('GitHub repository search adapter', () => {
  it('builds the repository query and normalizes items', async () => {
    const transport = new QueueTransport([{ status: 200, body: { items: [{ full_name: 'upstash/context7', html_url: 'https://github.com/upstash/context7', description: 'Up-to-date docs', updated_at: '2026-03-04T00:00:00Z' }] } }]);
    const provider = new GitHubRepositoriesProvider({ token: 'github-secret', transport, clock });
    await expect(provider.search(searchRequest())).resolves.toEqual([{ title: 'upstash/context7', url: 'https://github.com/upstash/context7', snippet: 'Up-to-date docs', published_at: '2026-03-04T00:00:00Z' }]);
    expect(transport.requests[0]!.headers).toEqual({ Accept: 'application/vnd.github+json', Authorization: 'Bearer github-secret' });
    const url = new URL(transport.requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.github.com/search/repositories');
    expect(url.searchParams.get('q')).toBe('query');
  });

  it('returns an empty result set without a token', async () => {
    const transport = new QueueTransport([{ status: 200, body: { items: [] } }]);
    await expect(new GitHubRepositoriesProvider({ transport }).search(searchRequest())).resolves.toEqual([]);
    expect(transport.requests[0]!.headers).toEqual({ Accept: 'application/vnd.github+json' });
  });

  it.each(githubHttpFailures)('maps HTTP $status failures', async ({ status, code, retryable }) => {
    const provider = new GitHubRepositoriesProvider({ transport: new QueueTransport([{ status, body: {} }]), clock });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code, retryable, provider: 'github', data: { status } });
  });

  it('maps an ordinary GitHub 403 to authentication failure', async () => {
    const provider = new GitHubRepositoriesProvider({ transport: new QueueTransport([{ status: 403, body: { message: 'Resource not accessible' }, headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1767229200' } }]), clock });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_AUTH', retryable: false, data: { status: 403 } });
  });

  it('maps GitHub 403 rate-limit signals and reset metadata to retryable rate limits', async () => {
    const reset = Math.floor(clock().getTime() / 1000) + 5;
    const primary = new GitHubRepositoriesProvider({ transport: new QueueTransport([{ status: 403, body: {}, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) } }]), clock });
    await expect(primary.search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 5000, data: { status: 403 } });
    const secondary = new GitHubRepositoriesProvider({ transport: new QueueTransport([{ status: 403, body: { message: 'You have exceeded a secondary rate limit.' }, headers: { 'retry-after': '7' } }]), clock });
    await expect(secondary.search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 7000, data: { status: 403 } });
  });

  it('rejects malformed content', async () => {
    await expect(new GitHubRepositoriesProvider({ transport: new QueueTransport([{ status: 200, body: '{' }]) }).search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'github' });
  });

  it('propagates GitHub timeout aborts', async () => {
    await expect(timeout((signal) => new GitHubRepositoriesProvider({ transport: new QueueTransport([]) }).search(searchRequest(signal)))).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });

  it('propagates GitHub caller cancellation', async () => {
    await expect(cancelled((signal) => new GitHubRepositoriesProvider({ transport: new QueueTransport([]) }).search(searchRequest(signal)))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports unauthenticated rate-limit risk while ready', () => {
    const unauthenticated = loadConfiguration({}, new QueueTransport([]), configOptions());
    expect(unauthenticated.lanes['github.repositories']).toMatchObject({ availability: 'ready', issues: ['RATE_LIMIT_UNAUTHENTICATED'], execution_modes: ['sync', 'async'] });
    const authenticated = loadConfiguration({ NB_SEARCH_GITHUB_TOKEN: 'token' }, new QueueTransport([]), configOptions());
    expect(authenticated.lanes['github.repositories']).toMatchObject({ availability: 'ready', issues: [] });
  });
});

const httpFailures = [
  { status: 401, code: 'PROVIDER_AUTH', retryable: false },
  { status: 403, code: 'PROVIDER_AUTH', retryable: false },
  { status: 429, code: 'PROVIDER_RATE_LIMIT', retryable: true },
  { status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: true },
] as const;
const githubHttpFailures = [
  { status: 401, code: 'PROVIDER_AUTH', retryable: false },
  { status: 429, code: 'PROVIDER_RATE_LIMIT', retryable: true },
  { status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: true },
] as const;

class QueueTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  constructor(private readonly responses: JsonResponse[]) {}
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    this.requests.push(request);
    if (request.signal.aborted) throw request.signal.reason;
    const response = this.responses.shift();
    if (response === undefined) return await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    return response as JsonResponse<T>;
  }
}

async function timeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const promise = run(controller.signal);
  controller.abort(new NbSearchError('DEADLINE_EXCEEDED', 'The operation timed out.', true));
  return await promise;
}
async function cancelled<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const promise = run(controller.signal);
  controller.abort(new NbSearchError('CANCELLED', 'The operation was cancelled.'));
  return await promise;
}
function libraryResponse(): JsonResponse { return { status: 200, body: { results: [{ id: '/colinhacks/zod', title: 'Zod', description: 'Schema validation' }] } }; }
function queryRequest(signal = new AbortController().signal) { return { query: 'query', limit: 3, request_time_utc: '2026-01-01T00:00:00.000Z', signal }; }
function searchRequest(signal = new AbortController().signal, limit = 3) { return { query: 'query', limit, signal }; }
function configOptions() { return { cwd: 'C:/tmp/nb-search-vertical-providers', homeDirectory: 'C:/tmp/nb-search-vertical-providers' }; }
