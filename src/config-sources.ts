import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CONFIG_SCHEMA_VERSION, parseConfigPatch, parseResolvedConfig, stableFingerprint, type CanonicalConfig, type CanonicalConfigPatch, type ProviderInstanceConfig } from './config-schema.ts';
import { NbSearchError } from './errors.ts';
import { DEFAULT_GMA_EFFORT, DEFAULT_GMA_MODEL, DEFAULT_GROK_MODEL } from './providers.ts';

export type WorkerGrant = { kind: 'environment'; name: string } | { kind: 'opaque'; id: string };
export interface SecretBinding { credential_slot_id: string; provider_id: string; value: string; worker_grant: WorkerGrant }
export type SecretBindings = ReadonlyMap<string, SecretBinding>;
export interface ResolvedConfiguration { config: CanonicalConfig; config_revision: string; config_fingerprint: string; secret_bindings: SecretBindings; canonical_path: string }
export interface ResolveConfigurationOptions { env?: NodeJS.ProcessEnv; config?: CanonicalConfigPatch; overrides?: CanonicalConfigPatch; cwd?: string; homeDirectory?: string }
const instance = (provider_id: string, credential_slot_id: string | undefined, options: Record<string, unknown> = {}, base_url?: string): ProviderInstanceConfig => ({ provider_id, enabled: true, ...(credential_slot_id === undefined ? {} : { credential_slot_id }), ...(base_url === undefined ? {} : { base_url }), options });
export const DEFAULT_FETCH_BLOCKED_MARKERS = ['cf-challenge', 'cf-mitigated', 'verify you are human', 'just a moment', 'please enable javascript', '__cf_chl'] as const;
export function defaultConfiguration(home: string): CanonicalConfig {
  return {
    schema_version: CONFIG_SCHEMA_VERSION, home, jobs_root: resolve(home, 'jobs'), retention_hours: 72, log_level: 'warn',
    provider_instances: {
      'exa.default': instance('exa', 'exa.default'), 'tavily.default': instance('tavily', 'tavily.default'),
      'jina-reader.default': instance('jina-reader', 'jina-reader.default'), 'firecrawl.default': instance('firecrawl', 'firecrawl.default'),
      'grok.default': instance('grok', 'grok.default', { model: DEFAULT_GROK_MODEL }),
      'grok-multi-agent.default': instance('grok-multi-agent', 'grok-multi-agent.default', { model: DEFAULT_GMA_MODEL, reasoning_effort: DEFAULT_GMA_EFFORT }),
      'search-gateway.default': instance('search-gateway', 'search-gateway.default'), 'direct-http.default': instance('direct-http', undefined),
    },
    credential_slots: {
      'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' }, 'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_TAVILY_API_KEY' },
      'jina-reader.default': { provider_id: 'jina-reader', env: 'NB_SEARCH_JINA_API_KEY' }, 'firecrawl.default': { provider_id: 'firecrawl', env: 'NB_SEARCH_FIRECRAWL_API_KEY' },
      'grok.default': { provider_id: 'grok', env: 'NB_SEARCH_GROK_API_KEY' }, 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'NB_SEARCH_GROK_MULTI_AGENT_API_KEY' },
      'search-gateway.default': { provider_id: 'search-gateway', env: 'NB_SEARCH_GATEWAY_TOKEN' },
    },
    lanes: {
      'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['exa'] },
      'exa.synthesis': { provider_instance_id: 'exa.default', operation_id: 'synthesis', latency: 'medium', cost: 'expensive' },
      'exa.contents': { provider_instance_id: 'exa.default', operation_id: 'contents', latency: 'fast', cost: 'cheap' },
      'tavily.search': { provider_instance_id: 'tavily.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['tavily'] },
      'tavily.synthesis': { provider_instance_id: 'tavily.default', operation_id: 'synthesis', latency: 'medium', cost: 'cheap' },
      'tavily.extract': { provider_instance_id: 'tavily.default', operation_id: 'extract', latency: 'fast', cost: 'cheap' },
      'jina.reader': { provider_instance_id: 'jina-reader.default', operation_id: 'reader', latency: 'medium', cost: 'free' },
      'firecrawl.scrape': { provider_instance_id: 'firecrawl.default', operation_id: 'scrape', latency: 'medium', cost: 'cheap' },
      'grok.search': { provider_instance_id: 'grok.default', operation_id: 'search', latency: 'medium', cost: 'expensive', evidence_groups: ['grok'] },
      'gma.research': { provider_instance_id: 'grok-multi-agent.default', operation_id: 'research', latency: 'slow', cost: 'expensive' },
      'gateway.search': { provider_instance_id: 'search-gateway.default', operation_id: 'search', latency: 'medium', cost: 'expensive' },
      'direct.fetch': { provider_instance_id: 'direct-http.default', operation_id: 'fetch', latency: 'fast', cost: 'free' },
    },
    defaults: { fetch_chain: ['direct.fetch', 'jina.reader'] }, presets: {},
    execution: { max_provider_calls: 64, max_concurrency: 8, retry_count: 1, search_timeout_ms: 30_000, fetch_timeout_ms: 60_000, max_inline_bytes: 64 * 1024, fetch: { max_response_bytes: 2 * 1024 * 1024, max_content_chars: 200_000, max_redirects: 5, quality: { min_content_chars: 500, blocked_markers: [...DEFAULT_FETCH_BLOCKED_MARKERS] } } },
  };
}
export function resolveConfiguration(options: ResolveConfigurationOptions = {}): ResolvedConfiguration {
  const env = options.env ?? process.env; const cwd = resolve(options.cwd ?? process.cwd()); const userHome = resolve(options.homeDirectory ?? homedir());
  const home = resolve(cwd, nonempty(env['NB_SEARCH_HOME']) ?? resolve(userHome, '.nb-search')); const canonicalPath = resolve(cwd, nonempty(env['NB_SEARCH_CONFIG']) ?? resolve(home, 'config.json'));
  const sources: CanonicalConfigPatch[] = [defaultConfiguration(home)];
  if (existsSync(canonicalPath)) sources.push(readPatch(canonicalPath)); else if (nonempty(env['NB_SEARCH_CONFIG']) !== undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Canonical configuration file was not found: ${canonicalPath}.`);
  sources.push(environmentPatch(env)); if (options.config !== undefined) sources.push(parseConfigPatch(options.config, 'host configuration')); if (options.overrides !== undefined) sources.push(parseConfigPatch(options.overrides, 'runtime overrides'));
  let merged: unknown = {}; for (const source of sources) merged = mergeValue(merged, source); const config = parseResolvedConfig(merged);
  const secrets = new Map<string, SecretBinding>(); for (const [slotId, slot] of Object.entries(config.credential_slots)) { const value = nonempty(env[slot.env]); if (value !== undefined) secrets.set(slotId, { credential_slot_id: slotId, provider_id: slot.provider_id, value, worker_grant: { kind: 'environment', name: slot.env } }); }
  const fingerprint = stableFingerprint(config); return { config, config_revision: `config-4-${fingerprint.slice(0, 16)}`, config_fingerprint: fingerprint, secret_bindings: secrets, canonical_path: canonicalPath };
}
function environmentPatch(env: NodeJS.ProcessEnv): CanonicalConfigPatch {
  const provider_instances: Record<string, Record<string, unknown>> = {};
  const set = (id: string, key: string, value: unknown): void => { if (value !== undefined) (provider_instances[id] ??= {})[key] = value; };
  set('exa.default', 'base_url', nonempty(env['NB_SEARCH_EXA_BASE_URL'])); set('tavily.default', 'base_url', nonempty(env['NB_SEARCH_TAVILY_BASE_URL'])); set('jina-reader.default', 'base_url', nonempty(env['NB_SEARCH_JINA_BASE_URL'])); set('firecrawl.default', 'base_url', nonempty(env['NB_SEARCH_FIRECRAWL_BASE_URL'])); set('grok.default', 'base_url', nonempty(env['NB_SEARCH_GROK_BASE_URL'])); set('grok-multi-agent.default', 'base_url', nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_BASE_URL'])); set('search-gateway.default', 'base_url', nonempty(env['NB_SEARCH_GATEWAY_BASE_URL']));
  const grokModel = nonempty(env['NB_SEARCH_GROK_MODEL']); if (grokModel !== undefined) set('grok.default', 'options', { model: grokModel });
  const gmaModel = nonempty(env['NB_SEARCH_GROK_MULTI_AGENT_MODEL']); if (gmaModel !== undefined) set('grok-multi-agent.default', 'options', { model: gmaModel });
  return { ...(Object.keys(provider_instances).length === 0 ? {} : { provider_instances }), ...(nonempty(env['NB_SEARCH_JOBS_ROOT']) === undefined ? {} : { jobs_root: nonempty(env['NB_SEARCH_JOBS_ROOT']) }), ...(integer(env['NB_SEARCH_RETENTION_HOURS'], 'NB_SEARCH_RETENTION_HOURS') === undefined ? {} : { retention_hours: integer(env['NB_SEARCH_RETENTION_HOURS'], 'NB_SEARCH_RETENTION_HOURS') }), ...(nonempty(env['NB_SEARCH_LOG_LEVEL']) === undefined ? {} : { log_level: nonempty(env['NB_SEARCH_LOG_LEVEL']) as CanonicalConfig['log_level'] }) };
}
function readPatch(path: string): CanonicalConfigPatch { try { return parseConfigPatch(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown, 'canonical configuration'); } catch (error) { if (error instanceof NbSearchError) throw error; throw new NbSearchError('CONFIGURATION_ERROR', 'Canonical configuration is invalid.'); } }
function mergeValue(base: unknown, patch: unknown): unknown { if (patch === null) return undefined; if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch; const result: Record<string, unknown> = isRecord(base) ? structuredClone(base) : {}; for (const [key, value] of Object.entries(patch)) { if (value === undefined) continue; if (value === null) delete result[key]; else result[key] = mergeValue(result[key], value); } return result; }
function integer(value: string | undefined, name: string): number | undefined { const raw = nonempty(value); if (raw === undefined) return undefined; const parsed = Number(raw); if (!Number.isSafeInteger(parsed)) throw new NbSearchError('CONFIGURATION_ERROR', `${name} must be an integer.`); return parsed; }
function nonempty(value: string | undefined): string | undefined { const item = value?.trim(); return item === '' ? undefined : item }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
