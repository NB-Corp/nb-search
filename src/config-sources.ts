import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  CONFIG_SCHEMA_VERSION, DEFAULT_PROFILE_ID, parseConfigPatch, parseResolvedConfig, stableFingerprint,
  type CanonicalConfig, type CanonicalConfigPatch, type CredentialSlotConfig, type ProviderInstancePatch,
} from './config-schema.ts';
import { NbSearchError } from './errors.ts';
import {
  DEFAULT_GMA_EFFORT, DEFAULT_GMA_MODEL, DEFAULT_GROK_MODEL, validateGmaEffort, validateGrokBaseUrl,
  validateGrokModel, validateProviderBaseUrl,
} from './providers.ts';

export interface ConfigurationDiagnostic {
  code: 'LEGACY_NOT_FOUND' | 'LEGACY_INVALID' | 'LEGACY_UNSUPPORTED' | 'SOURCE_APPLIED' | 'GATEWAY_AGGREGATE_INCOMPLETE' | 'GMA_INCOMPLETE';
  source: string;
  path?: string;
  message: string;
}

export type WorkerGrant =
  | { kind: 'environment'; name: string }
  | { kind: 'legacy-json'; path: string; key: 'exa' | 'tavily' | 'grok' | 'grokMultiAgent' | 'searchGateway' }
  | { kind: 'opaque'; id: string };

export interface SecretBinding {
  credential_slot_id: string;
  provider_id: string;
  value: string;
  worker_grant: WorkerGrant;
  inherited_from_slot_id?: string;
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
const LEGACY_GROK_TIMEOUT_SECONDS = 30;
const LEGACY_GMA_TIMEOUT_SECONDS = 240;
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
  const gmaEnvironmentRequestCapSeconds = legacyEnvironmentNumber(
    nonempty(env['SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS']), 0.1, 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS', diagnostics, 3_600,
  );
  const environment = environmentPatch(env, cwd, parseResolvedConfig(preliminary), diagnostics, gmaEnvironmentRequestCapSeconds);
  if (Object.keys(environment).length > 0) sources.push({ label: 'environment', patch: environment });
  if (options.config !== undefined) sources.push({ label: 'host', patch: parseConfigPatch(options.config, 'host configuration') });
  if (options.overrides !== undefined) sources.push({ label: 'runtime', patch: parseConfigPatch(options.overrides, 'runtime overrides') });

  const provenance = new Map<string, string>();
  let merged: unknown = {};
  for (const source of sources) merged = mergeConfig(merged, source.patch, source.label, provenance);
  materializeProviderDefaults(merged, provenance);
  materializeGmaEnvironmentRequestCap(merged, provenance, gmaEnvironmentRequestCapSeconds);
  materializeGmaEndpointInheritance(merged, provenance);
  const beforeCompatibility = parseResolvedConfig(merged);
  const preliminaryOwnSecrets = resolveConfiguredSecrets(beforeCompatibility, env, legacySecrets, provenance);
  const preliminarySecrets = materializeGmaSecretInheritance(beforeCompatibility, preliminaryOwnSecrets, provenance, diagnostics);
  addCompatibilityProfiles(merged, provenance, preliminarySecrets, diagnostics);
  const config = parseResolvedConfig(merged);
  const secrets = materializeGmaSecretInheritance(config, resolveConfiguredSecrets(config, env, legacySecrets, provenance), provenance, diagnostics);
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
        capability_policies: { 'research-light': { timeout_ms: 60_000 } },
      },
      'tavily.default': {
        provider_id: 'tavily', enabled: true, credential_slot_id: 'tavily.default',
        base_url: 'https://api.tavily.com/search', timeout_ms: 45_000, retry, options: {},
      },
      'search-gateway.aggregate': {
        provider_id: 'search-gateway', enabled: false, credential_slot_id: 'search-gateway.aggregate',
        timeout_ms: 40_000, retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 }, options: {},
      },
      'grok.default': {
        provider_id: 'grok', enabled: true, credential_slot_id: 'grok.default',
        timeout_ms: 30_000, retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 },
        options: { model: DEFAULT_GROK_MODEL },
      },
      'grok-multi-agent.default': {
        provider_id: 'grok-multi-agent', enabled: false, credential_slot_id: 'grok-multi-agent.default',
        timeout_ms: 240_000, retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 },
        options: { model: DEFAULT_GMA_MODEL, reasoning_effort: DEFAULT_GMA_EFFORT, replace_grok: false },
      },
    },
    credential_slots: {
      'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' },
      'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_TAVILY_API_KEY' },
      'search-gateway.aggregate': { provider_id: 'search-gateway', env: 'NB_SEARCH_GATEWAY_TOKEN' },
      'grok.default': { provider_id: 'grok', env: 'NB_SEARCH_GROK_API_KEY' },
      'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'NB_SEARCH_GROK_MULTI_AGENT_API_KEY' },
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
  mapLegacyGrok(value, path, providerInstances, credentialSlots, secrets, diagnostics);
  mapLegacyGma(value, path, providerInstances, credentialSlots, secrets, diagnostics);
  mapLegacyGateway(value, path, providerInstances, credentialSlots, secrets, diagnostics);
  mapLegacyPolicies(value, path, providerInstances, diagnostics);
  const patch: CanonicalConfigPatch = {};
  if (Object.keys(providerInstances).length > 0) patch.provider_instances = providerInstances;
  if (Object.keys(credentialSlots).length > 0) patch.credential_slots = credentialSlots;
  return patch;
}

