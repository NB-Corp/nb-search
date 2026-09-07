import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { remoteIdempotencyContent } from '../../src/remote-protocol.ts';

/**
 * Test-only loopback service. This is deliberately not a production HTTP server:
 * it has no authentication, tenancy, provider execution, persistence, or egress.
 */
export interface RemoteHttpRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: unknown;
}

export interface RemoteHttpResponse {
  status?: number;
  headers?: Record<string, string | number>;
  omit_headers?: readonly string[];
  body?: string | Uint8Array;
  chunks?: readonly (string | Uint8Array)[];
  omit_content_length?: boolean;
  delay_ms?: number;
  chunk_delay_ms?: number;
  close?: boolean;
}

export type RemoteHttpHandler = (request: RemoteHttpRequest, fixture: RemoteHttpFixture) => RemoteHttpResponse | Promise<RemoteHttpResponse>;

export interface RemoteHttpFixture {
  readonly server: Server;
  readonly requests: readonly RemoteHttpRequest[];
  readonly base_url: string;
  setHandler(handler: RemoteHttpHandler): void;
  start(): Promise<void>;
  close(): Promise<void>;
  waitForRequests(count: number, timeout_ms?: number): Promise<void>;
}

const PROTOCOL = '1';
const SCHEMA_VERSION = '3.0';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const DEFAULT_JOB_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_ARTIFACT = {
  media_type: 'application/json' as const,
  byte_length: 5,
  sha256: 'a'.repeat(64),
  expires_at: '2027-01-01T00:00:00.000Z',
};

export function jsonResponse(value: unknown, options: Omit<RemoteHttpResponse, 'body' | 'chunks'> = {}): RemoteHttpResponse {
  return { ...options, body: JSON.stringify(value) };
}

export function serviceError(status: number, code: string, retryable: boolean, retry_after_ms?: number, headers: Record<string, string | number> = {}): RemoteHttpResponse {
  return jsonResponse({ error: { code, message: `fixture ${code}`, retryable, ...(retry_after_ms === undefined ? {} : { retry_after_ms }) } }, { status, headers });
}

