import { describe, expect, it, vi } from 'vitest';
import { defaultConfiguration } from '../src/config-sources.ts';
import { describeConfiguredLaneGuidance, listBuiltInLaneGuidance } from '../src/lane-guidance.ts';
import { builtInProviderRegistrations } from '../src/provider-registry.ts';

describe('pure usage guidance', () => {
  it('covers every default lane/provider without credential, endpoint, or live readiness claims', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try { const catalog = listBuiltInLaneGuidance(); const defaults = defaultConfiguration('.'); expect(catalog.lanes.map((lane) => lane.lane_id).sort()).toEqual(Object.keys(defaults.lanes).sort()); expect(new Set(catalog.lanes.map((lane) => lane.provider_id))).toEqual(new Set(builtInProviderRegistrations().map((item) => item.descriptor.provider_id))); expect(catalog.lanes.every((lane) => lane.group !== 'unclassified' && lane.readiness === 'not_evaluated' && lane.live_verified === false)).toBe(true); expect(JSON.stringify(catalog)).not.toMatch(/NB_SEARCH_.*KEY|base_url|https:\/\//); expect(network).not.toHaveBeenCalled(); } finally { network.mockRestore(); }
  });
  it('classifies actual provider operation and channel rather than misleading lane names', () => {
    const config = defaultConfiguration('.'); config.lanes = { 'exa.search': { provider_instance_id: 'exa.default', operation_id: 'synthesis', latency: 'slow', cost: 'expensive' }, 'gma.research': { provider_instance_id: 'tavily.default', operation_id: 'search', latency: 'fast', cost: 'cheap' }, custom: { provider_instance_id: 'host', operation_id: 'lookup', latency: 'medium', cost: 'free' } }; config.provider_instances = { ...config.provider_instances, host: { provider_id: 'host', enabled: true, options: {} } };
    const result = describeConfiguredLaneGuidance(config); expect(result.find((lane) => lane.lane_id === 'exa.search')).toMatchObject({ group: 'research', output: { channel: 'typed' }, cost: 'expensive' }); expect(result.find((lane) => lane.lane_id === 'gma.research')).toMatchObject({ group: 'onboarding', provider_id: 'tavily', output: { channel: 'results' } }); expect(result.find((lane) => lane.lane_id === 'custom')).toMatchObject({ group: 'unclassified', readiness: 'not_evaluated' });
  });
});