function mapLegacyGma(
  value: Record<string, unknown>,
  path: string,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  secrets: Map<string, SecretBinding>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const raw = value['grokMultiAgent'];
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: 'Legacy grokMultiAgent was invalid and was ignored.' });
    return;
  }
  const recognized = ['apiUrl', 'baseUrl', 'apiBase', 'apiKey', 'model', 'reasoningEffort', 'replaceGrokWithMultiAgent']
    .some((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== '');
  if (!recognized) return;
  const instanceId = 'grok-multi-agent.default';
  const patch: ProviderInstancePatch = { enabled: true };
  const base = firstNonempty([raw['apiUrl'], raw['baseUrl'], raw['apiBase']]);
  if (base !== undefined) {
    if (isStrictGrokUrl(base)) patch.base_url = base;
    else legacyGmaWarning(path, 'grokMultiAgent URL', diagnostics);
  }
  const options: Record<string, unknown> = {};
  const model = nonempty(stringValue(raw['model']));
  if (model !== undefined) {
    if (isStrictGrokModel(model)) options['model'] = model;
    else legacyGmaWarning(path, 'grokMultiAgent.model', diagnostics);
  } else if (raw['model'] !== undefined && raw['model'] !== '') legacyGmaWarning(path, 'grokMultiAgent.model', diagnostics);
  const effort = nonempty(stringValue(raw['reasoningEffort']));
  if (effort !== undefined) {
    if (isGmaEffort(effort)) options['reasoning_effort'] = effort;
    else legacyGmaWarning(path, 'grokMultiAgent.reasoningEffort', diagnostics);
  } else if (raw['reasoningEffort'] !== undefined && raw['reasoningEffort'] !== '') legacyGmaWarning(path, 'grokMultiAgent.reasoningEffort', diagnostics);
  if (raw['replaceGrokWithMultiAgent'] !== undefined) {
    const replacement = legacyBoolean(raw['replaceGrokWithMultiAgent']);
    if (replacement === undefined) legacyGmaWarning(path, 'grokMultiAgent.replaceGrokWithMultiAgent', diagnostics);
    else options['replace_grok'] = replacement;
  }
  if (Object.keys(options).length > 0) patch.options = options;
  instances[instanceId] = { ...instances[instanceId], ...patch };
  const credential = nonempty(stringValue(raw['apiKey']));
  if (credential !== undefined && credential.length <= 8192) {
    slots[instanceId] = { provider_id: 'grok-multi-agent', worker_grant: 'legacy:grokMultiAgent' };
    secrets.set(instanceId, {
      credential_slot_id: instanceId, provider_id: 'grok-multi-agent', value: credential,
      worker_grant: { kind: 'legacy-json', path, key: 'grokMultiAgent' },
    });
  } else if (raw['apiKey'] !== undefined && raw['apiKey'] !== '') legacyGmaWarning(path, 'grokMultiAgent.apiKey', diagnostics);
}

function mapLegacyGateway(
  value: Record<string, unknown>,
  path: string,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  secrets: Map<string, SecretBinding>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const raw = value['searchGateway'];
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: 'Legacy searchGateway was invalid and was ignored.' });
    return;
  }
  const instanceId = 'search-gateway.aggregate';
  const patch: ProviderInstancePatch = {};
  const base = firstNonempty([raw['baseUrl'], raw['apiUrl'], raw['apiBase']]);
  if (base !== undefined) {
    if (isStrictHttpUrl(base)) patch.base_url = base;
    else legacyGatewayWarning(path, 'searchGateway base URL', diagnostics);
  }
  if (raw['aggregate'] !== undefined) {
    const enabled = legacyBoolean(raw['aggregate']);
    if (enabled === undefined) legacyGatewayWarning(path, 'searchGateway.aggregate', diagnostics);
    else patch.enabled = enabled;
  }
  if (raw['profile'] !== undefined) {
    const profile = boundedProfile(raw['profile']);
    if (profile === undefined) legacyGatewayWarning(path, 'searchGateway.profile', diagnostics);
    else patch.options = { downstream_profile: profile };
  }
  instances[instanceId] = { ...instances[instanceId], ...patch };
  const token = firstNonempty([raw['token'], raw['apiKey']]);
  if (token !== undefined) {
    slots[instanceId] = { provider_id: 'search-gateway', worker_grant: 'legacy:searchGateway' };
    secrets.set(instanceId, {
      credential_slot_id: instanceId, provider_id: 'search-gateway', value: token,
      worker_grant: { kind: 'legacy-json', path, key: 'searchGateway' },
    });
  }
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

