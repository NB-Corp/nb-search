import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { ExaContentsFetchProvider, FirecrawlScrapeFetchProvider, JinaReaderFetchProvider, TavilyExtractFetchProvider } from '../src/fetch-providers.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';
import { document, mockRegistration } from './helpers.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const signal = new AbortController().signal;

describe('fetch provider adapters', () => {
  it('normalizes Jina Reader text and sends an optional credential header', async () => {
    const transport = new CaptureTransport({ status: 200, body: 'reader content', headers: { 'content-type': 'text/plain; charset=utf-8' } }); const provider = new JinaReaderFetchProvider({ apiKey: 'jina-secret', transport }); const value = await provider.fetch(request());
    expect(transport.requests[0]).toMatchObject({ url: 'https://r.jina.ai/https://example.com/page', method: 'GET', headers: { Accept: 'text/plain', Authorization: 'Bearer jina-secret' }, response_type: 'text' }); expect(value).toMatchObject({ content: 'reader content', final_url: 'https://example.com/page', content_type: 'text/plain', format: 'text', truncated: false });
  });

  it('normalizes Tavily Extract and sends the extract request', async () => {
    const transport = new CaptureTransport({ status: 200, body: { results: [{ url: 'https://final.test', raw_content: 'tavily content', title: 'T' }] } }); const provider = new TavilyExtractFetchProvider({ apiKey: 'tavily-secret', transport }); const value = await provider.fetch(request());
    expect(transport.requests[0]).toMatchObject({ url: 'https://api.tavily.com/extract', method: 'POST', headers: { Authorization: 'Bearer tavily-secret', 'Content-Type': 'application/json' }, body: { urls: ['https://example.com/page'], format: 'text' } }); expect(value).toMatchObject({ final_url: 'https://final.test', title: 'T', content: 'tavily content', content_type: 'text/plain' });
  });

  it('normalizes Exa Contents and sends the contents request', async () => {
    const transport = new CaptureTransport({ status: 200, body: { results: [{ url: 'https://final.test', text: 'exa content', title: 'E' }] } }); const provider = new ExaContentsFetchProvider({ apiKey: 'exa-secret', transport }); const value = await provider.fetch(request());
    expect(transport.requests[0]).toMatchObject({ url: 'https://api.exa.ai/contents', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'exa-secret' }, body: { urls: ['https://example.com/page'], text: { maxCharacters: 1000 } } }); expect(value).toMatchObject({ final_url: 'https://final.test', title: 'E', content: 'exa content', content_type: 'text/plain' });
  });

  it('normalizes Firecrawl Scrape and sends the scrape request', async () => {
    const transport = new CaptureTransport({ status: 200, body: { success: true, data: { markdown: '# Firecrawl', metadata: { title: 'F', sourceURL: 'https://final.test' } } } }); const provider = new FirecrawlScrapeFetchProvider({ apiKey: 'fire-secret', transport }); const value = await provider.fetch(request());
    expect(transport.requests[0]).toMatchObject({ url: 'https://api.firecrawl.dev/v2/scrape', method: 'POST', headers: { Authorization: 'Bearer fire-secret', 'Content-Type': 'application/json' }, body: { url: 'https://example.com/page', formats: ['markdown'] } }); expect(value).toMatchObject({ final_url: 'https://final.test', title: 'F', content: '# Firecrawl', content_type: 'text/markdown' });
  });

  it('maps Exa HTTP-200 status errors to target HTTP errors and terminates on 404', async () => {
    const response = { status: 200, body: { results: [], statuses: [{ status: 'error', error: { httpStatusCode: 404 } }] } }; await expect(new ExaContentsFetchProvider({ apiKey: 'secret', transport: new CaptureTransport(response) }).fetch(request())).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', data: { status: 404 } }); await expect(new ExaContentsFetchProvider({ apiKey: 'secret', transport: new CaptureTransport({ status: 200, body: { results: [], statuses: [{ status: 'error', error: { tag: 'CRAWL_FAILED' } }] } }) }).fetch(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const root = await mkdtemp(join(tmpdir(), 'nb-search-exa-business-failure-')); roots.push(root); let fallback = 0; const app = createRuntimeComposition({ NB_SEARCH_EXA_API_KEY: 'secret' }, { cwd: root, homeDirectory: root, transport: new CaptureTransport(response), config: { home: root, jobs_root: join(root, 'jobs'), provider_instances: { 'mock.default': { provider_id: 'mock', enabled: true, options: {} } }, lanes: { 'mock.fetch': { provider_instance_id: 'mock.default', operation_id: 'fetch', latency: 'fast', cost: 'free' } }, defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['exa.contents', 'mock.fetch'] }] }, execution: { retry_count: 0, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } }, provider_registrations: [mockRegistration({ async fetch(url) { fallback += 1; return document(url, 'fallback'); } })] });
    const value = await app.runtime.fetch({ url: 'https://example.com/page' }); expect(value).toMatchObject({ status: 'failed', documents: [], lane_outcomes: [{ lane: 'exa.contents', error: { code: 'FETCH_HTTP_ERROR', data: { status: 404 } } }] }); expect(fallback).toBe(0);
  });

  it('rejects Tavily failed_results and Firecrawl success false even with quality disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-fetch-business-failure-')); roots.push(root); const quality = { min_content_chars: 0, blocked_markers: [] };
    const tavily = createRuntimeComposition({ NB_SEARCH_TAVILY_API_KEY: 'secret' }, { cwd: root, homeDirectory: root, transport: new CaptureTransport({ status: 200, body: { results: [], failed_results: [{ url: 'https://example.com/page', error: 'blocked' }] } }), config: { home: root, jobs_root: join(root, 'tavily-jobs'), defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['tavily.extract'] }] }, execution: { retry_count: 0, fetch: { quality } } } }); const tavilyValue = await tavily.runtime.fetch({ url: 'https://example.com/page' }); expect(tavilyValue).toMatchObject({ status: 'failed', documents: [], lane_outcomes: [{ lane: 'tavily.extract', error: { code: 'PROVIDER_UNAVAILABLE' } }] });
    const firecrawl = createRuntimeComposition({ NB_SEARCH_FIRECRAWL_API_KEY: 'secret' }, { cwd: root, homeDirectory: root, transport: new CaptureTransport({ status: 200, body: { success: false } }), config: { home: root, jobs_root: join(root, 'firecrawl-jobs'), defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['firecrawl.scrape'] }] }, execution: { retry_count: 0, fetch: { quality } } } }); const firecrawlValue = await firecrawl.runtime.fetch({ url: 'https://example.com/page' }); expect(firecrawlValue).toMatchObject({ status: 'failed', documents: [], lane_outcomes: [{ lane: 'firecrawl.scrape', error: { code: 'PROVIDER_UNAVAILABLE' } }] });
  });

  it.each([
    ['Tavily', 'tavily.extract', { NB_SEARCH_TAVILY_API_KEY: 'secret' }, { status: 200, body: { results: [{ url: 'https://example.com/page', raw_content: '' }], failed_results: [] } }],
    ['Exa', 'exa.contents', { NB_SEARCH_EXA_API_KEY: 'secret' }, { status: 200, body: { results: [{ url: 'https://example.com/page', text: '' }], statuses: [{ status: 'success' }] } }],
    ['Firecrawl', 'firecrawl.scrape', { NB_SEARCH_FIRECRAWL_API_KEY: 'secret' }, { status: 200, body: { success: true, data: { markdown: '', metadata: { sourceURL: 'https://example.com/page' } } } }],
  ] as const)('lets the quality gate decide empty successful %s content', async (_name, lane, env, response) => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-empty-fetch-content-')); roots.push(root); let fallback = 0; const registration = mockRegistration({ async fetch(url) { fallback += 1; return document(url, 'fallback'); } }); const shared = { home: root, provider_instances: { 'mock.default': { provider_id: 'mock', enabled: true, options: {} } }, lanes: { 'mock.fetch': { provider_instance_id: 'mock.default', operation_id: 'fetch', latency: 'fast' as const, cost: 'free' as const } }, defaults: { fetch_chain: [{ input_kind: 'url' as const, pipelines: [lane, 'mock.fetch'] }] }, execution: { retry_count: 0 } };
    const disabled = createRuntimeComposition(env, { cwd: root, homeDirectory: root, transport: new CaptureTransport(response), config: { ...shared, jobs_root: join(root, 'disabled-jobs'), execution: { ...shared.execution, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } }, provider_registrations: [registration] }); const disabledValue = await disabled.runtime.fetch({ url: 'https://example.com/page' }); expect(disabledValue).toMatchObject({ status: 'succeeded', documents: [{ source_lane: lane, content: '' }], lane_outcomes: [{ lane, state: 'succeeded' }] }); expect(fallback).toBe(0);
    const enabled = createRuntimeComposition(env, { cwd: root, homeDirectory: root, transport: new CaptureTransport(response), config: { ...shared, jobs_root: join(root, 'enabled-jobs'), execution: { ...shared.execution, fetch: { quality: { min_content_chars: 1, blocked_markers: [] } } } }, provider_registrations: [registration] }); const enabledValue = await enabled.runtime.fetch({ url: 'https://example.com/page' }); expect(enabledValue).toMatchObject({ status: 'succeeded', documents: [{ source_lane: 'mock.fetch', content: 'fallback' }], lane_outcomes: [{ lane, error: { code: 'QUALITY_GATE_FAILED' } }, { lane: 'mock.fetch', state: 'succeeded' }] }); expect(fallback).toBe(1);
  });

  it.each([
    ['jina', (transport: JsonTransport) => new JinaReaderFetchProvider({ transport })],
    ['tavily', (transport: JsonTransport) => new TavilyExtractFetchProvider({ apiKey: 'secret', transport })],
    ['exa', (transport: JsonTransport) => new ExaContentsFetchProvider({ apiKey: 'secret', transport })],
    ['firecrawl', (transport: JsonTransport) => new FirecrawlScrapeFetchProvider({ apiKey: 'secret', transport })],
  ] as const)('maps %s upstream errors to FETCH_HTTP_ERROR', async (_name, create) => {
    for (const status of [404, 429, 500]) await expect(create(new CaptureTransport({ status, body: {} })).fetch(request())).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', retryable: status >= 500, data: { status } });
  });

  it('gates credentialed built-in lanes while keeping direct and Jina ready without keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-fetch-availability-')); roots.push(root); let network = 0; const transport: JsonTransport = { async send<T>() { network += 1; throw new Error() as never; } };
    const offline = createRuntimeComposition({}, { cwd: root, homeDirectory: root, transport }); const offlineCaps = await offline.runtime.capabilities(); expect(availability(offlineCaps)).toMatchObject({ 'direct.fetch': 'ready', 'jina.reader': 'ready', 'tavily.extract': 'unavailable', 'exa.contents': 'unavailable', 'firecrawl.scrape': 'unavailable' });
    const configured = createRuntimeComposition({ NB_SEARCH_TAVILY_API_KEY: 't', NB_SEARCH_EXA_API_KEY: 'e', NB_SEARCH_FIRECRAWL_API_KEY: 'f' }, { cwd: root, homeDirectory: root, transport }); const configuredCaps = await configured.runtime.capabilities(); expect(availability(configuredCaps)).toMatchObject({ 'tavily.extract': 'ready', 'exa.contents': 'ready', 'firecrawl.scrape': 'ready' }); expect(network).toBe(0);
  });
});

class CaptureTransport implements JsonTransport { readonly requests: JsonRequest[] = []; constructor(private readonly response: JsonResponse) {} async send<T>(value: JsonRequest): Promise<JsonResponse<T>> { this.requests.push(value); return this.response as JsonResponse<T>; } }
function request() { return { source: { kind: 'url' as const, url: 'https://example.com/page' }, representation: 'markdown' as const, signal, max_source_bytes: 4096, max_response_bytes: 4096, max_content_chars: 1000, max_redirects: 5, file_scopes: [] }; }
function availability(value: Awaited<ReturnType<ReturnType<typeof createRuntimeComposition>['runtime']['capabilities']>>): Record<string, string> { return Object.fromEntries(value.fetch.pipelines.map((pipeline) => [pipeline.id, pipeline.availability])); }
