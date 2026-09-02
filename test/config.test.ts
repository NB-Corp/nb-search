import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../src/config.ts';
import { defaultConfiguration, resolveConfiguration } from '../src/config-sources.ts';
import { mockConfig, mockRegistration } from './helpers.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'nb-search-config-v3-')); roots.push(value); return value; }
describe('schema v3 configuration', () => {
  it('uses operation bindings and the one-time lane IDs', () => { const config = defaultConfiguration('C:/tmp/nb-search'); expect(config.schema_version).toBe('3'); expect(Object.keys(config.lanes).sort()).toEqual(['direct.fetch', 'exa.search', 'exa.synthesis', 'gateway.search', 'gma.research', 'grok.search', 'tavily.search', 'tavily.synthesis']); expect(config.lanes['exa.search']).toEqual({ provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['exa'] }); expect(JSON.stringify(config)).not.toMatch(/"verbs"|"capability"|"kind"|"execution":"(sync|job)"|answer_lane|deep_lane/); });
  it('ignores every legacy credential and routing environment alias', async () => { const home = await root(); const baseline = resolveConfiguration({ env: { NB_SEARCH_HOME: home }, cwd: home, homeDirectory: home }); const injected = resolveConfiguration({ env: { NB_SEARCH_HOME: home, SEARCH_LAYER_CREDENTIALS: 'x', EXA_API_KEY: 'legacy', TAVILY_API_KEY: 'legacy', GROK_API_KEY: 'legacy', GROK_MODEL: 'legacy', SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: '1', NB_SEARCH_GATEWAY_AGGREGATE: 'true', NB_SEARCH_GATEWAY_PROFILE: 'legacy' }, cwd: home, homeDirectory: home }); expect(injected.config_fingerprint).toBe(baseline.config_fingerprint); expect(injected.secret_bindings.size).toBe(0); expect(JSON.stringify(injected)).not.toMatch(/legacy_path|LEGACY_NOT_FOUND|LEGACY_INVALID|legacy-json/); });
  it('uses canonical provider environment names only', async () => { const home = await root(); const resolved = resolveConfiguration({ env: { NB_SEARCH_HOME: home, NB_SEARCH_EXA_API_KEY: 'canonical', NB_SEARCH_EXA_BASE_URL: 'https://exa.example' }, cwd: home, homeDirectory: home }); expect(resolved.secret_bindings.get('exa.default')?.value).toBe('canonical'); expect(resolved.config.provider_instances['exa.default']?.base_url).toBe('https://exa.example'); });
  it('rejects a typed lane inside a preset during configuration loading', async () => { const home = await root(); const base = mockConfig(home); expect(() => loadConfiguration({}, undefined, { cwd: home, homeDirectory: home, provider_registrations: [mockRegistration()], config: { ...base, presets: { bad: { lanes: ['mock.results', 'mock.typed'] } } } })).toThrow(/results lanes only/); });
});
