import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeComposition } from '../src/app.ts';
import { loadConfiguration } from '../src/config.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { SearchGatewayProvider } from '../src/providers.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe('L2 gateway migration', () => {
  it('preserves source order and lets primary gateway environment names win their aliases', async () => {
    const root = await temporaryRoot();
    const legacy = join(root, 'legacy.json');
    const canonical = join(root, 'canonical.json');
    await writeFile(legacy, JSON.stringify({
      searchGateway: { baseUrl: 'https://legacy.test', token: 'legacy-token', aggregate: true, profile: 'legacy-profile' },
      searchLayer: { providerTimeouts: { searchGateway: 11 } },
    }));
    await writeFile(canonical, JSON.stringify({
      provider_instances: { 'search-gateway.aggregate': { base_url: 'https://canonical.test', timeout_ms: 22_000 } },
      credential_slots: { 'search-gateway.aggregate': { provider_id: 'search-gateway', env: 'CANONICAL_TOKEN' } },
    }));
    const resolved = resolveConfiguration({
      env: {
        SEARCH_LAYER_CREDENTIALS: legacy, NB_SEARCH_CONFIG: canonical, CANONICAL_TOKEN: 'canonical-token',
        SEARCH_GATEWAY_BASE_URL: 'https://alias.test', NB_SEARCH_GATEWAY_BASE_URL: 'https://environment.test',
        SEARCH_GATEWAY_TOKEN: 'alias-token', NB_SEARCH_GATEWAY_TOKEN: 'environment-token',
        SEARCH_GATEWAY_AGGREGATE: 'false', NB_SEARCH_GATEWAY_AGGREGATE: 'true',
        SEARCH_GATEWAY_PROFILE: 'alias-profile', NB_SEARCH_GATEWAY_PROFILE: 'environment-profile',
        SEARCH_LAYER_SEARCH_GATEWAY_TIMEOUT_SECONDS: '33', NB_SEARCH_GATEWAY_TIMEOUT_MS: '44000',
        HOST_TOKEN: 'host-token', RUNTIME_TOKEN: 'runtime-token',
      },
      config: {
        provider_instances: { 'search-gateway.aggregate': { base_url: 'https://host.test', timeout_ms: 55_000 } },
        credential_slots: { 'search-gateway.aggregate': { provider_id: 'search-gateway', env: 'HOST_TOKEN' } },
      },
      overrides: {
        provider_instances: { 'search-gateway.aggregate': { base_url: 'https://runtime.test', timeout_ms: 66_000 } },
        credential_slots: { 'search-gateway.aggregate': { provider_id: 'search-gateway', env: 'RUNTIME_TOKEN' } },
      },
      cwd: root, homeDirectory: root,
    });
    expect(resolved.config.provider_instances['search-gateway.aggregate']).toMatchObject({
      base_url: 'https://runtime.test', timeout_ms: 66_000, enabled: true,
      options: { downstream_profile: 'environment-profile' },
    });
    expect(resolved.secret_bindings.get('search-gateway.aggregate')?.value).toBe('runtime-token');
    expect(resolved.provenance).toContainEqual({
      path: 'provider_instances.search-gateway.aggregate.timeout_ms', source: 'runtime',
    });
  });

  it('maps the legacy gateway aliases and materializes an aggregate-only compatibility cutover', async () => {
    const root = await temporaryRoot();
    const legacy = join(root, 'legacy.json');
    await writeFile(legacy, JSON.stringify({
      searchGateway: {
        baseUrl: 'https://gateway.test/root', apiUrl: 'https://ignored.test',
        token: 'legacy-token-sentinel', apiKey: 'ignored-token', aggregate: 'yes', profile: 'custom-ops',
      },
      searchLayer: { providerTimeouts: { searchGateway: 33 }, retry: { maxAttempts: 3, backoffMs: 7 } },
    }));
    const resolved = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: legacy }, cwd: root, homeDirectory: root,
    });

    expect(resolved.config.provider_instances['search-gateway.aggregate']).toMatchObject({
      provider_id: 'search-gateway', enabled: true, credential_slot_id: 'search-gateway.aggregate',
      base_url: 'https://gateway.test/root', timeout_ms: 33_000,
      retry: { max_attempts: 3, backoff_ms: 7 }, options: { downstream_profile: 'custom-ops' },
    });
    expect(resolved.secret_bindings.get('search-gateway.aggregate')).toMatchObject({
      value: 'legacy-token-sentinel', worker_grant: { kind: 'legacy-json', key: 'searchGateway' },
    });
    for (const profileId of ['default', 'fast', 'deep']) {
      const invocations = resolved.config.profiles[profileId]?.stages.flatMap((stage) => stage.invocations);
      expect(invocations).toEqual([expect.objectContaining({ provider_instance_id: 'search-gateway.aggregate' })]);
    }
    expect(JSON.stringify({ config: resolved.config, diagnostics: resolved.diagnostics, provenance: resolved.provenance }))
      .not.toContain('legacy-token-sentinel');
  });

  it('keeps direct compatibility profiles for incomplete cutover and never overwrites an explicit profile', async () => {
    const root = await temporaryRoot();
    const incomplete = resolveConfiguration({
      env: { NB_SEARCH_GATEWAY_AGGREGATE: 'true' }, cwd: root, homeDirectory: root,
    });
    expect(incomplete.diagnostics).toContainEqual({
      code: 'GATEWAY_AGGREGATE_INCOMPLETE', source: 'compatibility',
      path: 'provider_instances.search-gateway.aggregate',
      message: 'Aggregate cutover is enabled but its endpoint or credential is unavailable; direct compatibility profiles remain selected.',
    });
    expect(incomplete.config.profiles['default']?.stages[0]?.invocations.map((item) => item.provider_instance_id))
      .toEqual(['exa.default', 'tavily.default']);

    const explicitDeep = {
      stages: [{ kind: 'parallel' as const, invocations: [{
        provider_instance_id: 'exa.default', capability: 'retrieval' as const, role: 'custom', trigger: 'always',
      }] }],
    };
    const complete = resolveConfiguration({
      env: {
        NB_SEARCH_GATEWAY_AGGREGATE: 'true', NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test',
        NB_SEARCH_GATEWAY_TOKEN: 'token',
      },
      config: { profiles: { deep: explicitDeep } }, cwd: root, homeDirectory: root,
    });
    expect(complete.config.profiles['deep']).toEqual(explicitDeep);
    expect(complete.config.profiles['default']?.stages[0]?.invocations).toHaveLength(1);
    expect(complete.config.profiles['fast']?.stages[0]?.invocations).toHaveLength(1);
  });

  it('sends the exact aggregate request and projects bounded nested evidence without answers', async () => {
    const signal = new AbortController().signal;
    const transport = new CaptureTransport({
      status: 200,
      body: {
        answer: 'answer-sentinel', answers: ['answers-sentinel'],
        results: [{
          title: ' Result ', link: 'https://source.test/a', content: ' content ', publishedDate: '2026-01-01',
          source: 'exa,tavily,exa',
        }, { title: 'bad', link: 42 }],
        attempts: [
          { service: 'exa', status: 'success', elapsed_ms: 12, result_count: 1 },
          { provider: 'tavily', status: 'timeout', error: { code: 'TIMEOUT', message: 'request https://gateway.test/root/v1/aggregate/search token=gateway-secret migration' } },
        ],
      },
    });
    const provider = new SearchGatewayProvider({
      apiKey: 'gateway-secret', baseUrl: 'https://gateway.test/root/', downstreamProfile: 'custom-ops', transport,
    });
    const result = await provider.search({ query: 'migration', profile: 'deep', intent: 'exploratory', freshness: 'pw', limit: 4, signal });

    expect(transport.requests).toEqual([{
      url: 'https://gateway.test/root/v1/aggregate/search', method: 'POST',
      headers: { Authorization: 'Bearer gateway-secret', 'Content-Type': 'application/json' },
      body: { query: 'migration', profile: 'custom-ops', num: 4, intent: 'exploratory', freshness: 'pw' },
      signal,
    }]);
    expect(result).toMatchObject({
      results: [{
        title: 'Result', url: 'https://source.test/a', snippet: 'content', published_at: '2026-01-01',
        upstream_attribution: [{ provider: 'exa' }, { provider: 'tavily' }],
      }],
      upstream_attempts: [
        { provider: 'exa', state: 'succeeded', duration_ms: 12, result_count: 1 },
        { provider: 'tavily', state: 'timed_out', duration_ms: 0, result_count: 0, error: { code: 'TIMEOUT' } },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/answer-sentinel|answers-sentinel|gateway-secret|gateway\.test|migration/);

    const exactPathTransport = new CaptureTransport({ status: 200, body: { results: [] } });
    await new SearchGatewayProvider({
      apiKey: 'secret', baseUrl: 'https://gateway.test/root/v1/aggregate/search/', transport: exactPathTransport,
    }).search({ query: 'q', limit: 1, signal });
    expect(exactPathTransport.requests[0]?.url).toBe('https://gateway.test/root/v1/aggregate/search');
  });

  it.each([
    {
      label: 'valid providers array', providers: ['exa', 'tavily', 'exa'], source: 'ignored',
      expected: [{ provider: 'exa' }, { provider: 'tavily' }],
    },
    {
      label: 'empty providers with source alias', providers: [], source: 'exa,tavily',
      expected: [{ provider: 'exa' }, { provider: 'tavily' }],
    },
    {
      label: 'malformed providers with source alias', providers: 'malformed', source: 'tavily,exa',
      expected: [{ provider: 'tavily' }, { provider: 'exa' }],
    },
    { label: 'absent attribution', expected: undefined },
  ])('normalizes aggregate attribution from $label', async ({ providers, source, expected }) => {
    const row: Record<string, unknown> = { title: 'Source', url: 'https://source.test/' };
    if (providers !== undefined) row['providers'] = providers;
    if (source !== undefined) row['source'] = source;
    const provider = new SearchGatewayProvider({
      apiKey: 'secret', baseUrl: 'https://gateway.test',
      transport: new CaptureTransport({ status: 200, body: { results: [row] } }),
    });
    const response = await provider.search({ query: 'q', limit: 1, signal: new AbortController().signal });
    expect(response.results[0]?.upstream_attribution).toEqual(expected);
  });

  it.each([
    [401, 'PROVIDER_AUTH', false], [403, 'PROVIDER_AUTH', false],
    [429, 'PROVIDER_RATE_LIMIT', true],
    [408, 'PROVIDER_UNAVAILABLE', true], [425, 'PROVIDER_UNAVAILABLE', true],
    [500, 'PROVIDER_UNAVAILABLE', true], [502, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true], [504, 'PROVIDER_UNAVAILABLE', true],
    [400, 'PROVIDER_UNAVAILABLE', false],
  ] as const)('maps aggregate HTTP %s to %s with retryable=%s', async (status, code, retryable) => {
    const provider = new SearchGatewayProvider({
      apiKey: 'secret', baseUrl: 'https://gateway.test',
      transport: new CaptureTransport({
        status, body: {}, ...(status === 429 ? { headers: { 'Retry-After': '2' } } : {}),
      }),
    });
    await expect(provider.search({ query: 'q', limit: 1, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code, retryable, ...(status === 429 ? { retryAfterMs: 2000 } : {}) });
  });

  it('routes relay instances through strict vendor-compatible paths and preserves provider-native auth', async () => {
    const root = await temporaryRoot();
    const transport = new QueueTransport([
      { status: 200, body: { results: [{ title: 'Exa', url: 'https://exa-result.test', text: 'exa' }] } },
      { status: 200, body: { results: [{ title: 'Tavily', url: 'https://tavily-result.test', content: 'tavily' }] } },
    ]);
    const config = loadConfiguration({ SHARED_TOKEN: 'shared-token' }, transport, {
      cwd: root, homeDirectory: root,
      config: {
        provider_instances: {
          'exa.default': { enabled: false }, 'tavily.default': { enabled: false },
          'exa.gateway': relayInstance('exa', 'exa.gateway', '/exa/search'),
          'tavily.gateway': relayInstance('tavily', 'tavily.gateway', '/api/search'),
        },
        credential_slots: {
          'exa.gateway': { provider_id: 'exa', env: 'SHARED_TOKEN' },
          'tavily.gateway': { provider_id: 'tavily', env: 'SHARED_TOKEN' },
        },
        profiles: { default: relayProfile() },
      },
    });
    await Promise.all(config.providers.map(async (provider) => await provider.search({ query: 'q', limit: 2, signal: new AbortController().signal })));
    expect(transport.requests.find((item) => item.url.endsWith('/exa/search'))).toMatchObject({
      url: 'https://gateway.test/exa/search', headers: { 'x-api-key': 'shared-token' },
      body: { query: 'q', numResults: 2 },
    });
    expect(transport.requests.find((item) => item.url.endsWith('/api/search'))).toMatchObject({
      url: 'https://gateway.test/api/search', body: { api_key: 'shared-token', query: 'q', max_results: 2, include_answer: false },
    });
  });

  it('rejects malformed paths and unknown relay options before transport', async () => {
    const root = await temporaryRoot();
    const transport = new CaptureTransport({ status: 200, body: { results: [] } });
    for (const options of [
      { search_path: '/../search' }, { search_path: '/exa/search?x=1' }, { auth_mode: 'bearer' },
    ]) {
      expect(() => loadConfiguration({ KEY: 'secret' }, transport, {
        cwd: root, homeDirectory: root,
        config: {
          provider_instances: {
            'exa.default': { base_url: 'https://gateway.test', options },
            'tavily.default': { enabled: false },
          },
          credential_slots: { 'exa.default': { provider_id: 'exa', env: 'KEY' } },
        },
      })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    }
    expect(transport.requests).toHaveLength(0);
  });

  it('keeps nested failure observational in the outer aggregate state', async () => {
    const root = await temporaryRoot();
    const transport = new CaptureTransport({
      status: 200,
      body: { results: [], attempts: [{ provider: 'exa', status: 'failed', error: 'upstream failed' }] },
    });
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, NB_SEARCH_GATEWAY_AGGREGATE: 'true',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'token',
      NB_SEARCH_GATEWAY_PROFILE: 'private-profile',
    }, { transport, config: { provider_instances: { 'grok.default': { enabled: false } } } });
    const capabilities = await composition.runtime.capabilities();
    expect(capabilities.providers.instances).toContainEqual({
      provider_id: 'search-gateway', provider_instance_id: 'search-gateway.aggregate',
      credential_slot_id: 'search-gateway.aggregate', enabled: true, ready: true, capabilities: ['retrieval'],
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/gateway\.test|private-profile|"token"|Authorization|search_path/);
    const result = await composition.runtime.search({ query: 'q' });
    expect(result).toMatchObject({
      state: 'empty', attempts: [{ provider: 'search-gateway', state: 'empty', upstream_attempts: [{ state: 'failed' }] }],
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('exhausts only aggregate retries after cutover failure', async () => {
    const root = await temporaryRoot();
    const transport = new CaptureTransport({ status: 503, body: { results: [] } });
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, NB_SEARCH_GATEWAY_AGGREGATE: 'true',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'token',
      NB_SEARCH_RETRY_BACKOFF_MS: '0',
    }, { transport, config: { provider_instances: { 'grok.default': { enabled: false } } } });
    const result = await composition.runtime.search({ query: 'q' });
    expect(result).toMatchObject({ state: 'failed', attempts: [
      { provider: 'search-gateway', attempt: 1, state: 'failed' },
      { provider: 'search-gateway', attempt: 2, state: 'failed' },
    ] });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every((item) => item.url === 'https://gateway.test/v1/aggregate/search')).toBe(true);
  });

  it('bounds hostile nested trace while preserving the outer attempt', async () => {
    const root = await temporaryRoot();
    const transport = new CaptureTransport({
      status: 200,
      body: {
        results: [{
          title: 'Source', url: 'https://source.test/', content: 'evidence',
          providers: Array.from({ length: 20 }, (_, index) => `provider-${String(index)}`),
        }],
        attempts: Array.from({ length: 50 }, (_, index) => ({
          provider: `provider-${String(index)}`, status: index % 2 === 0 ? 'failed' : 'timeout',
          error: { code: 'REMOTE', message: `secret-sentinel https://remote.test/${String(index)} ${'x'.repeat(1000)}` },
        })),
      },
    });
    const result = await createRuntimeComposition({
      NB_SEARCH_HOME: root, NB_SEARCH_GATEWAY_AGGREGATE: 'true',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'secret-sentinel',
    }, { transport, config: { provider_instances: { 'grok.default': { enabled: false } } } }).runtime.search({ query: 'q' });
    expect(result).toMatchObject({
      state: 'succeeded', attempts: [{
        provider: 'search-gateway', attempt: 1, state: 'succeeded', result_count: 1,
        upstream_attempts_omitted: expect.any(Number),
      }],
      results: [{ providers: ['search-gateway'], provenance: [{ upstream_omitted: 4 }] }],
    });
    expect((result.attempts[0]?.upstream_attempts_omitted ?? 0)).toBeGreaterThanOrEqual(18);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(JSON.stringify(result)).not.toMatch(/secret-sentinel|remote\.test/);
  });
});

class CaptureTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly response: HttpResponse) {}
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return this.response as HttpResponse<T>;
  }
}

class QueueTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responses: HttpResponse[]) {}
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('unexpected request');
    return response as HttpResponse<T>;
  }
}

function relayInstance(providerId: 'exa' | 'tavily', slot: string, searchPath: string) {
  return {
    provider_id: providerId, enabled: true, credential_slot_id: slot, base_url: 'https://gateway.test', timeout_ms: 1000,
    retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 }, options: { search_path: searchPath },
  };
}

function relayProfile() {
  return { stages: [{ kind: 'parallel' as const, invocations: [
    { provider_instance_id: 'exa.gateway', capability: 'retrieval' as const, role: 'primary', trigger: 'always' },
    { provider_instance_id: 'tavily.gateway', capability: 'retrieval' as const, role: 'primary', trigger: 'always' },
  ] }] };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-l2-'));
  roots.push(root);
  return root;
}
