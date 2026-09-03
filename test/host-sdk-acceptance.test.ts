import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNbSearchRuntime,
  parseConfigPatch,
  type CanonicalConfigPatch,
  type FetchOperationDescriptor,
  type ProviderRegistration,
  type QueryProviderValue
} from '@nb-corp/nb-search';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

const secret = 'host-sdk-secret-value';
const waitForAbort = async (signal: AbortSignal): Promise<never> => await new Promise((_, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const resultValue = (label: string, query: string): QueryProviderValue => ({ channel: 'results', value: { results: [{ title: label, url: `https://example.com/${query}`, snippet: query }] } });
const fetchOperation = (operation_id: string): FetchOperationDescriptor => ({ operation_id, schema_id: 'nb-search.fetch@1', input_kinds: ['url'], media_types: ['text/plain'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', stages: [{ id: operation_id, role: 'reader' }] });
const registration: ProviderRegistration = {
  descriptor: {
    provider_id: 'host-sdk',
    adapter_version: 'acceptance-1',
    query_operations: [
      { operation_id: 'base', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: false },
      { operation_id: 'override', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: false },
      { operation_id: 'failure', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: false },
      { operation_id: 'blocking', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: false }
    ],
    fetch_operations: [fetchOperation('fetch-primary'), fetchOperation('fetch-secondary')],
    activation: { credential: 'required', endpoint: 'none' },
    option_keys: []
  },
  create(context) {
    if (context.credential?.value !== secret) throw new Error('credential binding mismatch');
    return {
      query: {
        base: { name: 'host-sdk', async execute(request) { return resultValue('base', request.query); } },
        override: { name: 'host-sdk', async execute(request) { return resultValue('override', request.query); } },
        failure: { name: 'host-sdk', async execute() { throw new Error('query failure'); } },
        blocking: { name: 'host-sdk', async execute(request) { return await waitForAbort(request.signal); } }
      },
      fetch: {
        'fetch-primary': { name: 'host-sdk', async fetch() { throw new Error('primary fetch failure'); } },
        'fetch-secondary': { name: 'host-sdk', async fetch(request) { const url = request.source.kind === 'url' ? request.source.url : undefined; if (url === undefined) throw new Error('unexpected source'); const content = 'secondary fetch'; return { url, final_url: url, content, content_type: 'text/plain', media_type: 'text/plain', representation: request.representation, format: 'text', byte_length: Buffer.byteLength(content), truncated: false, warnings: [] }; } }
      }
    };
  }
};

function hostConfig(root: string): CanonicalConfigPatch {
  return parseConfigPatch({
    home: root,
    jobs_root: join(root, 'jobs'),
    credential_slots: { 'host-sdk.default': { provider_id: 'host-sdk', env: 'HOST_SDK_SECRET' } },
    provider_instances: { 'host-sdk.default': { provider_id: 'host-sdk', enabled: true, credential_slot_id: 'host-sdk.default', options: {} } },
    lanes: {
      'host.base': { provider_instance_id: 'host-sdk.default', operation_id: 'base', latency: 'fast', cost: 'free' },
      'host.override': { provider_instance_id: 'host-sdk.default', operation_id: 'override', latency: 'fast', cost: 'free' },
      'host.failure': { provider_instance_id: 'host-sdk.default', operation_id: 'failure', latency: 'fast', cost: 'free' },
      'host.blocking': { provider_instance_id: 'host-sdk.default', operation_id: 'blocking', latency: 'slow', cost: 'free' },
      'host.fetch-primary': { provider_instance_id: 'host-sdk.default', operation_id: 'fetch-primary', latency: 'fast', cost: 'free' },
      'host.fetch-secondary': { provider_instance_id: 'host-sdk.default', operation_id: 'fetch-secondary', latency: 'fast', cost: 'free' }
    },
    defaults: { search_lane: 'host.base', fetch_chain: [{ input_kind: 'url', pipelines: ['host.fetch-primary', 'host.fetch-secondary'] }] },
    execution: { retry_count: 0, search_timeout_ms: 1000, fetch_timeout_ms: 1000, fetch: { quality: { min_content_chars: 0, blocked_markers: [] } } }
  }, 'host settings');
}

async function createHostRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-host-sdk-'));
  roots.push(root);
  const config = hostConfig(root);
  const overrides = parseConfigPatch({ defaults: { search_lane: 'host.override' } }, 'session overrides');
  return { runtime: createNbSearchRuntime({ env: { HOST_SDK_SECRET: secret }, config, overrides, provider_registrations: [registration] }), config };
}

describe('host SDK package acceptance', () => {
  it('applies config overrides, uses default search and fetch selection, and reports redacted readiness', async () => {
    const { runtime } = await createHostRuntime();
    const search = await runtime.search({ action: 'run', query: 'default-query' });
    expect(search).toMatchObject({ action: 'run', execution: 'sync', selection: { source: 'default', lanes: ['host.override'] }, status: 'succeeded', output: { channel: 'results', results: [{ title: 'override' }] } });

    const fetch = await runtime.fetch({ action: 'run', source: { kind: 'url', url: 'https://example.com/page' } });
    expect(fetch).toMatchObject({ action: 'run', execution: 'sync', selection: { source: 'default' }, status: 'succeeded', lane_outcomes: [{ lane: 'host.fetch-primary', state: 'failed', error: { code: 'INTERNAL' } }, { lane: 'host.fetch-secondary', state: 'succeeded' }], documents: [{ source_lane: 'host.fetch-secondary', content: 'secondary fetch' }] });

    const capabilities = await runtime.capabilities();
    expect(capabilities.providers.descriptors.find((item) => item.provider_id === 'host-sdk')).toMatchObject({ activation: { credential: 'required', endpoint: 'none' }, option_keys: [] });
    expect(capabilities.providers.instances.find((item) => item.id === 'host-sdk.default')).toEqual({ id: 'host-sdk.default', provider_id: 'host-sdk', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'host-sdk.default' }, endpoint: { requirement: 'none', configured: false } });
    expect(capabilities.search.default_lane).toBe('host.override');
    expect(capabilities.fetch.chains).toContainEqual({ input_kind: 'url', representation: 'markdown', pipelines: ['host.fetch-primary', 'host.fetch-secondary'] });
    expect(JSON.stringify(capabilities)).not.toContain(secret);
    expect(JSON.stringify(capabilities)).not.toContain('HOST_SDK_SECRET');
  });

  it('keeps default and partial failures in stable envelopes', async () => {
    const { runtime, config } = await createHostRuntime();
    const withoutDefault = createNbSearchRuntime({ env: { HOST_SDK_SECRET: secret }, config, overrides: { defaults: { search_lane: null } }, provider_registrations: [registration] });
    await expect(withoutDefault.search({ action: 'run', query: 'no-default' })).resolves.toMatchObject({ action: 'run', execution: 'sync', status: 'failed', error: { code: 'DEFAULT_NOT_CONFIGURED', retryable: false } });

    const partial = await runtime.search({ action: 'run', query: 'partial-query', lanes: ['host.override', 'host.failure'] });
    expect(partial).toMatchObject({ action: 'run', execution: 'sync', status: 'partial', output: { status: 'partial', lane_outcomes: [{ lane: 'host.override', state: 'succeeded' }, { lane: 'host.failure', state: 'failed', error: { code: 'INTERNAL' } }] } });
  });

  it('classifies AbortSignal cancellation and execution deadlines', async () => {
    const { runtime } = await createHostRuntime();
    const controller = new AbortController();
    const pending = runtime.search({ action: 'run', query: 'cancel-query', lane: 'host.blocking' }, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ action: 'run', execution: 'sync', status: 'cancelled', output: { status: 'cancelled', lane_outcomes: [{ lane: 'host.blocking', state: 'cancelled', error: { code: 'CANCELLED' } }] } });

    await expect(runtime.search({ action: 'run', query: 'deadline-query', lane: 'host.blocking', timeout_ms: 100 })).resolves.toMatchObject({ action: 'run', execution: 'sync', status: 'timed_out', output: { status: 'timed_out', lane_outcomes: [{ lane: 'host.blocking', state: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } }] } });
  });
});
