import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFetchJobRunnerFromSnapshot, createRuntimeComposition } from '../src/app.ts';
import { BrowserRenderProvider, type BrowserRenderIo } from '../src/browser-render.ts';
import { NbSearchError } from '../src/errors.ts';
import { WaybackFetchProvider } from '../src/fetch-providers.ts';
import { OpenAiCompatibleFetchProvider } from '../src/providers/openai-compatible.ts';
import { ResponseLimitError, type JsonRequest, type JsonResponse, type JsonTransport } from '../src/transport.ts';
import type { FetchProviderRequest } from '../src/types.ts';
import { document, mockRegistration } from './helpers.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const unavailableBrowser: BrowserRenderIo = {
  available: false,
  async resolve() { throw new Error('unavailable'); },
  async render() { throw new Error('unavailable'); },
};

describe('fetch pipeline registration', () => {
  it('reports exact descriptors, availability gates, and unchanged default chains', async () => {
    const root = await tempRoot('nb-search-fetch-pipeline-caps-');
    const offline = createRuntimeComposition({}, { cwd: root, homeDirectory: root, test_only_browser_render_io: unavailableBrowser });
    const caps = await offline.runtime.capabilities();
    expect(pipeline(caps, 'wayback.fetch')).toMatchObject({ input_kinds: ['url'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', availability: 'ready', stages: [{ id: 'wayback.lookup', role: 'acquire' }, { id: 'wayback.snapshot', role: 'acquire' }, { id: 'html.text', role: 'extract' }] });
    expect(pipeline(caps, 'browser.render')).toMatchObject({ input_kinds: ['url'], representations: ['markdown', 'text'], execution_modes: [], egress: 'none', availability: 'unavailable', issues: [{ code: 'BROWSER_NOT_INSTALLED' }], stages: [{ id: 'browser.chromium', role: 'acquire' }, { id: 'html.text', role: 'extract' }] });
    expect(pipeline(caps, 'oac.fetch')).toMatchObject({ input_kinds: ['url'], representations: ['markdown', 'text'], execution_modes: [], egress: 'url', availability: 'unavailable' });
    expect(caps.fetch.chains.filter((item) => item.input_kind === 'url').every((item) => item.pipelines.join(',') === 'direct.fetch,jina.reader')).toBe(true);

    const readyBrowser = browserIo();
    const configured = createRuntimeComposition({ NB_SEARCH_OAC_API_KEY: 'key', NB_SEARCH_OAC_BASE_URL: 'https://oac.test/v1', NB_SEARCH_OAC_MODEL: 'model' }, { cwd: root, homeDirectory: root, test_only_browser_render_io: readyBrowser });
    const configuredCaps = await configured.runtime.capabilities();
    expect(pipeline(configuredCaps, 'browser.render')).toMatchObject({ availability: 'ready', execution_modes: ['async'] });
    expect(pipeline(configuredCaps, 'oac.fetch')).toMatchObject({ availability: 'ready', execution_modes: ['sync'] });
  });

  it('rejects sync browser.render in preflight without invoking the renderer', async () => {
    const root = await tempRoot('nb-search-browser-sync-'); let calls = 0;
    const io = browserIo({ async render() { calls += 1; throw new Error('must not render'); } });
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, test_only_browser_render_io: io });
    const result = await app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com' }, pipeline: 'browser.render' });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'LANE_EXECUTION_UNSUPPORTED' } });
    expect(calls).toBe(0);
  });
});

describe('wayback.fetch adapter', () => {
  it('looks up a status-200 snapshot, fetches it, and annotates archive time', async () => {
    const snapshot = 'https://web.archive.org/web/20240102030405id_/https://example.com/page';
    const transport = new SequenceTransport([
      { status: 200, body: { archived_snapshots: { closest: { status: '200', url: snapshot, timestamp: '20240102030405' } } } },
      { status: 200, body: '<html><head><title>Archived</title></head><body><main>archived content</main></body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } },
    ]);
    const value = await new WaybackFetchProvider({ transport }).fetch(fetchRequest());
    expect(transport.requests[0]).toMatchObject({ url: 'https://archive.org/wayback/available?url=https%3A%2F%2Fexample.com%2Fpage', method: 'GET', response_type: 'json' });
    expect(transport.requests[1]).toMatchObject({ url: snapshot, method: 'GET', response_type: 'text' });
    expect(value).toMatchObject({ final_url: snapshot, title: 'Archived', content: 'Archived\narchived content', media_type: 'text/html', warnings: [{ code: 'WAYBACK_SNAPSHOT', data: { snapshot_timestamp: '20240102030405', archived_at: '2024-01-02T03:04:05Z' } }] });
  });

  it('maps missing snapshots to terminal 404 without chain fallback', async () => {
    const root = await tempRoot('nb-search-wayback-not-found-'); let fallback = 0;
    const transport = new SequenceTransport([{ status: 200, body: { archived_snapshots: {} } }]);
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, transport, provider_registrations: [mockRegistration({ async fetch(url) { fallback += 1; return document(url, 'fallback'); } })], config: { home: root, jobs_root: join(root, 'jobs'), provider_instances: { 'mock.default': { provider_id: 'mock', enabled: true, options: {} } }, lanes: { 'mock.fetch': { provider_instance_id: 'mock.default', operation_id: 'fetch', latency: 'fast', cost: 'free' } }, defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['wayback.fetch', 'mock.fetch'] }] }, execution: { retry_count: 0, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } } });
    const result = await app.runtime.fetch({ url: 'https://example.com/page' });
    expect(result).toMatchObject({ status: 'failed', documents: [], lane_outcomes: [{ lane: 'wayback.fetch', error: { code: 'FETCH_HTTP_ERROR', retryable: false, data: { status: 404, reason: 'snapshot_not_found' } } }] });
    expect(fallback).toBe(0);
  });

  it.each([[401, false], [403, false], [429, true], [500, true]] as const)('maps lookup HTTP %s', async (status, retryable) => {
    await expect(new WaybackFetchProvider({ transport: new SequenceTransport([{ status, body: {} }]) }).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', retryable, data: { status } });
  });

  it('rejects malformed lookup content and lets the quality gate classify an empty snapshot', async () => {
    await expect(new WaybackFetchProvider({ transport: new SequenceTransport([{ status: 200, body: [] }]) }).fetch(fetchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
    const root = await tempRoot('nb-search-wayback-empty-');
    const transport = new SequenceTransport([{ status: 200, body: { archived_snapshots: { closest: { status: 200, url: 'https://web.archive.org/snapshot', timestamp: '20200101000000' } } } }, { status: 200, body: '', headers: { 'content-type': 'text/plain' } }]);
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, transport, config: { home: root, jobs_root: join(root, 'jobs'), execution: { retry_count: 0, fetch: { quality: { min_content_chars: 1, blocked_markers: [] } } } } });
    expect(await app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/page' }, pipeline: 'wayback.fetch' })).toMatchObject({ status: 'failed', lane_outcomes: [{ error: { code: 'QUALITY_GATE_FAILED' } }] });
  });
});

