import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  CONFIG_SCHEMA_VERSION, DEFAULT_PROFILE_ID, parseConfigPatch, parseResolvedConfig, stableFingerprint,
  type CanonicalConfig, type CanonicalConfigPatch, type CredentialSlotConfig, type ProviderInstancePatch,
} from './config-schema.ts';
import { NbSearchError } from './errors.ts';

export interface ConfigurationDiagnostic {
  code: 'LEGACY_NOT_FOUND' | 'LEGACY_INVALID' | 'LEGACY_UNSUPPORTED' | 'SOURCE_APPLIED';
  source: string;
  path?: string;
  message: string;
}

export type WorkerGrant =
  | { kind: 'environment'; name: string }
  | { kind: 'legacy-json'; path: string; key: 'exa' | 'tavily' }
  | { kind: 'opaque'; id: string };

export interface SecretBinding {
  credential_slot_id: string;
  provider_id: string;
  value: string;
  worker_grant: WorkerGrant;
}

export type SecretBindings = ReadonlyMap<string, SecretBinding>;

export interface ConfigurationProvenance {
  path: string;
  source: string;
}

export interface ResolvedConfiguration {
  config: CanonicalConfig;
  config_revision: string;
  config_fingerprint: string;
  secret_bindings: SecretBindings;
  diagnostics: readonly ConfigurationDiagnostic[];
  provenance: readonly ConfigurationProvenance[];
  canonical_path: string;
  legacy_path?: string;
}

export interface ResolveConfigurationOptions {
  env?: NodeJS.ProcessEnv;
  config?: CanonicalConfigPatch;
  overrides?: CanonicalConfigPatch;
  cwd?: string;
  homeDirectory?: string;
}

interface SourcePatch { label: string; patch: CanonicalConfigPatch }

const LEGACY_REQUEST_TIMEOUT_SECONDS = 90;
const LEGACY_PROVIDER_TIMEOUT_SECONDS = 20;
const LEGACY_RETRY_MAX_ATTEMPTS = 2;
const LEGACY_RETRY_BACKOFF_MS = 500;

export function resolveConfiguration(options: ResolveConfigurationOptions = {}): ResolvedConfiguration {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const userHome = resolve(options.homeDirectory ?? homedir());
  const configuredHome = nonempty(env['NB_SEARCH_HOME']);
  const nbHome = configuredHome === undefined ? resolve(userHome, '.nb-search') : resolve(cwd, configuredHome);
  const configuredCanonical = nonempty(env['NB_SEARCH_CONFIG']);
  const canonicalPath = configuredCanonical === undefined ? resolve(nbHome, 'config.json') : resolve(cwd, configuredCanonical);
  const diagnostics: ConfigurationDiagnostic[] = [];
  const legacySecrets = new Map<string, SecretBinding>();
  const sources: SourcePatch[] = [{ label: 'defaults', patch: defaultConfiguration(nbHome) }];

  const legacyPath = selectLegacyPath(env, cwd, userHome);
  if (legacyPath !== undefined) {
    const legacy = readLegacySource(legacyPath, diagnostics, legacySecrets);
    if (legacy !== undefined) sources.push({ label: 'legacy', patch: legacy });
  }

  if (existsSync(canonicalPath)) {
    sources.push({ label: 'canonical', patch: readExplicitSource(canonicalPath, 'canonical configuration') });
  } else if (nonempty(env['NB_SEARCH_CONFIG']) !== undefined) {
    throw new NbSearchError('CONFIGURATION_ERROR', `Canonical configuration file was not found: ${canonicalPath}.`);
  }

  const preliminaryProvenance = new Map<string, string>();
  let preliminary: unknown = {};
  for (const source of sources) preliminary = mergeConfig(preliminary, source.patch, source.label, preliminaryProvenance);
  const environment = environmentPatch(env, cwd, parseResolvedConfig(preliminary), diagnostics);
  if (Object.keys(environment).length > 0) sources.push({ label: 'environment', patch: environment });
  if (options.config !== undefined) sources.push({ label: 'host', patch: parseConfigPatch(options.config, 'host configuration') });
  if (options.overrides !== undefined) sources.push({ label: 'runtime', patch: parseConfigPatch(options.overrides, 'runtime overrides') });

  const provenance = new Map<string, string>();
  let merged: unknown = {};
  for (const source of sources) merged = mergeConfig(merged, source.patch, source.label, provenance);
  addCompatibilityProfiles(merged, provenance);
  const config = parseResolvedConfig(merged);
  const secrets = resolveConfiguredSecrets(config, env, legacySecrets, provenance);
  const safeConfig = {
    ...config,
    credential_slots: Object.fromEntries(Object.entries(config.credential_slots).map(([id, slot]) => [id, { ...slot }])),
  };
  const configFingerprint = stableFingerprint(safeConfig);
  return {
    config,
    config_revision: `config-${CONFIG_SCHEMA_VERSION}-${configFingerprint.slice(0, 16)}`,
    config_fingerprint: configFingerprint,
    secret_bindings: secrets,
    diagnostics,
    provenance: [...provenance.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, source]) => ({ path, source })),
    canonical_path: canonicalPath,
    ...(legacyPath === undefined ? {} : { legacy_path: legacyPath }),
  };
}

