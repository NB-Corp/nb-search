// New verification, not recovered source. Only local fixtures and stubbed DNS run.
import assert from 'node:assert/strict';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRecoveredRegions } from './check-next7-regions.mjs';

const archiveRoot = process.argv[2];
assert(archiveRoot, 'Usage: pnpm test:next7-oracle <extracted accepted next.7 package root>');
await checkRecoveredRegions(resolve(archiveRoot));
const originalLookup = dns.lookup;
const originalPromiseLookup = dnsPromises.lookup;
const addresses = new Map([
  ['public.test', ['8.8.8.8']], ['final.test', ['1.1.1.1']],
  ['synthetic.test', ['198.18.0.2']], ['private.test', ['10.0.0.1']],
  ['mixed.test', ['8.8.8.8', '10.0.0.1']], ['empty.test', []],
]);
const preflight = [];
// Unknown names fail closed. No system resolver or external socket is used.
dnsPromises.lookup = async (hostname, options) => {
  preflight.push(hostname);
  const values = addresses.get(hostname);
  if (!values) throw Object.assign(new Error('fixture DNS failure'), { code: 'ENOTFOUND' });
  const rows = values.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  return options?.all ? rows : rows[0];
};
// A direct native connection sees rebinding to loopback and must be rejected by
// the guarded connector. Successful native traffic below goes through our proxy.
dns.lookup = (_host, options, callback) => queueMicrotask(() => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
syncBuiltinESMExports();
const servers = []; const sockets = new Set(); const roots = [];
const archiveUrl = pathToFileURL(resolve(archiveRoot) + '/').href;
const candidateEntry = pathToFileURL(resolve(import.meta.dirname, '../dist/index.mjs')).href;
// Pin both implementations to the candidate's exact installed runtime dependencies.
// The extracted archive must not inherit a consumer worktree's different Undici.
const dependencyHook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(archiveUrl) && !specifier.startsWith('.') && !specifier.includes(':')) return nextResolve(specifier, { ...context, parentURL: candidateEntry });
  return nextResolve(specifier, context);
} });
try {
  const oracle = await import(pathToFileURL(resolve(archiveRoot, 'dist/index.mjs')).href);
  const candidate = await import(candidateEntry);
  const implementations = [oracle, candidate];
  let passed = 0;
  const clean = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'duration_ms' ? undefined : item));
  const errorValue = error => ({ name: error.name, code: error.code, message: error.message, retryable: error.retryable, provider: error.provider, data: error.data, cause: error.cause && { name: error.cause.name, code: error.cause.code, message: error.cause.message } });
  const request = (url = 'https://public.test/page', extra = {}) => ({ source: { kind: 'url', url }, representation: 'text', signal: new AbortController().signal, timeout_ms: 1000, max_source_bytes: 4096, max_response_bytes: 4096, max_content_chars: 1000, max_redirects: 3, file_scopes: [], ...extra });
  async function pair(name, run, verify) {
    const results = [];
    for (const implementation of implementations) {
      preflight.length = 0;
      const result = await run(implementation);
      results.push(clean({ ...result, dns: [...preflight] }));
    }
    assert.deepEqual(results[1], results[0], name);
    verify?.(results[0]); passed++;
    console.log('MATCH ' + name);
  }
  function direct(implementation, io) {
    return implementation.builtInProviderRegistrations(io).find(item => item.descriptor.provider_id === 'direct-http').create({}).fetch.fetch;
  }
  async function capture(provider, input) { try { return { value: await provider.fetch(input) }; } catch (error) { return { error: errorValue(error) }; } }
  function response(url, body = 'plain content', status = 200, headers = { 'content-type': 'text/plain' }) {
    const value = new Response(body, { status, headers }); Object.defineProperty(value, 'url', { value: String(url) }); return value;
  }
  const fixture = handler => ({ fetch: async (url, init) => handler(new URL(url), init) });
  await pair('success, final URL, headers, exact text', async implementation => {
    const calls = [];
    const io = fixture((url, init) => { calls.push({ url: url.href, method: init.method, redirect: init.redirect, headers: [...init.headers] }); return response(url, 'two  spaces\r\nnext'); });
    return { ...await capture(direct(implementation, io), request()), calls };
  }, value => assert.equal(value.value.content, 'two  spaces\nnext'));
  for (const [name, body, status, headers, extra, expected] of [
    ['byte and char limits', 'abcdef', 200, { 'content-type': 'text/plain' }, { max_response_bytes: 4, max_content_chars: 2 }, 'ok'],
    ['HTTP 404', '', 404, {}, {}, 'FETCH_HTTP_ERROR'],
    ['HTTP 503', '', 503, {}, {}, 'FETCH_HTTP_ERROR'],
    ['binary MIME', 'pdf', 200, { 'content-type': 'application/pdf' }, {}, 'FETCH_CONTENT_TYPE_REJECTED'],
    ['invalid UTF8', new Uint8Array([255]), 200, { 'content-type': 'text/plain' }, {}, 'FETCH_CONTENT_TYPE_REJECTED'],
    ['binary control byte', new Uint8Array([0]), 200, { 'content-type': 'text/plain' }, {}, 'FETCH_CONTENT_TYPE_REJECTED'],
    ['pagination and LFS warnings', 'version https://git-lfs.github.com/spec/v1\n', 200, { 'content-type': 'text/plain', link: '<next>; rel="next"' }, {}, 'ok'],
  ]) await pair(name, async implementation => capture(direct(implementation, fixture(url => response(url, body, status, headers))), request(undefined, extra)), value => expected === 'ok' ? assert(value.value) : assert.equal(value.error.code, expected));
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://198.18.0.2/', 'ftp://public.test/', 'https://user:password@public.test/', 'https://private.test/', 'https://mixed.test/', 'https://empty.test/', 'https://unknown.test/']) {
    await pair('blocked ' + url, async implementation => {
      let calls = 0;
      const result = await capture(direct(implementation, fixture(target => { calls++; return response(target); })), request(url));
      return { ...result, calls };
    }, value => { assert.equal(value.error.code, 'FETCH_BLOCKED'); assert.equal(value.calls, 0); });
  }
  for (const [name, destination, maximum, expected] of [
    ['redirect success', 'https://final.test/end', 2, 'ok'],
    ['redirect private DNS', 'https://private.test/end', 2, 'FETCH_BLOCKED'],
    ['redirect private literal', 'http://127.0.0.1/end', 2, 'FETCH_BLOCKED'],
    ['credential redirect with injected fetch (accepted behavior)', 'https://user:pass@final.test/end', 2, 'ok'],
    ['redirect limit', 'https://final.test/end', 0, 'FETCH_HTTP_ERROR'],
  ]) await pair(name, async implementation => {
    const calls = [];
    const io = fixture(url => { calls.push(url.href); return url.hostname === 'public.test' ? response(url, '', 302, { location: destination }) : response(url, 'redirected content'); });
    return { ...await capture(direct(implementation, io), request(undefined, { max_redirects: maximum })), calls };
  }, value => expected === 'ok' ? assert.equal(value.value.final_url, destination) : assert.equal(value.error.code, expected));
  await pair('transport error mapping and owned dispatcher cleanup', async implementation => {
    const calls = [];
    const io = { ...fixture((_url, init) => { calls.push(init.dispatcher === dispatcher); throw new Error('fixture transport failure'); }), createDispatcher() { calls.push('create'); return dispatcher; } };
    const dispatcher = { async destroy() { calls.push('destroy'); throw new Error('cleanup error'); } };
    return { ...await capture(direct(implementation, io), request()), calls };
  }, value => { assert.equal(value.error.code, 'PROVIDER_UNAVAILABLE'); assert.deepEqual(value.calls, ['create', true, 'destroy']); });
  await pair('guarded timeout', async implementation => {
    const io = fixture((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
    return capture(direct(implementation, io), request(undefined, { timeout_ms: 30 }));
  }, value => assert.equal(value.error.code, 'DEADLINE_EXCEEDED'));
  await pair('external cancellation preserves reason', async implementation => {
    const controller = new AbortController();
    const io = fixture((_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); controller.abort(new Error('fixture cancellation')); }));
    return capture(direct(implementation, io), request(undefined, { signal: controller.signal }));
  }, value => assert.equal(value.error.message, 'fixture cancellation'));
  await pair('body-read cancellation preserves reason', async implementation => {
    const controller = new AbortController();
    const io = fixture(url => { const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('first')); setTimeout(() => controller.abort(new Error('fixture body cancellation')), 10); } }); return response(url, body); });
    return capture(direct(implementation, io), request(undefined, { signal: controller.signal }));
  }, value => assert.equal(value.error.message, 'fixture body cancellation'));

  const listen = async server => {
    servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port;
  };
  const originHits = []; const proxyHits = [];
  const origin = createServer((req, res) => {
    originHits.push({ url: req.url, host: req.headers.host });
    if (req.url === '/hang') return;
    if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    res.writeHead(req.url === '/error' ? 503 : 200, { 'content-type': 'text/plain' }); res.end('native proxy content');
  });
  const originPort = await listen(origin);
  const proxy = createServer((_req, res) => { res.writeHead(500); res.end('CONNECT required'); });
  proxy.on('connect', (req, client, head) => {
    proxyHits.push({ target: req.url, authorization: req.headers['proxy-authorization'] });
    // This proxy can connect only to the fixture origin, never the internet.
    if (![ `synthetic.test:${originPort}`, `public.test:${originPort}` ].includes(req.url)) { client.destroy(); return; }
    const upstream = connect(originPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const proxyUrl = `http://fixture:password@127.0.0.1:${proxyPort}`;
  const root = await mkdtemp(join(tmpdir(), 'nb-next7-oracle-')); roots.push(root);
  const configuration = { home: root, jobs_root: join(root, 'jobs'), execution: { retry_count: 0, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } } };
  async function nativeRun(implementation, env, path = '/ok', { cancel = false, captured = false, host = 'synthetic.test' } = {}) {
    originHits.length = 0; proxyHits.length = 0;
    const runtime = captured ? implementation.createCapturedNbSearchRuntime(implementation.resolveCapturedConfiguration({ home: root, canonicalPath: join(root, 'config.json'), canonical: undefined }, { env, config: configuration, cwd: root }), { env }) : implementation.createNbSearchRuntime({ env, config: configuration });
    // Mutation after composition must not alter proxy selection.
    env.HTTP_PROXY = 'http://invalid-after-capture.test:1';
    const controller = new AbortController();
    const pending = runtime.fetch({ url: `http://${host}:${originPort}${path}`, pipeline: 'direct.fetch', timeout_ms: 100 }, { signal: controller.signal });
    const timer = cancel ? setTimeout(() => controller.abort(), 25) : undefined;
    try { return { value: await pending, originHits: [...originHits], proxyHits: [...proxyHits] }; } finally { clearTimeout(timer); }
  }
  for (const [name, env, path, options, expected] of [
    ['HTTP_PROXY native tunnel', { HTTP_PROXY: proxyUrl }, '/ok', {}, 'succeeded'],
    ['lowercase priority', { http_proxy: proxyUrl, HTTP_PROXY: 'http://127.0.0.1:1' }, '/ok', {}, 'succeeded'],
    ['ALL_PROXY fallback', { ALL_PROXY: proxyUrl }, '/ok', {}, 'succeeded'],
    ['NO_PROXY nonmatching', { HTTP_PROXY: proxyUrl, NO_PROXY: 'different.test' }, '/ok', {}, 'succeeded'],
    ['NO_PROXY exact off', { HTTP_PROXY: proxyUrl, NO_PROXY: 'synthetic.test' }, '/ok', {}, 'failed'],
    ['NO_PROXY suffix off', { HTTP_PROXY: proxyUrl, NO_PROXY: '.test' }, '/ok', {}, 'failed'],
    ['NO_PROXY wildcard off', { HTTP_PROXY: proxyUrl, NO_PROXY: '*' }, '/ok', {}, 'failed'],
    ['empty proxy explicit off', { HTTP_PROXY: '', ALL_PROXY: '' }, '/ok', {}, 'failed'],
    ['unsupported proxy protocol', { HTTP_PROXY: 'ftp://127.0.0.1:1' }, '/ok', {}, 'failed'],
    ['native redirect', { HTTP_PROXY: proxyUrl }, '/redirect', {}, 'succeeded'],
    ['native redirect to private literal', { HTTP_PROXY: proxyUrl }, '/private', {}, 'failed'],
    ['native HTTP error', { HTTP_PROXY: proxyUrl }, '/error', {}, 'failed'],
    ['native deadline', { HTTP_PROXY: proxyUrl }, '/hang', {}, 'timed_out'],
    ['native cancellation', { HTTP_PROXY: proxyUrl }, '/hang', { cancel: true }, 'cancelled'],
    ['captured runtime native proxy', { HTTP_PROXY: proxyUrl }, '/ok', { captured: true }, 'succeeded'],
    ['direct DNS rebinding rejected', {}, '/ok', { host: 'public.test' }, 'failed'],
  ]) await pair(name, implementation => nativeRun(implementation, { ...env }, path, options), result => {
    assert.equal(result.value.status, expected);
    if (expected === 'succeeded') { assert(result.proxyHits.length > 0); assert.equal(result.value.documents[0].content, 'native proxy content'); }
    if (name.includes('off') || name === 'unsupported proxy protocol' || name === 'direct DNS rebinding rejected') { assert.equal(result.proxyHits.length, 0); assert.equal(result.originHits.length, 0); assert.equal(result.value.lane_outcomes[0].error.code, 'FETCH_BLOCKED'); }
  });
  console.log(`Accepted next.7 oracle: ${passed} same-input comparisons passed; only duration_ms omitted.`);
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  dns.lookup = originalLookup; dnsPromises.lookup = originalPromiseLookup; syncBuiltinESMExports();
}
