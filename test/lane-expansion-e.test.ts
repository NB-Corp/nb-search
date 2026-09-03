import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { NbSearchError } from '../src/errors.ts';
import { OpenAiCompatibleSynthesisProvider } from '../src/providers/openai-compatible.ts';
import { ParallelSearchProvider } from '../src/providers/parallel.ts';
import { SearxngSearchProvider } from '../src/providers/searxng.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class SequenceTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  constructor(private readonly responses: Array<JsonResponse | Error>) {}
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('No mock response.');
    return next as JsonResponse<T>;
  }
}

const searchRequest = (signal = new AbortController().signal) => ({ query: 'query', limit: 3, signal, request_time_utc: '2026-01-01T00:00:00.000Z' });
const synthesisRequest = (signal = new AbortController().signal) => ({ query: 'query', limit: 3, signal, request_time_utc: '2026-01-01T00:00:00.000Z' });
const completion = (answer = 'answer', sources: unknown[] = [{ title: 'Source', url: 'https://source.test/path' }]) => ({ choices: [{ message: { content: JSON.stringify({ answer, sources }) } }] });

function abortingTransport(): JsonTransport {
  return { async send<T>(request: JsonRequest) { return await new Promise<JsonResponse<T>>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } };
}

async function expectDeadline(run: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  const result = run(controller.signal);
  controller.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Execution deadline was exceeded.', true));
  await expect(result).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
}

async function expectCancelled(run: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  const result = run(controller.signal);
  controller.abort(new NbSearchError('CANCELLED', 'Execution was cancelled.'));
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
}

describe('parallel.search adapter', () => {
  it('uses the fixed fast request and normalizes excerpts', async () => {
    const transport = new SequenceTransport([{ status: 200, body: { results: [{ title: 'Parallel', url: 'https://parallel.test/a', excerpts: ['first', 'second'], publish_date: '2026-01-02' }] } }]);
    const provider = new ParallelSearchProvider({ apiKey: 'parallel-secret', transport });
    await expect(provider.search({ ...searchRequest(), limit: 100 })).resolves.toEqual([{ title: 'Parallel', url: 'https://parallel.test/a', snippet: 'first … second', published_at: '2026-01-02' }]);
    expect(transport.requests[0]).toMatchObject({ url: 'https://api.parallel.ai/v1/search', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'parallel-secret' }, body: { objective: 'query', search_queries: ['query'], mode: 'fast', advanced_settings: { max_results: 20 } } });
  });

  it('returns an explicit empty result set', async () => {
    const provider = new ParallelSearchProvider({ apiKey: 'secret', transport: new SequenceTransport([{ status: 200, body: { results: [] } }]) });
    await expect(provider.search(searchRequest())).resolves.toEqual([]);
  });

  it.each([[401, 'PROVIDER_AUTH', false], [403, 'PROVIDER_AUTH', false], [429, 'PROVIDER_RATE_LIMIT', true], [503, 'PROVIDER_UNAVAILABLE', true]] as const)('maps HTTP %s', async (status, code, retryable) => {
    const provider = new ParallelSearchProvider({ apiKey: 'secret', transport: new SequenceTransport([{ status, body: {}, headers: status === 429 ? { 'retry-after': '2' } : {} }]) });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code, retryable, provider: 'parallel', data: { status }, ...(status === 429 ? { retryAfterMs: 2000 } : {}) });
  });

  it('rejects malformed JSON shapes', async () => {
    const provider = new ParallelSearchProvider({ apiKey: 'secret', transport: new SequenceTransport([{ status: 200, body: { results: {} } }]) });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it('preserves timeout and cancellation signals', async () => {
    await expectDeadline(async (signal) => await new ParallelSearchProvider({ apiKey: 'secret', transport: abortingTransport() }).search(searchRequest(signal)));
    await expectCancelled(async (signal) => await new ParallelSearchProvider({ apiKey: 'secret', transport: abortingTransport() }).search(searchRequest(signal)));
  });
});