export function defaultConfiguration(home: string): CanonicalConfigPatch {
  const retry = { max_attempts: 2, backoff_ms: 100, max_backoff_ms: 2_000 };
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    home,
    jobs_root: resolve(home, 'jobs'),
    retention_hours: 72,
    log_level: 'warn',
    provider_instances: {
      'exa.default': {
        provider_id: 'exa', enabled: true, credential_slot_id: 'exa.default',
        base_url: 'https://api.exa.ai/search', timeout_ms: 45_000, retry, options: {},
      },
      'tavily.default': {
        provider_id: 'tavily', enabled: true, credential_slot_id: 'tavily.default',
        base_url: 'https://api.tavily.com/search', timeout_ms: 45_000, retry, options: {},
      },
    },
    credential_slots: {
      'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' },
      'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_TAVILY_API_KEY' },
    },
    profiles: {
      [DEFAULT_PROFILE_ID]: {
        stages: [{
          kind: 'parallel',
          invocations: [
            { provider_instance_id: 'exa.default', capability: 'retrieval', role: 'primary', trigger: 'always' },
            { provider_instance_id: 'tavily.default', capability: 'retrieval', role: 'primary', trigger: 'always' },
          ],
        }],
      },
    },
    default_profile_id: DEFAULT_PROFILE_ID,
  };
}

function selectLegacyPath(env: NodeJS.ProcessEnv, cwd: string, userHome: string): string | undefined {
  const configured = nonempty(env['SEARCH_LAYER_CREDENTIALS']);
  const candidates = [
    configured === undefined ? undefined : resolve(cwd, configured),
    resolve(userHome, '.openclaw', 'credentials', 'search.json'),
    resolve(cwd, 'credentials', 'search.json'),
  ].filter((value): value is string => value !== undefined).map((value) => resolve(value));
  return candidates.find(isFile);
}

function readLegacySource(
  path: string,
  diagnostics: ConfigurationDiagnostic[],
  secrets: Map<string, SecretBinding>,
): CanonicalConfigPatch | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown; }
  catch {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: 'Legacy configuration could not be parsed; safe defaults were used.' });
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: 'Legacy configuration must be a JSON object; safe defaults were used.' });
    return undefined;
  }
  const providerInstances: Record<string, ProviderInstancePatch> = {};
  const credentialSlots: Record<string, CredentialSlotConfig> = {};
  mapLegacyProvider('exa', value, path, providerInstances, credentialSlots, secrets, diagnostics);
  mapLegacyProvider('tavily', value, path, providerInstances, credentialSlots, secrets, diagnostics);
  mapLegacyPolicies(value, path, providerInstances, diagnostics);
  const patch: CanonicalConfigPatch = {};
  if (Object.keys(providerInstances).length > 0) patch.provider_instances = providerInstances;
  if (Object.keys(credentialSlots).length > 0) patch.credential_slots = credentialSlots;
  return patch;
}

