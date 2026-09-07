import { defaultConfiguration } from './config-sources.ts';
import type { CanonicalConfig } from './config-schema.ts';
import { builtInProviderRegistrations, ProviderRegistry, type ProviderRegistration } from './provider-registry.ts';
import type { CapabilityEnvelope, LaneCost, LaneLatency } from './types.ts';

export type GuidanceGroup = 'onboarding' | 'specialist' | 'research' | 'unclassified';
export interface LaneGuidanceEntry {
  lane_id: string; provider_id: string; operation_id: string; group: GuidanceGroup;
  purpose: string; output: { channel: 'results' | 'typed' | 'documents' | 'unknown'; schema_id?: string };
  cost: LaneCost; latency: LaneLatency;
  prerequisites: { credential: string; endpoint: string; optional_runtime?: string };
  readiness: 'ready' | 'unavailable' | 'not_evaluated'; live_verified: false;
}
export interface GuidanceCatalog { schema_version: '1'; groups: Record<GuidanceGroup, string>; lanes: LaneGuidanceEntry[]; note: string }
const groups: Record<GuidanceGroup, string> = { onboarding: '入门通用检索与原文', specialist: '按需专题能力', research: '综合与深度研究', unclassified: '未分类自定义能力' };
// Keys are provider + operation, never the configured lane name.
const guide: Record<string, readonly [GuidanceGroup, string]> = {
  'exa/search': ['onboarding', 'General web evidence retrieval'], 'tavily/search': ['onboarding', 'General web evidence retrieval'],
  'brave/search': ['onboarding', 'General web evidence retrieval'], 'parallel/search': ['onboarding', 'General web evidence retrieval'],
  'searxng/search': ['onboarding', 'Self-hosted general web retrieval'], 'zhipu/search': ['onboarding', 'General web evidence retrieval'],
  'direct-http/fetch': ['onboarding', 'Default URL document acquisition'], 'jina-reader/reader': ['onboarding', 'URL reader pipeline'],
  'exa/synthesis': ['research', 'Provider-generated synthesis with supporting evidence'], 'tavily/synthesis': ['research', 'Provider-generated synthesis with supporting evidence'],
  'grok/synthesis': ['research', 'Responses web synthesis'], 'grok-multi-agent/research': ['research', 'One complete multi-agent research brief'],
  'openai-compatible/synthesis': ['research', 'Explicit compatible-model synthesis'],
  'grok/x-synthesis': ['specialist', 'Responses X-focused synthesis'], 'context7/docs': ['specialist', 'Library and code documentation'],
  'github/repositories': ['specialist', 'Repository discovery'], 'firecrawl/search': ['specialist', 'Search with extracted web content'],
  'exa/contents': ['specialist', 'Provider content extraction'], 'tavily/extract': ['specialist', 'Provider content extraction'],
  'firecrawl/scrape': ['specialist', 'Web scraping pipeline'], 'direct-http/local': ['specialist', 'Non-egress inline or scoped-file normalization'],
  'wayback/fetch': ['specialist', 'Explicit archived-page acquisition'], 'browser-render/render': ['specialist', 'Explicit browser rendering'],
  'openai-compatible/fetch': ['specialist', 'Explicit compatible-model document transformation'],
};
export function describeConfiguredLaneGuidance(config: CanonicalConfig, registrations: readonly ProviderRegistration[] = builtInProviderRegistrations(), capabilities?: CapabilityEnvelope): LaneGuidanceEntry[] {
  const registry = new ProviderRegistry([], registrations);
  return Object.entries(config.lanes).sort(([a], [b]) => a.localeCompare(b)).map(([id, lane]) => {
    const instance = config.provider_instances[lane.provider_instance_id]; const provider = instance?.provider_id ?? 'unknown'; const descriptor = registry.descriptor(provider);
    const query = descriptor?.query_operations.find((operation) => operation.operation_id === lane.operation_id); const fetch = descriptor?.fetch_operations.find((operation) => operation.operation_id === lane.operation_id);
    const known = guide[`${provider}/${lane.operation_id}`];
    const expected = builtInProviderRegistrations().find((item) => item.descriptor.provider_id === provider)?.descriptor;
    const originalQuery = expected?.query_operations.find((operation) => operation.operation_id === lane.operation_id); const originalFetch = expected?.fetch_operations.find((operation) => operation.operation_id === lane.operation_id);
    const matches = query ? originalQuery?.output.channel === query.output.channel && originalQuery.output.schema_id === query.output.schema_id : fetch ? originalFetch?.schema_id === fetch.schema_id : false;
    const classification = known && matches ? known : ['unclassified', 'Consult the custom provider contract; no built-in usage recommendation'] as const;
    const published = capabilities?.search.lanes.find((item) => item.id === id) ?? capabilities?.fetch.pipelines.find((item) => item.id === id);
    return { lane_id: id, provider_id: provider, operation_id: lane.operation_id, group: classification[0], purpose: classification[1], output: query ? { ...query.output } : fetch ? { channel: 'documents' as const, schema_id: fetch.schema_id } : { channel: 'unknown' as const }, cost: lane.cost, latency: lane.latency,
      prerequisites: { credential: descriptor?.activation.credential ?? 'unknown', endpoint: descriptor?.activation.endpoint ?? 'unknown', ...(provider === 'browser-render' ? { optional_runtime: 'Playwright and Chromium; async only' } : {}) }, readiness: published?.availability ?? 'not_evaluated', live_verified: false };
  });
}
/** Safe structural catalog: no canonical/secret/env lookup, runtime construction or network probes. */
export function listBuiltInLaneGuidance(): GuidanceCatalog {
  return { schema_version: '1', groups: { ...groups }, lanes: describeConfiguredLaneGuidance(defaultConfiguration('.')), note: 'Usage groups are not quality rankings. Start with one configured general results lane; specialist and research lanes are explicit choices. Cost/latency are relative. Readiness is not a live probe.' };
}
