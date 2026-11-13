import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { captureFetchFileIdentity, LocalFetchProvider, type LocalFetchFileIo } from '../src/fetch-sources.ts';
import { open, stat } from 'node:fs/promises';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nb-file-admission-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const docs = join(workspace, 'docs');
  const privateDir = join(root, 'private');
  await mkdir(docs, { recursive: true });
  await mkdir(privateDir);
  await writeFile(join(docs, 'document.txt'), 'AUTHORIZED CONTENT');
  await writeFile(join(privateDir, 'document.txt'), 'PRIVATE CONTENT');
  const target = await realpath(join(docs, 'document.txt'));
  const env = { NB_SEARCH_CONFIG: join(root, 'config.json'), NB_SEARCH_HOME: root };
  await writeFile(env.NB_SEARCH_CONFIG, '{}');
  const config = { home: root, jobs_root: join(root, 'jobs'), fetch: { file_scopes: [{ id: 'scope', root, canonical_target: target, approved_identity: JSON.parse(JSON.stringify(await captureFetchFileIdentity(target))), media_types: ['text/plain'] }] } };
  const app = createRuntimeComposition(env, { cwd: root, homeDirectory: root, launcher: { async launch() {} }, config });
  const source = { kind: 'file' as const, scope: 'scope', path: 'workspace/docs/document.txt' };
  return { root, docs, privateDir, target, env, config, app, source };
}
async function worker(job: string, root: string, env: Record<string, string>) {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', resolve('src/worker.ts'), job, join(root, 'jobs')], { env: { ...env, PATH: process.env['PATH'] }, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(error)));
  });
}