function mapLegacyProvider(
  providerId: 'exa' | 'tavily',
  value: Record<string, unknown>,
  path: string,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  secrets: Map<string, SecretBinding>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const instanceId = `${providerId}.default`;
  const raw = value[providerId];
  const legacyObject = isRecord(raw) ? raw : undefined;
  const key = nonempty(typeof raw === 'string' ? raw : stringValue(legacyObject?.['apiKey']));
  const title = providerId === 'exa' ? 'exa' : 'tavily';
  const nestedBase = firstNonempty([legacyObject?.['apiUrl'], legacyObject?.['baseUrl'], legacyObject?.['apiBase']]);
  const topLevelBase = firstNonempty([
    value[`${title}ApiUrl`], value[`${title}ApiBase`], value[`${title}BaseUrl`],
  ]);
  const base = topLevelBase ?? nestedBase;
  if (base !== undefined) {
    if (isHttpUrl(base)) instances[instanceId] = { base_url: base };
    else diagnostics.push({
      code: 'LEGACY_INVALID', source: 'legacy', path,
      message: `Legacy ${providerId} base URL was invalid and was ignored.`,
    });
  }
  if (key === undefined) return;
  slots[instanceId] = { provider_id: providerId, worker_grant: `legacy:${providerId}` };
  secrets.set(instanceId, {
    credential_slot_id: instanceId, provider_id: providerId, value: key,
    worker_grant: { kind: 'legacy-json', path, key: providerId },
  });
}

function mapLegacyPolicies(
  value: Record<string, unknown>,
  path: string,
  instances: Record<string, ProviderInstancePatch>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const rawSearchLayer = value['searchLayer'];
  const searchLayer = isRecord(rawSearchLayer) ? rawSearchLayer : {};
  if (rawSearchLayer !== undefined && !isRecord(rawSearchLayer)) legacyPolicyWarning(path, 'searchLayer', diagnostics);

  const requestTimeoutSeconds = legacyNumber(
    searchLayer['requestTimeoutSeconds'], LEGACY_REQUEST_TIMEOUT_SECONDS, 0.1,
    path, 'searchLayer.requestTimeoutSeconds', diagnostics, 3_600,
  );
  const rawProviderTimeouts = searchLayer['providerTimeouts'];
  const providerTimeouts = isRecord(rawProviderTimeouts) ? rawProviderTimeouts : {};
  if (rawProviderTimeouts !== undefined && !isRecord(rawProviderTimeouts)) {
    legacyPolicyWarning(path, 'searchLayer.providerTimeouts', diagnostics);
  }
  const rawRetry = searchLayer['retry'];
  const retry = isRecord(rawRetry) ? rawRetry : {};
  if (rawRetry !== undefined && !isRecord(rawRetry)) legacyPolicyWarning(path, 'searchLayer.retry', diagnostics);
  const maxAttempts = legacyInteger(
    retry['maxAttempts'], LEGACY_RETRY_MAX_ATTEMPTS, 1,
    path, 'searchLayer.retry.maxAttempts', diagnostics, 10,
  );
  const backoffMs = legacyInteger(
    retry['backoffMs'], LEGACY_RETRY_BACKOFF_MS, 0,
    path, 'searchLayer.retry.backoffMs', diagnostics, 60_000,
  );

  for (const providerId of ['exa', 'tavily'] as const) {
    const providerTimeoutSeconds = legacyNumber(
      providerTimeouts[providerId], LEGACY_PROVIDER_TIMEOUT_SECONDS, 0.1,
      path, `searchLayer.providerTimeouts.${providerId}`, diagnostics, 3_600,
    );
    const instanceId = `${providerId}.default`;
    instances[instanceId] = {
      ...instances[instanceId],
      timeout_ms: Math.round(Math.min(requestTimeoutSeconds, providerTimeoutSeconds) * 1000),
      retry: {
        max_attempts: maxAttempts,
        backoff_ms: Math.round(backoffMs),
      },
    };
  }
}

function readExplicitSource(path: string, source: string): CanonicalConfigPatch {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown; }
  catch (error) { throw new NbSearchError('CONFIGURATION_ERROR', `${source} could not be read as JSON.`, false, undefined, { cause: error }); }
  return parseConfigPatch(value, source);
}

