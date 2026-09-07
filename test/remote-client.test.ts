import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNbSearchRemoteClient, normalizeRemoteBase } from '../src/remote-client.ts';
import { NbSearchRemoteError, remoteIdempotencyContent } from '../src/remote-protocol.ts';
import {
  createAdmissionFixture,
  createRemoteHttpFixture,
  defaultRemoteHandler,
  jsonResponse,
  searchGetEnvelope,
  searchSyncEnvelope,
  serviceError,
  type RemoteHttpFixture,
  type RemoteHttpHandler,
} from './fixtures/remote-http.ts';

const FAKE_TOKEN = 'fake-loopback-token';
const JOB_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_JOB_ID = '00000000-0000-4000-8000-000000000002';
const fixtures: RemoteHttpFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.close()));
});

async function fixtureFor(handler: RemoteHttpHandler = defaultRemoteHandler): Promise<RemoteHttpFixture> {
  const fixture = createRemoteHttpFixture(handler);
  fixtures.push(fixture);
  await fixture.start();
  return fixture;
}

async function admissionFixtureFor() {
  const fixture = createAdmissionFixture();
  fixtures.push(fixture);
  await fixture.start();
  return fixture;
}

function clientFor(fixture: RemoteHttpFixture, options: Partial<Parameters<typeof createNbSearchRemoteClient>[0]> = {}) {
  return createNbSearchRemoteClient({ base_url: fixture.base_url, access_key: FAKE_TOKEN, allow_loopback_http: true, ...options });
}

async function rejected(promise: Promise<unknown>): Promise<NbSearchRemoteError> {
  const result = await promise.then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(NbSearchRemoteError);
  return result as NbSearchRemoteError;
}

