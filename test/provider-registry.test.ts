import { describe, expect, it } from 'vitest';

import type { ProviderInstanceConfig } from '../src/config-schema.ts';
import type { SecretBinding } from '../src/config-sources.ts';
import {
  builtInProviderRegistrations, ProviderRegistry,
} from '../src/provider-registry.ts';
import type { HttpTransport } from '../src/transport.ts';

const transport: HttpTransport = { async send<T>() { return { status: 200, body: { results: [] } as T }; } };

describe('static provider registry', () => {
  it('declares only Exa and Tavily retrieval descriptors with fixed protocol contracts', () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    expect(registry.descriptors()).toMatchObject([
      {
        provider_id: 'exa', adapter_version: 'm1', capabilities: ['retrieval'],
        operations: [{ method: 'POST', response_type: 'json', path: '/search' }],
        auth: { kind: 'api-key-header', name: 'x-api-key' },
      },
      {
        provider_id: 'tavily', adapter_version: 'm1', capabilities: ['retrieval'],
        operations: [{ method: 'POST', response_type: 'json', path: '/search' }],
        auth: { kind: 'api-key-body', name: 'api_key' },
      },
    ]);
    expect(registry.revision()).toMatch(/^registry-1-/);
  });

  it('creates distinct instances of one provider family and rejects unsafe registration/binding ambiguity', () => {
    const registrations = builtInProviderRegistrations();
    const registry = new ProviderRegistry(registrations);
    const binding = credential('exa.slot', 'exa');
    const first = registry.create('exa.first', instance('exa.slot'), {
      credential: binding, transports: { http: transport }, clock: () => new Date(0),
    }).retrieval;
    const second = registry.create('exa.second', instance('exa.slot'), {
      credential: binding, transports: { http: transport }, clock: () => new Date(0),
    }).retrieval;
    expect([first?.provider_instance_id, second?.provider_instance_id]).toEqual(['exa.first', 'exa.second']);
    expect(() => new ProviderRegistry([registrations[0]!, registrations[0]!])).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => registry.create('exa.bad', instance('exa.slot'), {
      credential: credential('other.slot', 'exa'), transports: { http: transport }, clock: () => new Date(0),
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });
});

function instance(slotId: string): ProviderInstanceConfig {
  return {
    provider_id: 'exa', enabled: true, credential_slot_id: slotId,
    timeout_ms: 1_000, retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 }, options: {},
  };
}
function credential(slotId: string, providerId: string): SecretBinding {
  return {
    credential_slot_id: slotId, provider_id: providerId, value: 'secret',
    worker_grant: { kind: 'opaque', id: 'test-grant' },
  };
}

