import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createNbSearchRuntime, type CanonicalConfigPatch } from '../src/index.ts';
import { resolveConfiguration } from '../src/config-sources.ts';

const roots: string[] = [];
function fixture() { mkdirSync(resolve('.release-check'), { recursive: true }); const root = mkdtempSync(resolve('.release-check/script-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config(module: string): CanonicalConfigPatch { return { provider_instances: { custom: { provider_id: 'script', enabled: true, options: { module, params: { label: 'fixture' } } } }, lanes: { 'custom.search': { provider_instance_id: 'custom', operation_id: 'search', latency: 'fast', cost: 'free' } }, execution: { retry_count: 0 } }; }
const cli = resolve('scripts/nb-search.mjs');
async function command(root: string, input: unknown, cwd = root) {
  return await new Promise<{ code: number | null; body: any; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [cli, 'search', '--stdin'], { cwd, env: { ...process.env, NB_SEARCH_HOME: root, NB_SEARCH_CONFIG: resolve(root, 'config.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; }); child.on('error', reject); child.on('close', (code) => { try { done({ code, body: JSON.parse(out), stderr: err }); } catch { reject(new Error(out + err)); } }); child.stdin.end(JSON.stringify(input));
  });
}

describe('trusted script results lanes', () => {
  it('runs the shipped no-network catalog example', async () => {
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_HOME: fixture(), NB_SEARCH_CONFIG: resolve('examples/script-lane/config.json') } });
    expect(await runtime.search({ action: 'run', query: 'Node', lane: 'local.search' })).toMatchObject({ status: 'succeeded', output: { results: [{ title: 'Node.js documentation' }] } });
  });
  it('rejects malformed module/params configuration without loading code', () => {
    for (const module of ['', 'script.txt']) {
      expect(() => createNbSearchRuntime({ env: { NB_SEARCH_HOME: fixture() }, config: config(module) })).toThrow(/Script options/);
    }
    expect(() => createNbSearchRuntime({ env: { NB_SEARCH_HOME: fixture() }, config: { provider_instances: { custom: { provider_id: 'script', enabled: true, options: { module: './script.mjs', params: [] } } } } })).toThrow(/Script options/);
  });
  it('normalizes source-relative paths without loading modules during capabilities', async () => {
    const root = fixture(); const marker = resolve(root, 'loaded');
    writeFileSync(resolve(root, 'script.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'yes'); export const search = q => [{title:q,url:'https://example.com/'}];`);
    writeFileSync(resolve(root, 'config.json'), JSON.stringify(config('./script.mjs')));
    const env = { NB_SEARCH_HOME: root };
    expect(resolveConfiguration({ env, cwd: resolve(root, 'elsewhere') }).config.provider_instances['custom']?.options['module']).toBe(resolve(root, 'script.mjs'));
    const runtime = createNbSearchRuntime({ env });
    expect((await runtime.capabilities()).search.lanes.find((l) => l.id === 'custom.search')).toMatchObject({ execution_modes: ['sync', 'async'], availability: 'ready' });
    expect(existsSync(marker)).toBe(false);
    expect(await runtime.search({ action: 'run', query: 'hello', lane: 'custom.search' })).toMatchObject({ status: 'succeeded', output: { results: [{ title: 'hello' }] } });
    expect(existsSync(marker)).toBe(true);
    const override = resolveConfiguration({ env, cwd: root, overrides: { provider_instances: { custom: { options: { module: './override.mjs' } } } } });
    expect(override.config.provider_instances['custom']?.options['module']).toBe(resolve(root, 'override.mjs'));
  });
  it('passes explicit credential, transport, request and cloned params; errors are safe and no implicit retries', async () => {
    const root = fixture(); const module = resolve(root, 'execute.mjs');
    writeFileSync(module, `export async function execute(r,c) { if(r.query==='fail') throw Error(c.credential); const x=await c.transport.send({url:'https://fixture.test',method:'GET',signal:c.signal}); return [{title:r.query+' '+r.limit+' '+r.freshness+' '+c.options.label+' '+x.body.ok,url:'https://example.com/',snippet:c.credential==='fake-secret'?'bound':'missing'}]; }`);
    let calls = 0;
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_HOME: root, SCRIPT_KEY: 'fake-secret', OTHER_KEY: 'other-secret' }, config: { ...config(module), credential_slots: { custom: { provider_id: 'script', env: 'SCRIPT_KEY' } }, provider_instances: { custom: { provider_id: 'script', enabled: true, credential_slot_id: 'custom', options: { module, params: { label: 'fixture' } } } } }, http_transport: { async send<T>() { calls++; return { status: 200, body: { ok: true } as T }; } } });
    expect(await runtime.search({ action: 'run', query: 'ok', lane: 'custom.search', max_results: 3, freshness: 'pw' })).toMatchObject({ status: 'succeeded', output: { results: [{ title: 'ok 3 pw fixture true', snippet: 'bound' }] } });
    const failure = await runtime.search({ action: 'run', query: 'fail', lane: 'custom.search' });
    expect(failure).toMatchObject({ status: 'failed' }); expect(JSON.stringify(failure)).not.toContain('fake-secret'); expect(calls).toBe(1);
  });
  it.each(['.mjs', '.js', '.ts'] as const)('runs actual CLI sync and detached multi-query %s modules from another cwd', async (extension) => {
    const root = fixture(); const elsewhere = resolve(root, 'other'); mkdirSync(elsewhere);
    writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
    const annotation = extension === '.ts' ? ': string' : '';
    writeFileSync(resolve(root, `script${extension}`), `import {setTimeout as sleep} from 'node:timers/promises'; export async function search(q${annotation},c${extension === '.ts' ? ': any' : ''}) { c.logger.info('script fixture'); await sleep(20,undefined,{signal:c.signal}); return [{title:q+' '+c.options.label,url:'https://example.com/'+q}]; }`);
    writeFileSync(resolve(root, 'config.json'), JSON.stringify(config(`./script${extension}`)));
    expect((await command(root, { action: 'run', query: 'sync', lane: 'custom.search' }, elsewhere)).body).toMatchObject({ status: 'succeeded', output: { results: [{ title: 'sync fixture' }] } });
    const receipt = (await command(root, { action: 'run', query: ['first', 'second'], lane: 'custom.search', execution: 'async', idempotency_key: 'script-test', timeout_ms: 10000 }, elsewhere)).body;
    expect(receipt).toMatchObject({ status: 'queued' });
    let status: any;
    for (let i = 0; i < 100; i++) { status = (await command(root, { action: 'get', job_id: receipt.job.job_id }, elsewhere)).body; if (!['queued', 'running'].includes(status.state)) break; await sleep(50); }
    expect(status.state).toBe('succeeded');
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_HOME: root } });
    const read = await runtime.search({ action: 'read', job_id: receipt.job.job_id });
    if (!('chunks' in read)) throw Error('Expected artifact chunks');
    const artifact = JSON.parse(Buffer.concat(read.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString());
    expect(artifact.results.map((row: { title: string }) => row.title)).toEqual(['first fixture', 'second fixture']);
  }, 30000);
  it('runs concurrent queries in one module without serializing them', async () => {
    const root = fixture(); const module = resolve(root, 'parallel.mjs');
    writeFileSync(module, `let entered=0; let release; const both=new Promise(r=>release=r); export async function execute(r,c) { if(++entered===2) release(); await both; c.signal.throwIfAborted(); return [{title:r.query,url:'https://example.com/'+r.query}]; }`);
    const result = await createNbSearchRuntime({ env: { NB_SEARCH_HOME: root }, config: config(module) }).search({ action: 'run', query: ['one', 'two'], lane: 'custom.search', timeout_ms: 2000 });
    expect(result).toMatchObject({ status: 'succeeded', output: { results: [{ title: 'one' }, { title: 'two' }] } });
  });
  it('detached CLI reports script errors and cancellation without leaking module errors', async () => {
    const root = fixture();
    writeFileSync(resolve(root, 'script.mjs'), `import {writeFileSync} from 'node:fs'; import {setTimeout as sleep} from 'node:timers/promises'; export async function execute(r,c) { if(r.query==='fail') throw Error('private-detail'); writeFileSync(new URL('./started',import.meta.url),'started'); await sleep(10000,undefined,{signal:c.signal}); return []; }`);
    writeFileSync(resolve(root, 'config.json'), JSON.stringify(config('./script.mjs')));
    for (const query of ['fail', 'cancel']) {
      const started = (await command(root, { action: 'run', query, lane: 'custom.search', execution: 'async', idempotency_key: query, timeout_ms: 10000 })).body;
      if (query === 'cancel') {
        for (let i = 0; i < 100 && !existsSync(resolve(root, 'started')); i++) await sleep(30);
        expect(existsSync(resolve(root, 'started'))).toBe(true);
        await command(root, { action: 'cancel', job_id: started.job.job_id });
      }
      let status: any;
      for (let i = 0; i < 100; i++) { status = (await command(root, { action: 'get', job_id: started.job.job_id })).body; if (!['queued', 'running'].includes(status.state)) break; await sleep(30); }
      expect(status.state).toBe(query === 'cancel' ? 'cancelled' : 'failed');
      expect(JSON.stringify(status)).not.toContain('private-detail');
    }
  }, 30000);
  it('honors cooperative SDK cancellation and rejects missing exports/invalid results safely', async () => {
    const root = fixture(); const module = resolve(root, 'cancel.mjs');
    writeFileSync(module, `import {setTimeout as sleep} from 'node:timers/promises'; export async function execute(r,c) { await sleep(10000,undefined,{signal:c.signal}); return []; }`);
    const runtime = createNbSearchRuntime({ env: { NB_SEARCH_HOME: root }, config: config(module) });
    const controller = new AbortController(); const pending = runtime.search({ action: 'run', query: 'cancel', lane: 'custom.search' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30); expect(await pending).toMatchObject({ status: 'cancelled' });
    for (const [name, source] of [['missing', 'export const other = 1;'], ['invalid', 'export const search = () => ({answer:"not results"});']] as const) {
      const file = resolve(root, `${name}.mjs`); writeFileSync(file, source);
      expect(await createNbSearchRuntime({ env: { NB_SEARCH_HOME: root }, config: config(file) }).search({ action: 'run', query: 'bad', lane: 'custom.search' })).toMatchObject({ status: 'failed' });
    }
  });
});