describe('canonical file admission at the worker read', () => {
  it('rejects ABA against the approved identity before handle.read', async () => {
    const root = resolve('fixture'); const target = join(root, 'document.txt'); let reads = 0;
    const privateStat = { dev: 1, ino: 2, size: 7, isFile: () => true };
    const io: LocalFetchFileIo = { realpath: async (path) => path, stat: async () => privateStat, open: async () => ({ stat: async () => privateStat, approvedIdentity: async () => ({ dev: '1', ino: '2' }), read: async (buffer) => { reads++; if (reads > 1) return { bytesRead: 0 }; buffer.set(Buffer.from('PRIVATE')); return { bytesRead: 7 }; }, close: async () => {} }) };
    await expect(new LocalFetchProvider(io).fetch({ source: { kind: 'file', scope: 'scope', path: 'document.txt' }, representation: 'text', max_source_bytes: 1024, max_content_chars: 1024, file_scopes: [{ id: 'scope', root, canonical_target: target, approved_identity: JSON.parse(JSON.stringify({ dev: '1', ino: '9007199254740993' })) }], signal: new AbortController().signal, max_response_bytes: 1024, max_redirects: 0 })).rejects.toMatchObject({ code: 'FETCH_FILE_BLOCKED' });
    expect(reads).toBe(0);
  });
  it('reproduces the unconstrained donor scope reading the replaced directory', async () => {
    const f = await fixture();
    const app = createRuntimeComposition(f.env, { cwd: f.root, homeDirectory: f.root, launcher: { async launch() {} }, config: { ...f.config, fetch: { file_scopes: [{ id: 'scope', root: f.root, media_types: ['text/plain'] }] } } });
    const queued = await app.runtime.fetch({ action: 'run', source: f.source, pipeline: 'direct.local', execution: 'async', idempotency_key: 'unconstrained' });
    if (queued.action !== 'run' || queued.execution !== 'async' || queued.job === undefined) throw new Error(JSON.stringify(queued));
    await rename(f.docs, `${f.docs}-original`);
    await symlink(f.privateDir, f.docs, process.platform === 'win32' ? 'junction' : 'dir');
    await worker(queued.job.job_id, f.root, f.env);
    const page = await app.runtime.fetch({ action: 'read', job_id: queued.job.job_id });
    if (page.action !== 'read') throw new Error(JSON.stringify(page));
    expect(Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8')).toContain('PRIVATE CONTENT');
  }, 30_000);
  it.each(['none', 'inplace', 'atomic', 'link'])('keeps the approved file identity with worker update=%s', async (mode) => {
    const replace = mode === 'atomic' || mode === 'link';
    const f = await fixture();
    const sync = await f.app.runtime.fetch({ action: 'run', source: f.source, pipeline: 'direct.local' });
    expect(sync).toMatchObject({ status: 'succeeded', documents: [{ content: 'AUTHORIZED CONTENT' }] });
    const input = { action: 'run' as const, source: f.source, pipeline: 'direct.local', execution: 'async' as const, idempotency_key: 'file-job' };
    const queued = await f.app.runtime.fetch(input);
    if (queued.action !== 'run' || queued.execution !== 'async' || queued.job === undefined) throw new Error(JSON.stringify(queued));
    const id = queued.job.job_id;
    expect(await f.app.runtime.fetch(input)).toMatchObject({ reused: true, job: { job_id: id } });
    const snapshot = await f.app.store.readExecutionSnapshot(id);
    expect(snapshot.request).toMatchObject({ source: f.source, file_scopes: [{ canonical_target: f.target, approved_identity: f.config.fetch.file_scopes[0]!.approved_identity, media_types: ['text/plain'] }] });
    if (mode === 'link') {
      await rename(f.docs, `${f.docs}-original`);
      await symlink(f.privateDir, f.docs, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (mode === 'inplace') await writeFile(f.target, 'AUTHORIZED CONTENT UPDATED');
    if (mode === 'atomic') {
      await writeFile(`${f.target}.replacement`, 'PRIVATE CONTENT');
      await rename(`${f.target}.replacement`, f.target);
    }
    await worker(id, f.root, f.env);
    const restored = createRuntimeComposition(f.env, { cwd: f.root, homeDirectory: f.root, launcher: { async launch() {} }, config: f.config });
    expect(await restored.runtime.fetch({ action: 'get', job_id: id })).toMatchObject({ state: replace ? 'failed' : 'succeeded' });
    const page = await restored.runtime.fetch({ action: 'read', job_id: id });
    if (page.action !== 'read') throw new Error(JSON.stringify(page));
    const content = Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8');
    expect(content).not.toContain('PRIVATE CONTENT');
    if (replace) {
      expect(await restored.runtime.fetch({ action: 'get', job_id: id })).toMatchObject({ error: { code: 'FETCH_FILE_BLOCKED' } });
      expect(JSON.parse(content)).toMatchObject({ status: 'failed', documents: [], lane_outcomes: [{ error: { code: 'FETCH_FILE_BLOCKED' } }] });
    } else expect(content).toContain(mode === 'inplace' ? 'AUTHORIZED CONTENT UPDATED' : 'AUTHORIZED CONTENT');
    expect(await restored.runtime.fetch({ action: 'cancel', job_id: id })).toMatchObject({ state: replace ? 'failed' : 'succeeded', cancel_requested: false });
    expect(await readFile(join(f.privateDir, 'document.txt'), 'utf8')).toBe('PRIVATE CONTENT');
  }, 30_000);

  it('rejects a directory replacement after open and before reading the handle', async () => {
    const f = await fixture();
    let reads = 0;
    const io: LocalFetchFileIo = {
      realpath, stat,
      async open(path, flags) {
        await rename(f.docs, `${f.docs}-original`);
        await symlink(f.privateDir, f.docs, process.platform === 'win32' ? 'junction' : 'dir');
        const handle = await open(path, flags);
        return { stat: () => handle.stat(), close: () => handle.close(), read: async (...args) => { reads++; return handle.read(...args); } };
      },
    };
    await expect(new LocalFetchProvider(io).fetch({ source: f.source, representation: 'text', max_source_bytes: 1024, max_content_chars: 1024, file_scopes: f.config.fetch.file_scopes, signal: new AbortController().signal, max_response_bytes: 1024, max_redirects: 0 })).rejects.toMatchObject({ code: 'FETCH_FILE_BLOCKED' });
    expect(reads).toBe(0);
  });
});
