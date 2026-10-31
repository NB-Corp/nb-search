import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchJobRunnerFromSnapshot, createRuntimeComposition } from '../src/app.ts';
import { parseConfigPatch } from '../src/config-schema.ts';
import { NbSearchError } from '../src/errors.ts';
import { captureFetchFileIdentity } from '../src/fetch-sources.ts';
import { extractHtml, projectJson } from '../src/fetch-content.ts';
import { selectFetchRoute, fetchRoutingConfigSchema, type FetchRoutingConfig } from '../src/fetch-routing-contracts.ts';
import type { DirectFetchIo } from '../src/fetch-security.ts';
import { document, mockConfig, mockRegistration } from './helpers.ts';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const raw = 'https://raw.githubusercontent.com/example/project/main/README.md';
const chain = ['jina.reader', 'tavily.extract', 'direct.fetch'];
const user: FetchRoutingConfig = { rules: [{ id: 'override', match: { origin: 'https://raw.githubusercontent.com', path_globs: ['/**'] }, action: { pipelines: ['direct.fetch', 'mock.fetch'] } }] };
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), 'nb-routing-'))); roots.push(path); return path; }
function io(body = 'const greeting = "two  spaces";\n  return greeting;', status = 200, type = 'text/plain'): DirectFetchIo { return { async resolve() { return ['8.8.8.8']; }, async request() { return { status, headers: { 'content-type': type }, body: new TextEncoder().encode(body), truncated: false }; } }; }
describe('fetch route and useful-content contract', () => {
  it('selects explicit, ordered user/default exceptions, builtins and negatives without calls', () => {
    expect(selectFetchRoute({ url: raw, pipeline: 'jina.reader' }, user, chain)).toMatchObject({ origin: 'explicit', pipelines: ['jina.reader'] });
    expect(selectFetchRoute({ url: raw }, user, chain)).toMatchObject({ origin: 'user', rule_id: 'override', pipelines: ['direct.fetch', 'mock.fetch'] });
    expect(selectFetchRoute({ url: raw }, { rules: [{ ...user.rules![0]!, action: { use: 'default' } }] }, chain)).toMatchObject({ origin: 'user', pipelines: chain });
    expect(selectFetchRoute({ url: raw }, { rules: [{ ...user.rules![0]!, enabled: false }] }, chain)).toMatchObject({ origin: 'builtin', rule_id: 'github-raw-text', pipelines: ['direct.fetch'], package_version: '1' });
    for (const url of ['https://api.github.com/repos/example/project/contents/a.ts', 'https://api.github.com/repos/example/project/releases/latest', 'https://registry.npmjs.org/@example%2fpackage/1.0.0', 'https://pypi.org/pypi/example/json']) expect(selectFetchRoute({ url }, {}, chain).origin).toBe('builtin');
    for (const url of ['https://github.com/example/project', 'https://api.github.com/repos/example/project/actions/runs', 'https://raw.githubusercontent.com/example/project/main/image.png', 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', 'https://registry.npmjs.org/@example%2fpackage/-/package-1.0.0.tgz', 'https://registry.npmjs.org/-/v1/search', 'https://pypi.org/project/example/']) expect(selectFetchRoute({ url }, {}, chain).origin).toBe('default');
    expect(selectFetchRoute({ url: raw }, { builtin_enabled: false }, chain).origin).toBe('default');
    expect(selectFetchRoute({ url: raw }, { disabled_builtin_rules: ['github-raw-text'] }, chain).origin).toBe('default');
    expect(selectFetchRoute({ url: raw }, { ...user, enabled: false }, chain).origin).toBe('default');
    expect(selectFetchRoute({}, user, ['direct.local'])).toMatchObject({ origin: 'default', pipelines: ['direct.local'] });
    expect(selectFetchRoute({ url: 'https://RAW.githubusercontent.COM.:443/example/project/main/README.md?b=2&a=1#ref' }, {}, chain).origin).toBe('builtin');
    const literal = { rules: [{ id: 'encoded', match: { origin: 'https://example.test', path_globs: ['/a/*'] }, action: { pipelines: ['direct.fetch'] } }] } satisfies FetchRoutingConfig;
    expect(selectFetchRoute({ url: 'https://example.test/a/x%2Fy' }, literal, chain).origin).toBe('user');
    expect(selectFetchRoute({ url: 'https://example.test/a/x/y' }, literal, chain).origin).toBe('default');
    expect(fetchRoutingConfigSchema.safeParse({ rules: [user.rules![0], user.rules![0]] }).success).toBe(false);
    expect(() => parseConfigPatch({ fetch: { routing: { rules: [{ ...user.rules![0], match: { origin: 'https://example.test/path' } }] } } }, 'fixture')).toThrow(/origin/);
  });
  it('direct-only builtin preserves source semantics and does not call the default third party', async () => {
    const home = await root(); let remote = 0;
    const app = createRuntimeComposition({}, { cwd: home, homeDirectory: home, test_only_direct_fetch_io: io(), provider_registrations: [mockRegistration({ async fetch(url) { remote++; return document(url, 'remote'); } })], config: mockConfig(home) });
    const value = await app.runtime.fetch({ url: raw });
    expect(value).toMatchObject({ status: 'succeeded', routing: { origin: 'builtin', pipelines: ['direct.fetch'] }, documents: [{ content: 'const greeting = "two  spaces";\n  return greeting;' }], lane_outcomes: [{ lane: 'direct.fetch', attempts: [{ attempt: 1, state: 'succeeded' }] }] });
    expect(remote).toBe(0);
    const inline = await app.runtime.fetch({ action: 'run', source: { kind: 'inline_text', media_type: 'text/plain', content: 'local  fact' }, pipeline: 'direct.local' });
    expect(inline).toMatchObject({ status: 'succeeded', documents: [{ content: 'local  fact' }] });
    expect('routing' in inline && inline.routing).toBeUndefined(); expect(remote).toBe(0);
  });
  it('fails builtin without paid fallback, only uses listed user fallback, and terminates on admission/404/auth', async () => {
    const home = await root(); let remote = 0;
    const registration = mockRegistration({ async fetch(url) { remote++; return document(url, 'listed fallback'); } });
    const config = mockConfig(home);
    const shell = io('<html><body><nav><a href="/home">Home</a></nav></body></html>', 200, 'text/html');
    const builtin = createRuntimeComposition({}, { cwd: home, homeDirectory: home, config, provider_registrations: [registration], test_only_direct_fetch_io: shell });
    expect(await builtin.runtime.fetch({ url: raw })).toMatchObject({ status: 'failed', routing: { pipelines: ['direct.fetch'] }, lane_outcomes: [{ error: { code: 'QUALITY_GATE_FAILED', data: { reason: 'empty' } } }] }); expect(remote).toBe(0);
    const fallback = createRuntimeComposition({}, { cwd: home, homeDirectory: home, config: { ...config, fetch: { routing: user } }, provider_registrations: [registration], test_only_direct_fetch_io: shell });
    expect(await fallback.runtime.fetch({ url: raw })).toMatchObject({ status: 'succeeded', routing: { origin: 'user', pipelines: ['direct.fetch', 'mock.fetch'] }, lane_outcomes: [{ lane: 'direct.fetch', attempts: [{ error: { code: 'QUALITY_GATE_FAILED' } }] }, { lane: 'mock.fetch' }] }); expect(remote).toBe(1);
    for (const status of [401, 404]) { const app = createRuntimeComposition({}, { cwd: home, homeDirectory: home, config: { ...config, fetch: { routing: user } }, provider_registrations: [registration], test_only_direct_fetch_io: io('', status) }); expect(await app.runtime.fetch({ url: raw })).toMatchObject({ status: 'failed', lane_outcomes: [{ error: { data: { status } } }] }); }
    expect(remote).toBe(1);
    expect(await fallback.runtime.fetch({ url: 'http://metadata.google.internal./latest', pipeline: 'mock.fetch' })).toMatchObject({ status: 'failed', error: { code: 'FETCH_BLOCKED' } }); expect(remote).toBe(1);
  });
  it('freezes selected async plan and bindings once across changed config, exposing route and attempts', async () => {
    const home = await root(); let calls = 0;
    const browser = { available: true, async resolve() { return ['8.8.8.8']; }, async render() { calls++; return { status: 200, final_url: 'https://example.test/article', html: '<main>frozen body</main>', content_type: 'text/html', byte_length: 24, truncated: false }; } };
    const app = createRuntimeComposition({}, { cwd: home, homeDirectory: home, launcher: { async launch() {} }, test_only_browser_render_io: browser, config: { home, jobs_root: join(home, 'jobs'), fetch: { routing: { rules: [{ id: 'frozen', match: { origin: 'https://example.test' }, action: { pipelines: ['browser.render'] } }] } } } });
    expect(await app.runtime.fetch({ url: 'https://example.test/article' })).toMatchObject({ status: 'failed', routing: { rule_id: 'frozen', pipelines: ['browser.render'] }, error: { code: 'LANE_EXECUTION_UNSUPPORTED' } });
    const queued = await app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.test/article' }, execution: 'async', idempotency_key: 'freeze' });
    if (queued.action !== 'run' || queued.execution !== 'async' || queued.job === undefined) throw new Error(JSON.stringify(queued));
    expect(queued.routing).toMatchObject({ rule_id: 'frozen', pipelines: ['browser.render'] }); expect(calls).toBe(0);
    app.config.resolved.config.fetch.routing!.rules![0]!.action = { pipelines: ['direct.fetch'] };
    const snapshot = await app.store.readExecutionSnapshot(queued.job.job_id);
    await createFetchJobRunnerFromSnapshot(snapshot, app.store, {}, { test_only_browser_render_io: browser }).run(queued.job.job_id);
    expect(await app.runtime.fetch({ action: 'get', job_id: queued.job.job_id })).toMatchObject({ state: 'succeeded', routing: queued.routing });
    const page = await app.runtime.fetch({ action: 'read', job_id: queued.job.job_id, page_size: 100 });
    if (page.action !== 'read') throw new Error('missing artifact');
    expect(page.routing).toEqual(queued.routing);
    const result = JSON.parse(Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8'));
    expect(result).toMatchObject({ routing: queued.routing, documents: [{ content: 'frozen body' }], lane_outcomes: [{ lane: 'browser.render', attempts: [{ attempt: 1 }] }] }); expect(calls).toBe(1);
    app.config.resolved.config.fetch.routing!.rules![0]!.action = { pipelines: ['browser.render'] };
    const failed = await app.runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.test/article' }, execution: 'async', idempotency_key: 'freeze-failure' });
    if (failed.action !== 'run' || failed.execution !== 'async' || failed.job === undefined) throw new Error(JSON.stringify(failed));
    const failedSnapshot = await app.store.readExecutionSnapshot(failed.job.job_id);
    await createFetchJobRunnerFromSnapshot(failedSnapshot, app.store, {}, { test_only_browser_render_io: { ...browser, async render() { throw new NbSearchError('QUALITY_GATE_FAILED', 'Fixture returned no usable document.', false, undefined, { data: { reason: 'empty' } }); } } }).run(failed.job.job_id);
    expect(await app.runtime.fetch({ action: 'get', job_id: failed.job.job_id })).toMatchObject({ state: 'failed', routing: failed.routing, artifact: { media_type: 'application/json' } });
    const failurePage = await app.runtime.fetch({ action: 'read', job_id: failed.job.job_id, page_size: 100 });
    if (failurePage.action !== 'read') throw new Error('missing failure artifact');
    const failureText = Buffer.concat(failurePage.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8');
    expect(JSON.parse(failureText)).toMatchObject({ status: 'failed', routing: failed.routing, documents: [], lane_outcomes: [{ attempts: [{ error: { code: 'QUALITY_GATE_FAILED' } }] }] });
  });
  it('keeps useful facts, links, code and table content; rejects shells/login with no extractor network', async () => {
    let network = 0; vi.stubGlobal('fetch', () => { network++; throw new Error('extractor must not fetch'); });
    const html = '<html><head><title>Reference</title></head><body><nav>NOISE_NAV</nav><main><h1>Reference API</h1><p>Retry count is 3. See <a href="../guide">retry guide</a>.</p><pre><code>if ready:\n    print("two  spaces")</code></pre><table><tr><th>Flag</th><th>Value</th></tr><tr><td>retry</td><td>3</td></tr></table></main></body></html>';
    const md = await extractHtml(html, 'https://example.test/docs/ref', 'markdown');
    expect(md.content).toContain('Retry count is 3'); expect(md.content).toContain('https://example.test/guide'); expect(md.content).toContain('    print("two  spaces")'); expect(md.content).toContain('retry'); expect(md.content).not.toContain('NOISE_NAV');
    const text = await extractHtml(html, 'https://example.test/docs/ref', 'text'); expect(text.content).toContain('Retry count is 3'); expect(text.content).toContain('https://example.test/guide'); expect(text.content).toContain('    print("two  spaces")');
    await expect(extractHtml('<html><body><nav>Home</nav></body></html>', 'https://example.test', 'markdown')).rejects.toMatchObject({ code: 'QUALITY_GATE_FAILED' });
    await expect(extractHtml('<html><body><form><input type="password"></form></body></html>', 'https://example.test', 'markdown')).rejects.toMatchObject({ code: 'FETCH_BLOCKED' }); expect(network).toBe(0);
  });
  it('projects GitHub contents text locally without inventing directory/binary/oversized source', () => {
    const url = new URL('https://api.github.com/repos/example/project/contents/a.py');
    const source = 'if ready:\n    print("two  spaces")\n';
    const file = { type: 'file', path: 'a.py', sha: 'abc', html_url: 'https://github.com/example/project/blob/main/a.py', encoding: 'base64', content: Buffer.from(source).toString('base64') };
    const result = projectJson(JSON.stringify(file), url, false, 1024, 'markdown'); expect(result.content).toContain(source); expect(result.content).toContain(file.html_url); expect(result.content).not.toContain(file.content);
    const directory = [{ type: 'file', path: 'a.py', html_url: file.html_url }]; expect(projectJson(JSON.stringify(directory), url, false, 1024, 'markdown').content).toContain('a.py');
    expect(projectJson(JSON.stringify({ ...file, encoding: 'none', content: '' }), url, false, 1024, 'markdown').warnings).toMatchObject([{ code: 'GITHUB_CONTENT_UNAVAILABLE' }]);
    expect(() => projectJson(JSON.stringify({ ...file, content: '@@@@' }), url, false, 1024, 'markdown')).toThrow(/base64/);
    expect(() => projectJson(JSON.stringify({ ...file, content: Buffer.from([0, 1, 2]).toString('base64') }), url, false, 1024, 'markdown')).toThrow(/binary/);
    expect(() => projectJson(JSON.stringify(file), url, false, 1, 'markdown')).toThrow(/byte limit/);
    expect(projectJson('{"content":', url, true, 1024, 'markdown')).toMatchObject({ content: '{"content":', warnings: [{ code: 'JSON_INCOMPLETE' }] });
  });
  it('retains host approved identity against an atomic file replacement', async () => {
    const home = await root(); const target = join(home, 'approved.txt'); await writeFile(target, 'APPROVED'); const identity = await captureFetchFileIdentity(target);
    const app = createRuntimeComposition({}, { cwd: home, homeDirectory: home, config: { fetch: { file_scopes: [{ id: 'docs', root: home, canonical_target: target, approved_identity: identity }] } } });
    await writeFile(`${target}.new`, 'REPLACED'); await rename(`${target}.new`, target);
    expect(await app.runtime.fetch({ action: 'run', source: { kind: 'file', scope: 'docs', path: 'approved.txt' }, pipeline: 'direct.local' })).toMatchObject({ status: 'failed', error: { code: 'FETCH_FILE_BLOCKED' }, documents: [] });
  });
});
