import { describe, expect, it, vi } from 'vitest';
import { defaultConfiguration } from '../src/config-sources.ts';
import { describeConfiguredLaneGuidance, listBuiltInLaneGuidance } from '../src/lane-guidance.ts';
import { builtInProviderRegistrations } from '../src/provider-registry.ts';

describe('pure usage guidance', () => {
  it('covers every default lane/provider without credential, endpoint, or live readiness claims', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const catalog = listBuiltInLaneGuidance(); const defaults = defaultConfiguration('.');
      const registered = new Set(builtInProviderRegistrations().map((item) => item.descriptor.provider_id));
      const defaultProviders = new Set(Object.values(defaults.lanes).map((lane) => defaults.provider_instances[lane.provider_instance_id]!.provider_id));
      expect(catalog.lanes.map((lane) => lane.lane_id).sort()).toEqual(Object.keys(defaults.lanes).sort());
      expect(new Set(catalog.lanes.map((lane) => lane.provider_id))).toEqual(defaultProviders);
      expect([...defaultProviders].every((provider) => registered.has(provider))).toBe(true);
      // Registered adapters need not have runnable defaults: script requires an explicit module.
      expect(registered.has('script')).toBe(true);
      expect(Object.values(defaults.provider_instances).some((instance) => instance.provider_id === 'script')).toBe(false);
      expect(defaultProviders.has('script')).toBe(false);
      expect(catalog.lanes.every((lane) => lane.group !== 'unclassified' && lane.readiness === 'not_evaluated' && lane.live_verified === false)).toBe(true);
      expect(JSON.stringify(catalog)).not.toMatch(/NB_SEARCH_.*KEY|base_url|https:\/\//);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('describes explicitly configured script lanes without executing modules or exposing options', () => {
    const config = defaultConfiguration('.');
    config.provider_instances = { ...config.provider_instances, local: { provider_id: 'script', enabled: true, options: { module: '/private/not-loaded.mjs', params: { private_label: 'not-public' } } } };
    config.lanes = { 'local.search': { provider_instance_id: 'local', operation_id: 'search', latency: 'medium', cost: 'free' } };
    const registrations = builtInProviderRegistrations();
    const create = vi.fn(() => { throw new Error('Guidance must not construct a script provider'); });
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const guidance = describeConfiguredLaneGuidance(config, registrations.map((registration) => registration.descriptor.provider_id === 'script' ? { ...registration, create } : registration));
      expect(guidance).toEqual([{
        lane_id: 'local.search', provider_id: 'script', operation_id: 'search', group: 'unclassified',
        purpose: 'Consult the custom provider contract; no built-in usage recommendation',
        output: { channel: 'results', schema_id: 'nb-search.results@1' }, cost: 'free', latency: 'medium',
        prerequisites: { credential: 'none', endpoint: 'none' }, readiness: 'not_evaluated', live_verified: false,
      }]);
      expect(JSON.stringify(guidance)).not.toMatch(/private|not-loaded|not-public/);
      expect(create).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('classifies actual provider operation and channel rather than misleading lane names', () => {
    const config = defaultConfiguration('.'); config.lanes = { 'exa.search': { provider_instance_id: 'exa.default', operation_id: 'synthesis', latency: 'slow', cost: 'expensive' }, 'gma.research': { provider_instance_id: 'tavily.default', operation_id: 'search', latency: 'fast', cost: 'cheap' }, custom: { provider_instance_id: 'host', operation_id: 'lookup', latency: 'medium', cost: 'free' } }; config.provider_instances = { ...config.provider_instances, host: { provider_id: 'host', enabled: true, options: {} } };
    const result = describeConfiguredLaneGuidance(config); expect(result.find((lane) => lane.lane_id === 'exa.search')).toMatchObject({ group: 'research', output: { channel: 'typed' }, cost: 'expensive' }); expect(result.find((lane) => lane.lane_id === 'gma.research')).toMatchObject({ group: 'onboarding', provider_id: 'tavily', output: { channel: 'results' } }); expect(result.find((lane) => lane.lane_id === 'custom')).toMatchObject({ group: 'unclassified', readiness: 'not_evaluated' });
  });
});
