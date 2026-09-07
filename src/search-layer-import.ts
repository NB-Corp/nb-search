import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfigPatch, parseResolvedConfig, stableFingerprint, type CanonicalConfigPatch } from './config-schema.ts';
import { defaultConfiguration, mergeValue } from './config-sources.ts';
import { validateGrokModel } from './providers.ts';
import { validateConfigurationSemantics } from './config.ts';
import { cliPaths, loadSecrets, type SecretFile } from './cli-config.ts';
import { configurationTargets, acquireConfigurationLocks, assertConfigurationUnlocked, commitTargetRevisions, readJson, storageError, writeProtected, commitRevision, replaceFile, ensureHome, statIfPresent } from './cli-storage.ts';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const first = (...values: unknown[]) => values.map(text).find((value) => value !== undefined);
interface ProviderReport { provider: string; status: 'compatible_unverified' | 'disabled_incompatible' | 'missing'; normalized_protocol?: 'chat_completions' | 'messages' | 'unknown'; reason?: string }
export interface ImportReport { status: 'succeeded' | 'partial'; mode: 'dry-run' | 'apply'; source: string; providers: ProviderReport[]; targets: 'created' | 'merged' | 'unchanged'; network_probed: false }
export interface ImportOptions { source?: string; apply: boolean; env?: NodeJS.ProcessEnv; homeDirectory?: string; cwd?: string }
export function mapLegacy(raw: unknown, env: NodeJS.ProcessEnv): { patch: CanonicalConfigPatch; secrets: SecretFile; providers: ProviderReport[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw storageError('Legacy credential JSON must be an object.');
  const root = record(raw); const instances: Record<string, unknown> = {}; const slots: Record<string, unknown> = {}; const values: Record<string, string> = {}; const providers: ProviderReport[] = []; const lanes: string[] = [];
  function add(provider: string, key: string | undefined, base: string | undefined, enabled: boolean, options: Record<string, unknown> = {}, reason?: string) {
    if (!key) { providers.push({ provider, status: 'missing' }); return; }
    const id = `${provider}.default`; const name = provider === 'grok-multi-agent' ? 'NB_SEARCH_GROK_MULTI_AGENT_API_KEY' : `NB_SEARCH_${provider.toUpperCase()}_API_KEY`;
    instances[id] = { provider_id: provider, enabled, credential_slot_id: id, ...(base ? { base_url: base } : {}), options }; slots[id] = { provider_id: provider, env: name }; values[name] = key;
    providers.push({ provider, status: enabled ? 'compatible_unverified' : 'disabled_incompatible', ...(reason ? { reason } : {}) });
  }
  for (const provider of ['exa', 'tavily']) {
    const nested = record(root[provider]); const prefix = provider.toUpperCase();
    const key = first(env[`${prefix}_API_KEY`], typeof root[provider] === 'string' ? root[provider] : nested['apiKey']);
    const base = endpoint(first(env[`${prefix}_API_BASE`], env[`${prefix}_API_URL`], root[`${provider}ApiUrl`], root[`${provider}ApiBase`], root[`${provider}BaseUrl`], nested['apiUrl'], nested['baseUrl'], nested['apiBase']) ?? `https://api.${provider}.com`.replace('exa.com', 'exa.ai'), 'search');
    add(provider, key, base, true); if (key) lanes.push(`${provider}.search`);
  }
  const grok = record(root['grok']); const gma = record(root['grokMultiAgent']);
  const grokKey = first(env['GROK_API_KEY'], grok['apiKey']); const grokUrl = first(env['GROK_API_URL'], grok['apiUrl']);
  const grokModel = first(env['GROK_MODEL'], grok['model']) ?? 'grok-4.1-fast'; validateModel(grokModel);
  add('grok', grokKey, grokUrl ? endpoint(grokUrl, 'chat') : undefined, false, { model: grokModel }, 'CHAT_IS_NOT_RESPONSES');
  const gmaKey = first(gma['apiKey'], grokKey); const gmaUrl = first(gma['apiUrl'], gma['baseUrl'], gma['apiBase'], grokUrl);
  const rawMode = env['GROK_MULTI_AGENT_API_MODE'] || (Object.hasOwn(gma, 'apiMode') ? gma['apiMode'] : undefined);
  const modeInput = rawMode === undefined ? 'chat_completions' : typeof rawMode === 'string' ? rawMode.trim() : '';
  const mode = modeInput.toLowerCase().replace(/[- ]/g, '_');
  const normalized: 'chat_completions' | 'messages' | 'unknown' = ['chat', 'chat_completion', 'chat_completions', 'openai'].includes(mode) ? 'chat_completions' : ['message', 'messages', 'anthropic', 'anthropic_message', 'anthropic_messages'].includes(mode) ? 'messages' : 'unknown';
  const effort = first(env['GROK_MULTI_AGENT_EFFORT'], gma['reasoningEffort']) ?? 'xhigh'; if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw storageError('Legacy research effort is invalid.');
  const model = first(env['GROK_MULTI_AGENT_MODEL'], gma['model']) ?? 'grok-4.20-multi-agent-xhigh'; validateModel(model);
  const base = gmaUrl ? endpoint(gmaUrl, 'preserve') : undefined;
  const suffix = base ? ['/chat/completions', '/messages', '/responses'].find((item) => new URL(base).pathname.endsWith(item)) : undefined;
  const reason = normalized === 'unknown' ? 'API_MODE_UNKNOWN' : !base ? 'ENDPOINT_MISSING' : suffix && suffix !== (normalized === 'messages' ? '/messages' : '/chat/completions') ? 'ENDPOINT_PROTOCOL_CONFLICT' : undefined;
  add('grok-multi-agent', gmaKey, base, reason === undefined, { model, reasoning_effort: effort, ...(normalized === 'unknown' ? {} : { api_mode: normalized }) }, reason);
  const gmaReport = providers.find((item) => item.provider === 'grok-multi-agent')!; gmaReport.normalized_protocol = normalized; if (!gmaKey) gmaReport.reason = 'CREDENTIAL_MISSING';
  const gateway = record(root['searchGateway']); if (Object.keys(gateway).length || env['SEARCH_GATEWAY_TOKEN']) providers.push({ provider: 'search-gateway', status: 'disabled_incompatible', reason: 'AGGREGATE_UNSUPPORTED' });
  const settings = record(root['searchLayer']); const timeoutRaw = env['SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS'] || settings['requestTimeoutSeconds'];
  let timeout: number | undefined; if (timeoutRaw !== undefined) { timeout = Number(timeoutRaw) * 1000; if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 3600000) throw storageError('Legacy timeout is invalid.'); }
  if (Object.keys(record(settings['providerTimeouts'])).length || Object.keys(env).some((key) => /^SEARCH_LAYER_.+_TIMEOUT_SECONDS$/.test(key) && key !== 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS' && env[key])) providers.push({ provider: 'provider-timeouts', status: 'disabled_incompatible', reason: 'PER_PROVIDER_TIMEOUT_UNSUPPORTED' });
  const patch = parseConfigPatch({ schema_version: '4', provider_instances: instances, credential_slots: slots, ...(lanes.length ? { defaults: { search_lane: lanes[0] }, presets: { 'research-evidence': { lanes } } } : {}), execution: { retry_count: 0, ...(timeout === undefined ? {} : { search_timeout_ms: timeout }) } }, 'migration');
  return { patch, secrets: { schema_version: '1', values }, providers };
}
function validateModel(model: string) { validateGrokModel(model); }
function endpoint(raw: string, kind: 'search' | 'chat' | 'preserve'): string { try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); url.pathname = url.pathname.replace(/\/+$/, ''); if (kind === 'search') { if (/\/(?:messages|chat\/completions|responses)$/.test(url.pathname)) throw new Error(); url.pathname = url.pathname.replace(/\/search$/, ''); } if (kind === 'chat') url.pathname = url.pathname.replace(/\/chat\/completions$/, ''); return url.href.replace(/\/$/, ''); } catch { throw storageError('Legacy endpoint is invalid or ambiguous.'); } }
function mergeWithoutConflict(existing: unknown, patch: unknown): unknown { if (existing === undefined) return structuredClone(patch); if (patch === undefined) return structuredClone(existing); if (stableFingerprint(existing) === stableFingerprint(patch)) return structuredClone(existing); if (existing && patch && typeof existing === 'object' && typeof patch === 'object' && !Array.isArray(existing) && !Array.isArray(patch)) { const merged = { ...record(existing) }; for (const [key, value] of Object.entries(record(patch))) merged[key] = mergeWithoutConflict(merged[key], value); return merged; } throw storageError('Migration conflicts with existing configuration or credentials; no fields were overwritten.'); }
export function importSearchLayer(options: ImportOptions): ImportReport {
  const env = { ...(options.env ?? process.env) }; const paths = cliPaths(env); const cwd = options.cwd ?? process.cwd(); const userHome = options.homeDirectory ?? homedir();
  const expand = (path: string) => resolve(cwd, path.replace(/^~(?=[/\\]|$)/, userHome));
  const candidates = options.source ? [expand(options.source)] : [env['SEARCH_LAYER_CREDENTIALS'] ? expand(env['SEARCH_LAYER_CREDENTIALS']) : undefined, resolve(userHome, '.openclaw/credentials/search.json'), resolve(cwd, 'credentials/search.json')].filter((item): item is string => item !== undefined);
  const source = candidates.find((path) => statIfPresent(path)?.isFile()); if (!source) throw storageError(`Legacy credential source was not found (ENOENT): ${candidates[0] ?? 'credentials/search.json'}.`);
  const preflight = () => {
    const targets = configurationTargets(paths.home, paths.config);
    if (!locked) assertConfigurationUnlocked(targets);
    const [configTarget, secretsTarget] = targets.data as [string, string];
    const mapped = mapLegacy(readJson(source), env); const oldConfig = readJson(paths.config); const oldSecrets = loadSecrets(paths.secrets);
    const config = parseConfigPatch(mergeWithoutConflict(oldConfig, mapped.patch), 'migration'); const secrets = mergeWithoutConflict(oldSecrets, mapped.secrets) as SecretFile;
    const expected = parseResolvedConfig(mergeValue(defaultConfiguration(paths.home), config));
    try {
      validateConfigurationSemantics(expected);
      for (const laneId of mapped.patch.presets?.['research-evidence']?.lanes ?? []) {
        const lane = expected.lanes[laneId]; const provider = laneId.split('.')[0]!;
        if (lane?.provider_instance_id !== `${provider}.default` || lane.operation_id !== 'search' || expected.provider_instances[lane.provider_instance_id]?.provider_id !== provider) throw new Error();
      }
    } catch { throw storageError('Migration conflicts with the saved lane, provider, operation, default or results-only preset semantics; no fields were overwritten.'); }
    return { mapped, config, secrets, oldConfig, oldSecrets, configTarget, secretsTarget, targets };
  };
  let locked = false;
  const before = preflight(); const second = preflight(); if (stableFingerprint(before) !== stableFingerprint(second)) throw storageError('Configuration changed; rerun migration.');
  const unchanged = stableFingerprint(before.config) === stableFingerprint(before.oldConfig) && stableFingerprint(before.secrets) === stableFingerprint(before.oldSecrets);
  const report: ImportReport = { status: before.mapped.providers.some((item) => item.status !== 'compatible_unverified') ? 'partial' : 'succeeded', mode: options.apply ? 'apply' : 'dry-run', source, providers: before.mapped.providers, targets: unchanged ? 'unchanged' : before.oldConfig === undefined ? 'created' : 'merged', network_probed: false };
  if (!options.apply || unchanged) return report;
  const unlock = acquireConfigurationLocks(before.targets); locked = true; let publishing = false;
  try {
    const current = preflight(); if (stableFingerprint(current) !== stableFingerprint(before)) throw storageError('Configuration changed; rerun migration.');
    ensureHome(dirname(current.configTarget)); ensureHome(dirname(current.secretsTarget));
    const transaction = randomUUID(); const stagedConfig = resolve(dirname(current.configTarget), `.migration-${transaction}-config.json`); const stagedSecrets = resolve(dirname(current.secretsTarget), `.migration-${transaction}-secrets.json`);
    writeProtected(resolve(paths.home, `.migration-${transaction}-backup.json`), { config: current.oldConfig ?? null, secrets: current.oldSecrets });
    writeProtected(stagedConfig, current.config); writeProtected(stagedSecrets, current.secrets);
    if (stableFingerprint(configurationTargets(paths.home, paths.config)) !== stableFingerprint(current.targets)) throw storageError('Configuration targets changed; rerun migration.');
    publishing = true; replaceFile(stagedSecrets, current.secretsTarget); replaceFile(stagedConfig, current.configTarget);
    if (stableFingerprint(readJson(paths.config)) !== stableFingerprint(current.config) || stableFingerprint(loadSecrets(paths.secrets)) !== stableFingerprint(current.secrets)) throw storageError('Migration publication could not be verified; recovery is required.');
    commitTargetRevisions(current.targets); commitRevision(paths.home); unlock(); return report;
  } catch (error) { if (!publishing) unlock(); throw error; }
}
