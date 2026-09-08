import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHome, writeProtected } from '../src/cli-storage.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const parent of homes.splice(0)) {
    // A cancel receipt (even terminal) does not mean its detached worker has exited.
    // Wait for the existing test-only lifecycle trace before removing worker-owned files.
    const trace = resolve(parent, 'worker-trace', 'lifecycle.ndjson');
    await expect.poll(() => {
      if (!existsSync(trace)) return [];
      const lines = readFileSync(trace, 'utf8').split('\n'); lines.pop();
      const events = lines.map((line) => JSON.parse(line) as { event: string; pid: number; worker_pid?: number });
      const exited = new Set(events.filter((event) => event.event === 'worker-exit').map((event) => event.pid));
      return events.filter((event) => event.event === 'worker-spawn' && event.worker_pid !== undefined && !exited.has(event.worker_pid)).map((event) => event.worker_pid);
    }, { timeout: 15000, interval: 25, message: `Detached fixture workers must exit before cleanup: ${trace}` }).toEqual([]);
    // The exit hook precedes OS handle release; retry only bounded transient filesystem failures.
    rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 20000);
function fixtureHome(base: string) {
  const parent = mkdtempSync(resolve('.test-concurrency-')); homes.push(parent); const home = resolve(parent, 'deep', 'nested', 'home'); ensureHome(home);
  writeProtected(resolve(home, 'config.json'), { schema_version: '4', provider_instances: { 'exa.default': { base_url: base } }, defaults: { search_lane: 'exa.search' }, execution: { retry_count: 0 } });
  writeProtected(resolve(home, 'secrets.json'), { schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fake-concurrent-key' } });
  const env: NodeJS.ProcessEnv = { NB_SEARCH_HOME: home, NB_TEST_WORKER_TRACE_DIR: resolve(parent, 'worker-trace'), NODE_OPTIONS: '--import=./test/fixtures/no-external.mjs --import=./test/fixtures/worker-trace.mjs' };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
async function cli(env: NodeJS.ProcessEnv, args: string[], input?: unknown) {
  const started = Date.now();
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; pid: number | undefined; args: string[]; elapsed_ms: number; killed_by_test: boolean; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['dist/cli.mjs', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let killed = false;
    child.stdout.on('data', (data) => stdout += data); child.stderr.on('data', (data) => stderr += data); child.on('error', reject);
    const timeout = setTimeout(() => { killed = true; child.kill(); }, 45000);
    child.on('close', (code, signal) => {
      clearTimeout(timeout); const result = { code, signal, pid: child.pid, args, elapsed_ms: Date.now() - started, killed_by_test: killed, stdout, stderr };
      const directory = process.env['NB_TEST_DIAGNOSTICS_DIR']; if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(resolve(directory, `cli-${child.pid}-${randomUUID()}.json`), JSON.stringify(result, null, 2)); }
      done(result);
    }); child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
function diagnosticFiles(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => { const path = resolve(entry.parentPath, entry.name); try { return [path, readFileSync(path, 'utf8')]; } catch (error) { return [path, String(error)]; } }));
}
function summary(results: Array<{ code: number | null; stderr: string }>) { return results.map((result) => ({ code: result.code, busy: /busy|recovery/.test(result.stderr) })); }

describe('same-home real CLI concurrency', () => {
  it('does not create a missing home for concurrent read-only operations', async () => {
    const env = fixtureHome('http://127.0.0.1:1'); const home = env['NB_SEARCH_HOME']!; rmSync(home, { recursive: true });
    const id = randomUUID();
    const results = await Promise.all([cli(env, ['capabilities']), cli(env, ['--doctor']), cli(env, ['fetch', '--stdin'], { action: 'run', pipeline: 'direct.local', source: { kind: 'inline_text', media_type: 'text/plain', content: 'Read-only local text. '.repeat(40) } }), cli(env, ['--profile', 'local', 'fetch', 'get', id]), cli(env, ['--profile', 'local', 'fetch', 'read', id])]);
    expect(results.map((result) => result.code)).toEqual([0, 0, 0, 2, 2]); expect(existsSync(home)).toBe(false);
  }, 60000);
  it('recursively initializes a completely missing home before four distinct concurrent async admissions', async () => {
    const env = fixtureHome('http://127.0.0.1:1'); const home = env['NB_SEARCH_HOME']!; rmSync(resolve(home, '..', '..'), { recursive: true, force: true });
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => cli(env, ['fetch', '--stdin'], { action: 'run', execution: 'async', idempotency_key: `missing-${i}`, pipeline: 'direct.local', source: { kind: 'inline_text', media_type: 'text/plain', content: 'New-home async data. '.repeat(40) } })));
    expect(summary(results)).toEqual(results.map(() => ({ code: 7, busy: false }))); const ids = results.map((result) => JSON.parse(result.stdout).job.job_id as string); expect(new Set(ids).size).toBe(4);
    expect(existsSync(home)).toBe(true); expect(existsSync(resolve(home, 'jobs'))).toBe(true); expect(existsSync(resolve(home, 'job-connections'))).toBe(true);
    // Complete readers before fixture cleanup so detached workers do not race removal.
    const completed = await Promise.all(ids.map((id) => cli(env, ['--profile', 'local', 'fetch', 'get', id, '--wait', '15000'])));
    const diagnostics = JSON.stringify({ admissions: results, followups: completed, jobs: diagnosticFiles(resolve(home, 'jobs')), workers: diagnosticFiles(env['NB_TEST_WORKER_TRACE_DIR']!) }, null, 2);
    if (process.env['NB_TEST_DIAGNOSTICS_DIR']) { mkdirSync(process.env['NB_TEST_DIAGNOSTICS_DIR'], { recursive: true }); writeFileSync(resolve(process.env['NB_TEST_DIAGNOSTICS_DIR'], `missing-home-${randomUUID()}.json`), diagnostics); }
    expect(completed.map((result) => result.code), diagnostics).toEqual([0, 0, 0, 0]);
  }, 90000);
  it('allows simultaneous capabilities/search/local fetch and overlapping provider execution', async () => {
    let active = 0; let maximum = 0; let hits = 0; const waiting: Array<() => void> = [];
    const server = createServer(async (req, res) => {
      for await (const _ of req) {} hits++; active++; maximum = Math.max(maximum, active);
      // A provider barrier proves genuine execution overlap rather than whole-command queuing.
      await new Promise<void>((done) => { const timer = setTimeout(done, 12000); waiting.push(() => { clearTimeout(timer); done(); }); if (active >= 2) for (const release of waiting.splice(0)) release(); });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'Fixture', url: 'https://example.com/', text: 'Evidence' }] })); active--;
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const env = fixtureHome(`http://127.0.0.1:${address.port}`);
    try {
      const results = await Promise.all([
        cli(env, ['capabilities']), cli(env, ['capabilities']),
        cli(env, ['search', 'one']), cli(env, ['search', 'two']), cli(env, ['search', 'three']),
        cli(env, ['fetch', '--stdin'], { action: 'run', source: { kind: 'inline_text', media_type: 'text/plain', content: 'Independent local evidence. '.repeat(40) }, pipeline: 'direct.local' }),
      ]);
      expect(summary(results), `observed provider hits=${hits}, maximum overlap=${maximum}`).toEqual(results.map(() => ({ code: 0, busy: false })));
      expect(hits).toBe(3); expect(maximum).toBeGreaterThanOrEqual(2);
    } finally { for (const release of waiting.splice(0)) release(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  }, 90000);
  it('admits independent async jobs together and permits concurrent get/read/cancel', async () => {
    const env = fixtureHome('http://127.0.0.1:1');
    const admitted = await Promise.all(Array.from({ length: 4 }, (_, i) => cli(env, ['fetch', '--stdin'], { action: 'run', execution: 'async', idempotency_key: `concurrent-${i}`, source: { kind: 'inline_text', media_type: 'text/plain', content: 'Local async evidence. '.repeat(40) }, pipeline: 'direct.local' })));
    const ids = admitted.flatMap((result) => { try { const value = JSON.parse(result.stdout); return typeof value.job?.job_id === 'string' ? [value.job.job_id as string] : []; } catch { return []; } });
    const followups = await Promise.all(ids.flatMap((id) => ['get', 'read', 'cancel'].map((action) => cli(env, ['--profile', 'local', 'fetch', action, id]))));
    expect(summary(admitted), JSON.stringify({ admitted, followups, jobs: diagnosticFiles(resolve(env['NB_SEARCH_HOME']!, 'jobs')) }, null, 2)).toEqual(admitted.map(() => ({ code: 7, busy: false })));
    expect(ids).toHaveLength(4);
    expect(followups.every((result) => [0, 6, 7].includes(result.code ?? -1) && !/busy|recovery/.test(result.stderr)), JSON.stringify(summary(followups))).toBe(true);
  }, 120000);
});
