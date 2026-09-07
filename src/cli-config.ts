import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createCapturedRuntimeComposition } from './app.ts';
import { validateConfigurationSemantics } from './config.ts';
import { describeConfiguredLaneGuidance } from './lane-guidance.ts';
import { parseConfigPatch, stableFingerprint } from './config-schema.ts';
import { resolveCapturedConfiguration } from './config-sources.ts';
import { createNbSearchRemoteClient, normalizeRemoteBase } from './remote-client.ts';
import { captureConfigPair, ensureHome, publishRecord, readJson, samePath, storageError, writeTarget } from './cli-storage.ts';
import type { NbSearchRuntime } from './runtime.ts';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
// Older files may contain bindings metadata; it no longer constrains user configuration.
export const secretSchema = z.object({ schema_version: z.literal('1'), values: z.record(envName, z.string()), bindings: z.unknown().optional() }).strict();
export type SecretFile = z.infer<typeof secretSchema>;
const profileSchema = z.object({ kind: z.literal('remote'), base_url: z.string(), token_env: envName, allow_loopback_http: z.boolean().optional(), timeout_ms: z.number().int().min(100).max(3600000).optional(), max_request_bytes: z.number().int().positive().optional(), max_response_bytes: z.number().int().positive().optional() }).strict();
export const profilesSchema = z.object({ schema_version: z.literal('1'), profiles: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), profileSchema) }).strict();
export function cliPaths(env: NodeJS.ProcessEnv = process.env) { const home = resolve(env['NB_SEARCH_HOME']?.trim() || resolve(homedir(), '.nb-search')); return { home, config: resolve(env['NB_SEARCH_CONFIG']?.trim() || resolve(home, 'config.json')), secrets: resolve(home, 'secrets.json') }; }
export function loadSecrets(path: string): SecretFile { const raw = readJson(path); const parsed = secretSchema.safeParse(raw === undefined ? { schema_version: '1', values: {} } : raw); if (!parsed.success) throw storageError(`Invalid secret-file format: ${path}.`); return parsed.data; }
export function privateEnvironment(env: NodeJS.ProcessEnv, secrets: SecretFile, allowed?: ReadonlySet<string>): NodeJS.ProcessEnv { const copy = { ...env }; for (const [name, value] of Object.entries(secrets.values)) if ((!allowed || allowed.has(name)) && !Object.hasOwn(env, name)) copy[name] = value; return copy; }
export function resolveCliSnapshot(env: NodeJS.ProcessEnv) {
  env = { ...env }; const paths = cliPaths(env); const pair = captureConfigPair(paths.home, paths.config);
  const parsed = secretSchema.safeParse(pair.secrets === undefined ? { schema_version: '1', values: {} } : pair.secrets); if (!parsed.success) throw storageError(`Invalid secret-file format: ${paths.secrets}.`);
  const captured = { home: paths.home, canonicalPath: paths.config, canonical: pair.config === undefined ? undefined : parseConfigPatch(pair.config, 'canonical configuration') };
  const original = resolveCapturedConfiguration(captured, { env });
  const allowed = new Set(Object.values(original.config.credential_slots).map((slot) => slot.env));
  const copy = privateEnvironment(env, parsed.data, allowed); const effective = resolveCapturedConfiguration(captured, { env: copy });
  if (effective.config_fingerprint !== original.config_fingerprint || !samePath(cliPaths(copy).home, paths.home) || !samePath(cliPaths(copy).config, paths.config)) throw storageError('Credential-file values must not override canonical configuration.');
  return { paths, effective, env: copy, config_present: pair.config !== undefined };
}
export interface CliConnection { runtime: NbSearchRuntime; identity: string; home: string; legacy_local_identity?: string }
export function loadCliConnection(profile = 'local', env: NodeJS.ProcessEnv = process.env): CliConnection {
  const paths = cliPaths(env);
  if (profile !== 'local') {
    const parsed = profilesSchema.safeParse(readJson(resolve(paths.home, 'profiles.json'))); if (!parsed.success || !Object.hasOwn(parsed.data.profiles, profile)) throw storageError('The selected profile is not configured.');
    const selected = parsed.data.profiles[profile]!; const token = Object.hasOwn(env, selected.token_env) ? env[selected.token_env] : loadSecrets(resolve(paths.home, 'remote-secrets.json')).values[selected.token_env];
    const base = normalizeRemoteBase(selected.base_url, selected.allow_loopback_http);
    return { home: paths.home, identity: stableFingerprint({ kind: 'remote', base, token_env: selected.token_env }), runtime: createNbSearchRemoteClient({ ...selected, base_url: base, access_key: token ?? '' }) };
  }
  const snapshot = resolveCliSnapshot(env);
  const composition = createCapturedRuntimeComposition(snapshot.effective, snapshot.env);
  return { home: paths.home, identity: stableFingerprint({ kind: 'local', jobs_root: writeTarget(composition.config.jobs_root) }), legacy_local_identity: stableFingerprint({ kind: 'local', jobs_root: composition.config.jobs_root }), runtime: composition.runtime };
}
export function cliDoctor(profile = 'local', env: NodeJS.ProcessEnv = process.env): unknown {
  const paths = cliPaths(env);
  if (profile !== 'local') { const parsed = profilesSchema.safeParse(readJson(resolve(paths.home, 'profiles.json'))); if (!parsed.success || !Object.hasOwn(parsed.data.profiles, profile)) throw storageError('The selected profile is not configured.'); const selected = parsed.data.profiles[profile]!; normalizeRemoteBase(selected.base_url, selected.allow_loopback_http); const secrets = Object.hasOwn(env, selected.token_env) ? undefined : loadSecrets(resolve(paths.home, 'remote-secrets.json')); return { status: (env[selected.token_env] ?? secrets?.values[selected.token_env]) ? 'succeeded' : 'failed', profile, kind: 'remote', network_probed: false }; }
  const { effective, config_present } = resolveCliSnapshot(env);
  validateConfigurationSemantics(effective.config);
  return { status: 'succeeded', profile: 'local', kind: 'local', config_present, configured_providers: [...new Set([...effective.secret_bindings.values()].map((binding) => binding.provider_id))], guide: describeConfiguredLaneGuidance(effective.config), network_probed: false };
}
const connectionSchema = z.object({ kind: z.enum(['search', 'fetch']), identity: z.string() }).strict();
const connectionsSchema = z.record(z.string().uuid(), connectionSchema);
export function initializeAdmissionStorage(home: string): void { ensureHome(home); ensureHome(resolve(home, 'job-connections')); }
export function jobBinding(connection: CliConnection, kind: 'search' | 'fetch', jobId: string, record = false): void {
  if (!z.uuid().safeParse(jobId).success) throw storageError('Invalid job connection ID.');
  if (record) initializeAdmissionStorage(connection.home);
  const directory = resolve(connection.home, 'job-connections');
  const legacyValue = readJson(resolve(connection.home, 'job-connections.json'));
  const legacy = connectionsSchema.safeParse(legacyValue === undefined ? {} : legacyValue);
  if (!legacy.success) throw storageError('Job connection records are invalid.');
  const path = resolve(directory, `${jobId}.json`); const old = legacy.data[jobId];
  const check = (value: unknown): void => { if (value === undefined) return; const parsed = connectionSchema.safeParse(value); if (!parsed.success) throw storageError('Job connection records are invalid.'); if (parsed.data.kind !== kind || (parsed.data.identity !== connection.identity && parsed.data.identity !== connection.legacy_local_identity)) throw storageError('The job belongs to a different connection or capability.'); };
  check(old); const existing = readJson(path); check(existing);
  if (record && existing === undefined) { if (!publishRecord(path, { kind, identity: connection.identity })) check(readJson(path)); }
}
