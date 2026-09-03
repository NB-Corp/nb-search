import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import type { ProviderInstanceConfig } from '../src/config-schema.ts';
import { loadConfiguration } from '../src/config.ts';
import { NbSearchError } from '../src/errors.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import { DEFAULT_GROK_RESPONSES_URL, GrokResponsesProvider, resolveGrokResponsesUrl } from '../src/providers/grok-responses.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('xAI Responses adapter', () => {
  it('normalizes official xAI citation annotations without treating labels as page titles', async () => {
    const transport = new CaptureTransport({
      status: 200,
      body: {
        output: [
          { type: 'web_search_call', status: 'completed' },
          { type: 'message', content: [
            { type: 'output_text', text: ' First ', annotations: [
              { type: 'url_citation', url: 'https://Example.test/page/?utm_source=x#fragment', start_index: 208, end_index: 235, title: '1' },
              { type: 'url_citation', url: 'https://example.test/page', title: '2' },
              { type: 'url_citation', url: 'ftp://invalid.test/file', start_index: 236, end_index: 250, title: '3' },
            ] },
            { type: 'output_text', text: 'Second', annotations: [] },
          ] },
        ],
      },
    });
    const provider = new GrokResponsesProvider({ apiKey: 'grok-secret', model: 'grok-4.1-fast', tool: 'web_search', transport });
    await expect(provider.synthesize(queryRequest())).resolves.toEqual({
      answer: 'First\n\nSecond',
      sources: [{ url: 'https://example.test/page', start_index: 208, end_index: 235 }],
    });
    expect(transport.requests).toEqual([{
      url: DEFAULT_GROK_RESPONSES_URL,
      method: 'POST',
      headers: { Authorization: 'Bearer grok-secret', 'Content-Type': 'application/json' },
      body: { model: 'grok-4.1-fast', input: 'query', stream: false, store: false, tools: [{ type: 'web_search' }] },
      response_type: 'json',
      max_response_bytes: expect.any(Number),
      signal: expect.any(AbortSignal),
    }]);
  });

  it('binds web and X operations to independent tools and optional models', async () => {
    const transport = new CaptureTransport({ status: 200, body: { output: [{ content: [{ type: 'output_text', text: 'ok' }] }] } });
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const ports = registry.create('grok.default', grokInstance({ model: 'fallback', synthesis_model: 'web-model', x_synthesis_model: 'x-model' }, 'https://proxy.test/xai/v1'), grokContext(transport));
    await ports.query['synthesis']!.execute(queryRequest());
    await ports.query['x-synthesis']!.execute(queryRequest());
    expect(transport.requests.map((request) => ({ url: request.url, body: request.body }))).toEqual([
      { url: 'https://proxy.test/xai/v1/responses', body: { model: 'web-model', input: 'query', stream: false, store: false, tools: [{ type: 'web_search' }] } },
      { url: 'https://proxy.test/xai/v1/responses', body: { model: 'x-model', input: 'query', stream: false, store: false, tools: [{ type: 'x_search' }] } },
    ]);
  });

  it.each([
    { output: [{ content: [{ type: 'output_text', text: '', annotations: [{ type: 'url_citation', url: 'https://source.test' }] }] }] },
    { output: [{ type: 'message' }] },
  ])('rejects Responses payloads with citations or output items but no output text', async (body) => {
    const provider = createProvider(new CaptureTransport({ status: 200, body }));
    await expect(provider.synthesize(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'grok' });
  });

  it.each([401, 403])('maps HTTP %s to authentication failure with status data', async (status) => {
    await expect(createProvider(new CaptureTransport({ status, body: {} })).synthesize(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_AUTH', retryable: false, provider: 'grok', data: { status } });
  });

  it('maps HTTP 429 with retry metadata', async () => {
    await expect(createProvider(new CaptureTransport({ status: 429, body: {}, headers: { 'Retry-After': '7' } })).synthesize(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true, provider: 'grok', retryAfterMs: 7000, data: { status: 429 } });
  });

  it.each([500, 503, 599])('maps HTTP %s to a retryable unavailable failure', async (status) => {
    await expect(createProvider(new CaptureTransport({ status, body: {} })).synthesize(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, provider: 'grok', data: { status } });
  });

  it.each([
    null,
    {},
    { output: {} },
    { output: [null] },
    { output: [{ content: {} }] },
    { output: [{ content: [{ type: 'output_text' }] }] },
    { output: [{ content: [{ type: 'output_text', text: 'ok', annotations: {} }] }] },
  ])('rejects malformed Responses payload %#', async (body) => {
    await expect(createProvider(new CaptureTransport({ status: 200, body })).synthesize(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'grok' });
  });

  it('maps malformed JSON transport failures to the Grok provider', async () => {
    const transport: JsonTransport = { async send() { throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider returned invalid JSON (HTTP 200).', true); } };
    await expect(createProvider(transport).synthesize(queryRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, provider: 'grok' });
  });

  it('propagates transport timeout aborts', async () => {
    const transport: JsonTransport = { async send<T>(request: JsonRequest) { return await new Promise<JsonResponse<T>>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } };
    const controller = new AbortController();
    const timeout = new NbSearchError('DEADLINE_EXCEEDED', 'deadline exceeded');
    const pending = createProvider(transport).synthesize(queryRequest(controller.signal));
    controller.abort(timeout);
    await expect(pending).rejects.toBe(timeout);
  });

  it('propagates independent caller cancellation as CANCELLED', async () => {
    const transport: JsonTransport = { async send<T>(request: JsonRequest) { return await new Promise<JsonResponse<T>>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } };
    const controller = new AbortController();
    const cancelled = new NbSearchError('CANCELLED', 'caller cancelled');
    const pending = createProvider(transport).synthesize(queryRequest(controller.signal));
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
  });

  it('normalizes base URLs to one /v1/responses suffix', () => {
    expect(resolveGrokResponsesUrl('https://api.x.ai')).toBe(DEFAULT_GROK_RESPONSES_URL);
    expect(resolveGrokResponsesUrl('https://api.x.ai/v1/')).toBe(DEFAULT_GROK_RESPONSES_URL);
    expect(resolveGrokResponsesUrl(DEFAULT_GROK_RESPONSES_URL)).toBe(DEFAULT_GROK_RESPONSES_URL);
  });
});

describe('grok lane migration', () => {
  it('returns schema-bound typed synthesis without ranked-result projection', async () => {
    const home = await temporaryRoot();
    const transport = new CaptureTransport({ status: 200, body: { output: [{ content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://source.test' }] }] }] } });
    const app = createRuntimeComposition({ NB_SEARCH_GROK_API_KEY: 'shared' }, { cwd: home, homeDirectory: home, transport, config: { execution: { retry_count: 0 } } });
    await expect(app.runtime.search({ action: 'run', query: 'query', lane: 'grok.synthesis' })).resolves.toMatchObject({ status: 'succeeded', output: { channel: 'typed', lane: 'grok.synthesis', schema_id: 'nb-search.synthesis@1', data: { answer: 'answer', sources: [{ url: 'https://source.test/' }] } } });
  });

  it('registers only typed synthesis operations and rejects a residual grok.search config lane', async () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    expect(registry.descriptor('grok')?.query_operations).toEqual([
      { operation_id: 'synthesis', output: { channel: 'typed', schema_id: 'nb-search.synthesis@1' }, built_in_async: true },
      { operation_id: 'x-synthesis', output: { channel: 'typed', schema_id: 'nb-search.synthesis@1' }, built_in_async: true },
    ]);
    const home = await temporaryRoot();
    expect(() => loadConfiguration({}, undefined, { cwd: home, homeDirectory: home, config: { lanes: { 'grok.search': { provider_instance_id: 'grok.default', operation_id: 'search', latency: 'slow', cost: 'expensive' } } } })).toThrow(expect.objectContaining({ code: 'LANE_NOT_REGISTERED' }));
  });

  it('preflights both synthesis lanes without transport calls when the credential is missing', async () => {
    const home = await temporaryRoot();
    let calls = 0;
    const transport: JsonTransport = { async send<T>() { calls += 1; throw new Error('unexpected network') as never; } };
    const offline = createRuntimeComposition({}, { cwd: home, homeDirectory: home, transport });
    const configured = createRuntimeComposition({ NB_SEARCH_GROK_API_KEY: 'shared' }, { cwd: home, homeDirectory: home, transport });
    const offlineAvailability = Object.fromEntries((await offline.runtime.capabilities()).search.lanes.map((lane) => [lane.id, lane.availability]));
    const configuredAvailability = Object.fromEntries((await configured.runtime.capabilities()).search.lanes.map((lane) => [lane.id, lane.availability]));
    expect(offlineAvailability).toMatchObject({ 'grok.synthesis': 'unavailable', 'grok.x-synthesis': 'unavailable' });
    await expect(offline.runtime.search({ action: 'run', query: 'no key', lane: 'grok.synthesis' })).resolves.toMatchObject({ status: 'failed', error: { code: 'LANE_NOT_CONFIGURED' } });
    await expect(offline.runtime.search({ action: 'run', query: 'no key', lane: 'grok.x-synthesis' })).resolves.toMatchObject({ status: 'failed', error: { code: 'LANE_NOT_CONFIGURED' } });
    expect(configuredAvailability).toMatchObject({ 'grok.synthesis': 'ready', 'grok.x-synthesis': 'ready' });
    expect(configured.config.resolved.config.provider_instances['grok.default']?.credential_slot_id).toBe('grok.default');
    expect(configured.config.resolved.secret_bindings.get('grok.default')?.value).toBe('shared');
    expect(calls).toBe(0);
  });
});

class CaptureTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  constructor(private readonly response: JsonResponse) {}
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> { this.requests.push(request); return this.response as JsonResponse<T>; }
}
function createProvider(transport: JsonTransport): GrokResponsesProvider { return new GrokResponsesProvider({ apiKey: 'secret', model: 'grok-4.1-fast', tool: 'web_search', transport, clock: () => new Date('2026-01-01T00:00:00.000Z') }) }
function queryRequest(signal = new AbortController().signal) { return { query: 'query', limit: 3, request_time_utc: '2026-01-01T00:00:00.000Z', signal }; }
function grokInstance(options: Record<string, unknown>, base_url?: string): ProviderInstanceConfig { return { provider_id: 'grok', enabled: true, credential_slot_id: 'grok.default', ...(base_url === undefined ? {} : { base_url }), options }; }
function grokContext(transport: JsonTransport) { return { credential: { credential_slot_id: 'grok.default', provider_id: 'grok', value: 'secret', worker_grant: { kind: 'environment' as const, name: 'NB_SEARCH_GROK_API_KEY' } }, transports: { http: transport }, clock: () => new Date('2026-01-01T00:00:00.000Z') }; }
async function temporaryRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'nb-search-grok-responses-')); roots.push(root); return root; }
