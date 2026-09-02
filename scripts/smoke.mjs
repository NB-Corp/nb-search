import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.mjs');
const home = await mkdtemp(join(tmpdir(), 'nb-search-smoke-'));
const configPath = join(home, 'config.json');
const env = { NB_SEARCH_HOME: home, NB_SEARCH_CONFIG: configPath };
try {
  await writeFile(configPath, JSON.stringify({ schema_version: '3', defaults: { search_lane: 'exa.search', fetch_lane: 'direct.fetch' } }));
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
  assert(capabilities.fetch.lanes.some((lane) => lane.id === 'direct.fetch' && lane.availability === 'ready'), 'direct.fetch capability');

  const publicModule = await import(new URL('../dist/index.mjs', import.meta.url));
  const runtime = publicModule.createNbSearchRuntime({ env });
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(runtime)).filter((name) => name !== 'constructor').sort();
  assert(JSON.stringify(methods) === JSON.stringify(['capabilities', 'fetch', 'search']), 'three-method SDK');
  for (const removed of ['answer', 'deepStart', 'deepStatus', 'deepRead', 'deepList', 'deepCancel', 'researchStart', 'listJobs']) assert(runtime[removed] === undefined, `removed SDK method ${removed}`);
  assert(publicModule.createNodeDirectFetchIo === undefined && publicModule.createTestOnlyNodeDirectFetchIo === undefined && publicModule.nodeDirectFetchIo === undefined && publicModule.DirectFetchProvider === undefined, 'SSRF test seam is not public');

  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert(packageJson.files.includes('SKILL.md') && packageJson.exports['./SKILL.md'] === './SKILL.md', 'skill publish shape');
  assert((await readFile(resolve(root, 'SKILL.md'), 'utf8')).includes('nb-search 使用协议'), 'skill file');
  const cliSource = await readFile(cli, 'utf8');
  assert(!/@modelcontextprotocol|StdioClientTransport|createNbSearchMcpServer/.test(cliSource), 'CLI artifact has no MCP construction path');
  process.stdout.write(`${JSON.stringify({ search_status: search.status, search_code: search.error.code, schema_version: capabilities.schema_version, sdk_methods: methods, public_exports: Object.keys(publicModule).sort(), skill: true })}\n`);
} finally {
  const rel = relative(resolve(tmpdir()), resolve(home));
  if (rel === basename(home) && !rel.startsWith(`..${sep}`)) await rm(home, { recursive: true, force: true });
}

function assert(condition, label) {
  if (!condition) throw new Error(`Smoke assertion failed: ${label}.`);
}
