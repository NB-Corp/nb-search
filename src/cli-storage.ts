import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, statSync, realpathSync, readlinkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, linkSync, type Stats } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { NbSearchError } from './errors.ts';

export const storageError = (message = 'Local configuration is invalid.') => new NbSearchError('CONFIGURATION_ERROR', message);
export function fileError(error: unknown, path: string, operation: string): NbSearchError {
  const raw = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof raw === 'string' && /^E[A-Z0-9]+$/.test(raw) ? raw : 'FILESYSTEM_ERROR';
  return storageError(`${operation} failed (${code}): ${path}.`);
}
/** Follows user-selected links. Only ENOENT means absent; no owner/mode policy. */
export function statIfPresent(path: string): Stats | undefined { try { return statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw fileError(error, path, 'Stat'); } }
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function ensureHome(home: string): void {
  try { mkdirSync(home, { recursive: true, mode: 0o700 }); if (!statSync(home).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' }); }
  catch (error) { throw fileError(error, home, 'Create directory'); }
}
/** Resolve even a dangling file link to its intended target; writes must never replace the link. */
export function writeTarget(path: string, hops = 0): string {
  path = resolve(path); if (hops > 40) throw fileError({ code: 'ELOOP' }, path, 'Resolve write target');
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return writeTarget(resolve(dirname(path), readlinkSync(path)), hops + 1);
    return realpathSync(path);
  } catch (error) {
    if (error instanceof NbSearchError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileError(error, path, 'Resolve write target');
    const parent = dirname(path); if (parent === path) throw fileError(error, path, 'Resolve write target');
    return resolve(writeTarget(parent, hops), basename(path));
  }
}
export function decodeJson(bytes: Buffer | undefined, path = 'configuration'): unknown | undefined { if (bytes === undefined) return undefined; try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); } catch { throw storageError(`Invalid UTF-8 JSON: ${path}.`); } }
export function readBytes(path: string): Buffer | undefined {
  const stat = statIfPresent(path); if (!stat) return undefined;
  if (!stat.isFile()) throw fileError({ code: 'EISDIR' }, path, 'Read file');
  if (stat.size > 4 * 1024 * 1024) throw storageError(`Configuration file exceeds 4 MiB: ${path}.`);
  try { const bytes = readFileSync(path); if (bytes.length > 4 * 1024 * 1024) throw storageError(`Configuration file exceeds 4 MiB: ${path}.`); return bytes; } catch (error) { throw error instanceof NbSearchError ? error : fileError(error, path, 'Read file'); }
}
export function readJson(path: string): unknown | undefined { return decodeJson(readBytes(path), path); }
// Historical internal name: ordinary exclusive writes use 0600, with no ACL probing or chmod.
export function writeProtected(path: string, value: unknown): void {
  let fd: number | undefined;
  try { fd = openSync(path, 'wx', 0o600); writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(fd); }
  catch (error) { throw fileError(error, path, 'Write file'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function retryStorage(operation: () => void): void { for (let attempt = 0;; attempt++) try { operation(); return; } catch (error) { if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; pause(10 * (attempt + 1)); } }
export function replaceFile(from: string, to: string): void {
  const target = writeTarget(to);
  try { retryStorage(() => renameSync(from, target)); } catch (error) { throw fileError(error, target, 'Replace file'); }
}
export function atomicJson(path: string, value: unknown): void { const target = writeTarget(path); ensureHome(dirname(target)); const temporary = `${target}.${randomUUID()}.tmp`; writeProtected(temporary, value); replaceFile(temporary, target); }
export function publishRecord(path: string, value: unknown): boolean {
  const target = writeTarget(path); const temporary = `${target}.${randomUUID()}.tmp`; writeProtected(temporary, value);
  try { retryStorage(() => linkSync(temporary, target)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw fileError(error, target, 'Publish job connection'); } finally { try { retryStorage(() => unlinkSync(temporary)); } catch (error) { throw fileError(error, temporary, 'Remove staging file'); } }
}
export function readRevision(home: string): string { return readRevisionFile(resolve(home, '.config-revision.json')); }
function readRevisionFile(path: string): string {
  const value = readJson(path);
  if (value === undefined) return 'initial';
  if (!value || typeof value !== 'object' || !('schema_version' in value) || value.schema_version !== '1' || !('revision' in value) || typeof value.revision !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.revision) || Object.keys(value).length !== 2) throw storageError('Configuration revision is invalid.');
  return value.revision;
}
export function commitRevision(home: string): void { const revision = randomUUID(); atomicJson(resolve(home, '.config-revision.json'), { schema_version: '1', revision }); if (readRevision(home) !== revision) throw storageError('Configuration revision publication failed; recovery is required.'); }
export function acquireConfigLock(home: string): () => void { return acquireLock(resolve(home, '.config-access.lock')); }
function acquireLock(path: string, transaction?: ConfigurationTargets): () => void {
  ensureHome(dirname(path)); const nonce = randomUUID();
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ nonce, ...(transaction ? { transaction } : {}) })); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw storageError(`Configuration is busy or recovery is required: ${path}. Restore the complete pair before removing transaction locks.`);
    throw fileError(error, path, 'Acquire configuration transaction');
  }
  return () => { const owner = readJson(path) as { nonce?: unknown } | undefined; if (owner?.nonce !== nonce) throw storageError(`Configuration lock ownership changed: ${path}.`); try { unlinkSync(path); } catch (error) { throw fileError(error, path, 'Release configuration transaction'); } };
}
export function assertUnlocked(home: string): void { assertLockAbsent(resolve(home, '.config-access.lock')); }
function assertLockAbsent(path: string): void {
  // An existing dangling marker is still an interrupted transaction, not absence.
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw fileError(error, path, 'Inspect configuration transaction'); }
  throw storageError(`Configuration is busy or recovery is required: ${path}.`);
}
export interface ConfigurationTargets { home: string; data: string[]; locks: string[]; revisions: string[] }
const metadataName = new RegExp('^(?:\\.config-access\\.lock|\\.config-revision\\.json|\\..+\\.nb-search(?:\\.lock|-revision\\.json))$', process.platform === 'win32' ? 'i' : '');
function dataTarget(path: string, hops = 0): string {
  path = resolve(path);
  if (metadataName.test(basename(path))) throw storageError(`Configuration data conflicts with the reserved transaction metadata namespace: ${path}.`);
  if (hops > 40) throw fileError({ code: 'ELOOP' }, path, 'Resolve data target');
  try { if (lstatSync(path).isSymbolicLink()) return dataTarget(resolve(dirname(path), readlinkSync(path)), hops + 1); }
  catch (error) { if (error instanceof NbSearchError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileError(error, path, 'Resolve data target'); }
  return writeTarget(path);
}
/** Only app-owned metadata leaf links are disallowed; user-selected data and parent-directory links remain supported. */
function metadataTarget(path: string): string {
  try { if (lstatSync(path).isSymbolicLink()) throw storageError(`Transaction metadata leaf must not be a link: ${path}.`); }
  catch (error) { if (error instanceof NbSearchError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileError(error, path, 'Inspect transaction metadata'); }
  return writeTarget(path);
}
/** Sidecars use resolved data paths, so different homes and directory aliases cooperate. Pure calculation: no mkdir. */
export function configurationTargets(home: string, configPath: string): ConfigurationTargets {
  const actualHome = writeTarget(home); const data = [dataTarget(configPath), dataTarget(resolve(home, 'secrets.json'))];
  const sibling = (path: string, suffix: string) => resolve(dirname(path), `.${basename(path)}.nb-search${suffix}`);
  const locks = [resolve(actualHome, '.config-access.lock'), ...data.map((path) => sibling(path, '.lock'))].map(metadataTarget);
  const revisions = [resolve(actualHome, '.config-revision.json'), ...data.map((path) => sibling(path, '-revision.json'))].map(metadataTarget);
  const paths = [...data, ...locks, ...revisions].map((path) => writeTarget(path));
  if (paths.some((path, index) => paths.slice(0, index).some((other) => samePath(path, other)))) throw storageError('Configuration data and transaction metadata targets conflict; each format requires a distinct file.');
  return { home: actualHome, data, locks, revisions };
}
export function assertConfigurationUnlocked(targets: ConfigurationTargets): void { for (const path of targets.locks) assertLockAbsent(path); }
export function acquireConfigurationLocks(targets: ConfigurationTargets): () => void {
  const unlocks: Array<() => void> = [];
  try { for (const path of targets.locks) unlocks.push(acquireLock(path, targets)); }
  catch (error) { for (const unlock of unlocks.reverse()) unlock(); throw error; }
  return () => { for (const unlock of [...unlocks].reverse()) unlock(); };
}
export function commitTargetRevisions(targets: ConfigurationTargets): void {
  for (const path of targets.revisions.slice(1)) { const revision = randomUUID(); atomicJson(path, { schema_version: '1', revision }); if (readRevisionFile(path) !== revision) throw storageError(`Configuration revision publication failed; recovery is required: ${path}.`); }
}
function identity(path: string): string { const value = statIfPresent(path); return value === undefined ? `missing:${writeTarget(path)}` : `${writeTarget(path)}:${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`; }
export function captureConfigPair(home: string, configPath: string): { config: unknown | undefined; secrets: unknown | undefined; revision: string } {
  const secretPath = resolve(home, 'secrets.json');
  for (let attempt = 0; attempt < 4; attempt++) {
    const targets = configurationTargets(home, configPath);
    const before = targets.revisions.map(readRevisionFile); assertConfigurationUnlocked(targets);
    const paths = [home, configPath, secretPath]; const ids = paths.map(identity);
    const config = readBytes(configPath); const secrets = readBytes(secretPath); const afterIds = paths.map(identity);
    assertConfigurationUnlocked(targets); const after = targets.revisions.map(readRevisionFile); // All markers MUST precede final revision observations.
    if (before.every((revision, index) => revision === after[index]) && ids.every((id, index) => id === afterIds[index]) && JSON.stringify(targets) === JSON.stringify(configurationTargets(home, configPath))) return { config: decodeJson(config, configPath), secrets: decodeJson(secrets, secretPath), revision: after[0]! };
    if (attempt < 3) pause(25 * 2 ** attempt);
  }
  throw storageError('Configuration changed repeatedly; retry the command.');
}
export function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b); }
