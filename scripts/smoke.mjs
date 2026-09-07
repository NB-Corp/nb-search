import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.mjs');
const temporary = await mkdtemp(join(root, '.test-smoke-'));
const home = join(temporary, 'home');
const configPath = join(home, 'config.json');
const env = { NB_SEARCH_HOME: home, NB_SEARCH_CONFIG: configPath };
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
try {
  await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', "import { ensureHome } from './src/cli-storage.ts'; ensureHome(process.env.NB_SEARCH_HOME);"], { cwd: root, env });
  await writeFile(configPath, JSON.stringify({ schema_version: '4', defaults: { search_lane: 'exa.search', fetch_chain: [{ input_kind: 'url', pipelines: ['direct.fetch', 'jina.reader'] }] } }));
  let search;
  try {
    await execute(process.execPath, [cli, 'search', 'offline-smoke'], { cwd: root, env });
    throw new Error('Offline search unexpectedly succeeded.');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 2 || !('stdout' in error)) throw error;
    search = JSON.parse(String(error.stdout));
  }
  assert(search.action === 'run' && search.execution === 'sync' && search.status === 'failed' && search.error?.code === 'LANE_NOT_CONFIGURED', 'offline search failure envelope');

  const capabilities = JSON.parse((await execute(process.execPath, [cli, 'capabilities'], { cwd: root, env })).stdout);
  assert(capabilities.schema_version === '3.0' && Array.isArray(capabilities.search?.lanes) && capabilities.jobs?.cancel_supported === true, 'capabilities envelope');
  assert(capabilities.fetch.pipelines.some((pipeline) => pipeline.id === 'direct.fetch' && pipeline.availability === 'ready'), 'direct.fetch capability');

  const publicModule = await import(new URL('../dist/index.mjs', import.meta.url));
  const runtime = publicModule.createNbSearchRuntime({ env });
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(runtime)).filter((name) => name !== 'constructor').sort();
  assert(JSON.stringify(methods) === JSON.stringify(['capabilities', 'fetch', 'search']), 'three-method SDK');
  assert(new publicModule.ResponseLimitError(128).maximum === 128, 'public transport limit error');
  let injectedCalls = 0;
  const injected = publicModule.createNbSearchRuntime({ env, http_transport: { async send() { injectedCalls++; throw new Error('Smoke must not dispatch HTTP.'); } } });
  const denied = await injected.search({ action: 'run', query: 'offline', execution: 'async', idempotency_key: 'smoke' });
  assert(denied.status === 'failed' && denied.error?.code === 'LANE_EXECUTION_UNSUPPORTED' && injectedCalls === 0, 'injected public transport cannot enter detached async');
  for (const removed of ['answer', 'deepStart', 'deepStatus', 'deepRead', 'deepList', 'deepCancel', 'researchStart', 'listJobs']) assert(runtime[removed] === undefined, `removed SDK method ${removed}`);
  assert(publicModule.createNodeDirectFetchIo === undefined && publicModule.createTestOnlyNodeDirectFetchIo === undefined && publicModule.nodeDirectFetchIo === undefined && publicModule.DirectFetchProvider === undefined, 'SSRF test seam is not public');

  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert(packageJson.files.includes('SKILL.md') && packageJson.exports['./SKILL.md'] === './SKILL.md', 'skill publish shape');
  assert((await readFile(resolve(root, 'SKILL.md'), 'utf8')).includes('nb-search 使用协议'), 'skill file');
  const cliSource = await readFile(cli, 'utf8');
  assert(!/@modelcontextprotocol|StdioClientTransport|createNbSearchMcpServer/.test(cliSource), 'CLI artifact has no MCP construction path');
  process.stdout.write(`${JSON.stringify({ search_status: search.status, search_code: search.error.code, schema_version: capabilities.schema_version, sdk_methods: methods, public_exports: Object.keys(publicModule).sort(), skill: true })}\n`);
} finally {
  const rel = relative(root, temporary);
  if (rel === basename(temporary) && !rel.startsWith(`..${sep}`)) await rm(temporary, { recursive: true, force: true });
}

function assert(condition, label) {
  if (!condition) throw new Error(`Smoke assertion failed: ${label}.`);
}
