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
const legacyPath = join(home, 'legacy.json');
const env = {
  NB_SEARCH_HOME: home,
  NB_SEARCH_CONFIG: configPath,
  SEARCH_LAYER_CREDENTIALS: legacyPath,
};

try {
  await writeFile(configPath, JSON.stringify({
    provider_instances: {
      'exa.default': { enabled: false },
      'tavily.default': { enabled: false },
    },
  }));
  await writeFile(legacyPath, '{}');
  let oneStep;
  try {
    await execute(process.execPath, [cli, 'offline-smoke'], { cwd: root, env });
    throw new Error('One-step search unexpectedly succeeded without a provider.');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 2 || !('stdout' in error)) throw error;
    oneStep = JSON.parse(String(error.stdout));
  }
  assert(oneStep.mode === 'search' && oneStep.state === 'failed' && oneStep.error?.code === 'CONFIGURATION_ERROR', 'one-step CLI envelope');

  const started = await run(['research', 'start', 'offline-research-smoke', '--max-sources', '5', '--max-duration-ms', '60000']);
  const receipt = JSON.parse(started.stdout);
  let terminal;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    terminal = JSON.parse((await run(['research', 'status', receipt.job.job_id])).stdout);
    if (['succeeded', 'partial', 'failed', 'timed_out', 'cancelled'].includes(terminal.state)) break;
  }
  assert(terminal?.state === 'failed' && terminal.error?.code === 'CONFIGURATION_ERROR', 'research worker terminal state');

  const capabilities = JSON.parse((await run(['capabilities'])).stdout);
  assert(capabilities.mode === 'capabilities', 'capabilities CLI envelope');
  const cliSource = await readFile(cli, 'utf8');
  assert(!/@modelcontextprotocol|StdioClientTransport|createNbSearchMcpServer/.test(cliSource), 'CLI artifact has no MCP construction path');

  const publicModule = await import(new URL('../dist/index.mjs', import.meta.url));
  const runtime = publicModule.createNbSearchRuntime({ env });
  assert((await runtime.capabilities()).mode === 'capabilities', 'native public export import');

  process.stdout.write(`${JSON.stringify({
    one_step_state: oneStep.state,
    one_step_exit: 2,
    research_job: receipt.job.job_id,
    research_terminal: terminal.state,
    capabilities: capabilities.mode,
    public_exports: Object.keys(publicModule).sort(),
  })}\n`);
} finally {
  const rel = relative(resolve(tmpdir()), resolve(home));
  if (rel === basename(home) && !rel.startsWith(`..${sep}`)) await rm(home, { recursive: true, force: true });
}

async function run(args) {
  return await execute(process.execPath, [cli, ...args], { cwd: root, env });
}

function assert(condition, label) {
  if (!condition) throw new Error(`Smoke assertion failed: ${label}.`);
}
