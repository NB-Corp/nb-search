import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireConfigLock, atomicJson, captureConfigPair, commitRevision, ensureHome, readRevision, writeProtected } from '../src/cli-storage.ts';
import { jobBinding, loadCliConnection, resolveCliSnapshot } from '../src/cli-config.ts';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });
function setup() { const root = fs.mkdtempSync(resolve('.test-snapshot-')); roots.push(root); const home = resolve(root, 'home'); ensureHome(home); const config = resolve(home, 'config.json'); const secrets = resolve(home, 'secrets.json'); writeProtected(config, { schema_version: '4', provider_instances: { 'exa.default': { base_url: 'https://old.example' } } }); writeProtected(secrets, { schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fake-old' } }); return { root, home, config, secrets }; }
function commit(f: ReturnType<typeof setup>, base: string, key: string) { const unlock = acquireConfigLock(f.home); atomicJson(f.config, { schema_version: '4', provider_instances: { 'exa.default': { base_url: base } } }); atomicJson(f.secrets, { schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: key } }); commitRevision(f.home); unlock(); }

describe('configuration snapshot and immutable job records', () => {
  it('publishes same-job records concurrently without overwriting a competing identity', async () => {
    const f = setup(); const id = randomUUID();
    const env: NodeJS.ProcessEnv = {}; for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    const record = (identity: string) => new Promise<number | null>((done, reject) => { const child = childProcess.spawn(process.execPath, ['--experimental-transform-types', 'test/fixtures/record-binding.mjs', f.home, id, identity], { env, stdio: 'ignore' }); child.on('error', reject); child.on('close', done); });
    expect(await Promise.all(Array.from({ length: 4 }, () => record('same')))).toEqual([0, 0, 0, 0]);
    const path = resolve(f.home, 'job-connections', `${id}.json`); const bytes = fs.readFileSync(path);
    expect(await Promise.all([record('same'), record('different')])).toEqual([0, 2]); expect(fs.readFileSync(path)).toEqual(bytes);
    expect(fs.readdirSync(resolve(f.home, 'job-connections'))).toEqual([`${id}.json`]);
  }, 60000);
  it.each([false, true])('detects full commit during capture, including ABA restoring the original bytes (%s)', (aba) => {
    const f = setup(); const original = fs.readFileSync; let triggered = false; let configReads = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = (original as (...args: unknown[]) => unknown)(path, ...args);
      if (String(path) === f.config) { configReads++; if (!triggered) { triggered = true; commit(f, 'https://new.example', 'fake-new'); if (aba) commit(f, 'https://old.example', 'fake-old'); } }
      return value;
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    const snapshot = resolveCliSnapshot({ NB_SEARCH_HOME: f.home }); const binding = snapshot.effective.secret_bindings.get('exa.default');
    expect(snapshot.effective.config.provider_instances['exa.default']?.base_url).toBe(aba ? 'https://old.example' : 'https://new.example'); expect(binding?.value).toBe(aba ? 'fake-old' : 'fake-new'); expect(configReads).toBeGreaterThanOrEqual(2); expect(readRevision(f.home)).not.toBe('initial');
  }, 60000);
  it('requires final lock observation before final revision and detects commit between them', () => {
    const f = setup(); const original = fs.lstatSync; let observations = 0; let injected = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === resolve(f.home, '.config-access.lock') && !injected && ++observations === 2) { injected = true; commit(f, 'https://new.example', 'fake-new'); }
      return (original as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    const value = resolveCliSnapshot({ NB_SEARCH_HOME: f.home }); expect(injected).toBe(true); expect(value.effective.secret_bindings.get('exa.default')?.value).toBe('fake-new');
  }, 60000);
  it('reads captured config/secrets once per snapshot and never probes PowerShell', async () => {
    const f = setup(); const original = fs.readFileSync; const counts = new Map<string, number>();
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => { const name = String(path); if ([f.config, f.secrets].includes(name)) { const count = (counts.get(name) ?? 0) + 1; counts.set(name, count); if (count > 1) throw new Error('Forbidden post-capture file reread'); } return (original as (...args: unknown[]) => unknown)(path, ...args); }) as typeof fs.readFileSync);
    const probe = vi.spyOn(childProcess, 'execFileSync'); syncBuiltinESMExports(); const connection = loadCliConnection('local', { NB_SEARCH_HOME: f.home }); expect(await connection.runtime.capabilities()).toMatchObject({ schema_version: '3.0' }); expect([...counts.values()]).toEqual([1, 1]); expect(probe).not.toHaveBeenCalled();
    counts.clear(); loadCliConnection('local', { NB_SEARCH_HOME: f.home }); expect(probe).not.toHaveBeenCalled();
  }, 60000);
  it('does not treat permission-denied revision probes as absence', () => {
    const f = setup(); const original = fs.statSync;
    const name = '.config-revision.json';
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => { if (String(path) === resolve(f.home, name)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return (original as (...args: unknown[]) => unknown)(path, ...args); }) as typeof fs.statSync);
    syncBuiltinESMExports(); expect(() => captureConfigPair(f.home, f.config)).toThrow(); spy.mockRestore(); syncBuiltinESMExports();
  });
  it('preserves legacy binding conflicts and allows remote records during a local writer transaction', () => {
    const f = setup(); const id = randomUUID(); const legacy = { [id]: { kind: 'search', identity: 'old' } }; writeProtected(resolve(f.home, 'job-connections.json'), legacy); const bytes = fs.readFileSync(resolve(f.home, 'job-connections.json'));
    const runtime = {} as ReturnType<typeof loadCliConnection>['runtime']; const old = { home: f.home, identity: 'old', runtime };
    const unlock = acquireConfigLock(f.home);
    try { jobBinding(old, 'search', id, true); jobBinding(old, 'search', id, true); expect(() => jobBinding({ ...old, identity: 'new' }, 'search', id, true)).toThrow(/different/); jobBinding(old, 'fetch', randomUUID(), true); expect(fs.readFileSync(resolve(f.home, 'job-connections.json'))).toEqual(bytes); } finally { unlock(); }
    const path = resolve(f.home, 'job-connections', `${id}.json`); const alias = `${path}.leftover`; fs.linkSync(path, alias); expect(() => jobBinding(old, 'search', id)).not.toThrow();
  }, 60000);
});