describe('test-only loopback remote HTTP boundary', () => {
  it.each(['abort', 'deadline'])('terminates a stalled body after received headers: %s', async (mode) => {
    const urls: string[] = []; let streamClosed = false;
    const server = createServer(async (req, res) => { for await (const _ of req) {} urls.push(req.url!); res.on('close', () => { streamClosed = true; }); res.writeHead(200, { 'content-type': 'application/json', 'x-nb-search-protocol': '1', 'x-request-id': String(req.headers['x-request-id']) }); res.flushHeaders(); res.write('{'); /* deliberately no body completion */ });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    let received!: () => void; const headersReceived = new Promise<void>((done) => { received = done; }); const nativeFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => { const response = await nativeFetch(...args); received(); return response; });
    const controller = new AbortController(); const started = Date.now();
    try {
      const client = createNbSearchRemoteClient({ base_url: `http://127.0.0.1:${address.port}`, access_key: FAKE_TOKEN, allow_loopback_http: true, timeout_ms: mode === 'deadline' ? 300 : 2000 });
      const pending = rejected(client.search({ action: 'run', query: 'body stall' }, { signal: controller.signal })); await headersReceived; await sleep(20); if (mode === 'abort') controller.abort();
      expect(await pending).toMatchObject({ code: mode === 'abort' ? 'CANCELLED' : 'DEADLINE_EXCEEDED' }); expect(Date.now() - started).toBeLessThan(3000);
      for (let i = 0; !streamClosed && i < 100; i++) await sleep(10);
      expect(streamClosed).toBe(true); expect(urls).toEqual(['/v1/search']); expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it('calls search, fetch, and capabilities for sync/async run and job actions', async () => {
    const fixture = await fixtureFor();
    const client = clientFor(fixture);

    await expect(client.search({ action: 'run', query: 'fixture' })).resolves.toMatchObject({ action: 'run', execution: 'sync', status: 'succeeded', output: { schema_id: 'nb-search.results@1' } });
    await expect(client.search({ action: 'run', query: 'fixture', execution: 'async', idempotency_key: 'search-key' })).resolves.toMatchObject({ action: 'run', execution: 'async', status: 'queued', job: { job_id: JOB_ID } });
    await expect(client.search({ action: 'get', job_id: JOB_ID })).resolves.toMatchObject({ action: 'get', job_id: JOB_ID, state: 'queued' });
    await expect(client.search({ action: 'read', job_id: JOB_ID })).resolves.toMatchObject({ action: 'read', job_id: JOB_ID, chunks: [] });
    await expect(client.search({ action: 'cancel', job_id: JOB_ID })).resolves.toMatchObject({ action: 'cancel', job_id: JOB_ID, state: 'cancelled' });

    await expect(client.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/fixture' } })).resolves.toMatchObject({ mode: 'fetch', action: 'run', execution: 'sync', status: 'succeeded', documents: [{ source_lane: 'fixture.fetch' }] });
    await expect(client.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/fixture' }, execution: 'async', idempotency_key: 'fetch-key' })).resolves.toMatchObject({ mode: 'fetch', action: 'run', execution: 'async', status: 'queued', job: { job_id: JOB_ID } });
    await expect(client.fetch({ action: 'get', job_id: JOB_ID })).resolves.toMatchObject({ mode: 'fetch', action: 'get', job_id: JOB_ID, state: 'queued' });
    await expect(client.fetch({ action: 'read', job_id: JOB_ID })).resolves.toMatchObject({ mode: 'fetch', action: 'read', job_id: JOB_ID, chunks: [] });
    await expect(client.fetch({ action: 'cancel', job_id: JOB_ID })).resolves.toMatchObject({ mode: 'fetch', action: 'cancel', job_id: JOB_ID, state: 'cancelled' });

    await expect(client.capabilities()).resolves.toMatchObject({ schema_version: '3.0', revision: 'fixture-revision-1', fetch: { default_representation: 'markdown' } });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      '/v1/search', '/v1/search', '/v1/search', '/v1/search', '/v1/search',
      '/v1/fetch', '/v1/fetch', '/v1/fetch', '/v1/fetch', '/v1/fetch',
      '/v1/capabilities',
    ]);
  });

  it('sends bearer auth, protocol, content negotiation, and correlated request IDs without putting the token in the URL', async () => {
    const fixture = await fixtureFor();
    const client = clientFor(fixture);

    await client.search({ action: 'run', query: 'header test' }, { requestId: 'req:header-test' });
    await client.fetch({ url: 'https://example.com/fixture' }, { requestId: 'req:fetch-test' });
    await client.capabilities({}, { requestId: 'req:cap-test' });

    const searchRequest = fixture.requests[0]!;
    expect(searchRequest.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(searchRequest.headers['content-type']).toBe('application/json');
    expect(searchRequest.headers.accept).toBe('application/json');
    expect(searchRequest.headers['x-nb-search-protocol']).toBe('1');
    expect(searchRequest.headers['x-request-id']).toBe('req:header-test');
    expect(searchRequest.url).not.toContain(FAKE_TOKEN);
    expect(searchRequest.json).toEqual({ action: 'run', query: 'header test' });

    expect(fixture.requests[1]!.json).toEqual({ action: 'run', source: { kind: 'url', url: 'https://example.com/fixture' } });
    expect(fixture.requests[1]!.headers['x-request-id']).toBe('req:fetch-test');
    expect(fixture.requests[2]!.json).toEqual({});
    expect(fixture.requests[2]!.headers['x-request-id']).toBe('req:cap-test');

    const generated = await fixtureFor();
    const generatedClient = clientFor(generated);
    await generatedClient.capabilities();
    expect(generated.requests[0]!.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it('rejects invalid input before any loopback IO, including all non-URL fetch sources', async () => {
    const fixture = await fixtureFor();
    const client = clientFor(fixture);

    await expect(client.fetch({ action: 'run', source: { kind: 'inline_text', content: 'not uploaded', media_type: 'text/plain' } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.fetch({ action: 'run', source: { kind: 'inline_bytes', content_base64: 'aGVsbG8=', media_type: 'text/plain' } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.fetch({ action: 'run', source: { kind: 'file', path: 'fixture.txt', scope: 'fixture' } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.search({ action: 'run', query: '' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.capabilities({ extra: true } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.search({ action: 'run', query: 'bad request' }, { requestId: 'bad id' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.requests).toHaveLength(0);
  });

  it('rejects insecure, credential-bearing, query-bearing, and fragment-bearing service URLs', () => {
    const invalid = [
      'http://example.com/',
      'http://127.0.0.2/',
      'http://localhost.example/',
      'https://user:pass@example.com/',
      'https://example.com/?profile=secret',
      'https://example.com/#fragment',
      'not-an-absolute-url',
    ];
    for (const base_url of invalid) {
      expect(() => createNbSearchRemoteClient({ base_url, access_key: FAKE_TOKEN, allow_loopback_http: true })).toThrowError(NbSearchRemoteError);
      expect(() => createNbSearchRemoteClient({ base_url, access_key: FAKE_TOKEN, allow_loopback_http: true })).toThrowError(/CONFIGURATION_ERROR/);
    }
    expect(normalizeRemoteBase('https://example.com/api///')).toBe('https://example.com/api/');
    expect(normalizeRemoteBase('http://127.0.0.1:1234/api/', true)).toBe('http://127.0.0.1:1234/api/');
    expect(normalizeRemoteBase('http://[::1]:1234/api/', true)).toBe('http://[::1]:1234/api/');
  });

  it('maps service statuses and Retry-After metadata, with exactly one attempt and no automatic retry', async () => {
    const statuses = [
      [401, 'UNAUTHENTICATED', false],
      [403, 'FORBIDDEN', false],
      [404, 'NOT_FOUND', false],
      [409, 'CONFLICT', false],
    ] as const;
    for (const [status, code, retryable] of statuses) {
      let attempts = 0;
      const fixture = await fixtureFor(() => { attempts += 1; return serviceError(status, code, retryable); });
      const error = await rejected(clientFor(fixture).search({ action: 'run', query: 'status' }));
      expect(error).toMatchObject({ code, status, retryable, request_id: expect.any(String) });
      expect(attempts).toBe(1);
      expect(fixture.requests).toHaveLength(1);
    }

    let rateAttempts = 0;
    const rateFixture = await fixtureFor(() => { rateAttempts += 1; return serviceError(429, 'RATE_LIMITED', true, 3000, { 'retry-after': '7' }); });
    const rateError = await rejected(clientFor(rateFixture).search({ action: 'run', query: 'rate' }));
    expect(rateError).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true, retry_after_ms: 7000 });
    expect(rateAttempts).toBe(1);

    const date = new Date(Date.now() + 1500).toUTCString();
    let unavailableAttempts = 0;
    const unavailableFixture = await fixtureFor(() => { unavailableAttempts += 1; return serviceError(503, 'UNAVAILABLE', true, 0, { 'retry-after': date }); });
    const unavailableError = await rejected(clientFor(unavailableFixture).search({ action: 'run', query: 'unavailable' }));
    expect(unavailableError.code).toBe('UNAVAILABLE');
    expect(unavailableError.status).toBe(503);
    expect(unavailableError.retryable).toBe(true);
    expect(unavailableError.retry_after_ms).toBeGreaterThanOrEqual(0);
    expect(unavailableError.retry_after_ms).toBeLessThanOrEqual(2000);
    expect(unavailableAttempts).toBe(1);
  });

  it('treats redirects as errors and never sends a request to the second listener', async () => {
    const second = await fixtureFor();
    const first = await fixtureFor(() => ({ status: 302, headers: { location: `${second.base_url}v1/search` }, body: 'redirected' }));
    const error = await rejected(clientFor(first).search({ action: 'run', query: 'redirect' }));
    expect(error).toMatchObject({ code: 'HTTP_ERROR', status: 302, retryable: false });
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(0);
  });

  it('fails closed for malformed JSON, malformed UTF-8, envelopes, correlation, action, and job IDs', async () => {
    const malformedCases: Array<{ name: string; handler: RemoteHttpHandler; call: (client: ReturnType<typeof clientFor>) => Promise<unknown> }> = [
      { name: 'JSON', handler: () => ({ body: '{not-json' }), call: (client) => client.search({ action: 'run', query: 'malformed' }) },
      { name: 'UTF-8', handler: () => ({ body: Uint8Array.from([0xff, 0xfe]), headers: { 'content-type': 'application/json' } }), call: (client) => client.search({ action: 'run', query: 'malformed' }) },
      { name: 'envelope', handler: () => jsonResponse({ schema_version: '3.0', action: 'run', execution: 'sync', status: 'succeeded', hints: [] }), call: (client) => client.search({ action: 'run', query: 'malformed' }) },
      { name: 'action', handler: () => jsonResponse(searchGetEnvelope(JOB_ID)), call: (client) => client.search({ action: 'run', query: 'malformed' }) },
      { name: 'job', handler: () => jsonResponse(searchGetEnvelope(OTHER_JOB_ID)), call: (client) => client.search({ action: 'get', job_id: JOB_ID }) },
      { name: 'metadata', handler: () => ({ ...jsonResponse(searchSyncEnvelope()), omit_headers: ['x-nb-search-protocol'] }), call: (client) => client.search({ action: 'run', query: 'malformed' }) },
    ];
    for (const testCase of malformedCases) {
      const fixture = await fixtureFor(testCase.handler);
      const error = await rejected(testCase.call(clientFor(fixture)));
      expect(error.code, testCase.name).toBe('PROTOCOL_ERROR');
      expect(fixture.requests).toHaveLength(1);
    }
  });

  it('bounds streamed response bytes even without Content-Length', async () => {
    const fixture = await fixtureFor(() => ({ chunks: [Buffer.from('1234'), Buffer.from('5678')], omit_content_length: true }));
    const error = await rejected(clientFor(fixture, { max_response_bytes: 7 }).search({ action: 'run', query: 'large response' }));
    expect(error).toMatchObject({ code: 'RESPONSE_TOO_LARGE', request_id: expect.any(String) });
    expect(fixture.requests).toHaveLength(1);
  });

  it('composes caller cancellation and the per-call deadline without issuing a retry or implicit cancel', async () => {
    const abortFixture = await fixtureFor(() => ({ delay_ms: 300, body: JSON.stringify(searchSyncEnvelope()) }));
    const controller = new AbortController();
    const pending = clientFor(abortFixture).search({ action: 'run', query: 'caller abort' }, { signal: controller.signal });
    await abortFixture.waitForRequests(1);
    controller.abort();
    const abortError = await rejected(pending);
    expect(abortError).toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(abortFixture.requests).toHaveLength(1);

    const deadlineFixture = await fixtureFor(() => ({ delay_ms: 300, body: JSON.stringify(searchSyncEnvelope()) }));
    const deadlineError = await rejected(clientFor(deadlineFixture, { timeout_ms: 100 }).search({ action: 'run', query: 'deadline' }));
    expect(deadlineError).toMatchObject({ code: 'DEADLINE_EXCEEDED', retryable: true });
    expect(deadlineFixture.requests).toHaveLength(1);
  });
});

describe('remoteIdempotencyContent normative vectors', () => {
  const search = (query: string | string[], extra: Record<string, unknown> = {}, key = 'k1') => ({ action: 'run' as const, execution: 'async' as const, idempotency_key: key, query, ...extra });
  const fetch = (extra: Record<string, unknown> = {}, key = 'k1') => ({ action: 'run' as const, execution: 'async' as const, idempotency_key: key, source: { kind: 'url' as const, url: 'https://example.com/' }, ...extra });

  it('normalizes wire defaults and ordered queries while keeping omitted fields distinct', () => {
    expect(remoteIdempotencyContent('search', search(' q '))).toBe('{"action":"run","execution":"async","query":["q"]}');
    expect(remoteIdempotencyContent('search', search(' q '))).toBe(remoteIdempotencyContent('search', search(['q'])));
    expect(remoteIdempotencyContent('search', search(['a', 'b']))).toBe('{"action":"run","execution":"async","query":["a","b"]}');
    expect(remoteIdempotencyContent('search', search(['b', 'a']))).toBe('{"action":"run","execution":"async","query":["b","a"]}');
    expect(remoteIdempotencyContent('search', search('q'))).not.toBe(remoteIdempotencyContent('search', search('q', { max_results: 10 })));
    expect(remoteIdempotencyContent('search', search('q'))).not.toBe(remoteIdempotencyContent('search', search('q', { timeout_ms: 30_000 })));
    expect(remoteIdempotencyContent('fetch', fetch())).toBe('{"action":"run","execution":"async","representation":"markdown","source":{"kind":"url","url":"https://example.com/"}}');
    expect(remoteIdempotencyContent('fetch', fetch({ representation: 'markdown' }))).toBe(remoteIdempotencyContent('fetch', fetch()));
    expect(remoteIdempotencyContent('fetch', fetch({ representation: 'text' }))).not.toBe(remoteIdempotencyContent('fetch', fetch()));
  });

  it('trims selectors but preserves selector kind and array order, with lexicographic object keys', () => {
    const lane = remoteIdempotencyContent('search', search('q', { lane: ' exa.search ' }));
    expect(lane).toBe('{"action":"run","execution":"async","lane":"exa.search","query":["q"]}');
    expect(lane).toBe(remoteIdempotencyContent('search', search('q', { lane: 'exa.search' }, 'a-different-key')));
    expect(remoteIdempotencyContent('search', search('q', { lanes: ['exa.search'] }))).not.toBe(lane);
    expect(remoteIdempotencyContent('search', search('q', { preset: 'p' }))).not.toBe(remoteIdempotencyContent('search', search('q', { lanes: ['exa.search'] })));
    expect(remoteIdempotencyContent('search', search('q', { lanes: ['b', 'a'] }))).toBe('{"action":"run","execution":"async","lanes":["b","a"],"query":["q"]}');
    expect(remoteIdempotencyContent('search', search('q', { max_results: 10 }))).toBe('{"action":"run","execution":"async","max_results":10,"query":["q"]}');
  });

  it('keeps the actual wire request distinct from comparison-only defaults', async () => {
    const fixture = await fixtureFor();
    const client = clientFor(fixture);
    await client.fetch({ url: 'https://example.com/' });
    await client.search({ action: 'run', query: ['first', 'second'], lanes: ['lane-b', 'lane-a'] });
    expect(fixture.requests[0]!.json).toEqual({ action: 'run', source: { kind: 'url', url: 'https://example.com/' } });
    expect(fixture.requests[1]!.json).toEqual({ action: 'run', query: ['first', 'second'], lanes: ['lane-b', 'lane-a'] });
  });
});

describe('fixture-only async admission projections', () => {
  it('reuses current state after defaults change, worker failure, and cancellation without a second dispatch', async () => {
    const fixture = await admissionFixtureFor();
    const client = clientFor(fixture);
    const firstInput = { action: 'run' as const, query: ' q ', execution: 'async' as const, idempotency_key: 'k1' };

    const first = await client.search(firstInput);
    const jobId = (first as { job?: { job_id: string } }).job?.job_id;
    expect(first).toMatchObject({ status: 'queued', reused: false, job: { state: 'queued' }, selection: { lanes: ['fixture.search.v1'], plan_revision: 'fixture-defaults-v1' } });
    expect(jobId).toBeTruthy();
    expect(fixture.admission.dispatches).toBe(1);

    fixture.admission.setDefaults('fixture-defaults-v2', 'fixture.search.v2');
    const replay = await client.search({ ...firstInput, query: ['q'] });
    expect(replay).toMatchObject({ status: 'queued', reused: true, job: { job_id: jobId, state: 'queued' }, selection: { lanes: ['fixture.search.v1'], plan_revision: 'fixture-defaults-v1' } });
    expect(fixture.admission.dispatches).toBe(1);

    fixture.admission.setState('k1', 'running');
    await expect(client.search({ ...firstInput, query: ['q'] })).resolves.toMatchObject({ status: 'queued', reused: true, job: { job_id: jobId, state: 'running' } });
    fixture.admission.setState('k1', 'succeeded');
    await expect(client.search({ ...firstInput, query: ['q'] })).resolves.toMatchObject({ status: 'queued', reused: true, job: { job_id: jobId, state: 'succeeded' } });
    expect(fixture.admission.dispatches).toBe(1);

    const conflict = await rejected(client.search({ ...firstInput, max_results: 10 }));
    expect(conflict).toMatchObject({ code: 'CONFLICT', status: 409, retryable: false });
    expect(fixture.admission.dispatches).toBe(1);

    fixture.admission.fail('k1');
    const failed = await client.search({ ...firstInput, query: 'q' });
    expect(failed).toMatchObject({ status: 'failed', reused: true, job: { job_id: jobId, state: 'failed' }, error: { code: 'WORKER_START_FAILED' } });
    expect(fixture.admission.dispatches).toBe(1);

    const cancelledInput = { action: 'run' as const, query: 'cancel me', execution: 'async' as const, idempotency_key: 'k-cancel' };
    const admitted = await client.search(cancelledInput);
    const cancelledJobId = (admitted as { job?: { job_id: string } }).job?.job_id;
    fixture.admission.cancel('k-cancel');
    const cancelledReplay = await client.search(cancelledInput);
    expect(cancelledReplay).toMatchObject({ status: 'queued', reused: true, job: { job_id: cancelledJobId, state: 'cancelled' } });
    expect(fixture.admission.dispatches).toBe(2);
  });

  it('does not let exhausted execution quota block existing get/read/cancel or matching receipt recovery', async () => {
    const fixture = await admissionFixtureFor();
    const client = clientFor(fixture);
    const input = { action: 'run' as const, query: 'quota survivor', execution: 'async' as const, idempotency_key: 'quota-key' };
    const admitted = await client.search(input);
    const jobId = (admitted as { job?: { job_id: string } }).job?.job_id;
    expect(jobId).toBeTruthy();
    fixture.admission.setQuotaExhausted(true);

    await expect(client.search({ ...input, query: ' quota survivor ' })).resolves.toMatchObject({ status: 'queued', reused: true, job: { job_id: jobId } });
    await expect(client.search({ action: 'get', job_id: jobId! })).resolves.toMatchObject({ action: 'get', job_id: jobId, state: 'queued' });
    await expect(client.search({ action: 'read', job_id: jobId! })).resolves.toMatchObject({ action: 'read', job_id: jobId, state: 'queued', chunks: [] });
    await expect(client.search({ action: 'cancel', job_id: jobId! })).resolves.toMatchObject({ action: 'cancel', job_id: jobId, state: 'cancelled', cancel_requested: true });
    expect(fixture.admission.dispatches).toBe(1);

    const quotaError = await rejected(client.search({ action: 'run', query: 'new paid execution', execution: 'async', idempotency_key: 'new-key' }));
    expect(quotaError).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true, retry_after_ms: 1000 });
    expect(fixture.admission.dispatches).toBe(1);
  });
});