function mapLegacyGrok(
  value: Record<string, unknown>,
  path: string,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  secrets: Map<string, SecretBinding>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const raw = value['grok'];
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: 'Legacy grok was invalid and was ignored.' });
    return;
  }
  const patch: ProviderInstancePatch = {};
  const base = nonempty(stringValue(raw['apiUrl']));
  if (base !== undefined) {
    if (isStrictGrokUrl(base)) patch.base_url = base;
    else legacyGrokWarning(path, 'grok.apiUrl', diagnostics);
  } else if (raw['apiUrl'] !== undefined && (typeof raw['apiUrl'] !== 'string' || raw['apiUrl'].trim() !== '')) {
    legacyGrokWarning(path, 'grok.apiUrl', diagnostics);
  }
  const model = nonempty(stringValue(raw['model']));
  if (model !== undefined) {
    if (isStrictGrokModel(model)) patch.options = { model };
    else legacyGrokWarning(path, 'grok.model', diagnostics);
  } else if (raw['model'] !== undefined && (typeof raw['model'] !== 'string' || raw['model'].trim() !== '')) {
    legacyGrokWarning(path, 'grok.model', diagnostics);
  }
  if (Object.keys(patch).length > 0) instances['grok.default'] = { ...instances['grok.default'], ...patch };
  const credential = nonempty(stringValue(raw['apiKey']));
  if (credential === undefined) {
    if (raw['apiKey'] !== undefined && (typeof raw['apiKey'] !== 'string' || raw['apiKey'].trim() !== '')) {
      legacyGrokWarning(path, 'grok.apiKey', diagnostics);
    }
    return;
  }
  if (credential.length > 8192) {
    legacyGrokWarning(path, 'grok.apiKey', diagnostics);
    return;
  }
  slots['grok.default'] = { provider_id: 'grok', worker_grant: 'legacy:grok' };
  secrets.set('grok.default', {
    credential_slot_id: 'grok.default', provider_id: 'grok', value: credential,
    worker_grant: { kind: 'legacy-json', path, key: 'grok' },
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
  const researchLightTimeoutSeconds = legacyNumber(
    providerTimeouts['exaResearchLight'], 60, 0.1,
    path, 'searchLayer.providerTimeouts.exaResearchLight', diagnostics, 3_600,
  );
  instances['exa.default'] = {
    ...instances['exa.default'],
    capability_policies: {
      ...instances['exa.default']?.capability_policies,
      'research-light': { timeout_ms: Math.round(Math.min(requestTimeoutSeconds, researchLightTimeoutSeconds) * 1000) },
    },
  };
  const grokTimeoutSeconds = legacyNumber(
    providerTimeouts['grok'], LEGACY_GROK_TIMEOUT_SECONDS, 0.1,
    path, 'searchLayer.providerTimeouts.grok', diagnostics, 3_600,
  );
  instances['grok.default'] = {
    ...instances['grok.default'],
    timeout_ms: Math.round(Math.min(requestTimeoutSeconds, grokTimeoutSeconds) * 1000),
    retry: { max_attempts: maxAttempts, backoff_ms: Math.round(backoffMs) },
  };
  const rawGmaTimeout = providerTimeouts['grokMultiAgent'];
  const gmaTimeoutSeconds = legacyNumber(
    rawGmaTimeout, LEGACY_GMA_TIMEOUT_SECONDS, 0.1,
    path, 'searchLayer.providerTimeouts.grokMultiAgent', diagnostics, 3_600,
  );
  const explicitRequestTimeout = legacyOptionalNumber(searchLayer['requestTimeoutSeconds'], 0.1, path, 'searchLayer.requestTimeoutSeconds', diagnostics, 3_600);
  instances['grok-multi-agent.default'] = {
    ...instances['grok-multi-agent.default'],
    timeout_ms: Math.round(Math.min(gmaTimeoutSeconds, explicitRequestTimeout ?? Number.POSITIVE_INFINITY) * 1000),
    retry: { max_attempts: maxAttempts, backoff_ms: Math.round(backoffMs) },
  };
  const gatewayTimeoutSeconds = legacyNumber(
    providerTimeouts['searchGateway'], 40, 0.1,
    path, 'searchLayer.providerTimeouts.searchGateway', diagnostics, 3_600,
  );
  instances['search-gateway.aggregate'] = {
    ...instances['search-gateway.aggregate'],
    timeout_ms: Math.round(Math.min(requestTimeoutSeconds, gatewayTimeoutSeconds) * 1000),
    retry: { max_attempts: maxAttempts, backoff_ms: Math.round(backoffMs) },
  };
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
  gmaRequestCapSeconds: number | undefined,
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
  mapEnvironmentResearchLightPolicy(env, base, instances, diagnostics);
  mapEnvironmentGrok(env, base, instances, slots, diagnostics);
  mapEnvironmentGma(env, instances, slots, diagnostics, gmaRequestCapSeconds);
  mapEnvironmentGateway(env, base, instances, slots, diagnostics);
  mapEnvironmentRetry(env, instances);
  if (Object.keys(instances).length > 0) patch.provider_instances = instances;
  if (Object.keys(slots).length > 0) patch.credential_slots = slots;
  return patch;
}

function mapEnvironmentResearchLightPolicy(
  env: NodeJS.ProcessEnv,
  base: CanonicalConfig,
  instances: Record<string, ProviderInstancePatch>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const primary = nonempty(env['NB_SEARCH_EXA_RESEARCH_LIGHT_TIMEOUT_MS']);
  const alias = nonempty(env['SEARCH_LAYER_EXA_RESEARCH_LIGHT_TIMEOUT_SECONDS']);
  const request = nonempty(env['SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS']);
  let timeoutMs: number | undefined;
  if (primary !== undefined) timeoutMs = strictEnvironmentInteger(primary, 'NB_SEARCH_EXA_RESEARCH_LIGHT_TIMEOUT_MS', 100, 3_600_000);
  else if (alias !== undefined || request !== undefined) {
    const capabilitySeconds = legacyEnvironmentNumber(alias, 0.1, 'SEARCH_LAYER_EXA_RESEARCH_LIGHT_TIMEOUT_SECONDS', diagnostics, 3_600);
    const requestSeconds = legacyEnvironmentNumber(request, 0.1, 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS', diagnostics, 3_600);
    const inherited = base.provider_instances['exa.default']?.capability_policies?.['research-light']?.timeout_ms ?? 60_000;
    timeoutMs = capabilitySeconds === undefined
      ? requestSeconds === undefined ? inherited : Math.min(inherited, Math.round(requestSeconds * 1000))
      : Math.round(Math.min(capabilitySeconds, requestSeconds ?? Number.POSITIVE_INFINITY) * 1000);
  }
  if (timeoutMs === undefined) return;
  instances['exa.default'] = {
    ...instances['exa.default'],
    capability_policies: {
      ...instances['exa.default']?.capability_policies,
      'research-light': { ...instances['exa.default']?.capability_policies?.['research-light'], timeout_ms: timeoutMs },
    },
  };
}

function mapEnvironmentGrok(
  env: NodeJS.ProcessEnv,
  base: CanonicalConfig,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const instanceId = 'grok.default';
  const patch: ProviderInstancePatch = { ...instances[instanceId] };
  const primaryBase = nonempty(env['NB_SEARCH_GROK_BASE_URL']);
  const aliasBase = nonempty(env['GROK_API_URL']);
  if (primaryBase !== undefined) {
    if (!isStrictGrokUrl(primaryBase)) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_BASE_URL is invalid.');
    patch.base_url = primaryBase;
  } else if (aliasBase !== undefined) {
    if (isStrictGrokUrl(aliasBase)) patch.base_url = aliasBase;
    else environmentLegacyWarning('GROK_API_URL', diagnostics);
  }
  const primaryModel = nonempty(env['NB_SEARCH_GROK_MODEL']);
  const aliasModel = nonempty(env['GROK_MODEL']);
  if (primaryModel !== undefined) {
    if (!isStrictGrokModel(primaryModel)) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_MODEL is invalid.');
    patch.options = { ...patch.options, model: primaryModel };
  } else if (aliasModel !== undefined) {
    if (isStrictGrokModel(aliasModel)) patch.options = { ...patch.options, model: aliasModel };
    else environmentLegacyWarning('GROK_MODEL', diagnostics);
  }
  const primaryKey = nonempty(env['NB_SEARCH_GROK_API_KEY']);
  const aliasKey = nonempty(env['GROK_API_KEY']);
  if (primaryKey !== undefined) {
    if (primaryKey.length > 8192) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_API_KEY is invalid.');
    patch.credential_slot_id = instanceId;
    slots[instanceId] = { provider_id: 'grok', env: 'NB_SEARCH_GROK_API_KEY' };
  } else if (aliasKey !== undefined) {
    if (aliasKey.length <= 8192) {
      patch.credential_slot_id = instanceId;
      slots[instanceId] = { provider_id: 'grok', env: 'GROK_API_KEY' };
    } else environmentLegacyWarning('GROK_API_KEY', diagnostics);
  }
  const primaryTimeout = nonempty(env['NB_SEARCH_GROK_TIMEOUT_MS']);
  const aliasTimeout = nonempty(env['SEARCH_LAYER_GROK_TIMEOUT_SECONDS']);
  const requestTimeout = nonempty(env['SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS']);
  if (primaryTimeout !== undefined) {
    patch.timeout_ms = strictEnvironmentInteger(primaryTimeout, 'NB_SEARCH_GROK_TIMEOUT_MS', 100, 3_600_000);
  } else if (aliasTimeout !== undefined || requestTimeout !== undefined) {
    const providerSeconds = legacyEnvironmentNumber(aliasTimeout, 0.1, 'SEARCH_LAYER_GROK_TIMEOUT_SECONDS', diagnostics, 3_600);
    const requestSeconds = legacyEnvironmentNumber(requestTimeout, 0.1, 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS', diagnostics, 3_600);
    const inherited = base.provider_instances[instanceId]?.timeout_ms ?? 30_000;
    patch.timeout_ms = providerSeconds === undefined
      ? requestSeconds === undefined ? inherited : Math.min(inherited, Math.round(requestSeconds * 1000))
      : Math.round(Math.min(providerSeconds, requestSeconds ?? Number.POSITIVE_INFINITY) * 1000);
  }
  if (Object.keys(patch).length > 0) instances[instanceId] = patch;
}

function mapEnvironmentGma(
  env: NodeJS.ProcessEnv,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  diagnostics: ConfigurationDiagnostic[],
  requestCapSeconds: number | undefined,
): void {
  const instanceId = 'grok-multi-agent.default';
  const patch: ProviderInstancePatch = { ...instances[instanceId] };
  const environmentNames = [
    'NB_SEARCH_GROK_MULTI_AGENT_ENABLED', 'NB_SEARCH_GROK_MULTI_AGENT_BASE_URL', 'NB_SEARCH_GROK_MULTI_AGENT_API_KEY',
    'NB_SEARCH_GROK_MULTI_AGENT_MODEL', 'GROK_MULTI_AGENT_MODEL', 'NB_SEARCH_GROK_MULTI_AGENT_EFFORT',
    'GROK_MULTI_AGENT_EFFORT', 'NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK', 'GROK_MULTI_AGENT_REPLACE',
    'NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS', 'SEARCH_LAYER_GROK_MULTI_AGENT_TIMEOUT_SECONDS',
  ] as const;
  const hasSignal = environmentNames.some((name) => nonempty(env[name]) !== undefined);
  if (!hasSignal) return;
  const explicitEnabled = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_ENABLED']);
  patch.enabled = explicitEnabled === undefined ? true : strictEnvironmentBoolean(explicitEnabled, 'NB_SEARCH_GROK_MULTI_AGENT_ENABLED');
  const primaryBase = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_BASE_URL']);
  if (primaryBase !== undefined) {
    if (!isStrictGrokUrl(primaryBase)) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_MULTI_AGENT_BASE_URL is invalid.');
    patch.base_url = primaryBase;
  }
  const options: Record<string, unknown> = { ...patch.options };
  const primaryModel = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_MODEL']);
  const aliasModel = nonempty(env['GROK_MULTI_AGENT_MODEL']);
  if (primaryModel !== undefined) {
    if (!isStrictGrokModel(primaryModel)) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_MULTI_AGENT_MODEL is invalid.');
    options['model'] = primaryModel;
  } else if (aliasModel !== undefined) {
    if (isStrictGrokModel(aliasModel)) options['model'] = aliasModel;
    else environmentLegacyWarning('GROK_MULTI_AGENT_MODEL', diagnostics);
  }
  const primaryEffort = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_EFFORT']);
  const aliasEffort = nonempty(env['GROK_MULTI_AGENT_EFFORT']);
  if (primaryEffort !== undefined) {
    if (!isGmaEffort(primaryEffort)) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_MULTI_AGENT_EFFORT is invalid.');
    options['reasoning_effort'] = primaryEffort;
  } else if (aliasEffort !== undefined) {
    if (isGmaEffort(aliasEffort)) options['reasoning_effort'] = aliasEffort;
    else environmentLegacyWarning('GROK_MULTI_AGENT_EFFORT', diagnostics);
  }
  const primaryReplace = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK']);
  const aliasReplace = nonempty(env['GROK_MULTI_AGENT_REPLACE']);
  if (primaryReplace !== undefined) options['replace_grok'] = strictEnvironmentBoolean(primaryReplace, 'NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK');
  else if (aliasReplace !== undefined) {
    const parsed = legacyBoolean(aliasReplace);
    if (parsed === undefined) environmentLegacyWarning('GROK_MULTI_AGENT_REPLACE', diagnostics);
    else options['replace_grok'] = parsed;
  }
  patch.options = options;
  const primaryKey = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_API_KEY']);
  if (primaryKey !== undefined) {
    if (primaryKey.length > 8192) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GROK_MULTI_AGENT_API_KEY is invalid.');
    patch.credential_slot_id = instanceId;
    slots[instanceId] = { provider_id: 'grok-multi-agent', env: 'NB_SEARCH_GROK_MULTI_AGENT_API_KEY' };
  }
  const primaryTimeout = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS']);
  const aliasTimeout = nonempty(env['SEARCH_LAYER_GROK_MULTI_AGENT_TIMEOUT_SECONDS']);
  if (primaryTimeout !== undefined) patch.timeout_ms = strictEnvironmentInteger(primaryTimeout, 'NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS', 100, 3_600_000);
  else if (aliasTimeout !== undefined) {
    const providerSeconds = legacyEnvironmentNumber(aliasTimeout, 0.1, 'SEARCH_LAYER_GROK_MULTI_AGENT_TIMEOUT_SECONDS', diagnostics, 3_600);
    if (providerSeconds !== undefined) patch.timeout_ms = Math.round(Math.min(providerSeconds, requestCapSeconds ?? Number.POSITIVE_INFINITY) * 1000);
  }
  instances[instanceId] = patch;
}

function mapEnvironmentGateway(
  env: NodeJS.ProcessEnv,
  base: CanonicalConfig,
  instances: Record<string, ProviderInstancePatch>,
  slots: Record<string, CredentialSlotConfig>,
  diagnostics: ConfigurationDiagnostic[],
): void {
  const instanceId = 'search-gateway.aggregate';
  const patch: ProviderInstancePatch = { ...instances[instanceId] };
  const primaryBase = nonempty(env['NB_SEARCH_GATEWAY_BASE_URL']);
  const aliasBase = nonempty(env['SEARCH_GATEWAY_BASE_URL']);
  const gatewayBase = primaryBase ?? aliasBase;
  if (gatewayBase !== undefined) {
    if (!isStrictHttpUrl(gatewayBase)) {
      if (primaryBase !== undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GATEWAY_BASE_URL must be an HTTP(S) URL without user info, query, or fragment.');
      diagnostics.push({ code: 'LEGACY_INVALID', source: 'environment', message: 'SEARCH_GATEWAY_BASE_URL was invalid and was ignored.' });
    } else patch.base_url = gatewayBase;
  }
  const primaryToken = nonempty(env['NB_SEARCH_GATEWAY_TOKEN']);
  const aliasToken = nonempty(env['SEARCH_GATEWAY_TOKEN']);
  if (primaryToken !== undefined || aliasToken !== undefined) {
    const name = primaryToken !== undefined ? 'NB_SEARCH_GATEWAY_TOKEN' : 'SEARCH_GATEWAY_TOKEN';
    patch.credential_slot_id = instanceId;
    slots[instanceId] = { provider_id: 'search-gateway', env: name };
  }
  const primaryAggregate = nonempty(env['NB_SEARCH_GATEWAY_AGGREGATE']);
  const aliasAggregate = nonempty(env['SEARCH_GATEWAY_AGGREGATE']);
  if (primaryAggregate !== undefined) patch.enabled = strictEnvironmentBoolean(primaryAggregate, 'NB_SEARCH_GATEWAY_AGGREGATE');
  else if (aliasAggregate !== undefined) {
    const enabled = legacyBoolean(aliasAggregate);
    if (enabled === undefined) diagnostics.push({ code: 'LEGACY_INVALID', source: 'environment', message: 'SEARCH_GATEWAY_AGGREGATE was invalid and was ignored.' });
    else patch.enabled = enabled;
  }
  const primaryProfile = nonempty(env['NB_SEARCH_GATEWAY_PROFILE']);
  const aliasProfile = nonempty(env['SEARCH_GATEWAY_PROFILE']);
  const profileInput = primaryProfile ?? aliasProfile;
  if (profileInput !== undefined) {
    const profile = boundedProfile(profileInput);
    if (profile === undefined) {
      if (primaryProfile !== undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_GATEWAY_PROFILE must contain 1 to 256 characters.');
      diagnostics.push({ code: 'LEGACY_INVALID', source: 'environment', message: 'SEARCH_GATEWAY_PROFILE was invalid and was ignored.' });
    } else patch.options = { ...patch.options, downstream_profile: profile };
  }
  const primaryTimeout = nonempty(env['NB_SEARCH_GATEWAY_TIMEOUT_MS']);
  const aliasTimeout = nonempty(env['SEARCH_LAYER_SEARCH_GATEWAY_TIMEOUT_SECONDS']);
  if (primaryTimeout !== undefined) patch.timeout_ms = strictEnvironmentInteger(primaryTimeout, 'NB_SEARCH_GATEWAY_TIMEOUT_MS', 100, 3_600_000);
  else if (aliasTimeout !== undefined || nonempty(env['SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS']) !== undefined) {
    const providerSeconds = legacyEnvironmentNumber(aliasTimeout, 0.1, 'SEARCH_LAYER_SEARCH_GATEWAY_TIMEOUT_SECONDS', diagnostics, 3_600);
    const requestSeconds = legacyEnvironmentNumber(nonempty(env['SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS']), 0.1, 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS', diagnostics, 3_600);
    if (providerSeconds !== undefined) patch.timeout_ms = Math.round(Math.min(providerSeconds, requestSeconds ?? Number.POSITIVE_INFINITY) * 1000);
    else if (requestSeconds !== undefined) patch.timeout_ms = Math.min(base.provider_instances[instanceId]?.timeout_ms ?? 40_000, Math.round(requestSeconds * 1000));
  }
  if (Object.keys(patch).length > 0) instances[instanceId] = patch;
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
  for (const instanceId of ['exa.default', 'tavily.default', 'grok.default', 'grok-multi-agent.default', 'search-gateway.aggregate'] as const) {
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
  const activeGma = config.provider_instances['grok-multi-agent.default'];
  const directGrokSlot = config.provider_instances['grok.default']?.credential_slot_id;
  if (activeGma?.enabled === true && directGrokSlot !== undefined) activeSlotIds.add(directGrokSlot);
  for (const slotId of [...activeSlotIds].sort()) {
    const slot = config.credential_slots[slotId];
    if (slot === undefined) continue;
    if (slot.env !== undefined) {
      const value = nonempty(env[slot.env]);
      if (value !== undefined) {
        if ((slot.provider_id === 'grok' || slot.provider_id === 'grok-multi-agent') && value.length > 8192) {
          throw new NbSearchError('CONFIGURATION_ERROR', `Credential grant is invalid for slot ${slotId}.`);
        }
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

function addCompatibilityProfiles(
  value: unknown,
  provenance: Map<string, string>,
  secrets: SecretBindings,
  diagnostics: ConfigurationDiagnostic[],
): void {
  if (!isRecord(value) || !isRecord(value['profiles']) || !isRecord(value['provider_instances'])) return;
  const profiles = value['profiles'];
  const providerInstances = value['provider_instances'];
  const direct = (['exa.default', 'tavily.default'] as const).filter((instanceId) => isRecord(providerInstances[instanceId]));
  const grok = isRecord(providerInstances['grok.default']) ? providerInstances['grok.default'] : undefined;
  const gma = isRecord(providerInstances['grok-multi-agent.default']) ? providerInstances['grok-multi-agent.default'] : undefined;
  const gmaActive = gma?.['provider_id'] === 'grok-multi-agent' && gma['enabled'] === true;
  const gateway = isRecord(providerInstances['search-gateway.aggregate'])
    ? providerInstances['search-gateway.aggregate'] : undefined;
  const requested = gateway?.['enabled'] === true;
  const base = typeof gateway?.['base_url'] === 'string' ? gateway['base_url'] : undefined;
  if (base !== undefined) validateProviderBaseUrl(base);
  const active = requested && base !== undefined && secrets.has('search-gateway.aggregate');
  const grokSlotId = typeof grok?.['credential_slot_id'] === 'string' ? grok['credential_slot_id'] : undefined;
  const grokCredential = grokSlotId === undefined ? undefined : secrets.get(grokSlotId);
  const grokReady = grok?.['provider_id'] === 'grok'
    && grok['enabled'] === true
    && typeof grok['base_url'] === 'string'
    && isStrictGrokUrl(grok['base_url'])
    && isRecord(grok['options'])
    && isStrictGrokModel(grok['options']['model'])
    && grokCredential !== undefined
    && grokCredential.credential_slot_id === grokSlotId
    && grokCredential.provider_id === 'grok';
  if (requested && !active) {
    diagnostics.push({
      code: 'GATEWAY_AGGREGATE_INCOMPLETE', source: 'compatibility',
      path: 'provider_instances.search-gateway.aggregate',
      message: 'Aggregate cutover is enabled but its endpoint or credential is unavailable; direct compatibility profiles remain selected.',
    });
  }
  for (const profileId of ['default', 'deep', 'fast'] as const) {
    const owner = provenance.get(`profiles.${profileId}`);
    if (owner !== undefined && owner !== 'defaults' && !owner.startsWith('compatibility')) continue;
    if (active) {
      const retrieval = ['search-gateway.aggregate', ...(grokReady ? ['grok.default'] : [])];
      const stages: Array<Record<string, unknown>> = [{
        kind: profileId === 'fast' ? 'fallback' : 'parallel',
        invocations: profileId === 'fast'
          ? retrieval.map((instanceId, index) => ({ provider_instance_id: instanceId, capability: 'retrieval', role: index > 0 ? 'fallback' : 'primary', trigger: index > 0 ? 'empty_or_failure' : 'always' }))
          : [
            { provider_instance_id: 'search-gateway.aggregate', capability: 'retrieval', role: 'primary', trigger: 'always' },
            ...(grok !== undefined && (grokReady || gmaActive) ? [{ provider_instance_id: 'grok.default', capability: 'retrieval', role: 'primary', trigger: 'always', when: { intent_not_in: ['factual', 'tutorial'], multi_agent_route_in: ['none', 'overlay'] } }] : []),
            ...(isRecord(providerInstances['tavily.default']) ? [{ provider_instance_id: 'tavily.default', capability: 'answer', role: 'answer', trigger: 'routing:answer-intent', when: { intent_in: ['factual', 'tutorial'] }, failure_policy: 'affects-state', execution_scope: 'once-per-job' }] : []),
            ...(profileId === 'deep' && gmaActive ? [{ provider_instance_id: 'grok-multi-agent.default', capability: 'multi-agent-research', role: 'primary_synthesis', trigger: 'routing:async-deep-analysis', when: { intent_in: ['status', 'comparison', 'exploratory', 'news'], execution_in: ['research-job'], multi_agent_route_in: ['replacement', 'overlay'] }, failure_policy: 'affects-state', execution_scope: 'once-per-job' }] : []),
          ],
      }];
      if (profileId === 'deep' && isRecord(providerInstances['exa.default'])) stages.push({
        kind: 'augmentation', invocations: [{ provider_instance_id: 'exa.default', capability: 'research-light', role: 'augmentation', trigger: 'routing:deep-analysis-intent', when: { intent_in: ['status', 'comparison', 'exploratory', 'news'], multi_agent_route_in: ['none'] }, failure_policy: 'report-only', execution_scope: 'once-per-job' }],
      });
      profiles[profileId] = { stages };
      provenance.set(`profiles.${profileId}`, grokReady ? 'compatibility:search-gateway-grok' : 'compatibility:search-gateway');
    } else if (direct.length > 0) {
      const invocations = [...direct, ...(grokReady ? ['grok.default'] : [])];
      const firstExecutable = invocations.findIndex((instanceId) => instanceId === 'grok.default'
        ? grokReady
        : compatibilityCredentialReady(
          providerInstances[instanceId], instanceId === 'exa.default' ? 'exa' : 'tavily', secrets,
        ));
      const primaryIndex = firstExecutable < 0 ? 0 : firstExecutable;
      const stages: Array<Record<string, unknown>> = [{
        kind: profileId === 'fast' ? 'fallback' : 'parallel',
        invocations: profileId === 'fast'
          ? invocations.map((instanceId, index) => ({ provider_instance_id: instanceId, capability: 'retrieval', role: index !== primaryIndex ? 'fallback' : 'primary', trigger: index !== primaryIndex ? 'empty_or_failure' : 'always' }))
          : [
            ...(isRecord(providerInstances['exa.default']) ? [{ provider_instance_id: 'exa.default', capability: 'retrieval', role: 'primary', trigger: 'always' }] : []),
            ...(isRecord(providerInstances['tavily.default']) ? [
              { provider_instance_id: 'tavily.default', capability: 'retrieval', role: 'primary', trigger: 'always', when: { intent_not_in: ['factual', 'tutorial'] } },
            ] : []),
            ...(grok !== undefined && (grokReady || gmaActive) ? [{ provider_instance_id: 'grok.default', capability: 'retrieval', role: 'primary', trigger: 'always', when: { intent_not_in: ['factual', 'tutorial'], multi_agent_route_in: ['none', 'overlay'] } }] : []),
            ...(isRecord(providerInstances['tavily.default']) ? [{ provider_instance_id: 'tavily.default', capability: 'answer', role: 'answer', trigger: 'routing:answer-intent', when: { intent_in: ['factual', 'tutorial'] }, failure_policy: 'affects-state', execution_scope: 'once-per-job' }] : []),
            ...(profileId === 'deep' && gmaActive ? [{ provider_instance_id: 'grok-multi-agent.default', capability: 'multi-agent-research', role: 'primary_synthesis', trigger: 'routing:async-deep-analysis', when: { intent_in: ['status', 'comparison', 'exploratory', 'news'], execution_in: ['research-job'], multi_agent_route_in: ['replacement', 'overlay'] }, failure_policy: 'affects-state', execution_scope: 'once-per-job' }] : []),
          ],
      }];
      if (profileId === 'deep' && isRecord(providerInstances['exa.default'])) stages.push({
        kind: 'augmentation', invocations: [{ provider_instance_id: 'exa.default', capability: 'research-light', role: 'augmentation', trigger: 'routing:deep-analysis-intent', when: { intent_in: ['status', 'comparison', 'exploratory', 'news'], multi_agent_route_in: ['none'] }, failure_policy: 'report-only', execution_scope: 'once-per-job' }],
      });
      profiles[profileId] = { stages };
      provenance.set(`profiles.${profileId}`, grokReady ? 'compatibility:direct-grok' : 'compatibility:direct');
    }
  }
}

function compatibilityCredentialReady(
  value: unknown,
  providerId: string,
  secrets: SecretBindings,
): boolean {
  if (!isRecord(value) || value['provider_id'] !== providerId || value['enabled'] !== true
    || typeof value['credential_slot_id'] !== 'string') return false;
  const credential = secrets.get(value['credential_slot_id']);
  return credential?.credential_slot_id === value['credential_slot_id'] && credential.provider_id === providerId;
}

function materializeProviderDefaults(value: unknown, provenance: Map<string, string>): void {
  if (!isRecord(value) || !isRecord(value['provider_instances'])) return;
  for (const [instanceId, instance] of Object.entries(value['provider_instances'])) {
    if (!isRecord(instance) || (instance['provider_id'] !== 'grok' && instance['provider_id'] !== 'grok-multi-agent')) continue;
    const options = isRecord(instance['options']) ? instance['options'] : {};
    if (options['model'] === undefined) {
      options['model'] = instance['provider_id'] === 'grok' ? DEFAULT_GROK_MODEL : DEFAULT_GMA_MODEL;
      provenance.set(`provider_instances.${instanceId}.options.model`, instance['provider_id'] === 'grok' ? 'compatibility:grok-model-default' : 'compatibility:gma-default');
    }
    if (instance['provider_id'] === 'grok-multi-agent') {
      if (options['reasoning_effort'] === undefined) options['reasoning_effort'] = DEFAULT_GMA_EFFORT;
      if (options['replace_grok'] === undefined) options['replace_grok'] = false;
    }
    instance['options'] = options;
  }
}

function materializeGmaEnvironmentRequestCap(
  value: unknown,
  provenance: Map<string, string>,
  requestCapSeconds: number | undefined,
): void {
  if (requestCapSeconds === undefined || !isRecord(value) || !isRecord(value['provider_instances'])) return;
  const gma = value['provider_instances']['grok-multi-agent.default'];
  if (!isRecord(gma) || gma['provider_id'] !== 'grok-multi-agent' || gma['enabled'] !== true) return;
  const timeoutOwner = provenance.get('provider_instances.grok-multi-agent.default.timeout_ms');
  if (timeoutOwner === 'environment' || timeoutOwner === 'host' || timeoutOwner === 'runtime') return;
  if (typeof gma['timeout_ms'] !== 'number') return;
  gma['timeout_ms'] = Math.min(gma['timeout_ms'], Math.round(requestCapSeconds * 1000));
  provenance.set('provider_instances.grok-multi-agent.default.timeout_ms', 'environment:request-cap');
}

function materializeGmaEndpointInheritance(value: unknown, provenance: Map<string, string>): void {
  if (!isRecord(value) || !isRecord(value['provider_instances'])) return;
  const gma = value['provider_instances']['grok-multi-agent.default'];
  const grok = value['provider_instances']['grok.default'];
  if (!isRecord(gma) || gma['provider_id'] !== 'grok-multi-agent' || gma['enabled'] !== true || gma['base_url'] !== undefined) return;
  if (!isRecord(grok) || typeof grok['base_url'] !== 'string' || !isStrictGrokUrl(grok['base_url'])) return;
  gma['base_url'] = grok['base_url'];
  provenance.set('provider_instances.grok-multi-agent.default.base_url', 'compatibility:inherited-grok-endpoint');
}

function materializeGmaSecretInheritance(
  config: CanonicalConfig,
  ownSecrets: Map<string, SecretBinding>,
  provenance: ReadonlyMap<string, string>,
  diagnostics: ConfigurationDiagnostic[],
): Map<string, SecretBinding> {
  const gma = config.provider_instances['grok-multi-agent.default'];
  if (gma?.provider_id !== 'grok-multi-agent' || !gma.enabled || ownSecrets.has('grok-multi-agent.default')) return ownSecrets;
  const slotOwner = provenance.get('credential_slots.grok-multi-agent.default');
  if (slotOwner !== 'defaults' && slotOwner !== 'legacy' && slotOwner?.startsWith('compatibility:') !== true) {
    if (!diagnostics.some((item) => item.code === 'GMA_INCOMPLETE')) diagnostics.push({
      code: 'GMA_INCOMPLETE', source: 'compatibility', path: 'credential_slots.grok-multi-agent.default',
      message: 'Grok multi-agent is active but its explicit credential slot is unresolved.',
    });
    return ownSecrets;
  }
  const grok = config.provider_instances['grok.default'];
  const sourceSlotId = grok?.credential_slot_id;
  const source = sourceSlotId === undefined ? undefined : ownSecrets.get(sourceSlotId);
  if (source === undefined) return ownSecrets;
  ownSecrets.set('grok-multi-agent.default', {
    credential_slot_id: 'grok-multi-agent.default', provider_id: 'grok-multi-agent', value: source.value,
    worker_grant: structuredClone(source.worker_grant), inherited_from_slot_id: source.credential_slot_id,
  });
  return ownSecrets;
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
function legacyOptionalNumber(
  value: unknown,
  minimum: number,
  path: string,
  field: string,
  diagnostics: ConfigurationDiagnostic[],
  maximum = Number.POSITIVE_INFINITY,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (typeof value !== 'boolean' && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  legacyPolicyWarning(path, field, diagnostics);
  return undefined;
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
  const message = `Legacy ${field} was invalid and the legacy default was used.`;
  if (!diagnostics.some((item) => item.code === 'LEGACY_INVALID' && item.source === 'legacy' && item.path === path && item.message === message)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message });
  }
}
function strictEnvironmentInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new NbSearchError('CONFIGURATION_ERROR', `${name} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return parsed;
}
function strictEnvironmentBoolean(value: string, name: string): boolean {
  const parsed = legacyBoolean(value);
  if (parsed === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `${name} must be true or false.`);
  return parsed;
}
function legacyBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}
function boundedProfile(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const profile = value.trim();
  return profile === '' || profile.length > 256 ? undefined : profile;
}
function legacyGatewayWarning(path: string, field: string, diagnostics: ConfigurationDiagnostic[]): void {
  diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: `Legacy ${field} was invalid and was ignored.` });
}
function legacyGrokWarning(path: string, field: string, diagnostics: ConfigurationDiagnostic[]): void {
  diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: `Legacy ${field} was invalid and was ignored.` });
}
function legacyGmaWarning(path: string, field: string, diagnostics: ConfigurationDiagnostic[]): void {
  diagnostics.push({ code: 'LEGACY_INVALID', source: 'legacy', path, message: `Legacy ${field} was invalid and was ignored.` });
}
function environmentLegacyWarning(name: string, diagnostics: ConfigurationDiagnostic[]): void {
  const message = `${name} was invalid and was ignored.`;
  if (!diagnostics.some((item) => item.source === 'environment' && item.message === message)) {
    diagnostics.push({ code: 'LEGACY_INVALID', source: 'environment', message });
  }
}
function isStrictGrokUrl(value: string): boolean {
  try { validateGrokBaseUrl(value); return true; } catch { return false; }
}
function isStrictGrokModel(value: unknown): value is string {
  try { validateGrokModel(value); return true; } catch { return false; }
}
function isGmaEffort(value: unknown): value is 'low' | 'medium' | 'high' | 'xhigh' {
  try { validateGmaEffort(value); return true; } catch { return false; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}
function isStrictHttpUrl(value: string): boolean {
  try { validateProviderBaseUrl(value); return true; } catch { return false; }
}
