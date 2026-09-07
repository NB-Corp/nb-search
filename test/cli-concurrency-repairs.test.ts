import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureHome, writeProtected } from '../src/cli-storage.ts';
import { createRemoteHttpFixture } from './fixtures/remote-http.ts';
import { JobStore } from '../src/job-store.ts';
import { NbSearchError } from '../src/errors.ts';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(resolve('.test-concurrency-repairs-')); roots.push(root); const home = resolve(root, 'deep', 'nested', 'home'); const env: NodeJS.ProcessEnv = { NB_SEARCH_HOME: home, NODE_OPTIONS: '--import=./test/fixtures/no-external.mjs' }; for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name]; return { root, home, env }; }
function processRun(args: string[], env: NodeJS.ProcessEnv, input?: unknown) {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((complete, reject) => { child.on('error', reject); child.on('close', (code) => complete({ code, stdout, stderr })); });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input)); return { child, done };
}
async function stop(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>((done) => child.once('close', () => done())); child.kill(); await closed; } }
async function waitFile(path: string) { for (let i = 0; !existsSync(path) && i < 1200; i++) await sleep(25); expect(existsSync(path), 'fixture reached the requested scheduling boundary').toBe(true); }
const input = (key: string) => ({ action: 'run', execution: 'async', idempotency_key: key, pipeline: 'direct.local', source: { kind: 'inline_text', media_type: 'text/plain', content: 'Isolated local evidence. '.repeat(40) } });
function expired(home: string) { const id = randomUUID(); const dir = resolve(home, 'jobs', id); mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'job.json'), JSON.stringify({ schema_version: '3.0', job_id: id, kind: 'fetch', state: 'failed', request: { result_ttl_seconds: 1 }, channel: 'typed', schema_id: 'nb-search.fetch@1', request_hash: 'expired', idempotency_hash: 'expired', created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:01.000Z', completed_at: '2020-01-01T00:00:01.000Z', error: { code: 'CANCELLED', message: 'Expired test job.', retryable: false } })); return dir; }

describe('CR-01..03 real-process concurrency regressions', () => {
  it('CR-01: concurrent admissions recursively create a missing deep home', async () => {
    const f = setup();
    const admitted = await Promise.all(Array.from({ length: 4 }, (_, index) => processRun(['dist/cli.mjs', 'fetch', '--stdin'], f.env, input(`cr01-${index}`)).done));
    expect(admitted.map((result) => result.code), admitted.map((result) => result.stderr).join('\n')).toEqual([7, 7, 7, 7]); expect(existsSync(f.home)).toBe(true); expect(existsSync(resolve(f.home, 'jobs'))).toBe(true); expect(existsSync(resolve(f.home, 'job-connections'))).toBe(true);
    const ids = admitted.map((result) => JSON.parse(result.stdout).job.job_id as string); expect(new Set(ids).size).toBe(4);
    const terminal = await Promise.all(ids.map((id) => processRun(['dist/cli.mjs', '--profile', 'local', 'fetch', 'get', id, '--wait', '15000'], f.env).done)); expect(terminal.map((result) => result.code)).toEqual([0, 0, 0, 0]);
  }, 90000);
  it.each(['safe-dir', 'read', 'remove'])('CR-02: two real admissions tolerate expired-job deletion before %s', async (phase) => {
    const f = setup(); ensureHome(f.home); const old = expired(f.home); const paused = resolve(f.root, 'prune-paused'); const release = resolve(f.root, 'prune-release');
    const a = processRun(['--experimental-transform-types', 'test/fixtures/prune-cli-paused.mjs', old, phase, paused, release, 'fetch', '--stdin'], f.env, input('a'));
    let b: ReturnType<typeof processRun> | undefined;
    try {
      await waitFile(paused); b = processRun(['dist/cli.mjs', 'fetch', '--stdin'], f.env, input('b')); const rb = await b.done; expect(existsSync(old)).toBe(false); writeFileSync(release, 'other pruner completed'); const ra = await a.done;
      expect([ra.code, rb.code], ra.stderr + rb.stderr).toEqual([7, 7]); const ids = [ra, rb].map((result) => JSON.parse(result.stdout).job.job_id as string); expect(new Set(ids).size).toBe(2);
      const terminal = await Promise.all(ids.map((id) => processRun(['dist/cli.mjs', '--profile', 'local', 'fetch', 'get', id, '--wait', '15000'], f.env).done)); expect(terminal.map((result) => result.code)).toEqual([0, 0]);
    } finally { await stop(a.child); if (b) await stop(b.child); }
  }, 90000);
  it('CR-03: a present null legacy map rejects get/read/cancel before remote HTTP; missing remains allowed', async () => {
    const f = setup(); ensureHome(f.home); const server = createRemoteHttpFixture(); await server.start();
    writeProtected(resolve(f.home, 'profiles.json'), { schema_version: '1', profiles: { test: { kind: 'remote', base_url: server.base_url, allow_loopback_http: true, token_env: 'FAKE_SERVICE_TOKEN' } } });
    const path = resolve(f.home, 'job-connections.json'); writeProtected(path, null); const env = { ...f.env, FAKE_SERVICE_TOKEN: 'fake-service-token' }; const id = '00000000-0000-4000-8000-000000000001';
    try {
      const denied = await Promise.all(['get', 'read', 'cancel'].map((action) => processRun(['dist/cli.mjs', '--profile', 'test', 'search', action, id], env).done));
      expect(denied.map((result) => result.code)).toEqual([2, 2, 2]); expect(server.requests).toHaveLength(0); expect(readFileSync(path, 'utf8').trim()).toBe('null');
      rmSync(path); const allowed = await processRun(['dist/cli.mjs', '--profile', 'test', 'search', 'get', id], env).done; expect(allowed.code, allowed.stderr).toBe(7); expect(server.requests).toHaveLength(1);
    } finally { await server.close(); }
  }, 60000);
  it.each(['raw-permission', 'wrapped-permission', 'corrupt-json', 'unproven-missing'])('CR-02: %s is not reclassified as a successful prune race', async (kind) => {
    const f = setup(); ensureHome(f.home); const dir = expired(f.home); const store = new JobStore(resolve(f.home, 'jobs'));
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const error = kind === 'raw-permission' ? denied : new NbSearchError('JOB_NOT_FOUND', 'Job unavailable.', false, undefined, kind === 'unproven-missing' ? undefined : { cause: kind === 'corrupt-json' ? new SyntaxError('Malformed fixture') : denied });
    const original = store.read.bind(store); let reads = 0; vi.spyOn(store, 'read').mockImplementation(async (id) => { if (++reads === 2) throw error; return await original(id); });
    await expect(store.prune()).rejects.toBe(error); expect(existsSync(dir)).toBe(true);
  });
});
