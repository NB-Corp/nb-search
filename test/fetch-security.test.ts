import { fixtureDirectIo } from './direct-fixture.ts';
import { createServer, type Server } from 'node:http';
import { lookup } from 'node:dns';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { fetchInputSchema } from '../src/contracts.ts';
import { NbSearchError } from '../src/errors.ts';
import { DirectFetchProvider, htmlToText, isPublicAddress } from '../src/fetch-security.ts';

import { document, mockConfig, mockRegistration } from './helpers.ts';
const roots: string[] = []; const servers: Server[] = []; const agents: Agent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.destroy()));
  await Promise.all(servers.splice(0).map(async server => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function directRequest(url: string, maxResponseBytes = 1024, maxContentChars = 100, maxRedirects = 1) { return { source: { kind: 'url' as const, url }, representation: 'markdown' as const, signal: new AbortController().signal, max_source_bytes: maxResponseBytes, max_response_bytes: maxResponseBytes, max_content_chars: maxContentChars, max_redirects: maxRedirects, file_scopes: [] }; }
async function tempRoot(prefix: string) { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; }
describe('fetch contract and safety', () => {
  it('accepts one URL/one pipeline and rejects batch or query shapes', () => {
    expect(fetchInputSchema.safeParse({ url: 'https://example.com', pipeline: 'direct.fetch' }).success).toBe(true);
    for (const value of [{ url: 'https://example.com', lanes: ['direct.fetch'] }, { url: 'https://example.com', preset: 'x' }, { urls: ['https://example.com'] }, { query: 'https://example.com' }]) expect(fetchInputSchema.safeParse(value).success).toBe(false);
  });
  it('blocks non-public and non-HTTP targets before fetching', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) expect(isPublicAddress(address)).toBe(false);
    let calls = 0;
    const provider = new DirectFetchProvider(fixtureDirectIo({ async lookup() { return ['127.0.0.1']; }, async fetch() { calls++; throw new Error('no request'); } }));
    await expect(provider.fetch(directRequest('https://example.com'))).rejects.toMatchObject({ code: 'FETCH_BLOCKED' });
    for (const url of ['file:///x', 'ftp://example.com', 'https://u:p@example.com']) await expect(provider.fetch(directRequest(url))).rejects.toMatchObject({ code: 'FETCH_BLOCKED' });
    expect(calls).toBe(0);
  });
  it('revalidates redirects and rejects binary MIME', async () => {
    const io = fixtureDirectIo({ async lookup(host) { return host === 'public.example' ? ['8.8.8.8'] : ['10.0.0.1']; }, async fetch() { return { status: 302, headers: { location: 'https://private.example' } }; } });
    await expect(new DirectFetchProvider(io).fetch(directRequest('https://public.example', 1024, 100, 2))).rejects.toMatchObject({ code: 'FETCH_BLOCKED' });
    const binary = new DirectFetchProvider(fixtureDirectIo({ async fetch() { return { status: 200, headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([1]) }; } }));
    await expect(binary.fetch(directRequest('https://example.com/a.pdf'))).rejects.toMatchObject({ code: 'FETCH_CONTENT_TYPE_REJECTED' });
  });
  it('converts HTML and enforces real byte and character limits', async () => {
    const html = '<title>A &amp; B</title><style>hidden</style><h1>Hello</h1><script>bad()</script><p>World</p>';
    expect(htmlToText(html).content).toContain('Hello');
    const provider = new DirectFetchProvider(fixtureDirectIo({ async fetch() { return { status: 200, headers: { 'content-type': 'text/html' }, body: html + ' '.repeat(32) }; } }));
    const result = await provider.fetch(directRequest('https://example.com', 100, 5));
    expect(result).toMatchObject({ format: 'text', truncated: true });
    expect(result.warnings.map(item => item.code)).toEqual(['FETCH_BYTES_LIMIT', 'FETCH_CONTENT_CHARS_LIMIT']);
  });
  it('maps direct non-2xx responses to FETCH_HTTP_ERROR with status data', async () => {
    for (const status of [404, 429, 500]) {
      const provider = new DirectFetchProvider(fixtureDirectIo({ async fetch() { return { status }; } }));
      await expect(provider.fetch(directRequest('https://example.com'))).rejects.toMatchObject({ code: 'FETCH_HTTP_ERROR', retryable: status >= 500, data: { status } });
    }
  });
  it('falls through the chain when direct reaches the redirect limit', async () => {
    const root = await tempRoot('nb-search-fetch-redirect-limit-'); let direct = 0; let fallback = 0;
    const io = fixtureDirectIo({ async fetch() { direct++; return { status: 302, headers: { location: 'https://next.example' } }; } });
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, test_only_direct_fetch_io: io, config: { home: root, jobs_root: join(root, 'jobs'), provider_instances: { 'mock.default': { provider_id: 'mock', enabled: true, options: {} } }, lanes: { 'mock.fetch': { provider_instance_id: 'mock.default', operation_id: 'fetch', latency: 'fast', cost: 'free' } }, defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['direct.fetch', 'mock.fetch'] }] }, execution: { retry_count: 0, fetch: { max_redirects: 0, quality: { min_content_chars: 0, blocked_markers: [] } } } }, provider_registrations: [mockRegistration({ async fetch(url) { fallback++; return document(url, 'fallback'); } })] });
    expect(await app.runtime.fetch({ url: 'https://example.com' })).toMatchObject({ status: 'succeeded', documents: [{ source_lane: 'mock.fetch' }], lane_outcomes: [{ lane: 'direct.fetch', error: { code: 'FETCH_HTTP_ERROR', data: { max_redirects: 0 } } }, { lane: 'mock.fetch', state: 'succeeded' }] });
    expect(direct).toBe(1); expect(fallback).toBe(1);
  });
  it('retries ordinary direct transport failures within the shared provider-call budget', async () => {
    const root = await tempRoot('nb-search-fetch-direct-retry-'); let calls = 0;
    const io = fixtureDirectIo({ async fetch() { calls++; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } });
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, test_only_direct_fetch_io: io, config: { home: root, jobs_root: join(root, 'jobs'), defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['direct.fetch'] }] }, execution: { retry_count: 1, max_provider_calls: 2, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } } });
    expect(await app.runtime.fetch({ url: 'https://example.com' })).toMatchObject({ status: 'failed', lane_outcomes: [{ lane: 'direct.fetch', error: { code: 'PROVIDER_UNAVAILABLE', retryable: true } }] });
    expect(calls).toBe(2);
  });
  it('uses native undici against a controlled local server while preserving Host', async () => {
    let host = '';
    const server = createServer((request, response) => { host = request.headers.host ?? ''; response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<title>Oracle</title><p>Visible</p>'); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error();
    // Only this test's dispatcher maps a preflight-public hostname onto loopback.
    const localLookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4)) as typeof lookup;
    const dispatcher = new Agent({ connect: { lookup: localLookup } }); agents.push(dispatcher);
    fixtureDirectIo({ async fetch() { throw new Error('native fetch expected'); } });
    const root = await tempRoot('nb-search-fetch-oracle-');
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, test_only_direct_fetch_io: { dispatcher }, config: { home: root, jobs_root: join(root, 'jobs'), defaults: { fetch_chain: [{ input_kind: 'url', pipelines: ['direct.fetch'] }] }, execution: { fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } } });
    const result = await app.runtime.fetch({ url: `http://oracle.test:${String(address.port)}/` });
    expect(result).toMatchObject({ status: 'succeeded', documents: [{ source_lane: 'direct.fetch', title: 'Oracle', content_type: 'text/html' }] });
    expect(result.documents[0]?.content).toContain('Visible'); expect(host).toBe(`oracle.test:${String(address.port)}`);
  });
  it('returns timeout during retry backoff without a second fetch call', async () => {
    const root = await tempRoot('nb-search-fetch-timeout-'); let calls = 0;
    const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, config: { ...mockConfig(root), execution: { retry_count: 1, max_provider_calls: 2 } }, provider_registrations: [mockRegistration({ async fetch() { calls++; throw new NbSearchError('PROVIDER_UNAVAILABLE', 'retry', true); } })] });
    expect(await app.runtime.fetch({ url: 'https://example.com', timeout_ms: 100 })).toMatchObject({ status: 'timed_out', lane_outcomes: [{ state: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } }] });
    await new Promise(resolve => setTimeout(resolve, 120)); expect(calls).toBe(1);
  });
});
