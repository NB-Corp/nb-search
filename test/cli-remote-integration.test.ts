import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ensureHome, writeProtected } from '../src/cli-storage.ts';
import { createNbSearchRuntime } from '../src/index.ts';

it('real CLI routes profile/stdin/sync/async/get/raw-read/read-all/cancel through HTTP without provider-secret loading', async () => {
  const root = mkdtempSync(resolve('.test-cli-remote-')); const home = resolve(root, 'home'); ensureHome(home);
  const id = randomUUID(); const now = new Date().toISOString(); const logical = { channel: 'typed', lane: 'fixture', schema_id: 'fixture@1', status: 'succeeded', data: { answer: '完整证据 🌍' }, lane_outcomes: [], hints: [] }; const bytes = Buffer.from(JSON.stringify(logical)); const artifact = { media_type: 'application/json', byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expires_at: new Date(Date.now() + 600000).toISOString() }; const observed: string[] = [];
  const caps = await createNbSearchRuntime({ env: { NB_SEARCH_HOME: resolve(root, 'unused') } }).capabilities(); caps.fetch.inputs = caps.fetch.inputs.map((item) => ({ ...item, enabled: item.kind === 'url' }));
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks).toString()); observed.push(`${req.url}:${input.action ?? 'catalog'}`);
    expect(req.headers.authorization).toBe('Bearer fake-service-token');
    res.setHeader('content-type', 'application/json'); res.setHeader('x-nb-search-protocol', '1'); res.setHeader('x-request-id', req.headers['x-request-id']!);
    const mode = req.url === '/v1/fetch' ? { mode: 'fetch' } : {};
    const result = req.url === '/v1/capabilities' ? caps : input.action === 'run' ? input.execution === 'async' ? { schema_version: '3.0', ...mode, action: 'run', execution: 'async', status: 'queued', job: { job_id: id, state: 'queued', created_at: now }, poll_after_ms: 100, hints: [] } : req.url === '/v1/fetch' ? { schema_version: '3.0', ...mode, action: 'run', execution: 'sync', status: 'succeeded', selection: { source: 'default' }, documents: [], lane_outcomes: [], hints: [] } : { schema_version: '3.0', action: 'run', execution: 'sync', status: 'succeeded', output: logical, hints: [] } : input.action === 'get' ? { schema_version: '3.0', ...mode, action: 'get', job_id: id, state: 'succeeded', cancel_requested: false, created_at: now, updated_at: now, artifact } : input.action === 'read' ? { schema_version: '3.0', ...mode, action: 'read', job_id: id, state: 'succeeded', artifact, chunks: [{ index: 0, offset: 0, byte_length: bytes.length, data_base64: bytes.toString('base64') }] } : { schema_version: '3.0', ...mode, action: 'cancel', job_id: id, state: 'succeeded', cancel_requested: false };
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  writeProtected(resolve(home, 'profiles.json'), { schema_version: '1', profiles: { cloud: { kind: 'remote', base_url: `http://127.0.0.1:${address.port}`, allow_loopback_http: true, token_env: 'FIXTURE_SERVICE_TOKEN' } } });
  // These invalid local-only files prove remote never opens them.
  writeFileSync(resolve(home, 'secrets.json'), 'not provider credentials'); writeFileSync(resolve(home, 'config.json'), 'invalid canonical config');
  const env: NodeJS.ProcessEnv = { NB_SEARCH_HOME: home, FIXTURE_SERVICE_TOKEN: 'fake-service-token', NODE_OPTIONS: '--import=./test/fixtures/no-external.mjs' }; for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  async function call(args: string[], stdin?: string) { return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => { const child = spawn(process.execPath, ['scripts/nb-search.mjs', '--profile', 'cloud', ...args], { env }); let stdout = ''; let stderr = ''; child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v); child.on('error', reject); child.on('close', (code) => done({ code, stdout, stderr })); child.stdin.end(stdin); }); }
  try {
    for (const args of [['capabilities'], ['search', 'Unicode 🌍'], ['fetch', 'https://example.com/']]) { const result = await call(args); expect(result.code, result.stderr).toBe(0); expect(result.stdout + result.stderr).not.toContain('fake-service-token'); }
    const waited = await call(['search', '--stdin', '--wait', '20000'], JSON.stringify({ action: 'run', query: '完整研究', execution: 'async', idempotency_key: 'cli-http' })); expect(waited.code, waited.stderr + waited.stdout).toBe(0); expect(JSON.parse(waited.stdout)).toEqual(logical);
    writeProtected(resolve(home, '.config-access.lock'), { nonce: 'interrupted-local-provider-write' });
    for (const args of [['search', 'get', id], ['search', 'read', id], ['search', 'read', id, '--all'], ['search', 'cancel', id]]) { const result = await call(args); expect(result.code, result.stderr).toBe(0); if (args.includes('--all')) expect(JSON.parse(result.stdout)).toEqual(logical); else expect(JSON.parse(result.stdout).action).toBe(args[1]); }
    const count = observed.length; const rejected = await call(['fetch', '--stdin'], JSON.stringify({ action: 'run', source: { kind: 'inline_text', media_type: 'text/plain', content: 'do not upload' } })); expect(rejected.code).toBe(2); expect(observed).toHaveLength(count);
    expect(observed).toEqual(expect.arrayContaining(['/v1/search:run', '/v1/search:get', '/v1/search:read', '/v1/search:cancel', '/v1/fetch:run', '/v1/capabilities:catalog']));
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
}, 120000);
