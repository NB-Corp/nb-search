#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
// npm.cmd is not directly spawnable by Node on every Windows runner; use the
// bundled npm CLI instead of installing another npm globally.
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmArgsPrefix = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : [];
const MAX_CAPTURE_BYTES = 256 * 1024;

/**
 * The package's optional peer is deliberately not part of the clean install
 * used here. The package must still import, expose its SDK surface, and run
 * its non-browser CLI without a global executable or a browser installation.
 */
export const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'docs/assets/banner-dark.svg',
  'docs/assets/banner-light.svg',
  'docs/assets/workflow.svg',
  'CHANGELOG.md',
  'SKILL.md',
  '.env.example',
  'dist/index.mjs',
  'dist/index.d.mts',
  'dist/cli.mjs',
  'docs/cli.md',
  'docs/model-facing-lane-runtime.md',
  'docs/remote-protocol.md',
  'scripts/nb-search.mjs',
  'skills/nb-search/SKILL.md',
  'skills/nb-search/scripts/nb-search.mjs',
  'skills/nb-search/agents/openai.yaml',
];

const PROHIBITED_SEGMENT = /^(?:tasks?|tests?|node_modules|website)(?:[-_.]|$)/i;
const PROHIBITED_NAME = /(?:^|[._-])(?:secrets?|profiles?)(?:[._-]|$)/i;

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function assert(condition, value) {
  if (!condition) throw new Error(String(value));
}

/**
 * Parse npm's JSON output without accepting a log prefix as package metadata.
 * npm pack --json is expected to return one JSON array.
 * @param {string} text
 */
export function parsePackJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('npm pack did not return valid JSON.');
  }
  assert(Array.isArray(value) && value.length === 1 && isRecord(value[0]), 'npm pack returned an unexpected JSON shape.');
  return value[0];
}

/** @param {string} path */
function normalizeManifestPath(path) {
  assert(!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path), `Invalid package manifest path: ${path}`);
  const normalized = path.replaceAll('\\', '/');
  assert(normalized !== '' && !isAbsolute(normalized) && !normalized.split('/').includes('..'), `Invalid package manifest path: ${path}`);
  return normalized;
}

/**
 * Reject private/source material from the npm pack manifest. .env.example is
 * intentionally public and is the only .env-prefixed file permitted.
 * @param {readonly string[]} paths
 */
export function assertManifestSafe(paths) {
  const normalized = paths.map(normalizeManifestPath);
  for (const path of normalized) {
    const segments = path.split('/');
    const lower = path.toLowerCase();
    assert(path === '.env.example' || !segments.some((segment) => segment === '.env' || segment.startsWith('.env.')), `Private env file was packed: ${path}`);
    assert(!segments.some((segment) => PROHIBITED_SEGMENT.test(segment)), `Private/source directory was packed: ${path}`);
    assert(!segments.some((segment) => PROHIBITED_NAME.test(segment)) && !PROHIBITED_NAME.test(basename(path)), `Secret/profile material was packed: ${path}`);
    assert(!lower.includes('cli-runtime-design') && !lower.includes('migration-') && !lower.includes('.test-'), `Test/migration material was packed: ${path}`);
  }
  for (const required of REQUIRED_FILES) assert(normalized.includes(required), `Required package file is missing: ${required}`);
  return normalized;
}

/**
 * Keep npm and the installed candidate away from user npm config and user
 * provider configuration. Only platform process plumbing is inherited.
 * @param {string} workDir
 * @param {string} home
 */
export function controlledEnv(workDir, home) {
  const env = {};
  const platformKeys = {
    PATH: ['PATH', 'Path'],
    SystemRoot: ['SystemRoot', 'SYSTEMROOT'],
    WINDIR: ['WINDIR', 'windir'],
    TEMP: ['TEMP', 'temp'],
    TMP: ['TMP', 'tmp'],
    TMPDIR: ['TMPDIR', 'tmpdir'],
    COMSPEC: ['COMSPEC', 'ComSpec'],
    PATHEXT: ['PATHEXT', 'pathext'],
  };
  for (const [canonical, aliases] of Object.entries(platformKeys)) {
    const source = aliases.find((key) => process.env[key] !== undefined);
    if (source !== undefined) env[canonical] = process.env[source];
  }
  env.CI = '1';
  env.NODE_ENV = 'test';
  env.HOME = workDir;
  env.USERPROFILE = workDir;
  env.APPDATA = join(workDir, 'appdata');
  env.LOCALAPPDATA = join(workDir, 'localappdata');
  env.NB_SEARCH_HOME = home;
  env.NB_SEARCH_CONFIG = join(home, 'config.json');
  env.npm_config_userconfig = join(workDir, 'npmrc');
  env.npm_config_cache = join(workDir, 'npm-cache');
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  env.npm_config_color = 'false';
  return env;
}