describe('searxng.search adapter', () => {
  it('builds the JSON query, retains engine attribution, and returns unresponsive-engine hints', async () => {
    const transport = new SequenceTransport([{ status: 200, body: { results: [{ title: 'SearXNG', url: 'https://searx.test/a', content: 'snippet', engine: 'google' }], unresponsive_engines: [['bing', 'timeout']] } }]);
    const provider = new SearxngSearchProvider({ baseUrl: 'https://search.internal/meta', transport });
    const value = await provider.search(searchRequest());
    expect(transport.requests[0]).toMatchObject({ url: 'https://search.internal/meta/search?q=query&format=json', method: 'GET' });
    expect(value.results).toEqual([{ title: 'SearXNG', url: 'https://searx.test/a', snippet: '[google] snippet', metadata: { engine: 'google' } }]);
    expect(value.hints).toEqual([{ code: 'SEARXNG_UNRESPONSIVE_ENGINES', message: 'Some SearXNG engines were unresponsive.', data: { unresponsive_engines: ['bing: timeout'], engine_distribution: { google: 1 } } }]);
  });

  it('returns empty only when no engine failure is reported', async () => {
    const provider = new SearxngSearchProvider({ baseUrl: 'https://search.internal', transport: new SequenceTransport([{ status: 200, body: { results: [], unresponsive_engines: [] } }]) });
    await expect(provider.search(searchRequest())).resolves.toEqual({ results: [] });
  });

  it('does not disguise all-engine failure as empty success', async () => {
    const provider = new SearxngSearchProvider({ baseUrl: 'https://search.internal', transport: new SequenceTransport([{ status: 200, body: { results: [], unresponsive_engines: [['google', 'timeout']] } }]) });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, data: { unresponsive_engines: ['google: timeout'] } });
  });

  it.each([[401, 'PROVIDER_AUTH', false], [403, 'PROVIDER_AUTH', false], [429, 'PROVIDER_RATE_LIMIT', true], [500, 'PROVIDER_UNAVAILABLE', true]] as const)('maps HTTP %s', async (status, code, retryable) => {
    const provider = new SearxngSearchProvider({ baseUrl: 'https://search.internal', transport: new SequenceTransport([{ status, body: {} }]) });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code, retryable, provider: 'searxng', data: { status } });
  });

  it('rejects malformed JSON shapes', async () => {
    const provider = new SearxngSearchProvider({ baseUrl: 'https://search.internal', transport: new SequenceTransport([{ status: 200, body: { results: 'bad' } }]) });
    await expect(provider.search(searchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it('preserves timeout and cancellation signals', async () => {
    await expectDeadline(async (signal) => await new SearxngSearchProvider({ baseUrl: 'https://search.internal', transport: abortingTransport() }).search(searchRequest(signal)));
    await expectCancelled(async (signal) => await new SearxngSearchProvider({ baseUrl: 'https://search.internal', transport: abortingTransport() }).search(searchRequest(signal)));
  });
});

describe('oac.synthesis adapter', () => {
  it('returns typed answer and merged URL citations', async () => {
    const body = { choices: [{ message: { content: '```json\n{"answer":"answer","sources":[{"url":"https://source.test/a","title":"A"}]}\n```', citations: ['https://source.test/b'] } }], citations: [{ url: 'https://source.test/c', title: 'C' }] };
    const transport = new SequenceTransport([{ status: 200, body }]);
    const provider = new OpenAiCompatibleSynthesisProvider({ apiKey: 'oac-secret', baseUrl: 'https://oac.test/v1', model: 'search-model', transport });
    await expect(provider.synthesize(synthesisRequest())).resolves.toEqual({ answer: 'answer', sources: [{ url: 'https://source.test/a', title: 'A' }, { url: 'https://source.test/c', title: 'C' }, { url: 'https://source.test/b' }] });
    expect(transport.requests[0]).toMatchObject({ url: 'https://oac.test/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer oac-secret', 'Content-Type': 'application/json' }, body: { model: 'search-model', stream: false } });
  });

  it('accepts an explicit empty synthesis structure', async () => {
    const provider = new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: new SequenceTransport([{ status: 200, body: completion('', []) }]) });
    await expect(provider.synthesize(synthesisRequest())).resolves.toEqual({ answer: '', sources: [] });
  });

  it.each([[401, 'PROVIDER_AUTH', false], [403, 'PROVIDER_AUTH', false], [429, 'PROVIDER_RATE_LIMIT', true], [502, 'PROVIDER_UNAVAILABLE', true]] as const)('maps HTTP %s', async (status, code, retryable) => {
    const provider = new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: new SequenceTransport([{ status, body: {} }]) });
    await expect(provider.synthesize(synthesisRequest())).rejects.toMatchObject({ code, retryable, provider: 'openai-compatible', data: { status } });
  });

  it('rejects missing content and malformed structured content', async () => {
    for (const body of [{ choices: [{ message: {} }] }, { choices: [{ message: { content: '{"answer":1}' } }] }]) {
      const provider = new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: new SequenceTransport([{ status: 200, body }]) });
      await expect(provider.synthesize(synthesisRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
    }
  });

  it('tries fallback_models in order', async () => {
    const transport = new SequenceTransport([{ status: 503, body: {} }, { status: 429, body: {} }, { status: 200, body: completion('fallback') }]);
    const provider = new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'primary', fallbackModels: ['fallback-a', 'fallback-b'], transport });
    await expect(provider.synthesize(synthesisRequest())).resolves.toMatchObject({ answer: 'fallback' });
    expect(transport.requests.map((item) => (item.body as { model: string }).model)).toEqual(['primary', 'fallback-a', 'fallback-b']);
  });

  it('adds :online to primary and fallback OpenRouter models once', async () => {
    const transport = new SequenceTransport([{ status: 503, body: {} }, { status: 200, body: completion() }]);
    const provider = new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://openrouter.ai/api/v1', model: 'primary', fallbackModels: ['fallback:online'], transport });
    await provider.synthesize(synthesisRequest());
    expect(transport.requests.map((item) => (item.body as { model: string }).model)).toEqual(['primary:online', 'fallback:online']);
  });

  it('preserves timeout and cancellation signals', async () => {
    await expectDeadline(async (signal) => await new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: abortingTransport() }).synthesize(synthesisRequest(signal)));
    await expectCancelled(async (signal) => await new OpenAiCompatibleSynthesisProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: abortingTransport() }).synthesize(synthesisRequest(signal)));
  });
});