function environmentPatch(
  env: NodeJS.ProcessEnv,
  cwd: string,
  base: CanonicalConfig,
  diagnostics: ConfigurationDiagnostic[],
): CanonicalConfigPatch {
  const patch: CanonicalConfigPatch = {};
  const instances: Record<string, ProviderInstancePatch> = {};
  const slots: Record<string, CredentialSlotConfig> = {};
  const home = nonempty(env['NB_SEARCH_HOME']);
  if (home !== undefined) {
    patch.home = resolve(cwd, home);
    if (nonempty(env['NB_SEARCH_JOBS_ROOT']) === undefined) patch.jobs_root = resolve(cwd, home, 'jobs');
  }
  const jobsRoot = nonempty(env['NB_SEARCH_JOBS_ROOT']);
  if (jobsRoot !== undefined) patch.jobs_root = resolve(cwd, jobsRoot);
  const retention = nonempty(env['NB_SEARCH_RETENTION_HOURS']);
  if (retention !== undefined) {
    const parsed = Number(retention);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_RETENTION_HOURS must be a positive number.');
    patch.retention_hours = parsed;
  }
  const logLevel = nonempty(env['NB_SEARCH_LOG_LEVEL'])?.toLowerCase();
  if (logLevel !== undefined) {
    if (logLevel !== 'error' && logLevel !== 'warn' && logLevel !== 'info' && logLevel !== 'debug') {
      throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_LOG_LEVEL must be error, warn, info, or debug.');
    }
    patch.log_level = logLevel;
  }
  mapEnvironmentProvider('exa', 'NB_SEARCH_EXA_API_KEY', 'EXA_API_KEY', env, instances, slots);
  mapEnvironmentProvider('tavily', 'NB_SEARCH_TAVILY_API_KEY', 'TAVILY_API_KEY', env, instances, slots);
  mapEnvironmentEndpoint('exa', 'NB_SEARCH_EXA_BASE_URL', ['EXA_API_BASE', 'EXA_API_URL'], env, instances);
  mapEnvironmentEndpoint('tavily', 'NB_SEARCH_TAVILY_BASE_URL', ['TAVILY_API_BASE', 'TAVILY_API_URL'], env, instances);
  mapEnvironmentPolicy('exa', env, base, instances, diagnostics);
  mapEnvironmentPolicy('tavily', env, base, instances, diagnostics);
  mapEnvironmentRetry(env, instances);
  if (Object.keys(instances).length > 0) patch.provider_instances = instances;
  if (Object.keys(slots).length > 0) patch.credential_slots = slots;
  return patch;
}

function mapEnvironmentEndpoint(
  providerId: 'exa' | 'tavily',
  primary: string,
  aliases: readonly string[],
  env: NodeJS.ProcessEnv,
  instances: Record<string, ProviderInstancePatch>,
): void {
  const value = nonempty(env[primary]) ?? firstNonempty(aliases.map((name) => env[name]));
  if (value === undefined) return;
  if (!isHttpUrl(value)) throw new NbSearchError('CONFIGURATION_ERROR', `${primary} or its legacy alias must be an HTTP(S) URL.`);
  const instanceId = `${providerId}.default`;
  instances[instanceId] = { ...instances[instanceId], base_url: value };
}

