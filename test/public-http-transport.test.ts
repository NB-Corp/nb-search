import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { createNbSearchRuntime, ResponseLimitError, type HttpRequest, type HttpResponse, type HttpTransport, type CanonicalConfigPatch } from '../src/index.ts';
import { createRuntimeComposition } from '../src/app.ts';
import { DetachedWorkerLauncher } from '../src/query-jobs.ts';

const roots: string[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;
beforeEach(() => { globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden default HTTP fallback')); });
afterEach(() => { expect(globalFetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(resolve('.test-public-http-')); roots.push(root); return { root, env: { NB_SEARCH_HOME: resolve(root, 'unused-home'), NB_SEARCH_EXA_API_KEY: 'fake-exa-public', NB_SEARCH_GROK_API_KEY: 'fake-gma-public', NB_SEARCH_EXA_BASE_URL: 'https://provider.example/exa', NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: 'https://provider.example/gma' } }; }
const evidence = 'Public fixture evidence. '.repeat(40);
const research = { answer: 'Bounded research 🌍', results: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Evidence' }], claims: [{ text: 'Claim', confidence: 'high', evidence_strength: 'direct', evidence_urls: ['https://example.com/source'] }] };
function recorder(mode: 'chat_completions' | 'messages' = 'chat_completions') {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = { async send<T>(request: HttpRequest): Promise<HttpResponse<T>> { calls.push(request); const body = request.url.endsWith('/contents') ? { results: [{ url: 'https://example.com/source', title: 'Source', text: evidence }] } : request.url.endsWith('/search') ? { results: [{ title: 'Source', url: 'https://example.com/source', text: evidence }] } : mode === 'messages' ? JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(research) }] }) : JSON.stringify({ choices: [{ message: { content: JSON.stringify(research) } }] }); return { status: 200, headers: { 'content-type': 'application/json' }, body: body as T }; } };
  return { calls, transport };
}
function config(mode: 'chat_completions' | 'messages' = 'chat_completions'): CanonicalConfigPatch { return { provider_instances: { 'grok.default': { enabled: false }, 'grok-multi-agent.default': { options: { api_mode: mode } } }, execution: { retry_count: 0 }, presets: { evidence: { lanes: ['exa.search'] } } }; }

describe('root public trusted HTTP transport seam', () => {
  it.each(['chat_completions', 'messages'] as const)('passes real Exa/GMA %s adapter requests and byte policies to the exact injected object', async (mode) => {
    const f = fixture(); const recorded = recorder(mode); const runtime = createNbSearchRuntime({ env: f.env, config: config(mode), http_transport: recorded.transport });
    expect(await runtime.search({ action: 'run', query: 'public query', lane: 'exa.search' })).toMatchObject({ status: 'succeeded', output: { channel: 'results' } });
    expect(await runtime.fetch({ url: 'https://example.com/source', pipeline: 'exa.contents' })).toMatchObject({ status: 'succeeded', documents: [{ content: evidence }] });
    expect(await runtime.search({ action: 'run', query: 'one complete brief', lane: 'gma.research' })).toMatchObject({ status: 'succeeded', output: { channel: 'typed', data: { api_mode: mode } } });
    expect(recorded.calls).toHaveLength(3);
    expect(recorded.calls[0]).toMatchObject({ url: 'https://provider.example/exa/search', method: 'POST', headers: { 'x-api-key': 'fake-exa-public' }, body: { query: 'public query' }, signal: expect.any(AbortSignal) });
    // The existing search adapter leaves the response bound to its trusted transport's own policy.
    expect(recorded.calls[0]?.max_response_bytes).toBeUndefined();
    expect(recorded.calls[1]).toMatchObject({ url: 'https://provider.example/exa/contents', method: 'POST', response_type: 'json', max_response_bytes: 2 * 1024 * 1024, headers: { 'x-api-key': 'fake-exa-public' }, body: { urls: ['https://example.com/source'] }, signal: expect.any(AbortSignal) });
    expect(recorded.calls[2]).toMatchObject({ url: `https://provider.example/gma/${mode === 'messages' ? 'messages' : 'chat/completions'}`, method: 'POST', redirect: 'manual', response_type: 'text', max_response_bytes: 1048576, headers: { Authorization: 'Bearer fake-gma-public', ...(mode === 'messages' ? { 'x-api-key': 'fake-gma-public', 'anthropic-version': '2023-06-01' } : {}) }, body: { stream: true, reasoning: { effort: 'xhigh' } }, signal: expect.any(AbortSignal) });
    expect(existsSync(f.env.NB_SEARCH_HOME)).toBe(false);
  });
  it('rejects every async run before selection, fetch preflight, jobs, launcher or transport; schema and abort still precede it', async () => {
    const f = fixture(); const recorded = recorder(); const launch = vi.spyOn(DetachedWorkerLauncher.prototype, 'launch'); const runtime = createNbSearchRuntime({ env: f.env, config: config(), http_transport: recorded.transport });
    const jobs = [
      await runtime.search({ action: 'run', query: 'async', lane: 'not-registered', execution: 'async', idempotency_key: 'a' }),
      await runtime.search({ action: 'run', query: 'async', lane: 'gma.research', execution: 'async', idempotency_key: 'b' }),
      await runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/' }, pipeline: 'browser.render', execution: 'async', idempotency_key: 'c' }),
      await runtime.fetch({ action: 'run', source: { kind: 'inline_text', content: evidence, media_type: 'text/plain' }, pipeline: 'direct.local', execution: 'async', idempotency_key: 'd' }),
      await runtime.fetch({ action: 'run', source: { kind: 'file', path: 'never-read.txt', scope: 'nonexistent' }, execution: 'async', idempotency_key: 'e' }),
    ];
    for (const result of jobs) { expect(result).toMatchObject({ action: 'run', execution: 'async', status: 'failed', error: { code: 'LANE_EXECUTION_UNSUPPORTED', retryable: false } }); expect(result).not.toHaveProperty('job'); }
    await expect(runtime.search({ action: 'run', query: '', execution: 'async', idempotency_key: 'invalid' })).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); await expect(runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/' }, execution: 'async', idempotency_key: 'aborted' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(recorded.calls).toHaveLength(0); expect(launch).not.toHaveBeenCalled(); expect(existsSync(f.env.NB_SEARCH_HOME)).toBe(false);
  });
  it('projects only effective sync modes, with async-only browser unavailable and static descriptors intact', async () => {
    const f = fixture(); const { transport } = recorder(); const runtime = createNbSearchRuntime({ env: f.env, config: config(), http_transport: transport }); const catalog = await runtime.capabilities();
    expect(catalog.search.lanes.every((lane) => !lane.execution_modes.includes('async'))).toBe(true); expect(catalog.search.presets).toContainEqual(expect.objectContaining({ name: 'evidence', execution_modes: ['sync'] })); expect(catalog.fetch.pipelines.every((lane) => !lane.execution_modes.includes('async'))).toBe(true);
    expect(catalog.fetch.pipelines.find((lane) => lane.id === 'browser.render')).toMatchObject({ availability: 'unavailable', execution_modes: [], issues: expect.arrayContaining([{ code: 'LANE_EXECUTION_UNSUPPORTED' }]) });
    expect(catalog.providers.descriptors.find((item) => item.provider_id === 'browser-render')?.fetch_operations[0]?.execution_modes).toEqual(['async']);
    const normal = await createNbSearchRuntime({ env: f.env, config: config() }).capabilities(); expect(normal.search.lanes.find((lane) => lane.id === 'exa.search')?.execution_modes).toContain('async');
  });
  it('keeps sync local/file fetch and existing get/read/cancel semantics without calling the injected HTTP object', async () => {
    const f = fixture(); writeFileSync(resolve(f.root, 'evidence.txt'), evidence); const recorded = recorder(); const runtime = createNbSearchRuntime({ env: f.env, config: { ...config(), fetch: { file_scopes: [{ id: 'test', root: f.root }] } }, http_transport: recorded.transport });
    for (const source of [{ kind: 'inline_text' as const, content: evidence, media_type: 'text/plain' as const }, { kind: 'file' as const, scope: 'test', path: 'evidence.txt' }]) expect(await runtime.fetch({ action: 'run', source, pipeline: 'direct.local' })).toMatchObject({ status: 'succeeded', documents: [{ content: evidence }] });
    for (const action of ['get', 'read', 'cancel'] as const) await expect(runtime.fetch({ action, job_id: randomUUID() })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect(recorded.calls).toHaveLength(0); expect(existsSync(f.env.NB_SEARCH_HOME)).toBe(false);
  });
  it.each(['reject', 'oversize'] as const)('preserves safe %s errors with no default HTTP fallback', async (kind) => {
    const f = fixture(); let sends = 0; const transport: HttpTransport = { async send() { sends++; throw kind === 'oversize' ? new ResponseLimitError(123) : new Error('Never expose fake-private-value'); } }; const runtime = createNbSearchRuntime({ env: f.env, config: config('messages'), http_transport: transport });
    const fetched = await runtime.fetch({ url: 'https://example.com/', pipeline: 'exa.contents' }); expect(fetched).toMatchObject({ status: 'failed', documents: [], lane_outcomes: [{ error: { code: kind === 'oversize' ? 'FETCH_BYTES_LIMIT' : 'PROVIDER_UNAVAILABLE' } }] });
    const searched = await runtime.search({ action: 'run', query: 'brief', lane: 'gma.research' }); expect(searched).toMatchObject({ status: 'failed', output: { lane_outcomes: [{ error: { code: 'PROVIDER_UNAVAILABLE', ...(kind === 'oversize' ? { retryable: false } : {}) } }] } });
    expect(JSON.stringify([fetched, searched])).not.toContain('fake-private-value'); expect(sends).toBe(2);
  });
  it('propagates caller abort into an in-flight injected transport without fallback', async () => {
    const f = fixture(); const controller = new AbortController(); let reached!: () => void; const started = new Promise<void>((done) => { reached = done; }); let sends = 0;
    const transport: HttpTransport = { async send(request) { sends++; reached(); return await new Promise<never>((_, reject) => { if (request.signal.aborted) reject(request.signal.reason); else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); }); } };
    const runtime = createNbSearchRuntime({ env: f.env, config: config(), http_transport: transport }); const pending = runtime.search({ action: 'run', query: 'abort', lane: 'exa.search' }, { signal: controller.signal }); await started; controller.abort(); expect(await pending).toMatchObject({ status: 'cancelled' }); expect(sends).toBe(1);
  });
  it('does not apply the public policy to existing internal transport compositions', async () => {
    const f = fixture(); const recorded = recorder(); const launcher = { launch: vi.fn(async () => {}) }; const composition = createRuntimeComposition(f.env, { transport: recorded.transport, launcher, config: config() });
    const started = await composition.runtime.search({ action: 'run', query: 'internal', lane: 'exa.search', execution: 'async', idempotency_key: 'internal' });
    expect(started).toMatchObject({ status: 'queued', job: { state: 'queued' } }); expect(launcher.launch).toHaveBeenCalledTimes(1);
    if (!('job' in started) || !started.job) throw new Error('Expected local job receipt');
    const injected = createNbSearchRuntime({ env: f.env, config: config(), http_transport: recorded.transport });
    expect(await injected.search({ action: 'get', job_id: started.job.job_id })).toMatchObject({ action: 'get', state: 'queued' });
    expect(await injected.search({ action: 'read', job_id: started.job.job_id })).toMatchObject({ action: 'read', chunks: [] });
    expect(await injected.search({ action: 'cancel', job_id: started.job.job_id })).toMatchObject({ action: 'cancel', state: 'cancelled' });
    expect(recorded.calls).toHaveLength(0);
  });
  it('exports portable packaged HTTP types and rejects invalid host transport objects', () => {
    const f = fixture(); for (const invalid of [null, {}, { send: 'not-callable' }]) expect(() => createNbSearchRuntime({ env: f.env, http_transport: invalid as never })).toThrow(/http_transport/);
    const file = resolve(f.root, 'consumer.mts'); const module = resolve('dist/index.mjs').replace(/\\/g, '/');
    writeFileSync(file, `import {createNbSearchRuntime, ResponseLimitError, type HttpRequest, type HttpResponse, type HttpTransport} from ${JSON.stringify(module)};\nconst transport: HttpTransport = { async send<T>(request: HttpRequest): Promise<HttpResponse<T>> { if(request.max_response_bytes === 0) throw new ResponseLimitError(0); return {status:200, body: {} as T}; } };\nconst runtime=createNbSearchRuntime({http_transport:transport}); void runtime;\n// @ts-expect-error send must be callable\ncreateNbSearchRuntime({http_transport:{send:42}});\n// @ts-expect-error redirect is not an arbitrary string\nconst invalid: HttpRequest = {url:'https://example.com',method:'POST',signal:new AbortController().signal,redirect:'unsafe'}; void invalid;`);
    // Match the repository's Node types / skipLibCheck policy; this checks the consumer contract,
    // not the pre-existing bundled Zod declarations' TS6 variance diagnostics.
    const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, types: ['node'], typeRoots: [resolve('node_modules/@types')], module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext });
    const messages = ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (name) => name, getNewLine: () => '\n' }); expect(messages).toBe('');
  }, 30000);
});