/** @param {string} path @param {NodeJS.ProcessEnv} env */
async function secureDirectory(path, env) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/** @param {string} path @param {string} value @param {NodeJS.ProcessEnv} env */
async function secureFile(path, value, env) {
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
}

/** @param {string} path */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} value */
function relativePath(value) {
  const output = relative(repoRoot, value).split(sep).join('/');
  return output === '' ? '.' : output;
}

/** @param {string} value */
function safeVersion(value) {
  assert(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value), `Invalid package version: ${value}`);
  return value;
}

/** @param {string} command @param {readonly string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options] */
async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd ?? repoRoot,
      env: options.env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
      encoding: 'utf8',
    });
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr), timedOut: false };
  } catch (error) {
    const value = /** @type {import('node:child_process').ExecFileException & { stdout?: string; stderr?: string }} */ (error);
    return {
      code: typeof value.code === 'number' ? value.code : null,
      stdout: String(value.stdout ?? ''),
      stderr: String(value.stderr ?? ''),
      timedOut: value.killed === true || value.signal === 'SIGTERM' && value.code === null,
    };
  }
}

/** @param {string} label @param {string} command @param {readonly string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options] */
async function runChecked(label, command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new Error(`${label} failed${result.timedOut ? ' by timeout' : ` with exit code ${String(result.code)}`}.`);
  return result;
}