function mapEnvironmentPolicy(
  providerId: 'exa' | 'tavily',
  env: NodeJS.ProcessEnv,
  base: CanonicalConfig,
  instances: Record<string, ProviderInstancePatch>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const upper = providerId.toUpperCase();
  const primaryName = `NB_SEARCH_${upper}_TIMEOUT_MS`;
  const primary = nonempty(env[primaryName]);
  const instanceId = `${providerId}.default`;
  if (primary !== undefined) {
    const timeoutMs = strictEnvironmentInteger(primary, primaryName, 100, 3_600_000);
    instances[instanceId] = { ...instances[instanceId], timeout_ms: timeoutMs };
    return;
  }
  const providerName = `SEARCH_LAYER_${upper}_TIMEOUT_SECONDS`;
  const requestName = 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS';
  const providerValue = nonempty(env[providerName]);
  const requestValue = nonempty(env[requestName]);
  if (providerValue === undefined && requestValue === undefined) return;
  const providerSeconds = legacyEnvironmentNumber(providerValue, 0.1, providerName, diagnostics, 3_600);
  const requestSeconds = legacyEnvironmentNumber(requestValue, 0.1, requestName, diagnostics, 3_600);
  const inherited = base.provider_instances[instanceId]?.timeout_ms ?? 45_000;
  const timeoutMs = providerSeconds === undefined
    ? requestSeconds === undefined ? inherited : Math.min(inherited, Math.round(requestSeconds * 1000))
    : Math.round(Math.min(providerSeconds, requestSeconds ?? Number.POSITIVE_INFINITY) * 1000);
  instances[instanceId] = { ...instances[instanceId], timeout_ms: timeoutMs };
}

function mapEnvironmentRetry(
  env: NodeJS.ProcessEnv,
  instances: Record<string, ProviderInstancePatch>,
): void {
  const maxAttempts = nonempty(env['NB_SEARCH_RETRY_MAX_ATTEMPTS']);
  const backoffMs = nonempty(env['NB_SEARCH_RETRY_BACKOFF_MS']);
  const maxBackoffMs = nonempty(env['NB_SEARCH_RETRY_MAX_BACKOFF_MS']);
  if (maxAttempts === undefined && backoffMs === undefined && maxBackoffMs === undefined) return;
  const retry = {
    ...(maxAttempts === undefined ? {} : { max_attempts: strictEnvironmentInteger(maxAttempts, 'NB_SEARCH_RETRY_MAX_ATTEMPTS', 1, 10) }),
    ...(backoffMs === undefined ? {} : { backoff_ms: strictEnvironmentInteger(backoffMs, 'NB_SEARCH_RETRY_BACKOFF_MS', 0, 60_000) }),
    ...(maxBackoffMs === undefined ? {} : { max_backoff_ms: strictEnvironmentInteger(maxBackoffMs, 'NB_SEARCH_RETRY_MAX_BACKOFF_MS', 0, 300_000) }),
  };
  for (const providerId of ['exa', 'tavily'] as const) {
    const instanceId = `${providerId}.default`;
    instances[instanceId] = { ...instances[instanceId], retry: { ...instances[instanceId]?.retry, ...retry } };
  }
}

function mapEnvironmentProvider(
  providerId: 'exa' | 'tavily',
  primary: string,
  alias: string,
  env: NodeJS.ProcessEnv,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
): void {
  const primaryValue = nonempty(env[primary]);
  const aliasValue = nonempty(env[alias]);
  const value = primaryValue ?? aliasValue;
  if (value === undefined) return;
  const name = primaryValue === undefined ? alias : primary;
  const slotId = `${providerId}.default`;
  instances[slotId] = { credential_slot_id: slotId };
  slots[slotId] = { provider_id: providerId, env: name };
}

function resolveConfiguredSecrets(
  config: CanonicalConfig,
  env: NodeJS.ProcessEnv,
  legacySecrets: ReadonlyMap<string, SecretBinding>,
  provenance: ReadonlyMap<string, string>,
): Map<string, SecretBinding> {
  const secrets = new Map<string, SecretBinding>();
  const activeSlotIds = new Set(Object.values(config.provider_instances)
    .filter((instance) => instance.enabled && instance.credential_slot_id !== undefined)
    .map((instance) => instance.credential_slot_id!));
  for (const slotId of [...activeSlotIds].sort()) {
    const slot = config.credential_slots[slotId];
    if (slot === undefined) continue;
    if (slot.env !== undefined) {
      const value = nonempty(env[slot.env]);
      if (value !== undefined) {
        secrets.set(slotId, {
          credential_slot_id: slotId, provider_id: slot.provider_id, value,
          worker_grant: { kind: 'environment', name: slot.env },
        });
      }
      continue;
    }
    const legacy = legacySecrets.get(slotId);
    if (provenance.get(`credential_slots.${slotId}`) === 'legacy'
      && legacy?.provider_id === slot.provider_id
      && legacy.worker_grant.kind === 'legacy-json') {
      secrets.set(slotId, structuredClone(legacy));
    }
  }
  return secrets;
}

