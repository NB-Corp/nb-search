import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { importSearchLayer } from '../src/search-layer-import.ts';
import { stableFingerprint } from '../src/config-schema.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() { const root = fs.mkdtempSync(resolve('.test-local-sharing-')); roots.push(root); const home = resolve(root, 'a'); const other = resolve(root, 'b'); const config = resolve(root, 'shared', 'config.json'); const source = resolve(root, 'source.json'); fs.writeFileSync(source, JSON.stringify({ exa: 'fake-exa' })); return { root, home, other, config, source }; }
function env(home: string, config?: string): NodeJS.ProcessEnv { const result: NodeJS.ProcessEnv = { NB_SEARCH_HOME: home, ...(config ? { NB_SEARCH_CONFIG: config } : {}), NODE_OPTIONS: '--import=./test/fixtures/no-external.mjs' }; for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) result[key] = process.env[key]; return result; }
function child(args: string[], environment: NodeJS.ProcessEnv, input?: unknown, fixture = 'shared-transaction.mjs') { const process = spawn(globalThis.process.execPath, ['--experimental-transform-types', `test/fixtures/${fixture}`, ...args], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; process.stdout.on('data', (value) => stdout += value); process.stderr.on('data', (value) => stderr += value); const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => { process.on('error', reject); process.on('close', (code) => done({ code, stdout, stderr })); }); process.stdin.end(input === undefined ? undefined : JSON.stringify(input)); return { process, done }; }
async function stop(process: ChildProcess) { if (process.exitCode === null && process.signalCode === null) { const done = new Promise<void>((done) => process.once('close', () => done())); process.kill(); await done; } }
async function paused(path: string) { for (let i = 0; i < 1000 && !fs.existsSync(path); i++) await sleep(10); expect(fs.existsSync(path)).toBe(true); }
function tree(root: string): string { return JSON.stringify(fs.readdirSync(root, { recursive: true }).sort().map((name) => { const path = resolve(root, String(name)); return [name, fs.lstatSync(path).isFile() ? fs.readFileSync(path).toString('base64') : 'directory']; })); }