/** @param {string} text */
function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not emit JSON on stdout.`);
  }
}

/** @param {string} text @param {string} label */
function assertNoSensitiveOutput(text, label) {
  assert(!/(?:api[_-]?key|access[_-]?key|authorization|password|secret|token)\s*[:=]/i.test(text), `${label} exposed a credential-like field.`);
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** @param {string} path */
async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {string} installedRoot @param {NodeJS.ProcessEnv} env @param {string} expectedVersion */
async function checkInstalledCandidate(installedRoot, env, expectedVersion) {
  const packageRoot = resolve(installedRoot, 'node_modules', '@nb-corp', 'nb-search');
  const packageJsonPath = join(packageRoot, 'package.json');
  const installedPackage = await readJson(packageJsonPath);
  assert(installedPackage.name === '@nb-corp/nb-search', 'Installed candidate has an unexpected package name.');
  assert(typeof installedPackage.version === 'string' && installedPackage.version === expectedVersion, 'Installed candidate version does not match the packed candidate.');
  assert(installedPackage.peerDependencies?.playwright === '>=1.50.0', 'Playwright peer range is missing from the installed candidate.');
  assert(installedPackage.peerDependenciesMeta?.playwright?.optional === true, 'Playwright peer is not optional in the installed candidate.');
  assert(installedPackage.dependencies?.playwright === undefined, 'Playwright became a required runtime dependency.');
  const browserPeerPresent = await fileExists(join(installedRoot, 'node_modules', 'playwright'));
  assert(!browserPeerPresent, 'The clean candidate install unexpectedly included optional Playwright.');
  assert(await fileExists(join(packageRoot, 'dist', 'index.mjs')), 'Installed candidate is missing dist/index.mjs.');
  assert(await fileExists(join(packageRoot, 'dist', 'index.d.mts')), 'Installed candidate is missing dist/index.d.mts.');
  assert(await fileExists(join(packageRoot, 'dist', 'cli.mjs')), 'Installed candidate is missing dist/cli.mjs.');

  const packageModule = await import(pathToFileURL(join(packageRoot, 'dist', 'index.mjs')).href);
  assert(typeof packageModule.createNbSearchRuntime === 'function', 'Public SDK runtime export is missing.');
  assert(typeof packageModule.createNbSearchRemoteClient === 'function', 'Public SDK remote-client export is missing.');
  const runtime = packageModule.createNbSearchRuntime({ env });
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(runtime)).filter((name) => name !== 'constructor').sort();
  assert(JSON.stringify(methods) === JSON.stringify(['capabilities', 'fetch', 'search']), 'Public SDK runtime must expose exactly capabilities, fetch, and search.');

  const cli = join(packageRoot, 'dist', 'cli.mjs');
  const packageLauncher = join(packageRoot, 'scripts', 'nb-search.mjs');
  const nestedSkillCli = join(packageRoot, 'skills', 'nb-search', 'scripts', 'nb-search.mjs');
  const regularVersion = await runChecked('installed CLI --version', process.execPath, [cli, '--version'], { cwd: installedRoot, env });
  assert(regularVersion.stdout.trim() === installedPackage.version, 'Installed CLI version does not match package version.');
  const regularHelp = await runChecked('installed CLI --help', process.execPath, [cli, '--help'], { cwd: installedRoot, env });
  assert(regularHelp.stdout.includes('capabilities'), 'Installed CLI help is missing capabilities.');
  const packageVersion = await runChecked('root package launcher --version', process.execPath, [packageLauncher, '--version'], { cwd: installedRoot, env });
  assert(packageVersion.stdout.trim() === installedPackage.version, 'Root package launcher version does not match package version.');
  const packageHelp = await runChecked('root package launcher --help', process.execPath, [packageLauncher, '--help'], { cwd: installedRoot, env });
  assert(packageHelp.stdout.includes('capabilities'), 'Root package launcher help is missing capabilities.');
  const skillVersion = await runChecked('nested skill CLI --version', process.execPath, [nestedSkillCli, '--version'], { cwd: installedRoot, env });
  assert(skillVersion.stdout.trim() === installedPackage.version, 'Nested skill launcher version does not match package version.');
  const skillHelp = await runChecked('nested skill CLI --help', process.execPath, [nestedSkillCli, '--help'], { cwd: installedRoot, env });
  assert(skillHelp.stdout.includes('capabilities'), 'Nested skill launcher help is missing capabilities.');

  const capabilities = await runChecked('empty-environment capabilities', process.execPath, [cli, 'capabilities'], { cwd: installedRoot, env });
  assertNoSensitiveOutput(capabilities.stdout + capabilities.stderr, 'Capabilities');
  const capabilityValue = parseJsonOutput(capabilities.stdout, 'Capabilities');
  assert(capabilityValue.schema_version === '3.0', 'Capabilities schema version is not 3.0.');
  assert(Array.isArray(capabilityValue.search?.lanes) && Array.isArray(capabilityValue.fetch?.pipelines), 'Capabilities did not expose search lanes and fetch pipelines.');
  assert(capabilityValue.fetch.pipelines.some((pipeline) => pipeline.id === 'direct.fetch'), 'Capabilities did not expose direct.fetch.');
  assert(capabilityValue.providers?.instances?.every((instance) => instance.credential?.configured !== true), 'Empty-environment capabilities unexpectedly configured a credential.');

  const failedSearch = await run(process.execPath, [cli, 'search', 'release-check-offline'], { cwd: installedRoot, env });
  assert(failedSearch.code === 2, 'Offline search did not fail with the normal CLI error code.');
  const searchValue = parseJsonOutput(failedSearch.stdout, 'Offline search');
  assert(searchValue.status === 'failed' && searchValue.error?.code === 'LANE_NOT_CONFIGURED', 'Offline search did not use the controlled empty-provider path.');
  assertNoSensitiveOutput(failedSearch.stdout + failedSearch.stderr, 'Offline search');

  const home = env.NB_SEARCH_HOME;
  assert(typeof home === 'string' && isAbsolute(home) && home.startsWith(resolve(installedRoot, '..')), 'NB_SEARCH_HOME was not isolated in the scratch install area.');
  assert(await fileExists(home), 'Controlled NB_SEARCH_HOME was not created.');
  assert(!await fileExists(join(home, '.config-access.lock')), 'Controlled CLI left a configuration lock behind.');
  return {
    package_root: relativePath(packageRoot),
    sdk_exports: ['createNbSearchRemoteClient', 'createNbSearchRuntime'],
    runtime_methods: methods,
    cli_version: regularVersion.stdout.trim(),
    package_launcher_version: packageVersion.stdout.trim(),
    nested_skill_version: skillVersion.stdout.trim(),
    capabilities_schema: capabilityValue.schema_version,
    playwright_peer: 'optional',
    browser_peer_present: browserPeerPresent,
  };
}

/** @param {readonly string[]} argv */
export function parseArguments(argv) {
  let expectedVersion;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version') {
      assert(index + 1 < argv.length, '--version requires a value.');
      expectedVersion = safeVersion(argv[++index]);
      continue;
    }
    if (arg.startsWith('--version=')) {
      expectedVersion = safeVersion(arg.slice('--version='.length));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { help: false, ...(expectedVersion === undefined ? {} : { expectedVersion }) };
}

/**
 * Build and install one candidate without touching registry state. The run
 * directory is intentionally retained for reproducible tarball/manifest/hash
 * inspection; only this invocation's uniquely-created directory is used.
 * @param {{ expectedVersion?: string }} [options]
 */
export async function runReleaseCheck(options = {}) {
  const packageJson = await readJson(join(repoRoot, 'package.json'));
  const packageVersion = safeVersion(String(packageJson.version));
  if (options.expectedVersion !== undefined) assert(packageVersion === options.expectedVersion, `package.json version ${packageVersion} does not match requested ${options.expectedVersion}.`);

  const checkRoot = join(repoRoot, '.release-check');
  await mkdir(checkRoot, { recursive: true });
  const nonce = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const workDir = await mkdtemp(join(checkRoot, `run-${nonce}-`));
  const packDir = join(workDir, 'pack');
  const installDir = await mkdtemp(join(workDir, 'install-'));
  const home = join(installDir, 'scratch-home');
  await mkdir(packDir, { recursive: true });
  const env = controlledEnv(workDir, home);
  await secureDirectory(home, env);
  await secureFile(env.npm_config_userconfig, '# release-check intentionally uses no user npm configuration.\n', env);
  await secureFile(env.NB_SEARCH_CONFIG, `${JSON.stringify({ schema_version: '4', defaults: { search_lane: 'exa.search', fetch_chain: [{ input_kind: 'url', pipelines: ['direct.fetch', 'jina.reader'] }] } })}\n`, env);

  const packed = await runChecked('npm pack', npmCommand, [...npmArgsPrefix, 'pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: repoRoot, env });
  const packMetadata = parsePackJson(packed.stdout);
  assert(packMetadata.name === packageJson.name, 'npm pack returned an unexpected package name.');
  assert(packMetadata.version === packageVersion, 'npm pack returned a version different from package.json.');
  assert(typeof packMetadata.filename === 'string' && !isAbsolute(packMetadata.filename) && basename(packMetadata.filename) === packMetadata.filename, 'npm pack returned an unsafe tarball path.');
  const tarball = resolve(packDir, basename(packMetadata.filename));
  assert(await fileExists(tarball), 'npm pack did not create the candidate tarball.');
  const packFiles = Array.isArray(packMetadata.files) ? packMetadata.files.map((file) => isRecord(file) && typeof file.path === 'string' ? file.path : '') : [];
  assert(packFiles.every((path) => path !== ''), 'npm pack returned a malformed file manifest.');
  const manifest = assertManifestSafe(packFiles);
  const manifestPath = join(workDir, 'manifest.json');
  const digest = await sha256(tarball);
  await writeFile(manifestPath, `${JSON.stringify({ name: packMetadata.name, version: packMetadata.version, tarball: relativePath(tarball), sha256: digest, files: manifest }, null, 2)}\n`, 'utf8');

  await runChecked('clean candidate install', npmCommand, [...npmArgsPrefix, 'install', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--omit=peer', '--prefix', installDir, tarball], { cwd: installDir, env });
  const installed = await checkInstalledCandidate(installDir, env, packageVersion);
  return {
    status: 'passed',
    name: packMetadata.name,
    version: packageVersion,
    workdir: relativePath(workDir),
    tarball: relativePath(tarball),
    manifest: relativePath(manifestPath),
    sha256: digest,
    manifest_files: manifest.length,
    install: installed,
    publish: 'not attempted',
  };
}

function help() {
  process.stdout.write('Usage: node scripts/release-check.mjs [--version X.Y.Z]\n\nPacks the current package, validates its manifest, installs the local candidate in an isolated scratch directory, and runs SDK/CLI checks. It never publishes.\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) help();
    else {
      const result = await runReleaseCheck(args);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`release-check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
