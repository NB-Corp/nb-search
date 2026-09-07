import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliDoctor, loadCliConnection } from '../src/cli-config.ts';
import { runCli } from '../src/cli.ts';
import { importSearchLayer } from '../src/search-layer-import.ts';
import { createNbSearchRuntime, type ProviderRegistration } from '../src/index.ts';
import { JobStore } from '../src/job-store.ts';
import { readJson } from '../src/cli-storage.ts';
import type { NbSearchRuntime } from '../src/runtime.ts';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(resolve('.test-local-environment-')); roots.push(root); return { root, home: resolve(root, 'home'), source: resolve(root, 'legacy.json') }; }
function json(path: string, value: unknown) { fs.mkdirSync(resolve(path, '..'), { recursive: true }); fs.writeFileSync(path, JSON.stringify(value), { mode: 0o666 }); }
function io() { const stdout = { value: '', write(value: string) { this.value += value; } }; const stderr = { value: '', write(value: string) { this.value += value; } }; return { stdout, stderr }; }

describe('local environment is the user’s choice', () => {
  it('accepts readable broad-permission storage without spawning PowerShell or modifying modes', async () => {
    const f = fixture(); fs.mkdirSync(f.home, { mode: 0o777 }); json(resolve(f.home, 'config.json'), { schema_version: '4' }); json(resolve(f.home, 'secrets.json'), { schema_version: '1', values: {} });
    const mode = fs.statSync(f.home).mode; const spawn = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('PowerShell is not installed'); }); syncBuiltinESMExports();
    expect(cliDoctor('local', { NB_SEARCH_HOME: f.home })).toMatchObject({ status: 'succeeded' }); expect(await loadCliConnection('local', { NB_SEARCH_HOME: f.home }).runtime.capabilities()).toMatchObject({ schema_version: '3.0' }); expect(spawn).not.toHaveBeenCalled(); expect(fs.statSync(f.home).mode).toBe(mode);
  });
  it('imports to a linked custom config in a deep directory, keeps links and accepts existing env overrides', () => {
    const f = fixture(); const actualDir = resolve(f.root, 'user-config'); const actual = resolve(actualDir, 'config.json'); json(actual, { schema_version: '4' }); const selectedDir = resolve(f.root, 'selected'); fs.symlinkSync(actualDir, selectedDir, process.platform === 'win32' ? 'junction' : 'dir'); const linked = resolve(selectedDir, 'config.json'); const home = resolve(f.root, 'new', 'deep', 'home'); json(f.source, { exa: 'fake-file-key', exaApiBase: 'https://saved.example/exa' });
    const env = { NB_SEARCH_HOME: home, NB_SEARCH_CONFIG: linked, NB_SEARCH_EXA_API_KEY: 'fake-env-key', NB_SEARCH_EXA_BASE_URL: 'https://override.example/exa' };
    expect(importSearchLayer({ source: f.source, env, apply: false })).toMatchObject({ mode: 'dry-run' }); expect(fs.existsSync(home)).toBe(false); expect(JSON.parse(fs.readFileSync(actual, 'utf8'))).toEqual({ schema_version: '4' });
    expect(importSearchLayer({ source: f.source, env, apply: true })).toMatchObject({ mode: 'apply' }); expect(fs.lstatSync(selectedDir).isSymbolicLink()).toBe(true); expect(JSON.parse(fs.readFileSync(actual, 'utf8')).provider_instances['exa.default'].base_url).toBe('https://saved.example/exa');
    const secrets = JSON.parse(fs.readFileSync(resolve(home, 'secrets.json'), 'utf8')); expect(secrets.values.NB_SEARCH_EXA_API_KEY).toBe('fake-file-key'); expect(secrets).not.toHaveProperty('bindings');
    expect(cliDoctor('local', env)).toMatchObject({ status: 'succeeded' });
  });
  it('follows junction homes/jobs roots and ignores legacy endpoint/slot binding metadata', async () => {
    const f = fixture(); const target = resolve(f.root, 'actual-home'); fs.mkdirSync(target); fs.symlinkSync(target, f.home, process.platform === 'win32' ? 'junction' : 'dir');
    json(resolve(target, 'config.json'), { schema_version: '4', provider_instances: { 'exa.default': { base_url: 'https://new.example' } }, credential_slots: { 'exa.default': { provider_id: 'exa', env: 'USER_EXA_KEY' } } });
    json(resolve(target, 'secrets.json'), { schema_version: '1', values: { USER_EXA_KEY: 'fake-key' }, bindings: { USER_EXA_KEY: [{ instance: 'old', provider: 'exa', slot: 'old', env: 'OLD_KEY', base_url: 'https://old.example' }] } });
    expect(cliDoctor('local', { NB_SEARCH_HOME: f.home })).toMatchObject({ status: 'succeeded', configured_providers: ['exa'] });
    const actualJobs = resolve(f.root, 'actual-jobs'); fs.mkdirSync(actualJobs); const jobs = resolve(f.root, 'selected-jobs'); fs.symlinkSync(actualJobs, jobs, process.platform === 'win32' ? 'junction' : 'dir'); const store = new JobStore(jobs); await store.initialize(); const id = randomUUID(); json(resolve(actualJobs, id, 'job.json'), { job_id: id, state: 'queued' }); expect(await store.read(id)).toMatchObject({ job_id: id }); expect(fs.lstatSync(jobs).isSymbolicLink()).toBe(true);
    const escaped = randomUUID(); fs.symlinkSync(resolve(actualJobs, id), resolve(actualJobs, escaped), process.platform === 'win32' ? 'junction' : 'dir'); await expect(store.read(escaped)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
  it('defaults shorthand and stdin job follow-up to local', async () => {
    const id = randomUUID(); const runtime = { search: vi.fn(async () => ({ schema_version: '3.0', action: 'get', job_id: id, state: 'queued', cancel_requested: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })), fetch: vi.fn(), capabilities: vi.fn() } as unknown as NbSearchRuntime;
    expect(await runCli(['search', 'get', id], io(), () => runtime)).toBe(7);
    expect(await runCli(['search', '--stdin'], { ...io(), stdin: (async function* () { yield JSON.stringify({ action: 'get', job_id: id }); })() }, () => runtime)).toBe(7); expect(runtime.search).toHaveBeenCalledTimes(2);
  });
  it('returns short text and >64KiB sync outputs by default while explicit quality/inline limits still apply', async () => {
    const f = fixture(); const env = { NB_SEARCH_HOME: f.home };
    const registration: ProviderRegistration = { descriptor: { provider_id: 'fixture', adapter_version: '1', query_operations: [{ operation_id: 'answer', output: { channel: 'typed', schema_id: 'fixture@1' }, built_in_async: false }], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] }, create: () => ({ query: { answer: { name: 'fixture', async execute() { return { channel: 'typed', data: { text: 'x'.repeat(100000) } }; } } }, fetch: {} }) };
    const config = { provider_instances: { 'fixture.default': { provider_id: 'fixture', enabled: true, options: {} } }, lanes: { example: { provider_instance_id: 'fixture.default', operation_id: 'answer', latency: 'fast' as const, cost: 'free' as const } } };
    const runtime = createNbSearchRuntime({ env, config, provider_registrations: [registration] }); const source = { kind: 'inline_text' as const, content: 'cf-challenge', media_type: 'text/plain' as const };
    expect(await runtime.fetch({ action: 'run', source })).toMatchObject({ status: 'succeeded', documents: [{ content: 'cf-challenge' }] }); expect(await runtime.search({ action: 'run', query: 'q', lane: 'example' })).toMatchObject({ status: 'succeeded' }); expect(fs.existsSync(f.home)).toBe(false);
    const explicit = createNbSearchRuntime({ env, config: { ...config, execution: { max_inline_bytes: 65536, fetch: { quality: { min_content_chars: 500, blocked_markers: ['cf-challenge'] } } } }, provider_registrations: [registration] }); expect(await explicit.fetch({ action: 'run', source })).toMatchObject({ status: 'failed' }); expect(await explicit.search({ action: 'run', query: 'q', lane: 'example' })).toMatchObject({ status: 'failed', error: { code: 'OUTPUT_TOO_LARGE' } });
  });
  it('reports a real filesystem error category and selected path without raw exception content', () => {
    const f = fixture(); const path = resolve(f.root, 'secrets.json'); json(path, { secret: 'fake-not-for-output' }); const original = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => { if (String(file) === path) throw Object.assign(new Error('fake-not-for-output'), { code: 'EACCES' }); return (original as (...args: unknown[]) => unknown)(file, ...args); }) as typeof fs.readFileSync); syncBuiltinESMExports();
    let error: unknown; try { readJson(path); } catch (caught) { error = caught; } expect(error).toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('EACCES') }); expect((error as Error).message).toContain(path); expect((error as Error).message).not.toContain('fake-not-for-output');
  });
});
