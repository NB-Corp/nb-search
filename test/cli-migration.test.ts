import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, lstatSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importSearchLayer, mapLegacy } from '../src/search-layer-import.ts';
import { ensureHome, writeProtected, acquireConfigLock } from '../src/cli-storage.ts';
import { cliDoctor, loadCliConnection, privateEnvironment, resolveCliSnapshot } from '../src/cli-config.ts';

async function providerFixture() {
  const hits: string[] = [];
  const server = createServer(async (req, res) => { for await (const _ of req) {} hits.push(String(req.headers['x-api-key'])); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'fixture', url: 'https://example.com/', text: 'evidence' }] })); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  return { hits, base: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(raw: unknown = { exa: 'fake-exa', exaApiBase: 'https://proxy.example/exa', tavily: 'fake-tavily', grok: { apiKey: 'fake-grok', apiUrl: 'https://relay.example/v1' }, grokMultiAgent: { apiKey: 'fake-gma', apiUrl: 'https://relay.example/v1', apiMode: 'messages' } }) { const root = mkdtempSync(resolve('.test-migration-')); roots.push(root); const home = resolve(root, 'home'); const source = resolve(root, 'legacy.json'); writeFileSync(source, `\ufeff${JSON.stringify(raw)}`); return { root, home, source, env: { ...processEnv(), NB_SEARCH_HOME: home } }; }
function processEnv(): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '--import=./test/fixtures/no-external.mjs' }; for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key]; return env; }
function cli(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> { return new Promise((resolveResult, reject) => { const child = spawn(process.execPath, ['dist/cli.mjs', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v); child.on('error', reject); child.on('close', (code) => resolveResult({ code, stdout, stderr })); child.stdin.end(stdin); }); }

describe('explicit fake-secret migration', () => {
  it('R1 preserves a valid rebound lane and refuses an invalid merged results preset before any writes or network', async () => {
    const f = fixture({ exa: 'fake-semantic-key' }); ensureHome(f.home);
    const path = resolve(f.home, 'config.json'); const original = { schema_version: '4', lanes: { 'exa.search': { provider_instance_id: 'exa.default', operation_id: 'synthesis', latency: 'medium', cost: 'expensive' } } };
    writeProtected(path, original); const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed.'));
    try {
      expect(await loadCliConnection('local', f.env).runtime.capabilities()).toMatchObject({ schema_version: '3.0' }); expect(cliDoctor('local', f.env)).toMatchObject({ status: 'succeeded' });
      const before = readFileSync(path); const names = readdirSync(f.home).sort();
      for (const apply of [false, true]) { expect(() => importSearchLayer({ ...f, apply })).toThrow(/semantics/); expect(readFileSync(path)).toEqual(before); expect(readdirSync(f.home).sort()).toEqual(names); expect(existsSync(resolve(f.home, 'secrets.json'))).toBe(false); expect(existsSync(resolve(f.home, 'jobs'))).toBe(false); }
      writeFileSync(path, JSON.stringify({ ...original, presets: { bad: { lanes: ['exa.search'] } } })); expect(() => cliDoctor('local', f.env)).toThrow(/results/); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  }, 120000);
  it('maps real legacy precedence, independent GMA key, modes, aliases, and results-only preset', () => {
    const mapped = mapLegacy({ exa: { apiKey: 'nested', apiUrl: 'https://nested.example' }, exaApiBase: 'https://top.example/exa/search', grok: { apiKey: 'grok-own', apiUrl: 'https://relay.example/v1/chat/completions' }, grokMultiAgent: { apiKey: 'gma-own', apiMode: 'anthropic' } }, { EXA_API_KEY: 'environment', GROK_API_KEY: 'env-grok' });
    expect(mapped.secrets.values).toMatchObject({ NB_SEARCH_EXA_API_KEY: 'environment', NB_SEARCH_GROK_API_KEY: 'env-grok', NB_SEARCH_GROK_MULTI_AGENT_API_KEY: 'gma-own' });
    expect(mapped.secrets).not.toHaveProperty('bindings');
    expect(mapped.patch.provider_instances?.['exa.default']?.base_url).toBe('https://top.example/exa');
    expect(mapped.patch.provider_instances?.['grok.default']?.enabled).toBe(false); expect(mapped.patch.provider_instances?.['grok-multi-agent.default']?.enabled).toBe(false);
    expect(mapped.patch.presets?.['research-evidence']?.lanes).toEqual(['exa.search']); expect(mapped.patch.execution?.retry_count).toBe(0);
    expect(() => mapLegacy({ exaApiBase: 'https://x.example/?token=secret' }, {})).toThrow();
    expect(() => mapLegacy({ grokMultiAgent: { reasoningEffort: 'invalid' } }, {})).toThrow();
    expect(mapLegacy({ grokMultiAgent: { apiKey: 'fake', apiUrl: 'https://relay.example/v1/responses', apiMode: 'chat' } }, {}).patch.provider_instances?.['grok-multi-agent.default']?.enabled).toBe(false);
    expect(privateEnvironment({ NB_SEARCH_EXA_API_KEY: '' }, { schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'file' } })['NB_SEARCH_EXA_API_KEY']).toBe('');
  });
  it('dry-run is zero-write and apply is idempotent, mode-contract preserving, redacted, fresh-process readable', async () => {
    const f = fixture(); const before = readFileSync(f.source);
    const dry = importSearchLayer({ ...f, apply: false }); expect(dry.status).toBe('partial'); expect(existsSync(f.home)).toBe(false); expect(JSON.stringify(dry)).not.toMatch(/fake-|proxy\.example|relay\.example/);
    const applied = importSearchLayer({ ...f, apply: true }); expect(applied.targets).toBe('created');
    if (process.platform !== 'win32') { expect(statSync(f.home).mode & 0o777).toBe(0o700); expect(statSync(resolve(f.home, 'config.json')).mode & 0o777).toBe(0o600); expect(statSync(resolve(f.home, 'secrets.json')).mode & 0o777).toBe(0o600); }
    const second = importSearchLayer({ ...f, apply: true }); expect(second.targets).toBe('unchanged'); expect(readFileSync(f.source)).toEqual(before);
    const result = await cli(['--doctor'], f.env); expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('exa'); expect(result.stdout + result.stderr).not.toMatch(/fake-|proxy\.example|relay\.example/);
    const catalog = await cli(['capabilities'], f.env); expect(catalog.code, catalog.stderr).toBe(0); const value = JSON.parse(catalog.stdout); expect(value.search.default_lane).toBe('exa.search'); expect(value.search.lanes.find((lane: { id: string }) => lane.id === 'gma.research').availability).toBe('ready');
  }, 120000);
  it('saves to a deep linked config and lets canonical env values override at runtime', () => {
    const f = fixture({ exa: 'fake-file-key', exaApiBase: 'https://saved.example/exa' }); const linked = resolve(f.root, 'selected', 'config.json');
    const actual = process.platform === 'win32' ? resolve(f.root, 'selected-target', 'config.json') : resolve(f.root, 'selected.json');
    if (process.platform === 'win32') mkdirSync(resolve(f.root, 'selected-target'), { recursive: true }); else mkdirSync(resolve(linked, '..'), { recursive: true });
    writeFileSync(actual, JSON.stringify({ schema_version: '4' }));
    if (process.platform === 'win32') symlinkSync(resolve(f.root, 'selected-target'), resolve(f.root, 'selected'), 'junction'); else symlinkSync(actual, linked, 'file');
    const home = resolve(f.root, 'new', 'deep', 'home'); const env = { ...f.env, NB_SEARCH_HOME: home, NB_SEARCH_CONFIG: linked, NB_SEARCH_EXA_API_KEY: 'fake-env-key', NB_SEARCH_EXA_BASE_URL: 'https://override.example/exa' };
    expect(importSearchLayer({ source: f.source, env, apply: false })).toMatchObject({ mode: 'dry-run' }); expect(existsSync(home)).toBe(false); expect(JSON.parse(readFileSync(actual, 'utf8'))).toEqual({ schema_version: '4' });
    expect(importSearchLayer({ source: f.source, env, apply: true })).toMatchObject({ mode: 'apply' }); expect(lstatSync(process.platform === 'win32' ? resolve(f.root, 'selected') : linked).isSymbolicLink()).toBe(true); expect(JSON.parse(readFileSync(actual, 'utf8')).provider_instances['exa.default'].base_url).toBe('https://saved.example/exa');
    const secrets = JSON.parse(readFileSync(resolve(home, 'secrets.json'), 'utf8')); expect(secrets.values.NB_SEARCH_EXA_API_KEY).toBe('fake-file-key'); expect(secrets).not.toHaveProperty('bindings');
    const snapshot = resolveCliSnapshot(env); expect(snapshot.effective.config.provider_instances['exa.default']?.base_url).toBe('https://override.example/exa'); expect(snapshot.effective.secret_bindings.get('exa.default')?.value).toBe('fake-env-key'); expect(cliDoctor('local', env)).toMatchObject({ status: 'succeeded' });
  });
  it('allows later endpoint and structurally valid slot changes while explicit env still wins', () => {
    const f = fixture(); importSearchLayer({ ...f, apply: true });
    const configPath = resolve(f.home, 'config.json'); const config = JSON.parse(readFileSync(configPath, 'utf8')); config.provider_instances['exa.default'].base_url = 'https://changed.example'; config.credential_slots['exa.default'].env = 'NB_SEARCH_TAVILY_API_KEY'; writeFileSync(configPath, JSON.stringify(config));
    const secretsPath = resolve(f.home, 'secrets.json'); const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); secrets.bindings = { NB_SEARCH_EXA_API_KEY: [{ instance: 'legacy', provider: 'legacy', slot: 'legacy', env: 'OLD_KEY', base_url: 'https://old.example' }] }; writeFileSync(secretsPath, JSON.stringify(secrets));
    const env = { ...f.env, NB_SEARCH_EXA_BASE_URL: 'https://override.example' }; expect(() => loadCliConnection('local', env)).not.toThrow(); const snapshot = resolveCliSnapshot(env); expect(snapshot.effective.config.provider_instances['exa.default']?.base_url).toBe('https://override.example'); expect(snapshot.effective.config.credential_slots['exa.default']?.env).toBe('NB_SEARCH_TAVILY_API_KEY');
  }, 120000);
  it('rejects invalid sources, conflicts and an existing interruption lock', () => {
    const f = fixture(); writeFileSync(f.source, '{invalid secret'); expect(() => importSearchLayer({ ...f, apply: true })).toThrow(); expect(existsSync(f.home)).toBe(false);
    writeFileSync(f.source, JSON.stringify({ exa: 'fake' })); ensureHome(f.home); writeProtected(resolve(f.home, 'config.json'), { provider_instances: { 'exa.default': { base_url: 'https://existing.example' } } });
    expect(() => importSearchLayer({ ...f, apply: true })).toThrow(/conflict/); expect(existsSync(resolve(f.home, 'secrets.json'))).toBe(false);
    const unlock = acquireConfigLock(f.home); expect(() => loadCliConnection('local', f.env)).toThrow(/busy/); unlock();
  }, 120000);
  it.each(['before-secrets', 'after-secrets', 'before-config', 'after-config', 'before-revision', 'after-revision', 'before-unlock'])('real CLI refuses publication boundary %s, including killed importer', async (boundary) => {
    const vendor = await providerFixture(); const proxy = await providerFixture();
    const f = fixture({ exa: 'fake-proxy-key', exaApiBase: `${proxy.base}/exa` }); const marker = resolve(f.root, 'paused'); const release = resolve(f.root, 'release');
    const env = { ...f.env, NB_SEARCH_TEST_VENDOR_URL: vendor.base };
    const child = spawn(process.execPath, ['--experimental-transform-types', 'test/fixtures/import-paused.mjs', f.home, f.source, boundary, marker, release], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let errors = ''; child.stderr.on('data', (v) => errors += v);
    try {
      const until = Date.now() + 90000; while (!existsSync(marker) && Date.now() < until && child.exitCode === null) await sleep(50); expect(existsSync(marker), errors).toBe(true);
      const live = await cli(['search', 'probe', '--lane', 'exa.search'], env); expect(live.code).toBe(2); expect(live.stdout).toBe(''); expect(live.stderr).toMatch(/busy|recovery/);
      const closed = new Promise<void>((done) => child.once('close', () => done())); child.kill(); await closed;
      const after = await cli(['search', 'probe', '--lane', 'exa.search'], env); expect(after.code).toBe(2); expect(after.stdout).toBe(''); expect(after.stderr).not.toContain('fake-proxy-key'); expect(existsSync(resolve(f.home, '.config-access.lock'))).toBe(true);
      expect(vendor.hits).toEqual([]); expect(proxy.hits).toEqual([]);
    } finally { if (child.exitCode === null) child.kill(); await vendor.close(); await proxy.close(); }
  }, 150000);
  it('reader crash during snapshot capture leaves no configuration lock or recovery obligation', async () => {
    const f = fixture({ exa: 'fake-reader', exaApiBase: 'http://127.0.0.1:1' }); importSearchLayer({ ...f, apply: true });
    const marker = resolve(f.root, 'reader-paused'); const child = spawn(process.execPath, ['--experimental-transform-types', 'test/fixtures/reader-paused.mjs', f.home, marker, resolve(f.root, 'release')], { env: f.env, stdio: 'ignore' });
    try { const until = Date.now() + 60000; while (!existsSync(marker) && Date.now() < until && child.exitCode === null) await sleep(50); expect(existsSync(marker)).toBe(true); expect(existsSync(resolve(f.home, '.config-access.lock'))).toBe(false); const closed = new Promise<void>((done) => child.once('close', () => done())); child.kill(); await closed; const result = await cli(['capabilities'], f.env); expect(result.code, result.stderr).toBe(0); expect(existsSync(resolve(f.home, '.config-access.lock'))).toBe(false); } finally { if (child.exitCode === null) child.kill(); }
  }, 120000);
  it.each(['fault-after-secrets', 'fault-after-config', 'fault-before-unlock'])('keeps publication faults persistently blocked: %s', async (boundary) => {
    const f = fixture({ exa: 'fake-fault', exaApiBase: 'http://127.0.0.1:1' });
    await new Promise<void>((done, reject) => { const child = spawn(process.execPath, ['--experimental-transform-types', 'test/fixtures/import-paused.mjs', f.home, f.source, boundary, resolve(f.root, 'marker'), resolve(f.root, 'release')], { env: f.env, stdio: 'ignore' }); child.on('error', reject); child.on('close', (code) => { expect(code).not.toBe(0); done(); }); });
    expect(existsSync(resolve(f.home, '.config-access.lock'))).toBe(true);
    const result = await cli(['search', 'no call', '--lane', 'exa.search'], f.env); expect(result.code).toBe(2); expect(result.stdout).toBe('');
  }, 120000);
  it('keeps an already constructed runtime on its old endpoint/key while fresh CLI uses the new complete pair', async () => {
    const old = await providerFixture(); const next = await providerFixture(); const f = fixture({ exa: 'fake-new', exaApiBase: next.base });
    try {
      const connection = loadCliConnection('local', { ...f.env, NB_SEARCH_EXA_API_KEY: 'fake-old', NB_SEARCH_EXA_BASE_URL: old.base });
      importSearchLayer({ ...f, apply: true });
      await connection.runtime.search({ action: 'run', query: 'old runtime', lane: 'exa.search' });
      const result = await cli(['search', 'new runtime', '--lane', 'exa.search'], f.env); expect(result.code, result.stderr).toBe(0); expect(old.hits).toEqual(['fake-old']); expect(next.hits).toEqual(['fake-new']);
    } finally { await old.close(); await next.close(); }
  }, 120000);
  it('carries explicit messages mode through sync CLI and the real detached worker', async () => {
    const calls: Array<{ url?: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
    const research = { answer: '真实形状假数据 🌍', results: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Evidence' }], claims: [{ text: 'Statement', evidence_urls: ['https://example.com/source'], confidence: 'high', evidence_strength: 'direct' }] };
    const server = createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); calls.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: JSON.stringify(research) }] })); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const f = fixture({ grokMultiAgent: { apiKey: 'fake-messages-worker', apiUrl: `http://127.0.0.1:${address.port}/v1/messages`, apiMode: 'messages' } });
    try {
      expect(importSearchLayer({ ...f, apply: true }).providers.find((item) => item.provider === 'grok-multi-agent')).toMatchObject({ normalized_protocol: 'messages', status: 'compatible_unverified' });
      const sync = await cli(['search', 'one complete brief', '--lane', 'gma.research'], f.env); expect(sync.code, sync.stderr + sync.stdout).toBe(0); expect(JSON.parse(sync.stdout).output.data).toMatchObject({ api_mode: 'messages', answer: research.answer });
      const asyncResult = await cli(['--profile', 'local', 'search', 'one complete brief', '--lane', 'gma.research', '--execution', 'async', '--idempotency-key', 'messages-worker', '--wait', '30000'], f.env); expect(asyncResult.code, asyncResult.stderr + asyncResult.stdout).toBe(0); expect(JSON.parse(asyncResult.stdout).data).toMatchObject({ api_mode: 'messages', answer: research.answer, backend_trace_observable: false, semantic_verification: false });
      expect(calls).toHaveLength(2); for (const call of calls) { expect(call.url).toBe('/v1/messages'); expect(call.headers['x-api-key']).toBe('fake-messages-worker'); expect(call.headers['anthropic-version']).toBe('2023-06-01'); expect(call.body['system']).toEqual(expect.any(String)); expect(call.body['messages']).toHaveLength(1); }
      for (const job of readdirSync(resolve(f.home, 'jobs')).filter((name) => !name.startsWith('.'))) { const snapshot = readFileSync(resolve(f.home, 'jobs', job, 'execution.json'), 'utf8'); expect(snapshot).toContain('messages'); expect(snapshot).not.toContain('fake-messages-worker'); }
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  }, 120000);
  it('passes file credentials to the actual detached worker without snapshot disclosure', async () => {
    const hits: string[] = []; const server = createServer(async (req, res) => { for await (const _ of req) {} hits.push(String(req.headers['x-api-key'])); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'fixture', url: 'https://example.com/', text: 'fixture evidence' }] })); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const f = fixture({ exa: 'fake-worker-key', exaApiBase: `http://127.0.0.1:${address.port}` });
    try { importSearchLayer({ ...f, apply: true }); const result = await cli(['--profile', 'local', 'search', 'worker query', '--lane', 'exa.search', '--execution', 'async', '--idempotency-key', 'worker-test', '--wait', '30000'], f.env); expect(result.code, result.stderr + result.stdout).toBe(0); expect(hits).toEqual(['fake-worker-key']); const jobs = readdirSync(resolve(f.home, 'jobs')).filter((name) => !name.startsWith('.')); for (const job of jobs) expect(readFileSync(resolve(f.home, 'jobs', job, 'execution.json'), 'utf8')).not.toContain('fake-worker-key'); } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  }, 120000);
});