describe('oac.fetch adapter', () => {
  it('sends a fetch prompt, normalizes model output, and reports citations', async () => {
    const body = { choices: [{ message: { content: '# Extracted\n\nBody', citations: ['https://source.test/a'], annotations: [{ type: 'url_citation', url_citation: { url: 'https://source.test/b', title: 'B' } }] } }] };
    const transport = new SequenceTransport([{ status: 200, body }]);
    const provider = new OpenAiCompatibleFetchProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport });
    const value = await provider.fetch(fetchRequest());
    expect(transport.requests[0]).toMatchObject({ url: 'https://oac.test/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: { model: 'model', messages: [{ role: 'system' }, { role: 'user', content: '<url>https://example.com/page</url>' }], stream: false }, max_response_bytes: 4096 });
    expect(value).toMatchObject({ final_url: 'https://example.com/page', content: '# Extracted\n\nBody', media_type: 'text/markdown', warnings: [{ code: 'OAC_CITATIONS', data: { citations: [{ url: 'https://source.test/a' }, { url: 'https://source.test/b', title: 'B' }] } }] });
  });

  it('uses OpenRouter online fallback models in order', async () => {
    const transport = new SequenceTransport([{ status: 503, body: {} }, { status: 200, body: completion('fallback content') }]);
    const provider = new OpenAiCompatibleFetchProvider({ apiKey: 'secret', baseUrl: 'https://openrouter.ai/api/v1', model: 'primary', fallbackModels: ['fallback:online'], transport });
    await expect(provider.fetch(fetchRequest())).resolves.toMatchObject({ content: 'fallback content' });
    expect(transport.requests.map((item) => (item.body as { model: string }).model)).toEqual(['primary:online', 'fallback:online']);
  });

  it.each([[401, false], [403, false], [404, false], [429, true], [502, true]] as const)('maps HTTP %s to fetch errors', async (status, retryable) => {
    const provider = new OpenAiCompatibleFetchProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: new SequenceTransport([{ status, body: {} }]) });
    await expect(provider.fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', retryable, data: { status } });
  });

  it('keeps exhausted 404 responses terminal at the fetch-chain boundary', async () => {
    const root = await tempRoot('nb-search-oac-not-found-'); let fallback = 0;
    const app = createRuntimeComposition({ NB_SEARCH_OAC_API_KEY: 'key', NB_SEARCH_OAC_BASE_URL: 'https://oac.test/v1', NB_SEARCH_OAC_MODEL: 'model' }, { cwd: root, homeDirectory: root, transport: new SequenceTransport([{ status: 404, body: {} }]), provider_registrations: [mockRegistration({ async fetch(url) { fallback += 1; return document(url, 'fallback'); } })], config: { home: root, jobs_root: join(root, 'jobs'), provider_instances: { 'mock.default': { provider_id: 'mock', enabled: true, options: {} } }, lanes: { 'mock.fetch': { provider_instance_id: 'mock.default', operation_id: 'fetch', latency: 'fast', cost: 'free' } }, defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['oac.fetch', 'mock.fetch'] }] }, execution: { retry_count: 0, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } } });
    expect(await app.runtime.fetch({ url: 'https://example.com/page' })).toMatchObject({ status: 'failed', lane_outcomes: [{ lane: 'oac.fetch', error: { code: 'FETCH_HTTP_ERROR', data: { status: 404 } } }] });
    expect(fallback).toBe(0);
  });

  it('rejects empty and malformed completions and stops after byte overflow', async () => {
    for (const body of [{}, { choices: [{ message: {} }] }, completion('')]) {
      const provider = new OpenAiCompatibleFetchProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'model', transport: new SequenceTransport([{ status: 200, body }]) });
      await expect(provider.fetch(fetchRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
    }
    const transport = new SequenceTransport([new ResponseLimitError(4096), { status: 200, body: completion('must not run') }]);
    const provider = new OpenAiCompatibleFetchProvider({ apiKey: 'secret', baseUrl: 'https://oac.test/v1', model: 'primary', fallbackModels: ['fallback'], transport });
    await expect(provider.fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_BYTES_LIMIT', retryable: false, data: { max_response_bytes: 4096 } });
    expect(transport.requests).toHaveLength(1);
  });
});