export function createRemoteHttpFixture(handler: RemoteHttpHandler = defaultRemoteHandler): RemoteHttpFixture {
  const requests: RemoteHttpRequest[] = [];
  const waiters: Array<{ count: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  let currentHandler = handler;
  let started = false;
  let port: number | undefined;

  const server = createServer((incoming, response) => {
    void readRequest(incoming, response).then(async (request) => {
      requests.push(request);
      notifyWaiters();
      try {
        const result = await currentHandler(request, fixture);
        await writeResponse(response, request, result);
      } catch {
        if (!response.destroyed) {
          await writeResponse(response, request, serviceError(500, 'INTERNAL', true));
        }
      }
    });
  });

  const fixture: RemoteHttpFixture = {
    server,
    get requests() { return requests; },
    get base_url() { return port === undefined ? '' : `http://127.0.0.1:${port}/`; },
    setHandler(next) { currentHandler = next; },
    async start() {
      if (started) return;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (address === null || typeof address === 'string') { reject(new Error('loopback server did not expose a port')); return; }
          port = address.port;
          started = true;
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
    },
    async close() {
      for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('fixture closed')); }
      if (!started) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      started = false;
      port = undefined;
    },
    async waitForRequests(count, timeout_ms = 2000) {
      if (requests.length >= count) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${count} loopback requests`));
        }, timeout_ms);
        waiters.push({ count, resolve, reject, timer });
      });
    },
  };

  function notifyWaiters(): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || requests.length < waiter.count) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  return fixture;
}

async function readRequest(incoming: import('node:http').IncomingMessage, response: ServerResponse): Promise<RemoteHttpRequest> {
  const chunks: Buffer[] = [];
  incoming.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  await new Promise<void>((resolve) => incoming.once('end', resolve));
  const body = Buffer.concat(chunks);
  let json: unknown;
  try { json = JSON.parse(body.toString('utf8')); } catch { json = undefined; }
  response.on('error', () => {});
  return { method: incoming.method ?? 'GET', url: incoming.url ?? '/', headers: incoming.headers, body, json };
}

async function writeResponse(response: ServerResponse, request: RemoteHttpRequest, result: RemoteHttpResponse): Promise<void> {
  if (result.delay_ms !== undefined) await delay(result.delay_ms);
  if (response.destroyed) return;
  response.statusCode = result.status ?? 200;
  const omit = new Set((result.omit_headers ?? []).map((name) => name.toLowerCase()));
  const requestId = request.headers['x-request-id'];
  const defaultHeaders: Record<string, string | number> = {
    'content-type': 'application/json',
    'x-nb-search-protocol': PROTOCOL,
    'x-request-id': Array.isArray(requestId) ? requestId[0] ?? '' : requestId ?? '',
  };
  const headers = { ...defaultHeaders, ...(result.headers ?? {}) };
  for (const [name, value] of Object.entries(headers)) if (!omit.has(name.toLowerCase())) response.setHeader(name, value);

  if (result.chunks !== undefined) {
    const chunks = result.chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (!result.omit_content_length && !omit.has('content-length')) response.setHeader('content-length', chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    response.flushHeaders();
    for (const chunk of chunks) {
      if (response.destroyed) return;
      response.write(chunk);
      if (result.chunk_delay_ms !== undefined) await delay(result.chunk_delay_ms);
    }
    if (!response.destroyed) response.end();
    return;
  }

  const body = result.body === undefined ? Buffer.alloc(0) : Buffer.from(result.body);
  if (!result.omit_content_length && !omit.has('content-length')) response.setHeader('content-length', body.byteLength);
  if (result.close) { response.destroy(); return; }
  response.end(body);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function searchSyncEnvelope(query = 'fixture query') {
  const result = {
    title: query,
    url: 'https://example.com/fixture-result',
    snippet: 'fixture result',
    evidence_groups: ['fixture'],
    provenance: [{ lane: 'fixture.search', provider_instance_id: 'fixture.default', query_index: 0, rank: 0, original_url: 'https://example.com/fixture-result', evidence_groups: ['fixture'] }],
  };
  const outcome = { lane: 'fixture.search', ok: true, state: 'succeeded' as const, duration_ms: 1, result_count: 1, warnings: [] };
  const output = { channel: 'results' as const, schema_id: 'nb-search.results@1' as const, status: 'succeeded' as const, lanes: ['fixture.search'], results: [result], lane_outcomes: [outcome], merge_summary: { input_rows: 1, canonical_dedup: 0, independent_evidence_groups: 1, result_count: 1 }, hints: [] };
  return { schema_version: SCHEMA_VERSION, action: 'run' as const, execution: 'sync' as const, selection: { source: 'default' as const, lanes: ['fixture.search'] }, status: 'succeeded' as const, output, hints: [] };
}

export function searchAsyncEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'queued', reused = false, extra: Record<string, unknown> = {}) {
  return { schema_version: SCHEMA_VERSION, action: 'run' as const, execution: 'async' as const, selection: { source: 'default' as const, lanes: ['fixture.search'] }, status: 'queued' as const, channel: 'results' as const, schema_id: 'nb-search.results@1', job: { job_id, state, created_at: TIMESTAMP }, reused, poll_after_ms: 25, hints: [], ...extra };
}

export function searchFailedAsyncEnvelope(job_id: string, reused = true, message = 'fixture worker failed') {
  return { schema_version: SCHEMA_VERSION, action: 'run' as const, execution: 'async' as const, status: 'failed' as const, reused, job: { job_id, state: 'failed' as const, created_at: TIMESTAMP }, error: { code: 'WORKER_START_FAILED' as const, message, retryable: false }, hints: [] };
}

export function searchGetEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'queued', cancel_requested = false, error?: Record<string, unknown>) {
  return { schema_version: SCHEMA_VERSION, action: 'get' as const, job_id, state, cancel_requested, created_at: TIMESTAMP, updated_at: TIMESTAMP, ...(error === undefined ? {} : { error }), ...(state === 'queued' || state === 'running' ? { poll_after_ms: 25 } : {}) };
}

export function searchReadEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'queued') {
  return { schema_version: SCHEMA_VERSION, action: 'read' as const, job_id, state, ...(state === 'succeeded' ? { artifact: DEFAULT_ARTIFACT } : {}), chunks: state === 'succeeded' ? [{ index: 0, offset: 0, byte_length: 5, data_base64: 'aGVsbG8=' }] : [] };
}

export function searchCancelEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'cancelled', cancel_requested = true) {
  return { schema_version: SCHEMA_VERSION, action: 'cancel' as const, job_id, state, cancel_requested };
}

export function fetchSyncEnvelope(url = 'https://example.com/fixture') {
  const outcome = { lane: 'fixture.fetch', ok: true, state: 'succeeded' as const, duration_ms: 1, result_count: 1, warnings: [] };
  const document = { url, final_url: url, title: 'Fixture document', content: '# Fixture', content_type: 'text/html', media_type: 'text/html', representation: 'markdown' as const, format: 'text' as const, byte_length: 9, truncated: false, warnings: [], source_lane: 'fixture.fetch' };
  return { schema_version: SCHEMA_VERSION, mode: 'fetch' as const, action: 'run' as const, execution: 'sync' as const, selection: { source: 'default' as const }, status: 'succeeded' as const, lane_outcomes: [outcome], documents: [document], hints: [] };
}

export function fetchAsyncEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'queued', reused = false, extra: Record<string, unknown> = {}) {
  return { schema_version: SCHEMA_VERSION, mode: 'fetch' as const, action: 'run' as const, execution: 'async' as const, selection: { source: 'default' as const }, status: 'queued' as const, schema_id: 'nb-search.fetch@1', job: { job_id, state, created_at: TIMESTAMP }, reused, poll_after_ms: 25, hints: [], ...extra };
}

export function fetchFailedAsyncEnvelope(job_id: string, reused = true, message = 'fixture worker failed') {
  return { schema_version: SCHEMA_VERSION, mode: 'fetch' as const, action: 'run' as const, execution: 'async' as const, status: 'failed' as const, reused, job: { job_id, state: 'failed' as const, created_at: TIMESTAMP }, error: { code: 'WORKER_START_FAILED' as const, message, retryable: false }, hints: [] };
}

export function fetchGetEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'queued', cancel_requested = false, error?: Record<string, unknown>) {
  return { schema_version: SCHEMA_VERSION, mode: 'fetch' as const, action: 'get' as const, job_id, state, cancel_requested, created_at: TIMESTAMP, updated_at: TIMESTAMP, ...(error === undefined ? {} : { error }), ...(state === 'queued' || state === 'running' ? { poll_after_ms: 25 } : {}) };
}

export function fetchReadEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'queued') {
  return { schema_version: SCHEMA_VERSION, mode: 'fetch' as const, action: 'read' as const, job_id, state, ...(state === 'succeeded' ? { artifact: DEFAULT_ARTIFACT } : {}), chunks: state === 'succeeded' ? [{ index: 0, offset: 0, byte_length: 5, data_base64: 'aGVsbG8=' }] : [] };
}

export function fetchCancelEnvelope(job_id = DEFAULT_JOB_ID, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'cancelled', cancel_requested = true) {
  return { schema_version: SCHEMA_VERSION, mode: 'fetch' as const, action: 'cancel' as const, job_id, state, cancel_requested };
}

export function capabilityEnvelope() {
  return {
    schema_version: SCHEMA_VERSION,
    revision: 'fixture-revision-1',
    providers: {
      descriptors: [{ provider_id: 'fixture-provider', adapter_version: 'fixture-1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [{ operation_id: 'fetch', schema_id: 'nb-search.fetch@1', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'fixture.fetch', role: 'reader' }] }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] }],
      instances: [{ id: 'fixture.default', provider_id: 'fixture-provider', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } }],
    },
    search: {
      default_lane: 'fixture.search',
      lanes: [{ id: 'fixture.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' }],
      presets: [{ name: 'fixture', lanes: ['fixture.search'], execution_modes: ['sync', 'async'], availability: 'ready', issues: [] }],
      limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 1024 * 1024 },
    },
    fetch: {
      default_representation: 'markdown',
      inputs: [
        { kind: 'url', enabled: true, max_bytes: 1024 * 1024, media_types: ['text/html'] },
        { kind: 'inline_text', enabled: false, max_bytes: 0, media_types: ['text/html'] },
        { kind: 'inline_bytes', enabled: false, max_bytes: 0, media_types: ['text/html'] },
        { kind: 'file', enabled: false, max_bytes: 0, media_types: ['text/html'], scope_ids: [] },
      ],
      chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['fixture.fetch'] }, { input_kind: 'url', representation: 'text', pipelines: ['fixture.fetch'] }],
      pipelines: [{ id: 'fixture.fetch', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'fixture.fetch', role: 'reader' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' }],
      limits: { max_source_bytes: 1024 * 1024, max_response_bytes: 8 * 1024 * 1024, max_content_chars: 10_000, max_redirects: 5, max_timeout_ms: 120_000, max_inline_bytes: 1024 * 1024 },
    },
    jobs: { result_ttl_seconds: 3600, cancel_supported: true },
  };
}

export const defaultRemoteHandler: RemoteHttpHandler = (request) => {
  const path = request.url.split('?', 1)[0];
  const body = request.json as Record<string, unknown> | undefined;
  const action = body?.['action'];
  if (request.method !== 'POST') return serviceError(405, 'HTTP_ERROR', false);
  if (path === '/v1/capabilities') return jsonResponse(capabilityEnvelope());
  if (path === '/v1/search') {
    if (action === 'run' && body?.['execution'] === 'async') return jsonResponse(searchAsyncEnvelope());
    if (action === 'run') return jsonResponse(searchSyncEnvelope(typeof body?.['query'] === 'string' ? body['query'] as string : 'fixture query'));
    if (action === 'get') return jsonResponse(searchGetEnvelope(String(body?.['job_id'])));
    if (action === 'read') return jsonResponse(searchReadEnvelope(String(body?.['job_id'])));
    if (action === 'cancel') return jsonResponse(searchCancelEnvelope(String(body?.['job_id'])));
  }
  if (path === '/v1/fetch') {
    if (action === 'run' && body?.['execution'] === 'async') return jsonResponse(fetchAsyncEnvelope());
    if (action === 'run') return jsonResponse(fetchSyncEnvelope(String((body?.['source'] as { url?: string } | undefined)?.url ?? 'https://example.com/fixture')));
    if (action === 'get') return jsonResponse(fetchGetEnvelope(String(body?.['job_id'])));
    if (action === 'read') return jsonResponse(fetchReadEnvelope(String(body?.['job_id'])));
    if (action === 'cancel') return jsonResponse(fetchCancelEnvelope(String(body?.['job_id'])));
  }
  return serviceError(404, 'NOT_FOUND', false);
};

interface AdmissionRecord {
  method: 'search' | 'fetch';
  key: string;
  content: string;
  job_id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  created_at: string;
  updated_at: string;
  selection: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface AdmissionController {
  readonly dispatches: number;
  readonly records: readonly AdmissionRecord[];
  readonly defaults_revision: string;
  setDefaults(revision: string, search_lane?: string): void;
  setQuotaExhausted(value: boolean): void;
  fail(key: string, method?: 'search' | 'fetch'): void;
  cancel(key: string, method?: 'search' | 'fetch'): void;
  setState(key: string, state: AdmissionRecord['state'], method?: 'search' | 'fetch'): void;
  state(key: string, method?: 'search' | 'fetch'): AdmissionRecord['state'] | undefined;
  jobId(key: string, method?: 'search' | 'fetch'): string | undefined;
}

export function createAdmissionFixture(): RemoteHttpFixture & { admission: AdmissionController } {
  const records = new Map<string, AdmissionRecord>();
  const jobs = new Map<string, AdmissionRecord>();
  let dispatches = 0;
  let defaultsRevision = 'fixture-defaults-v1';
  let searchLane = 'fixture.search.v1';
  let quotaExhausted = false;

  const fixture = createRemoteHttpFixture(async (request) => {
    const path = request.url.split('?', 1)[0];
    const body = request.json as Record<string, unknown> | undefined;
    if (request.method !== 'POST') return serviceError(405, 'HTTP_ERROR', false);
    if (path === '/v1/capabilities') return jsonResponse(capabilityEnvelope());
    if (path !== '/v1/search' && path !== '/v1/fetch') return serviceError(404, 'NOT_FOUND', false);
    const method = path === '/v1/search' ? 'search' : 'fetch';
    const action = body?.['action'];
    if (action === 'run' && body?.['execution'] === 'async') {
      const key = typeof body?.['idempotency_key'] === 'string' ? body['idempotency_key'] as string : '';
      const content = remoteIdempotencyContent(method, body);
      const lookup = `${method}:${key}`;
      const existing = records.get(lookup);
      if (existing !== undefined) {
        if (existing.content !== content) return serviceError(409, 'CONFLICT', false);
        return jsonResponse(projectAdmission(existing));
      }
      if (quotaExhausted) return serviceError(429, 'RATE_LIMITED', true, 1000);
      const record: AdmissionRecord = {
        method,
        key,
        content,
        job_id: deterministicJobId(lookup),
        state: 'queued',
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        selection: method === 'search' ? { source: 'default', lanes: [searchLane], plan_revision: defaultsRevision } : { source: 'default', plan_revision: defaultsRevision },
      };
      records.set(lookup, record);
      jobs.set(record.job_id, record);
      dispatches += 1;
      return jsonResponse(projectAdmission(record, false));
    }
    const jobId = typeof body?.['job_id'] === 'string' ? body['job_id'] as string : undefined;
    if (jobId !== undefined) {
      const record = jobs.get(jobId);
      if (record === undefined || record.method !== method) return serviceError(404, 'NOT_FOUND', false);
      if (action === 'get') return jsonResponse(projectGet(record));
      if (action === 'read') return jsonResponse(method === 'search' ? searchReadEnvelope(record.job_id, record.state) : fetchReadEnvelope(record.job_id, record.state));
      if (action === 'cancel') {
        if (record.state === 'queued' || record.state === 'running') { record.state = 'cancelled'; record.updated_at = TIMESTAMP; }
        return jsonResponse(method === 'search' ? searchCancelEnvelope(record.job_id, record.state, record.state === 'cancelled') : fetchCancelEnvelope(record.job_id, record.state, record.state === 'cancelled'));
      }
    }
    if (action === 'run') return jsonResponse(method === 'search' ? searchSyncEnvelope() : fetchSyncEnvelope());
    return serviceError(400, 'INVALID_REQUEST', false);
  });

  const admission: AdmissionController = {
    get dispatches() { return dispatches; },
    get records() { return [...records.values()]; },
    get defaults_revision() { return defaultsRevision; },
    setDefaults(revision, lane = searchLane) { defaultsRevision = revision; searchLane = lane; },
    setQuotaExhausted(value) { quotaExhausted = value; },
    fail(key, method = 'search') {
      const record = records.get(`${method}:${key}`);
      if (record === undefined) throw new Error(`unknown admission key ${key}`);
      record.state = 'failed'; record.updated_at = TIMESTAMP; record.error = { code: 'WORKER_START_FAILED', message: 'fixture worker failed', retryable: false };
    },
    cancel(key, method = 'search') {
      const record = records.get(`${method}:${key}`);
      if (record === undefined) throw new Error(`unknown admission key ${key}`);
      record.state = 'cancelled'; record.updated_at = TIMESTAMP;
    },
    setState(key, state, method = 'search') {
      const record = records.get(`${method}:${key}`);
      if (record === undefined) throw new Error(`unknown admission key ${key}`);
      record.state = state; record.updated_at = TIMESTAMP;
    },
    state(key, method = 'search') { return records.get(`${method}:${key}`)?.state; },
    jobId(key, method = 'search') { return records.get(`${method}:${key}`)?.job_id; },
  };
  return Object.assign(fixture, { admission });

  function projectAdmission(record: AdmissionRecord, reused = true): unknown {
    if (record.state === 'failed') return record.method === 'search' ? searchFailedAsyncEnvelope(record.job_id, reused, String(record.error?.['message'] ?? 'fixture worker failed')) : fetchFailedAsyncEnvelope(record.job_id, reused, String(record.error?.['message'] ?? 'fixture worker failed'));
    const receipt = { job_id: record.job_id, state: record.state, created_at: record.created_at };
    return record.method === 'search'
      ? { ...searchAsyncEnvelope(record.job_id, record.state, reused), selection: record.selection, job: receipt }
      : { ...fetchAsyncEnvelope(record.job_id, record.state, reused), selection: record.selection, job: receipt };
  }

  function projectGet(record: AdmissionRecord): unknown {
    return record.method === 'search'
      ? searchGetEnvelope(record.job_id, record.state, record.state === 'cancelled', record.error)
      : fetchGetEnvelope(record.job_id, record.state, record.state === 'cancelled', record.error);
  }
}

function deterministicJobId(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

void DEFAULT_JOB_ID;