describe('lane registration and configuration gating', () => {
  it('gates credentials, endpoint, and required OAC model without network probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-e-gating-')); roots.push(root);
    let calls = 0;
    const transport: JsonTransport = { async send<T>() { calls += 1; throw new Error('must not call') as never; } };
    const offline = createRuntimeComposition({}, { cwd: root, homeDirectory: root, transport });
    const offlineCaps = await offline.runtime.capabilities();
    expect(offlineCaps.search.lanes.find((lane) => lane.id === 'parallel.search')).toMatchObject({ availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }] });
    expect(offlineCaps.search.lanes.find((lane) => lane.id === 'searxng.search')).toMatchObject({ availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }] });
    expect(offlineCaps.search.lanes.find((lane) => lane.id === 'oac.synthesis')).toMatchObject({ availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }] });

    const incompleteOac = createRuntimeComposition({ NB_SEARCH_OAC_API_KEY: 'key', NB_SEARCH_OAC_BASE_URL: 'https://oac.test/v1' }, { cwd: root, homeDirectory: root, transport });
    expect((await incompleteOac.runtime.capabilities()).search.lanes.find((lane) => lane.id === 'oac.synthesis')).toMatchObject({ availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }] });

    const configured = createRuntimeComposition({ NB_SEARCH_PARALLEL_API_KEY: 'p', NB_SEARCH_SEARXNG_BASE_URL: 'https://searx.test', NB_SEARCH_OAC_API_KEY: 'o', NB_SEARCH_OAC_BASE_URL: 'https://oac.test/v1', NB_SEARCH_OAC_MODEL: 'model' }, { cwd: root, homeDirectory: root, transport });
    const configuredCaps = await configured.runtime.capabilities();
    for (const id of ['parallel.search', 'searxng.search', 'oac.synthesis']) expect(configuredCaps.search.lanes.find((lane) => lane.id === id)?.availability).toBe('ready');
    expect(calls).toBe(0);
  });

  it('projects SearXNG upstream hints into the search envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-e-hints-')); roots.push(root);
    const transport = new SequenceTransport([{ status: 200, body: { results: [{ title: 'A', url: 'https://a.test', content: 'body', engine: 'google' }], unresponsive_engines: [['bing', 'timeout']] } }]);
    const app = createRuntimeComposition({ NB_SEARCH_SEARXNG_BASE_URL: 'https://searx.test' }, { cwd: root, homeDirectory: root, transport });
    const result = await app.runtime.search({ action: 'run', query: 'query', lane: 'searxng.search' });
    expect(result).toMatchObject({ status: 'succeeded', hints: [{ code: 'SEARXNG_UNRESPONSIVE_ENGINES', data: { lane: 'searxng.search', unresponsive_engines: ['bing: timeout'], engine_distribution: { google: 1 } } }], output: { channel: 'results', hints: [{ code: 'SEARXNG_UNRESPONSIVE_ENGINES' }], results: [{ snippet: '[google] body', evidence_groups: ['searxng'] }] } });
  });
});