function mergeConfig(base: unknown, patch: unknown, source: string, provenance: Map<string, string>, path = ''): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch) || !isRecord(patch)) {
    provenance.set(path || '<root>', source);
    return structuredClone(patch);
  }
  const current = isRecord(base) ? structuredClone(base) : {};
  for (const [key, patchValue] of Object.entries(patch)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (patchValue === null) {
      delete current[key];
      provenance.set(childPath, source);
      continue;
    }
    const atomic = path === 'credential_slots' || path === 'profiles';
    if (atomic) {
      current[key] = structuredClone(patchValue);
      provenance.set(childPath, source);
    } else {
      const merged = mergeConfig(current[key], patchValue, source, provenance, childPath);
      if (merged === undefined) delete current[key]; else current[key] = merged;
    }
  }
  return current;
}

function addCompatibilityProfiles(value: unknown, provenance: Map<string, string>): void {
  if (!isRecord(value) || !isRecord(value['profiles']) || !isRecord(value['provider_instances'])) return;
  const profiles = value['profiles'];
  const providerInstances = value['provider_instances'];
  const direct = (['exa.default', 'tavily.default'] as const).filter((instanceId) => isRecord(providerInstances[instanceId]));
  if (direct.length === 0) return;
  if (profiles['deep'] === undefined && !provenance.has('profiles.deep')) {
    profiles['deep'] = {
      stages: [{
        kind: 'parallel',
        invocations: direct.map((instanceId) => ({
          provider_instance_id: instanceId, capability: 'retrieval', role: 'primary', trigger: 'always',
        })),
      }],
    };
    provenance.set('profiles.deep', 'compatibility');
  }
  if (profiles['fast'] === undefined && !provenance.has('profiles.fast')) {
    profiles['fast'] = {
      stages: [{
        kind: 'fallback',
        invocations: direct.map((instanceId, index) => ({
          provider_instance_id: instanceId,
          capability: 'retrieval',
          role: index === 0 ? 'primary' : 'fallback',
          trigger: index === 0 ? 'always' : 'empty_or_failure',
        })),
      }],
    };
    provenance.set('profiles.fast', 'compatibility');
  }
}

function nonempty(value: string | undefined): string | undefined { const item = value?.trim(); return item === '' ? undefined : item }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function firstNonempty(values: readonly unknown[]): string | undefined {
  for (const value of values) { const item = nonempty(stringValue(value)); if (item !== undefined) return item; }
  return undefined;
}
function legacyNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  path: string,
  field: string,
  diagnostics: ConfigurationDiagnostic[],
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (typeof value !== 'boolean' && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  legacyPolicyWarning(path, field, diagnostics);
  return fallback;
}
function legacyInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  path: string,
  field: string,
  diagnostics: ConfigurationDiagnostic[],
  maximum = Number.POSITIVE_INFINITY,
): number {
  const parsed = legacyNumber(value, fallback, minimum, path, field, diagnostics, maximum);
  if (Number.isSafeInteger(parsed)) return parsed;
  legacyPolicyWarning(path, field, diagnostics);
  return fallback;
}
function legacyEnvironmentNumber(
  value: string | undefined,
  minimum: number,
  name: string,
  diagnostics: ConfigurationDiagnostic[],
  maximum = Number.POSITIVE_INFINITY,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  const message = `${name} was invalid and was ignored.`;
  if (!diagnostics.some((item) => item.source === 'environment' && item.message === message)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'environment', message });
  }
  return undefined;
}
function legacyPolicyWarning(path: string, field: string, diagnostics: ConfigurationDiagnostic[]): void {
  diagnostics.push({
    code: 'LEGACY_INVALID', source: 'legacy', path,
    message: `Legacy ${field} was invalid and the legacy default was used.`,
  });
}
function strictEnvironmentInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new NbSearchError('CONFIGURATION_ERROR', `${name} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return parsed;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}
