import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeComposition, createSearchFromSnapshot } from '../src/app.ts';
import { loadConfiguration } from '../src/config.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { createExecutionSnapshot } from '../src/execution-snapshot.ts';
import { NbSearchError } from '../src/errors.ts';
import { compileSearchPlan } from '../src/planner.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import {
  DEFAULT_GROK_MODEL, GROK_CONTENT_MAX_BYTES, GrokProvider, grokSystemPrompt,
  parseGrokAssistantResults, parseGrokChatEnvelope, resolveGrokUrl,
} from '../src/providers.ts';
import { FetchJsonTransport, ResponseLimitError, type HttpRequest, type HttpResponse, type HttpTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('L3 Grok retrieval migration', () => {
  it('registers a retrieval-only static descriptor and validates the model-only option', () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    expect(registry.requireDescriptor('grok')).toEqual({
      provider_id: 'grok', adapter_version: 'l3', capabilities: ['retrieval'], capability_versions: { retrieval: 'l3' },
      activation: { kind: 'credential', required: true, endpoint: 'required' },
      operations: [{ capability: 'retrieval', method: 'POST', response_type: 'text', path: '/chat/completions' }],
      auth: { kind: 'bearer-header', name: 'Authorization' }, option_keys: ['model'],
      option_schema: {
        type: 'object', properties: {
          model: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' },
        }, additionalProperties: false,
      },
    });
    expect(() => registry.validate('grok.custom', grokInstance({ messages: [] }))).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => registry.validate('grok.custom', grokInstance({ model: ' bad ' }))).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('maps only the direct Grok legacy object and applies bounded policy defaults', async () => {
    const root = await temporaryRoot();
    const legacy = join(root, 'legacy.json');
    await writeFile(legacy, JSON.stringify({
      grok: {
        apiUrl: 'https://legacy.test/v1', apiKey: 'legacy-secret', model: 'legacy-model',
        baseUrl: 'https://decoy.test', apiBase: 'https://decoy2.test',
      },
      grokMultiAgent: { apiUrl: 'https://gma.test', apiKey: 'gma-secret' },
      searchLayer: {
        requestTimeoutSeconds: 12.5, providerTimeouts: { grok: 30 },
        retry: { maxAttempts: 3, backoffMs: 750 },
      },
    }));
    const resolved = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: legacy }, cwd: root, homeDirectory: root,
    });
    expect(resolved.config.provider_instances['grok.default']).toMatchObject({
      provider_id: 'grok', base_url: 'https://legacy.test/v1', timeout_ms: 12_500,
      retry: { max_attempts: 3, backoff_ms: 750, max_backoff_ms: 2_000 },
      options: { model: 'legacy-model' },
    });
    expect(resolved.secret_bindings.get('grok.default')).toMatchObject({
      value: 'legacy-secret', worker_grant: { kind: 'legacy-json', path: legacy, key: 'grok' },
    });
    expect(JSON.stringify(resolved)).not.toContain('gma-secret');
  });

  it('lets primary environment names win tolerant aliases and materializes custom model defaults', async () => {
    const root = await temporaryRoot();
    const resolved = resolveConfiguration({
      env: {
        NB_SEARCH_GROK_BASE_URL: 'https://primary.test/v1', GROK_API_URL: 'not a url',
        NB_SEARCH_GROK_API_KEY: 'primary-secret', GROK_API_KEY: 'alias-secret',
        NB_SEARCH_GROK_MODEL: 'primary-model', GROK_MODEL: ' bad ',
        NB_SEARCH_GROK_TIMEOUT_MS: '32100', SEARCH_LAYER_GROK_TIMEOUT_SECONDS: 'bad',
      },
      config: {
        provider_instances: {
          'grok.custom': {
            provider_id: 'grok', enabled: false, timeout_ms: 30_000,
            retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 }, options: {},
          },
        },
      },
      cwd: root, homeDirectory: root,
    });
    expect(resolved.config.provider_instances['grok.default']).toMatchObject({
      base_url: 'https://primary.test/v1', timeout_ms: 32_100, options: { model: 'primary-model' },
    });
    expect(resolved.config.provider_instances['grok.custom']?.options).toEqual({ model: DEFAULT_GROK_MODEL });
    expect(resolved.secret_bindings.get('grok.default')).toMatchObject({
      value: 'primary-secret', worker_grant: { kind: 'environment', name: 'NB_SEARCH_GROK_API_KEY' },
    });
    expect(JSON.stringify(resolved)).not.toContain('alias-secret');
    expect(resolved.provenance).toContainEqual({
      path: 'provider_instances.grok.custom.options.model', source: 'compatibility:grok-model-default',
    });
  });

  it('diagnoses invalid legacy aliases but rejects invalid primary and canonical values before transport', async () => {
    const root = await temporaryRoot();
    const tolerant = resolveConfiguration({
      env: { GROK_API_URL: 'file:///tmp/x', GROK_MODEL: 'bad model', SEARCH_LAYER_GROK_TIMEOUT_SECONDS: 'bad' },
      cwd: root, homeDirectory: root,
    });
    expect(tolerant.config.provider_instances['grok.default']).toMatchObject({
      timeout_ms: 30_000, options: { model: DEFAULT_GROK_MODEL },
    });
    expect(tolerant.diagnostics.filter((item) => item.code === 'LEGACY_INVALID')).toHaveLength(3);
    expect(() => loadConfiguration({
      NB_SEARCH_GROK_BASE_URL: 'https://user:pass@bad.test', NB_SEARCH_GROK_API_KEY: 'secret',
    }, new QueueTransport([]), { cwd: root, homeDirectory: root })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => loadConfiguration({}, new QueueTransport([]), {
      cwd: root, homeDirectory: root,
      config: { provider_instances: { 'grok.default': { options: { model: 'bad model' } } } },
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('materializes the direct and aggregate route matrices without rewriting explicit profiles', async () => {
    const root = await temporaryRoot();
    const unready = loadConfiguration({
      NB_SEARCH_HOME: root, NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret',
    }, new QueueTransport([]), { cwd: root, homeDirectory: root });
    expect(planRows(unready, 'default')).toEqual([
      ['exa.default', 'primary', 'always'], ['tavily.default', 'primary', 'always'],
    ]);
    expect(planRows(unready, 'fast')).toEqual([
      ['exa.default', 'primary', 'always'], ['tavily.default', 'fallback', 'empty_or_failure'],
    ]);
    const aggregateWithoutGrok = loadConfiguration({
      NB_SEARCH_HOME: root, NB_SEARCH_GATEWAY_AGGREGATE: 'true',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'gateway-secret',
    }, new QueueTransport([]), { cwd: root, homeDirectory: root });
    expect(planRows(aggregateWithoutGrok, 'deep')).toEqual([['search-gateway.aggregate', 'primary', 'always']]);
    const direct = loadConfiguration(readyEnvironment(root), new QueueTransport([]), { cwd: root, homeDirectory: root });
    expect(planRows(direct, 'default')).toEqual([
      ['exa.default', 'primary', 'always'], ['tavily.default', 'primary', 'always'], ['grok.default', 'primary', 'always'],
    ]);
    expect(planRows(direct, 'fast')).toEqual([
      ['exa.default', 'primary', 'always'], ['tavily.default', 'fallback', 'empty_or_failure'], ['grok.default', 'fallback', 'empty_or_failure'],
    ]);

    const aggregate = loadConfiguration({
      ...readyEnvironment(root), NB_SEARCH_GATEWAY_AGGREGATE: 'true',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'gateway-secret',
    }, new QueueTransport([]), { cwd: root, homeDirectory: root });
    expect(planRows(aggregate, 'deep')).toEqual([
      ['search-gateway.aggregate', 'primary', 'always'], ['grok.default', 'primary', 'always'],
    ]);
    expect(planRows(aggregate, 'fast')).toEqual([
      ['search-gateway.aggregate', 'primary', 'always'], ['grok.default', 'fallback', 'empty_or_failure'],
    ]);

    const explicit = { stages: [{ kind: 'parallel' as const, invocations: [{
      provider_instance_id: 'grok.default', capability: 'retrieval' as const, role: 'only', trigger: 'always',
    }] }] };
    const authored = resolveConfiguration({
      env: readyEnvironment(root), config: { profiles: { default: explicit } }, cwd: root, homeDirectory: root,
    });
    expect(authored.config.profiles['default']).toEqual(explicit);
  });

  it('routes compatibility profiles through the configured Grok credential slot identity', async () => {
    const root = await temporaryRoot();
    const transport = new QueueTransport([
      grokSuccess('https://default.test'), grokSuccess('https://deep.test'), grokSuccess('https://fast.test'),
    ]);
    const composition = createRuntimeComposition({ NB_SEARCH_HOME: root, CUSTOM_GROK_KEY: 'custom-secret' }, {
      transport,
      config: {
        provider_instances: {
          'exa.default': { enabled: false }, 'tavily.default': { enabled: false },
          'grok.default': {
            base_url: 'https://custom-slot-relay.test/v1', credential_slot_id: 'grok.custom',
          },
        },
        credential_slots: { 'grok.custom': { provider_id: 'grok', env: 'CUSTOM_GROK_KEY' } },
      },
    });
    for (const profile of ['default', 'deep', 'fast'] as const) {
      expect(planRows(composition.config, profile)).toEqual([['grok.default', 'primary', 'always']]);
    }
    const capabilities = await composition.runtime.capabilities();
    for (const profile of ['default', 'deep', 'fast'] as const) {
      expect(capabilities.profiles).toContainEqual({ profile_id: profile, ready: true, stage_count: 1 });
      await expect(composition.runtime.search({ query: 'q', profile })).resolves.toMatchObject({
        state: 'succeeded', attempts: [{ provider: 'grok', credential_slot_id: 'grok.custom', state: 'succeeded' }],
      });
    }
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests.every((request) => request.headers?.['Authorization'] === 'Bearer custom-secret')).toBe(true);
  });

  it('sends the exact bounded request with a retry-stable clock anchor and projects typed rows', async () => {
    const signal = new AbortController().signal;
    const transport = new QueueTransport([{ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      choices: [{ message: { content: '<think>hidden</think>```json\n' + JSON.stringify({ results: [
        { title: '  First  title ', url: 'https://Example.test/a/?utm_source=x#fragment', snippet: ' one  two ', published_date: '2026-02-28' },
        { title: 'duplicate', url: 'https://example.test/a', snippet: 'ignored' },
        { title: 9, url: 'http://127.0.0.1/private', snippet: false, published_date: '2026-02-30' },
      ] }) + '\n```' } }],
    }) }]);
    const provider = new GrokProvider({
      apiKey: 'secret-sentinel', baseUrl: 'https://relay.test/v1/', model: 'grok-4.1-fast', transport,
      clock: () => new Date('2099-01-01T00:00:00.000Z'),
    });
    const results = await provider.search({
      query: 'latest <x>&</query>', limit: 4, freshness: 'pw', signal,
      request_time_utc: '2026-08-30T03:04:59.000Z',
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toEqual({
      url: 'https://relay.test/v1/chat/completions', method: 'POST',
      headers: { Authorization: 'Bearer secret-sentinel', 'Content-Type': 'application/json' },
      body: {
        model: 'grok-4.1-fast', messages: [
          { role: 'system', content: grokSystemPrompt(4) },
          { role: 'user', content: '\n[Current time: 2026-08-30 03:04 UTC]\n<query>latest &lt;x&gt;&amp;&lt;/query&gt;</query>\nFocus on results from the past week.' },
        ], max_tokens: 2048, temperature: 0.1, stream: false,
      },
      response_type: 'text', max_response_bytes: 1_048_576, signal,
    });
    expect(results).toEqual([
      {
        title: 'First title', url: 'https://Example.test/a/?utm_source=x#fragment', snippet: 'one two', published_at: '2026-02-28',
        metadata: { retrieval_protocol: 'chat-completions', model: 'grok-4.1-fast', freshness_mode: 'prompt-hint', freshness: 'pw' },
      },
      {
        title: '', url: 'http://127.0.0.1/private', snippet: '',
        metadata: { retrieval_protocol: 'chat-completions', model: 'grok-4.1-fast', freshness_mode: 'prompt-hint', freshness: 'pw' },
      },
    ]);
  });

  it('parses JSON parts, legacy text, bounded SSE, fences, prose, and braces in strings', () => {
    expect(parseGrokChatEnvelope(JSON.stringify({ choices: [{ message: { content: ['a', { text: 'b' }, 3] }, text: 'fallback' }] }))).toBe('a b');
    expect(parseGrokChatEnvelope(JSON.stringify({ choices: [{ text: '{"results":[]}' }] }))).toBe('{"results":[]}');
    const sse = [
      ': comment', 'event: message', 'data: {"choices":[{"delta":{"content":"prefix "}}]}', '',
      'data: malformed', '',
      'data: {"choices":[{"message":{"content":"{\\"results\\":[{\\"title\\":\\"a\\",\\"url\\":\\"https://a.test?q={x}\\"}]}"}}]}', '',
      'data: [DONE]', '', 'data: {"choices":[{"text":"decoy"}]}', '',
    ].join('\r\n');
    const content = parseGrokChatEnvelope(sse, { 'CONTENT-TYPE': 'Text/Event-Stream; charset=utf-8' });
    expect(content).toContain('prefix {"results"');
    expect(parseGrokAssistantResults(content)).toEqual([{ title: 'a', url: 'https://a.test?q={x}' }]);
    expect(parseGrokAssistantResults('prose ``` is ignored {"results":[]} suffix')).toEqual([]);
  });

  it('distinguishes empty, malformed, and over-limit successful content with fixed retryability', async () => {
    const empty = new GrokProvider({
      apiKey: 'secret', baseUrl: 'https://relay.test', model: 'grok',
      transport: new QueueTransport([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"results":[]}' } }] }) }]),
    });
    await expect(empty.search(providerRequest())).resolves.toEqual([]);
    const malformed = new GrokProvider({
      apiKey: 'secret', baseUrl: 'https://relay.test', model: 'grok',
      transport: new QueueTransport([{ status: 200, body: JSON.stringify({ choices: [] }) }]),
    });
    await expect(malformed.search(providerRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, message: 'grok returned malformed retrieval content.' });
    const overflow = new GrokProvider({
      apiKey: 'secret', baseUrl: 'https://relay.test', model: 'grok',
      transport: new QueueTransport([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'x'.repeat(GROK_CONTENT_MAX_BYTES + 1) } }] }) }]),
    });
    await expect(overflow.search(providerRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, message: 'grok response exceeded the retrieval limit.' });
    const marker = new GrokProvider({
      apiKey: 'secret', baseUrl: 'https://relay.test', model: 'grok', transport: new ThrowTransport(new ResponseLimitError(1_048_576)),
    });
    await expect(marker.search(providerRequest())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it('provider-tags the Fetch transport connection error without changing its typed semantics', async () => {
    const provider = new GrokProvider({
      apiKey: 'connection-secret', baseUrl: 'https://connection-relay.test', model: 'grok',
      transport: new ThrowTransport(new NbSearchError(
        'PROVIDER_UNAVAILABLE', 'Provider connection failed.', true, undefined,
        { cause: new Error('connection-secret https://connection-relay.test refused') },
      )),
    });
    const error = await provider.search(providerRequest()).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NbSearchError);
    const publicError = (error as NbSearchError).toPublic();
    expect(publicError).toEqual({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, provider: 'grok', message: 'grok provider connection failed.',
    });
    expect(JSON.stringify(publicError)).not.toMatch(/connection-secret|connection-relay|refused/);
  });

  it('maps retries and Retry-After through the executor without an adapter retry loop', async () => {
    const root = await temporaryRoot();
    const transport = new QueueTransport([
      { status: 429, headers: { 'Retry-After': '0' }, body: '' },
      grokSuccess('https://result.test'),
    ]);
    let tick = 0;
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, NB_SEARCH_GROK_BASE_URL: 'https://relay.test/v1', NB_SEARCH_GROK_API_KEY: 'secret',
    }, {
      transport,
      now: () => new Date(Date.UTC(2026, 7, 30, 3, 4 + tick++, 59)),
      config: { provider_instances: { 'exa.default': { enabled: false }, 'tavily.default': { enabled: false } } },
    });
    const result = await composition.runtime.search({ query: 'latest release' });
    expect(result).toMatchObject({ state: 'succeeded', attempts: [
      { provider: 'grok', attempt: 1, state: 'failed', error: { code: 'PROVIDER_RATE_LIMIT', retry_after_ms: 0 } },
      { provider: 'grok', attempt: 2, state: 'succeeded' },
    ] });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.body).toEqual(transport.requests[1]?.body);
    expect(JSON.stringify(transport.requests[0]?.body)).toContain('2026-08-30 03:04 UTC');
  });

  it('propagates the executor signal and preserves caller cancellation without a health-style retry', async () => {
    const root = await temporaryRoot();
    const transport = new WaitingTransport();
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, NB_SEARCH_GROK_BASE_URL: 'https://relay.test', NB_SEARCH_GROK_API_KEY: 'secret',
    }, {
      transport,
      config: { provider_instances: { 'exa.default': { enabled: false }, 'tavily.default': { enabled: false } } },
    });
    const controller = new AbortController();
    const operation = composition.runtime.search({ query: 'q' }, { signal: controller.signal });
    await transport.started;
    controller.abort(new Error('caller stop sentinel'));
    await expect(operation).resolves.toMatchObject({
      state: 'cancelled', attempts: [{ provider: 'grok', attempt: 1, state: 'cancelled', error: { code: 'CANCELLED' } }],
      error: { code: 'CANCELLED' },
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.signal.aborted).toBe(true);
  });

  it('freezes and replays route, model, policy, descriptor, and grant identity without secret bytes', async () => {
    const root = await temporaryRoot();
    const config = loadConfiguration({
      NB_SEARCH_GROK_BASE_URL: 'https://snapshot.test/v1', NB_SEARCH_GROK_API_KEY: 'secret-A', NB_SEARCH_GROK_MODEL: 'model-A',
    }, new QueueTransport([]), {
      cwd: root, homeDirectory: root,
      config: { provider_instances: { 'exa.default': { enabled: false }, 'tavily.default': { enabled: false } } },
    });
    const plan = compileSearchPlan({
      config: config.resolved.config, registry: config.registry, readiness: config.provider_readiness, profile_id: 'default',
    });
    const snapshot = createExecutionSnapshot(plan, config.resolved, config.registry, { profile: 'default', freshness: 'pm' });
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({
      snapshot_version: '4', artifact_contract_version: '3', routing: { profile: 'default', freshness: 'pm' },
      provider_instances: [{ provider_instance_id: 'grok.default', config: {
        provider_id: 'grok', base_url: 'https://snapshot.test/v1', options: { model: 'model-A' }, timeout_ms: 30_000,
      } }],
      credential_bindings: [{ credential_slot_id: 'grok.default', provider_id: 'grok', worker_grant: { kind: 'environment', name: 'NB_SEARCH_GROK_API_KEY' } }],
    });
    expect(serialized).not.toContain('secret-A');
    const replayTransport = new QueueTransport([grokSuccess('https://replay.test')]);
    const search = createSearchFromSnapshot(snapshot, {
      NB_SEARCH_GROK_API_KEY: 'secret-B', NB_SEARCH_GROK_BASE_URL: 'https://live-drift.test', NB_SEARCH_GROK_MODEL: 'model-B',
    }, { transport: replayTransport });
    await search.search({ query: 'q' });
    expect(replayTransport.requests[0]).toMatchObject({
      url: 'https://snapshot.test/v1/chat/completions', headers: { Authorization: 'Bearer secret-B' }, body: { model: 'model-A' },
    });
    expect(JSON.stringify(replayTransport.requests[0])).not.toContain('live-drift.test');
  });

  it('reports safe configured capability and omits endpoint, model, grant, policy, prompt, and query', async () => {
    const root = await temporaryRoot();
    const transport = new QueueTransport([]);
    const capabilities = await createRuntimeComposition({
      NB_SEARCH_HOME: root, NB_SEARCH_GROK_BASE_URL: 'https://private-relay.test',
      NB_SEARCH_GROK_API_KEY: 'private-secret', NB_SEARCH_GROK_MODEL: 'private-model',
    }, { transport }).runtime.capabilities();
    expect(capabilities.providers.grok).toEqual({ configured: true });
    expect(capabilities.providers.instances).toContainEqual({
      provider_id: 'grok', provider_instance_id: 'grok.default', credential_slot_id: 'grok.default',
      enabled: true, ready: true, capabilities: ['retrieval'], ready_capabilities: ['retrieval'],
    });
    expect(transport.requests).toHaveLength(0);
    expect(JSON.stringify(capabilities)).not.toMatch(/private-relay|private-secret|private-model|NB_SEARCH_GROK|chat\/completions/);
  });

  it('normalizes base and full endpoints without a duplicate suffix', () => {
    expect(resolveGrokUrl('https://api.x.ai/v1')).toBe('https://api.x.ai/v1/chat/completions');
    expect(resolveGrokUrl('https://relay.test/root/')).toBe('https://relay.test/root/chat/completions');
    expect(resolveGrokUrl('https://relay.test/root/chat/completions/')).toBe('https://relay.test/root/chat/completions');
  });

  it('enforces declared and streamed response caps and does not consume capped non-2xx bodies', async () => {
    const transport = new FetchJsonTransport();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abcd', { status: 200, headers: { 'Content-Length': '4' } })));
    await expect(transport.send({
      url: 'https://relay.test', method: 'POST', response_type: 'text', max_response_bytes: 3,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ResponseLimitError);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('abcd')); controller.close(); },
    }), { status: 200 })));
    await expect(transport.send({
      url: 'https://relay.test', method: 'POST', response_type: 'text', max_response_bytes: 3,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ResponseLimitError);

    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull() { /* A non-2xx capped response must not read. */ }, cancel() { cancelled = true; },
    }), { status: 503 })));
    await expect(transport.send<string>({
      url: 'https://relay.test', method: 'POST', response_type: 'text', max_response_bytes: 3,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 503, body: '' });
    expect(cancelled).toBe(true);
    vi.unstubAllGlobals();
  });
});

function readyEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    NB_SEARCH_HOME: root,
    NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret',
    NB_SEARCH_GROK_BASE_URL: 'https://grok.test/v1', NB_SEARCH_GROK_API_KEY: 'grok-secret',
  };
}

function planRows(config: ReturnType<typeof loadConfiguration>, profile: string): string[][] {
  const plan = compileSearchPlan({ config: config.resolved.config, registry: config.registry, readiness: config.provider_readiness, profile_id: profile });
  return plan.stages[0]?.invocations.map((item) => [item.provider_instance_id, item.role, item.trigger]) ?? [];
}

function grokInstance(options: Record<string, unknown>) {
  return {
    provider_id: 'grok', enabled: true, credential_slot_id: 'grok.custom', base_url: 'https://grok.test/v1', timeout_ms: 30_000,
    retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 }, options,
  };
}

function providerRequest() {
  return { query: 'q', limit: 3, signal: new AbortController().signal, request_time_utc: '2026-08-30T03:04:59.000Z' };
}

function grokSuccess(url: string): HttpResponse<string> {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [{ title: 'r', url, snippet: 's' }] }) } }] }) };
}

class QueueTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responses: HttpResponse[]) {}
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(structuredCloneRequest(request));
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No queued response.');
    return response as HttpResponse<T>;
  }
}

class ThrowTransport implements HttpTransport {
  constructor(private readonly error: Error) {}
  async send<T>(_request: HttpRequest): Promise<HttpResponse<T>> { throw this.error; }
}

class WaitingTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  private start!: () => void;
  readonly started = new Promise<void>((resolve) => { this.start = resolve; });
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    this.start();
    return await new Promise<HttpResponse<T>>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  }
}

function structuredCloneRequest(request: HttpRequest): HttpRequest {
  return { ...request, headers: structuredClone(request.headers), body: structuredClone(request.body), signal: request.signal };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-l3-'));
  roots.push(root);
  return root;
}