describe('browser.render adapter and jobs', () => {
  it('validates initial and redirect DNS targets and normalizes rendered HTML', async () => {
    const resolved: string[] = [];
    const io = browserIo({
      async resolve(hostname) { resolved.push(hostname); return ['93.184.216.34']; },
      async render(input) { await input.validate_redirect('https://redirect.test/final'); return { status: 200, final_url: 'https://redirect.test/final', html: '<title>Rendered</title><main>javascript content</main>', content_type: 'text/html', byte_length: 54, truncated: false }; },
    });
    const value = await new BrowserRenderProvider(io).fetch(fetchRequest());
    expect(resolved).toEqual(['example.com', 'redirect.test']);
    expect(value).toMatchObject({ final_url: 'https://redirect.test/final', title: 'Rendered', content: 'Rendered\njavascript content', media_type: 'text/html' });
  });

  it('blocks private initial, redirect, and subresource targets', async () => {
    const privateIo = browserIo({ async resolve() { return ['127.0.0.1']; } });
    await expect(new BrowserRenderProvider(privateIo).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_BLOCKED' });
    const redirectIo = browserIo({ async resolve(hostname) { return hostname === 'example.com' ? ['93.184.216.34'] : ['10.0.0.1']; }, async render(input) { await input.validate_redirect('http://private.test/path'); throw new Error('unreachable'); } });
    await expect(new BrowserRenderProvider(redirectIo).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_BLOCKED' });
    const subresourceIo = browserIo({ async resolve(hostname) { return hostname === 'example.com' ? ['93.184.216.34'] : ['169.254.169.254']; }, async render(input) { await input.validate_request('http://metadata.test/latest'); throw new Error('unreachable'); } });
    await expect(new BrowserRenderProvider(subresourceIo).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_BLOCKED' });
  });

  it('bounds redirects and rejects downloads or non-text documents', async () => {
    const redirects = browserIo({ async render(input) { await input.validate_redirect('https://one.test'); await input.validate_redirect('https://two.test'); throw new Error('unreachable'); } });
    await expect(new BrowserRenderProvider(redirects).fetch({ ...fetchRequest(), max_redirects: 1 })).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', data: { max_redirects: 1 } });
    const download = browserIo({ async render() { return { status: 200, final_url: 'https://example.com/page', html: '', content_type: 'application/octet-stream', content_disposition: 'attachment; filename=file.bin', byte_length: 0, truncated: false }; } });
    await expect(new BrowserRenderProvider(download).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_CONTENT_TYPE_REJECTED' });
  });

  it.each([[401, false], [403, false], [404, false], [429, true], [503, true]] as const)('maps rendered document HTTP %s', async (status, retryable) => {
    const io = browserIo({ async render() { return { status, final_url: 'https://example.com/page', html: 'body', content_type: 'text/html', byte_length: 4, truncated: false }; } });
    await expect(new BrowserRenderProvider(io).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', retryable, data: { status } });
  });

  it('enforces byte and character limits and preserves abort signals', async () => {
    const overflow = browserIo({ async render() { throw new ResponseLimitError(4096); } });
    await expect(new BrowserRenderProvider(overflow).fetch(fetchRequest())).rejects.toMatchObject({ code: 'FETCH_BYTES_LIMIT', data: { max_response_bytes: 4096 } });
    const bounded = browserIo({ async render() { return { status: 200, final_url: 'https://example.com/page', html: '<main>abcdef</main>', content_type: 'text/html', byte_length: 19, truncated: false }; } });
    await expect(new BrowserRenderProvider(bounded).fetch({ ...fetchRequest(), max_content_chars: 3 })).resolves.toMatchObject({ content: 'abc', truncated: true, warnings: [{ code: 'FETCH_CONTENT_CHARS_LIMIT' }] });
    const aborting = browserIo({ async render(input) { return await new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); } });
    for (const code of ['CANCELLED', 'DEADLINE_EXCEEDED'] as const) {
      const controller = new AbortController(); const promise = new BrowserRenderProvider(aborting).fetch(fetchRequest(controller.signal)); const reason = new NbSearchError(code, code); controller.abort(reason);
      await expect(promise).rejects.toBe(reason);
    }
  });

  it('runs browser.render through the unified async fetch worker', async () => {
    const root = await tempRoot('nb-search-browser-job-');
    const io = browserIo({ async render() { return { status: 200, final_url: 'https://example.com/page', html: '<main>rendered job content</main>', content_type: 'text/html', byte_length: 33, truncated: false }; } });
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, launcher: { async launch() {} }, test_only_browser_render_io: io, config: { home: root, jobs_root: join(root, 'jobs'), execution: { fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } } });
    const started = await app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/page' }, pipeline: 'browser.render', execution: 'async', idempotency_key: 'browser-job' });
    expect(started).toMatchObject({ status: 'queued', execution: 'async', selection: { source: 'pipeline', pipeline: 'browser.render' } });
    if (started.action !== 'run' || started.execution !== 'async' || started.job === undefined) throw new Error('missing browser job');
    const snapshot = await app.store.readExecutionSnapshot(started.job.job_id);
    await createFetchJobRunnerFromSnapshot(snapshot, app.store, {}, { test_only_browser_render_io: io }).run(started.job.job_id);
    expect(await app.runtime.fetch({ action: 'get', job_id: started.job.job_id })).toMatchObject({ state: 'succeeded' });
    const page = await app.runtime.fetch({ action: 'read', job_id: started.job.job_id, page_size: 100 });
    if (page.action !== 'read') throw new Error('missing browser artifact');
    const artifact = JSON.parse(Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8')) as unknown;
    expect(artifact).toMatchObject({ status: 'succeeded', documents: [{ source_lane: 'browser.render', content: 'rendered job content' }] });
  });
});

describe('fetch pipeline deadline and cancellation classification', () => {
  it.each([
    ['wayback.fetch', {}],
    ['oac.fetch', { NB_SEARCH_OAC_API_KEY: 'key', NB_SEARCH_OAC_BASE_URL: 'https://oac.test/v1', NB_SEARCH_OAC_MODEL: 'model' }],
  ] as const)('classifies timeout and cancellation for %s', async (pipelineId, env) => {
    const root = await tempRoot(`nb-search-${pipelineId}-abort-`);
    const transport: JsonTransport = { async send<T>(request: JsonRequest) { return await new Promise<JsonResponse<T>>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } };
    const app = createRuntimeComposition(env, { cwd: root, homeDirectory: root, transport, config: { home: root, jobs_root: join(root, 'jobs'), execution: { retry_count: 0, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } } });
    expect(await app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/page' }, pipeline: pipelineId, timeout_ms: 100 })).toMatchObject({ status: 'timed_out', lane_outcomes: [{ state: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } }] });
    const controller = new AbortController(); const pending = app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/page' }, pipeline: pipelineId }, { signal: controller.signal }); setTimeout(() => controller.abort(), 1);
    expect(await pending).toMatchObject({ status: 'cancelled', lane_outcomes: [{ state: 'cancelled', error: { code: 'CANCELLED' } }] });
  });
});

class SequenceTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  constructor(private readonly responses: Array<JsonResponse | Error>) {}
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> { this.requests.push(request); const response = this.responses.shift(); if (response instanceof Error) throw response; if (response === undefined) throw new Error('Missing mock response.'); return response as JsonResponse<T>; }
}

function fetchRequest(signal: AbortSignal = new AbortController().signal): FetchProviderRequest { return { source: { kind: 'url', url: 'https://example.com/page' }, representation: 'markdown', signal, max_source_bytes: 4096, max_response_bytes: 4096, max_content_chars: 1000, max_redirects: 5, file_scopes: [] }; }
function completion(content: string) { return { choices: [{ message: { content } }] }; }
function browserIo(overrides: Partial<BrowserRenderIo> = {}): BrowserRenderIo { return { available: true, async resolve() { return ['93.184.216.34']; }, async render() { return { status: 200, final_url: 'https://example.com/page', html: '<main>rendered</main>', content_type: 'text/html', byte_length: 21, truncated: false }; }, ...overrides }; }
async function tempRoot(prefix: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; }
function pipeline(value: Awaited<ReturnType<ReturnType<typeof createRuntimeComposition>['runtime']['capabilities']>>, id: string) { return value.fetch.pipelines.find((item) => item.id === id); }