describe('LD shared targets and legacy identity', () => {
  it.each(['.config-revision.json/config.json', '.config-revision.json.backup', 'notes.nb-search-revision.json'])('LD-02 reserves only exact metadata leaves, not ordinary data %s', (relative) => {
    const f = setup(); const config = resolve(f.root, relative); const before = tree(f.root); const environment = env(f.home, config);
    expect(importSearchLayer({ source: f.source, env: environment, apply: false }).mode).toBe('dry-run'); expect(tree(f.root)).toBe(before);
    expect(importSearchLayer({ source: f.source, env: environment, apply: true }).mode).toBe('apply'); expect(JSON.parse(fs.readFileSync(config, 'utf8')).schema_version).toBe('4');
  });
  it.each([false, true])('LD-02 reserves another transaction revision before either file exists; directory alias=%s', async (alias) => {
    const f = setup(); fs.mkdirSync(resolve(f.config, '..')); const selected = resolve(f.root, 'alias'); fs.symlinkSync(resolve(f.config, '..'), selected, process.platform === 'win32' ? 'junction' : 'dir');
    const marker = resolve(f.root, 'paused'); const release = resolve(f.root, 'release'); const a = child(['staging', f.source, marker, release], env(f.home, f.config));
    try { await paused(marker); const before = tree(f.root); const bConfig = resolve(alias ? selected : resolve(f.config, '..'), '.config.json.nb-search-revision.json');
      const b = await child(['apply', f.source], env(f.other, bConfig)).done; expect(b.code, b.stdout).toBe(2); expect(b.stderr).toMatch(/reserved|metadata/); expect(tree(f.root)).toBe(before); expect(fs.existsSync(f.other)).toBe(false);
      fs.writeFileSync(release, 'resume'); expect((await a.done).code).toBe(0); expect(JSON.parse(fs.readFileSync(f.config, 'utf8')).schema_version).toBe('4');
    } finally { await stop(a.process); }
  }, 60000);
  it.each(['.config-access.lock', '.config-revision.json', '.foreign.json.nb-search.lock', '.foreign.json.nb-search-revision.json'])('LD-02 rejects foreign reserved data leaf %s before creating any metadata', (name) => {
    const f = setup(); const before = tree(f.root); for (const apply of [false, true]) { expect(() => importSearchLayer({ source: f.source, env: env(f.home, resolve(f.root, name)), apply })).toThrow(/reserved|metadata/); expect(tree(f.root)).toBe(before); }
  });
  it.skipIf(process.platform === 'win32').each(['direct', 'chain'])('LD-02 rejects a file-data symlink to foreign metadata (%s)', (kind) => {
    const f = setup(); const reserved = resolve(f.root, '.foreign.json.nb-search-revision.json'); const selected = resolve(f.root, 'ordinary.json'); fs.symlinkSync(reserved, selected);
    if (kind === 'chain') fs.symlinkSync(resolve(f.root, 'target.json'), reserved);
    const before = tree(f.root); for (const apply of [false, true]) { expect(() => importSearchLayer({ source: f.source, env: env(f.home, selected), apply })).toThrow(/reserved|metadata/); expect(tree(f.root)).toBe(before); }
  });
  it.each(['.config-access.lock', '.config-revision.json', '.config.json.nb-search.lock', '.config.json.nb-search-revision.json'])('LD-02 rejects redirected metadata leaf %s before writes', (name) => {
    const f = setup(); fs.mkdirSync(f.home); const target = resolve(f.root, 'ordinary-target');
    if (process.platform === 'win32') fs.mkdirSync(target); else fs.writeFileSync(target, JSON.stringify({ schema_version: '4' }));
    fs.symlinkSync(target, resolve(f.home, name), process.platform === 'win32' ? 'junction' : 'file'); const before = tree(f.root);
    for (const apply of [false, true]) { expect(() => importSearchLayer({ source: f.source, env: env(f.home), apply })).toThrow(/metadata/); expect(tree(f.root)).toBe(before); }
  });
  it('LD-01 a real other-home ABA commit invalidates an in-flight snapshot without creating reader metadata', async () => {
    const f = setup(); fs.mkdirSync(resolve(f.config, '..')); const original = { schema_version: '4' }; fs.writeFileSync(f.config, JSON.stringify(original));
    const marker = resolve(f.root, 'paused'); const release = resolve(f.root, 'release'); const payload = resolve(f.root, 'payload.json'); const reader = child(['read', payload, marker, release], env(f.home, f.config), undefined, 'shared-snapshot.mjs');
    try {
      await paused(marker); const revisions: string[] = [];
      for (const value of [{ schema_version: '4', log_level: 'debug' }, original]) { fs.writeFileSync(payload, JSON.stringify({ config: value, secrets: { schema_version: '1', values: {} } })); const result = await child(['commit', payload], env(f.other, f.config), undefined, 'shared-snapshot.mjs').done; expect(result.code, result.stderr).toBe(0); revisions.push(fs.readFileSync(resolve(f.config, '..', '.config.json.nb-search-revision.json'), 'utf8')); }
      expect(revisions[0]).not.toBe(revisions[1]); fs.writeFileSync(release, 'resume'); const result = await reader.done; expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ pair: { config: original } }); expect(JSON.parse(result.stdout).reads).toBeGreaterThanOrEqual(2); expect(fs.existsSync(f.home)).toBe(false);
    } finally { await stop(reader.process); }
  }, 60000);
  it('LD-01 serializes real writers from different homes sharing a config, including a directory alias', async () => {
    const f = setup(); fs.mkdirSync(resolve(f.config, '..')); const alias = resolve(f.root, 'alias'); fs.symlinkSync(resolve(f.config, '..'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const marker = resolve(f.root, 'paused'); const release = resolve(f.root, 'release'); const a = child(['staging', f.source, marker, release], env(f.home, f.config));
    try {
      await paused(marker); const otherSource = resolve(f.root, 'tavily.json'); fs.writeFileSync(otherSource, JSON.stringify({ tavily: 'fake-tavily' })); const b = await child(['apply', otherSource], env(f.other, resolve(alias, 'config.json'))).done;
      expect(b.code, b.stderr).toBe(2); expect(b.stderr).toMatch(/busy|recovery/);
      const independentHome = resolve(f.root, 'independent'); expect((await child(['cli', 'capabilities'], env(independentHome)).done).code).toBe(0); expect(fs.existsSync(independentHome)).toBe(false);
      fs.writeFileSync(release, 'resume'); expect((await a.done).code).toBe(0);
      fs.writeFileSync(f.source, JSON.stringify({ exa: 'fake-exa', grokMultiAgent: { apiKey: 'fake-gma', apiUrl: 'https://fixture.example/v1' } })); const retry = await child(['apply', f.source], env(f.other, f.config)).done; expect(retry.code, retry.stderr).toBe(0);
      expect(Object.keys(JSON.parse(fs.readFileSync(f.config, 'utf8')).provider_instances).sort()).toEqual(['exa.default', 'grok-multi-agent.default']);
    } finally { await stop(a.process); }
  }, 60000);
  it.each([false, true])('LD-01 another-home reader rejects stable half-published shared pairs; crash=%s', async (crash) => {
    const f = setup(); fs.mkdirSync(f.home); fs.mkdirSync(f.other); fs.mkdirSync(resolve(f.config, '..')); fs.writeFileSync(f.config, JSON.stringify({ schema_version: '4' }));
    // Both platforms share the config across distinct homes; POSIX also shares the secrets file.
    const readerHome = f.other;
    if (process.platform !== 'win32') fs.symlinkSync(resolve(f.home, 'secrets.json'), resolve(f.other, 'secrets.json'));
    const marker = resolve(f.root, 'paused'); const release = resolve(f.root, 'release'); const a = child(['half', f.source, marker, release], env(f.home, f.config));
    try { await paused(marker); if (crash) await stop(a.process); const reader = await child(['cli', 'capabilities'], env(readerHome, f.config)).done; expect(reader.code, reader.stdout).toBe(2); expect(reader.stderr).toMatch(/busy|recovery/); if (!crash) { fs.writeFileSync(release, 'resume'); expect((await a.done).code).toBe(0); expect((await child(['cli', 'capabilities'], env(readerHome, f.config)).done).code).toBe(0); } }
    finally { await stop(a.process); }
  }, 60000);
  it.each(['.config-revision.json', '.config-access.lock', '.secrets.json.nb-search-revision.json', '.secrets.json.nb-search.lock'].flatMap((name) => [false, true].map((alias) => ({ name, alias }))))('LD-02 rejects data/metadata collision $name alias=$alias with zero writes', ({ name, alias }) => {
    const f = setup(); let parent = f.home;
    if (alias) { fs.mkdirSync(f.home); parent = resolve(f.root, 'alias'); fs.symlinkSync(f.home, parent, process.platform === 'win32' ? 'junction' : 'dir'); }
    const before = tree(f.root); for (const apply of [false, true]) { expect(() => importSearchLayer({ source: f.source, env: env(f.home, resolve(parent, name)), apply })).toThrow(/conflict|distinct|metadata/); expect(tree(f.root)).toBe(before); }
  });
  it.skipIf(process.platform === 'win32').each(['.config-revision.json', '.config-access.lock', '.config.json.nb-search-revision.json', '.config.json.nb-search.lock'])('LD-02 rejects secrets file alias to metadata %s without writes', (name) => {
    const f = setup(); fs.mkdirSync(f.home); fs.symlinkSync(resolve(f.home, name), resolve(f.home, 'secrets.json')); const before = tree(f.root);
    for (const apply of [false, true]) { expect(() => importSearchLayer({ source: f.source, env: env(f.home), apply })).toThrow(/conflict|distinct|metadata/); expect(tree(f.root)).toBe(before); }
  });
  it.each(['record', 'map'])('LD-03 follows a parent junction using a legacy lexical %s identity for get/read/cancel', async (layout) => {
    const f = setup(); const actual = resolve(f.root, 'actual'); fs.mkdirSync(resolve(actual, 'jobs'), { recursive: true }); const alias = resolve(f.root, 'alias'); fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir'); const jobs = resolve(alias, 'jobs'); expect(fs.lstatSync(jobs).isSymbolicLink()).toBe(false);
    const environment = { ...env(f.home), NB_SEARCH_JOBS_ROOT: jobs }; const admitted = await child(['cli', 'fetch', '--stdin'], environment, { action: 'run', execution: 'async', idempotency_key: layout, pipeline: 'direct.local', source: { kind: 'inline_text', content: 'legacy evidence', media_type: 'text/plain' } }).done; expect(admitted.code, admitted.stderr).toBe(7); const id = JSON.parse(admitted.stdout).job.job_id; const record = resolve(f.home, 'job-connections', `${id}.json`); const value = { kind: 'fetch', identity: stableFingerprint({ kind: 'local', jobs_root: jobs }) };
    if (layout === 'record') fs.writeFileSync(record, JSON.stringify(value)); else { fs.unlinkSync(record); fs.writeFileSync(resolve(f.home, 'job-connections.json'), JSON.stringify({ [id]: value })); }
    for (const action of ['get', 'read', 'cancel']) { const result = await child(['cli', 'fetch', action, id, ...(action === 'get' ? ['--wait', '15000'] : [])], environment).done; expect(result.code, result.stderr).toBe(0); }
    const different = await child(['cli', 'fetch', 'get', id], { ...environment, NB_SEARCH_JOBS_ROOT: resolve(f.root, 'different') }).done; expect(different.code).toBe(2); expect(different.stderr).toMatch(/different connection/);
    const wrongKind = await child(['cli', 'search', 'get', id], environment).done; expect(wrongKind.code).toBe(2); expect(wrongKind.stderr).toMatch(/different connection/);
    fs.writeFileSync(resolve(f.home, 'profiles.json'), JSON.stringify({ schema_version: '1', profiles: { remote: { kind: 'remote', base_url: 'http://127.0.0.1:1', allow_loopback_http: true, token_env: 'FAKE_TOKEN' } } }));
    const remote = await child(['cli', '--profile', 'remote', 'fetch', 'get', id], { ...environment, FAKE_TOKEN: 'fake-token' }).done; expect(remote.code).toBe(2); expect(remote.stderr).toMatch(/different connection/);
  }, 60000);
});
