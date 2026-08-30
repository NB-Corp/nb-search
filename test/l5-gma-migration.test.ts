import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeComposition, createSearchFromSnapshot } from '../src/app.ts';
import type { CanonicalConfigPatch, RetryPolicyConfig } from '../src/config-schema.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { researchReadInputSchema, searchInputSchema } from '../src/contracts.ts';
import { JobStore } from '../src/job-store.ts';
import { compileSearchPlan, PlanExecutor, type SearchPlan } from '../src/planner.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import { resolveSnapshotBindings, type ExecutionSnapshot } from '../src/execution-snapshot.ts';
import { ResearchRunner, ResearchService } from '../src/research.ts';
import { GrokMultiAgentProvider } from '../src/providers.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe('L5 Grok multi-agent research migration', () => {
  it('maps legacy activation, strict environment precedence, and compatible endpoint/grant inheritance without secret projection', async () => {
    const home = await temporaryRoot();
    const legacy = join(home, 'legacy.json');
    await writeFile(legacy, JSON.stringify({
      grok: { apiUrl: 'https://direct.legacy/v1', apiKey: 'direct-legacy' },
      grokMultiAgent: { apiUrl: 'https://gma.legacy/v1', apiKey: 'gma-legacy', model: 'legacy-model', reasoningEffort: 'medium', replaceGrokWithMultiAgent: true },
      searchLayer: { providerTimeouts: { grokMultiAgent: 222 }, retry: { maxAttempts: 3, backoffMs: 700 } },
    }));
    const own = resolveConfiguration({
      cwd: home, homeDirectory: home,
      env: {
        SEARCH_LAYER_CREDENTIALS: legacy,
        GROK_MULTI_AGENT_MODEL: 'alias-model', NB_SEARCH_GROK_MULTI_AGENT_MODEL: 'primary-model',
        GROK_MULTI_AGENT_EFFORT: 'low', NB_SEARCH_GROK_MULTI_AGENT_EFFORT: 'high',
        GROK_MULTI_AGENT_REPLACE: 'true', NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'false',
        SEARCH_LAYER_GROK_MULTI_AGENT_TIMEOUT_SECONDS: '230', NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '240000',
      },
    });
    expect(own.config.provider_instances['grok-multi-agent.default']).toMatchObject({
      provider_id: 'grok-multi-agent', enabled: true, base_url: 'https://gma.legacy/v1', timeout_ms: 240_000,
      options: { model: 'primary-model', reasoning_effort: 'high', replace_grok: false },
      retry: { max_attempts: 3, backoff_ms: 700, max_backoff_ms: 2_000 },
    });
    expect(own.secret_bindings.get('grok-multi-agent.default')).toMatchObject({
      provider_id: 'grok-multi-agent', value: 'gma-legacy', worker_grant: { kind: 'legacy-json', key: 'grokMultiAgent' },
    });

    const inherited = resolveConfiguration({
      cwd: home, homeDirectory: home,
      env: {
        NB_SEARCH_GROK_BASE_URL: 'https://direct.env/v1', NB_SEARCH_GROK_API_KEY: 'direct-secret',
        NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true',
      },
    });
    expect(inherited.config.provider_instances['grok-multi-agent.default']?.base_url).toBe('https://direct.env/v1');
    expect(inherited.secret_bindings.get('grok-multi-agent.default')).toMatchObject({
      credential_slot_id: 'grok-multi-agent.default', provider_id: 'grok-multi-agent', value: 'direct-secret',
      inherited_from_slot_id: 'grok.default', worker_grant: { kind: 'environment', name: 'NB_SEARCH_GROK_API_KEY' },
    });
    expect(JSON.stringify(inherited.config)).not.toContain('direct-secret');
    expect(() => resolveConfiguration({ env: { NB_SEARCH_GROK_MULTI_AGENT_EFFORT: 'ultra' }, cwd: home, homeDirectory: home })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('derives expected agent tiers from validated effort and ignores response-authored telemetry', async () => {
    for (const [effort, expected] of [['low', 4], ['medium', 4], ['high', 16], ['xhigh', 16]] as const) {
      const provider = new GrokMultiAgentProvider({
        apiKey: 'sentinel', baseUrl: 'https://relay.test/v1', model: 'grok-4.20-multi-agent-xhigh', reasoningEffort: effort,
        transport: new GmaTransport(), providerInstanceId: 'grok-multi-agent.default', credentialSlotId: 'grok-multi-agent.default',
      });
      const result = await provider.research({
        capability: 'multi-agent-research', query: 'q', brief: 'q', limit: 5, profile: 'deep', intent: 'comparison',
        request_time_utc: '2026-08-30T00:00:00.000Z', signal: new AbortController().signal,
      });
      expect(result.expected_agent_count).toBe(expected);
      expect(result.backend_trace_observable).toBe(false);
      expect(result).not.toHaveProperty('actual_agent_count');
    }
  });

  it('treats blank answers as absent and rejects answer bytes above the exact semantic boundary', async () => {
    const exactAscii = await gmaProviderWithContent({ answer: 'a'.repeat(12_000) }).research(gmaRequest());
    expect(exactAscii).toMatchObject({ completeness: 'partial', answer: 'a'.repeat(12_000) });
    const exactMultibyte = await gmaProviderWithContent({ answer: '界'.repeat(4_000) }).research(gmaRequest());
    expect(Buffer.byteLength(exactMultibyte.answer!, 'utf8')).toBe(12_000);
    expect((await gmaProviderWithContent({ answer: '   ' }).research(gmaRequest())).completeness).toBe('empty');
    await expect(gmaProviderWithContent({ answer: '界'.repeat(4_001) }).research(gmaRequest())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: false, provider: 'grok-multi-agent',
    });
  });

  it('omits a whole conflict when either provided semantic field is sensitive and accepts missing optional fields', async () => {
    const result = await gmaProviderWithContent({
      conflicts: [
        { topic: 'topic only' },
        { description: 'description only' },
        { topic: 'safe topic', description: 'contains secret-sentinel' },
        { topic: 'secret-sentinel', description: 'safe description' },
      ],
    }, 'secret-sentinel').research(gmaRequest());
    expect(result.trace.conflicts).toEqual([
      { topic: 'topic only', description: '', evidence_urls: [] },
      { topic: '', description: 'description only', evidence_urls: [] },
    ]);
    expect(result.trace.omissions.sensitive_semantic_items).toBe(2);
    expect(JSON.stringify(result)).not.toContain('contains secret-sentinel');
  });

  it('inherits disabled direct-Grok endpoint and grants without making direct Grok ready, and applies the standalone legacy request cap', async () => {
    const home = await temporaryRoot();
    const legacyPath = join(home, 'legacy.json');
    await writeFile(legacyPath, JSON.stringify({
      grok: { apiUrl: 'https://disabled-direct.test/v1', apiKey: 'legacy-direct-secret' },
      grokMultiAgent: { model: 'legacy-gma-model' },
    }));
    const legacy = createRuntimeComposition({ SEARCH_LAYER_CREDENTIALS: legacyPath, SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: '100' }, {
      cwd: home, homeDirectory: home, transport: new GmaTransport(), launcher: { async launch() {} },
      config: { provider_instances: { 'grok.default': { enabled: false } } },
    });
    expect(legacy.config.resolved.config.provider_instances['grok-multi-agent.default']).toMatchObject({
      enabled: true, base_url: 'https://disabled-direct.test/v1', timeout_ms: 100_000,
    });
    expect(legacy.config.resolved.secret_bindings.get('grok-multi-agent.default')).toMatchObject({
      value: 'legacy-direct-secret', inherited_from_slot_id: 'grok.default',
      worker_grant: { kind: 'legacy-json', key: 'grok' },
    });
    expect(legacy.config.provider_readiness['grok.default']).toBe(false);
    expect(legacy.config.provider_readiness['grok-multi-agent.default']).toBe(true);
    expect(JSON.stringify(legacy.config.resolved.config)).not.toContain('legacy-direct-secret');
    const hostGrant = resolveConfiguration({
      cwd: home, homeDirectory: home, env: { HOST_DIRECT_KEY: 'host-direct-secret' },
      config: {
        provider_instances: {
          'grok.default': { enabled: false, base_url: 'https://host-direct.test/v1' },
          'grok-multi-agent.default': { enabled: true },
        },
        credential_slots: { 'grok.default': { provider_id: 'grok', env: 'HOST_DIRECT_KEY' } },
      },
    });
    expect(hostGrant.secret_bindings.get('grok-multi-agent.default')).toMatchObject({
      value: 'host-direct-secret', inherited_from_slot_id: 'grok.default', worker_grant: { kind: 'environment', name: 'HOST_DIRECT_KEY' },
    });

    const receipt = await legacy.runtime.researchStart({ query: 'opaque replay', profile: 'deep', intent: 'comparison' });
    const opaqueSnapshot = structuredClone((await legacy.store.readExecutionSnapshot(receipt.job.job_id))!);
    const opaqueBinding = opaqueSnapshot.credential_bindings.find((item) => item.credential_slot_id === 'grok-multi-agent.default')!;
    opaqueBinding.worker_grant = { kind: 'opaque', id: 'host-opaque-gma' };
    expect(resolveSnapshotBindings(opaqueSnapshot, {}, { 'host-opaque-gma': 'opaque-secret' }).get('grok-multi-agent.default')).toMatchObject({
      value: 'opaque-secret', inherited_from_slot_id: 'grok.default', worker_grant: { kind: 'opaque', id: 'host-opaque-gma' },
    });

    const invalidCap = resolveConfiguration({
      cwd: home, homeDirectory: home,
      env: { SEARCH_LAYER_CREDENTIALS: legacyPath, SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: 'invalid' },
      config: { provider_instances: { 'grok.default': { enabled: false } } },
    });
    expect(invalidCap.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(240_000);
    expect(invalidCap.diagnostics).toContainEqual(expect.objectContaining({ source: 'environment', message: 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS was invalid and was ignored.' }));
    const primaryWins = resolveConfiguration({
      cwd: home, homeDirectory: home,
      env: { SEARCH_LAYER_CREDENTIALS: legacyPath, SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: '100', NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '260000' },
      config: { provider_instances: { 'grok.default': { enabled: false } } },
    });
    expect(primaryWins.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(260_000);
  });

  it('retains the environment request cap through later canonical, environment, host, and runtime activation without enabling an inactive GMA', async () => {
    const home = await temporaryRoot();
    const requestCapEnv = { SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: '100', HOST_GMA_KEY: 'host-secret' };
    const inactive = resolveConfiguration({ cwd: home, homeDirectory: home, env: requestCapEnv });
    expect(inactive.config.provider_instances['grok-multi-agent.default']).toMatchObject({ enabled: false, timeout_ms: 240_000 });

    const canonicalPath = join(home, 'canonical-cap.json');
    await writeFile(canonicalPath, JSON.stringify({
      provider_instances: { 'grok-multi-agent.default': { enabled: true, base_url: 'https://canonical-cap.test' } },
      credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'HOST_GMA_KEY' } },
    }));
    const canonical = resolveConfiguration({ cwd: home, homeDirectory: home, env: { ...requestCapEnv, NB_SEARCH_CONFIG: canonicalPath } });
    expect(canonical.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(100_000);

    const environment = resolveConfiguration({ cwd: home, homeDirectory: home, env: {
      ...requestCapEnv, NB_SEARCH_GROK_MULTI_AGENT_MODEL: 'environment-activates-gma',
    } });
    expect(environment.config.provider_instances['grok-multi-agent.default']).toMatchObject({ enabled: true, timeout_ms: 100_000 });

    const hostBase: CanonicalConfigPatch = {
      provider_instances: { 'grok-multi-agent.default': { enabled: true, base_url: 'https://host-cap.test' } },
      credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'HOST_GMA_KEY' } },
    };
    const host = resolveConfiguration({ cwd: home, homeDirectory: home, env: requestCapEnv, config: hostBase });
    expect(host.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(100_000);
    const invalidHost = resolveConfiguration({ cwd: home, homeDirectory: home, env: { ...requestCapEnv, SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: 'invalid' }, config: hostBase });
    expect(invalidHost.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(240_000);
    expect(invalidHost.diagnostics).toContainEqual(expect.objectContaining({ message: 'SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS was invalid and was ignored.' }));
    const hostExplicit = resolveConfiguration({ cwd: home, homeDirectory: home, env: requestCapEnv, config: {
      ...hostBase, provider_instances: { 'grok-multi-agent.default': { enabled: true, base_url: 'https://host-cap.test', timeout_ms: 180_000 } },
    } });
    expect(hostExplicit.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(180_000);

    const runtime = resolveConfiguration({
      cwd: home, homeDirectory: home, env: requestCapEnv,
      config: {
        provider_instances: { 'grok-multi-agent.default': { enabled: false, base_url: 'https://runtime-cap.test' } },
        credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'HOST_GMA_KEY' } },
      },
      overrides: { provider_instances: { 'grok-multi-agent.default': { enabled: true } } },
    });
    expect(runtime.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(100_000);
    const runtimeExplicit = resolveConfiguration({
      cwd: home, homeDirectory: home, env: requestCapEnv, config: hostBase,
      overrides: { provider_instances: { 'grok-multi-agent.default': { timeout_ms: 190_000 } } },
    });
    expect(runtimeExplicit.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(190_000);

    const primary = resolveConfiguration({ cwd: home, homeDirectory: home, env: {
      ...requestCapEnv, NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true', NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '260000',
    } });
    expect(primary.config.provider_instances['grok-multi-agent.default']?.timeout_ms).toBe(260_000);
  });

  it('applies every adjacent GMA source edge through runtime and atomically replaces the winning slot', async () => {
    const home = await temporaryRoot();
    const legacyPath = join(home, 'legacy.json');
    const canonicalPath = join(home, 'config.json');
    await writeFile(legacyPath, JSON.stringify({ grokMultiAgent: {
      apiUrl: 'https://legacy-gma.test', apiKey: 'legacy-secret', model: 'legacy-model', reasoningEffort: 'low', replaceGrokWithMultiAgent: true,
    }, searchLayer: { providerTimeouts: { grokMultiAgent: 210 } } }));
    await writeFile(canonicalPath, JSON.stringify({
      provider_instances: { 'grok-multi-agent.default': { enabled: true, base_url: 'https://canonical-gma.test', timeout_ms: 220_000, options: { model: 'canonical-model', reasoning_effort: 'medium', replace_grok: false } } },
      credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'CANONICAL_GMA_KEY' } },
    }));
    const base = { cwd: home, homeDirectory: home };
    const defaults = resolveConfiguration({ ...base, env: {} });
    expect(defaults.config.provider_instances['grok-multi-agent.default']).toMatchObject({ enabled: false, timeout_ms: 240_000, options: { model: 'grok-4.20-multi-agent-xhigh', reasoning_effort: 'xhigh', replace_grok: false } });
    const legacy = resolveConfiguration({ ...base, env: { SEARCH_LAYER_CREDENTIALS: legacyPath } });
    expect(gmaConfigTuple(legacy)).toEqual(['https://legacy-gma.test', 'legacy-model', 'low', true, 210_000, 'legacy-secret']);
    const canonical = resolveConfiguration({ ...base, env: { SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath, CANONICAL_GMA_KEY: 'canonical-secret' } });
    expect(gmaConfigTuple(canonical)).toEqual(['https://canonical-gma.test', 'canonical-model', 'medium', false, 220_000, 'canonical-secret']);
    const environment = resolveConfiguration({ ...base, env: {
      SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath, CANONICAL_GMA_KEY: 'canonical-secret',
      NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: 'https://environment-gma.test', NB_SEARCH_GROK_MULTI_AGENT_API_KEY: 'environment-secret',
      NB_SEARCH_GROK_MULTI_AGENT_MODEL: 'environment-model', NB_SEARCH_GROK_MULTI_AGENT_EFFORT: 'high',
      NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'true', NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '230000',
      HOST_GMA_KEY: 'host-secret', RUNTIME_GMA_KEY: 'runtime-secret',
    } });
    expect(gmaConfigTuple(environment)).toEqual(['https://environment-gma.test', 'environment-model', 'high', true, 230_000, 'environment-secret']);
    const commonEnv = {
      SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath, CANONICAL_GMA_KEY: 'canonical-secret',
      NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: 'https://environment-gma.test', NB_SEARCH_GROK_MULTI_AGENT_API_KEY: 'environment-secret',
      NB_SEARCH_GROK_MULTI_AGENT_MODEL: 'environment-model', NB_SEARCH_GROK_MULTI_AGENT_EFFORT: 'high',
      NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'true', NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '230000',
      HOST_GMA_KEY: 'host-secret', RUNTIME_GMA_KEY: 'runtime-secret',
    };
    const hostPatch = {
      provider_instances: { 'grok-multi-agent.default': { base_url: 'https://host-gma.test', timeout_ms: 240_000, options: { model: 'host-model', reasoning_effort: 'xhigh', replace_grok: false } } },
      credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent' as const, env: 'HOST_GMA_KEY' } },
    };
    const host = resolveConfiguration({ ...base, env: commonEnv, config: hostPatch });
    expect(gmaConfigTuple(host)).toEqual(['https://host-gma.test', 'host-model', 'xhigh', false, 240_000, 'host-secret']);
    const runtime = resolveConfiguration({ ...base, env: commonEnv, config: hostPatch, overrides: {
      provider_instances: { 'grok-multi-agent.default': { base_url: 'https://runtime-gma.test', timeout_ms: 250_000, options: { model: 'runtime-model', reasoning_effort: 'low', replace_grok: true } } },
      credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'RUNTIME_GMA_KEY' } },
    } });
    expect(gmaConfigTuple(runtime)).toEqual(['https://runtime-gma.test', 'runtime-model', 'low', true, 250_000, 'runtime-secret']);
  });

  it('keeps synchronous search GMA-free and materializes exact async direct replacement and overlay plans', async () => {
    for (const replace of [true, false]) {
      const home = await temporaryRoot();
      const transport = new GmaTransport();
      const app = composition(home, transport, replace);
      const sync = await app.runtime.search({ query: 'compare sync', profile: 'deep', intent: 'comparison' });
      expect(sync.state).toBe('succeeded');
      expect(transport.models).not.toContain('grok-4.20-multi-agent-xhigh');
      expect(sync.augmentations?.map((item) => item.capability)).toEqual(['research-light']);

      const receipt = await app.runtime.researchStart({ query: 'compare async', profile: 'deep', intent: 'comparison', max_sources: 5 });
      const snapshot = await app.store.readExecutionSnapshot(receipt.job.job_id);
      expect(snapshot).toBeDefined();
      expect(snapshot?.plan).toMatchObject({
        plan_version: '3', routing: { execution_surface: 'research-job', multi_agent_route: replace ? 'replacement' : 'overlay' },
      });
      expect(snapshot?.plan.stages.flatMap((stage) => stage.invocations).map((item) => `${item.provider_instance_id}:${item.capability}`)).toEqual(
        replace
          ? ['exa.default:retrieval', 'tavily.default:retrieval', 'grok-multi-agent.default:multi-agent-research']
          : ['exa.default:retrieval', 'tavily.default:retrieval', 'grok.default:retrieval', 'grok-multi-agent.default:multi-agent-research'],
      );
      expect(snapshot?.plan.stages.flatMap((stage) => stage.invocations).some((item) => item.capability === 'research-light')).toBe(false);
      expect(snapshot).toMatchObject({ snapshot_version: '4', artifact_contract_version: '3' });
      expect(snapshot?.provider_instances.find((item) => item.provider_instance_id === 'grok-multi-agent.default')).toMatchObject({
        connection_origin: { kind: 'inherited', provider_instance_id: 'grok.default' },
      });
      expect(snapshot?.credential_bindings.find((item) => item.credential_slot_id === 'grok-multi-agent.default')).toMatchObject({
        provider_id: 'grok-multi-agent', inherited_from_slot_id: 'grok.default',
        worker_grant: { kind: 'environment', name: 'NB_SEARCH_GROK_API_KEY' },
      });
      expect(JSON.stringify(snapshot)).not.toContain('direct-secret');
    }

    const aggregateHome = await temporaryRoot();
    const aggregate = createRuntimeComposition({
      NB_SEARCH_HOME: aggregateHome, NB_SEARCH_EXA_API_KEY: 'exa', NB_SEARCH_TAVILY_API_KEY: 'tavily',
      NB_SEARCH_GROK_BASE_URL: 'https://direct.test/v1', NB_SEARCH_GROK_API_KEY: 'direct',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'gateway', NB_SEARCH_GATEWAY_AGGREGATE: 'true',
      NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true', NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'true',
    }, { transport: new GmaTransport(), launcher: { async launch() {} }, cwd: aggregateHome, homeDirectory: aggregateHome });
    const receipt = await aggregate.runtime.researchStart({ query: 'aggregate research', profile: 'deep', intent: 'news' });
    const plan = (await aggregate.store.readExecutionSnapshot(receipt.job.job_id))!.plan;
    expect(plan.stages.flatMap((stage) => stage.invocations).map((item) => `${item.provider_instance_id}:${item.capability}`)).toEqual([
      'search-gateway.aggregate:retrieval', 'grok-multi-agent.default:multi-agent-research',
    ]);

    const unreadyHome = await temporaryRoot();
    const unready = createRuntimeComposition({
      NB_SEARCH_HOME: unreadyHome, NB_SEARCH_EXA_API_KEY: 'exa', NB_SEARCH_TAVILY_API_KEY: 'tavily',
      NB_SEARCH_GROK_BASE_URL: 'https://direct.test/v1', NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true', NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'true',
    }, { transport: new GmaTransport(), launcher: { async launch() {} }, cwd: unreadyHome, homeDirectory: unreadyHome });
    const unreadyReceipt = await unready.runtime.researchStart({ query: 'unready research', profile: 'deep', intent: 'comparison' });
    const unreadyPlan = (await unready.store.readExecutionSnapshot(unreadyReceipt.job.job_id))!.plan;
    expect(unreadyPlan.routing?.multi_agent_route).toBe('replacement');
    expect(unreadyPlan.omissions).toContainEqual(expect.objectContaining({ capability: 'multi-agent-research', reason: 'instance-unready', failure_policy: 'affects-state' }));
    expect(unreadyPlan.stages.flatMap((stage) => stage.invocations).some((item) => item.provider_instance_id === 'grok.default')).toBe(false);
  });

  it('keeps explicit profile membership authoritative and rejects a second selected GMA brief before transport', async () => {
    const home = await temporaryRoot();
    const config = resolveConfiguration({ cwd: home, homeDirectory: home, env: { GMA_ONE: 'one', GMA_TWO: 'two' }, config: {
      provider_instances: {
        'grok-multi-agent.default': { enabled: true, base_url: 'https://one.test', credential_slot_id: 'grok-multi-agent.default' },
        'grok-multi-agent.second': {
          provider_id: 'grok-multi-agent', enabled: true, base_url: 'https://two.test', credential_slot_id: 'grok-multi-agent.second', timeout_ms: 240_000,
          retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 }, options: { model: 'second-model', reasoning_effort: 'high', replace_grok: false },
        },
      },
      credential_slots: {
        'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'GMA_ONE' },
        'grok-multi-agent.second': { provider_id: 'grok-multi-agent', env: 'GMA_TWO' },
      },
      profiles: { deep: { stages: [{ kind: 'parallel', invocations: [
        { provider_instance_id: 'grok.default', capability: 'retrieval', role: 'verification', trigger: 'always' },
        { provider_instance_id: 'grok-multi-agent.default', capability: 'multi-agent-research', role: 'primary_synthesis', trigger: 'explicit', when: { execution_in: ['research-job'] } },
      ] }] } },
    } });
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const explicit = compileSearchPlan({
      config: config.config, registry,
      readiness: { 'grok.default': false, 'grok-multi-agent.default': true },
      capability_readiness: { 'grok-multi-agent.default': { 'multi-agent-research': true } },
      routing: { profile: 'deep', intent: 'comparison', execution_surface: 'research-job' },
    });
    expect(explicit.routing?.multi_agent_route).toBe('explicit');
    expect(explicit.stages.flatMap((stage) => stage.invocations).map((item) => item.provider_instance_id)).toEqual(['grok-multi-agent.default']);

    const duplicateConfig = structuredClone(config.config);
    duplicateConfig.profiles['deep']!.stages[0]!.invocations = [
      ...duplicateConfig.profiles['deep']!.stages[0]!.invocations,
      { provider_instance_id: 'grok-multi-agent.second', capability: 'multi-agent-research', role: 'second', trigger: 'explicit', when: { execution_in: ['research-job'] } },
    ];
    expect(() => compileSearchPlan({
      config: duplicateConfig, registry,
      readiness: { 'grok-multi-agent.default': true, 'grok-multi-agent.second': true },
      capability_readiness: { 'grok-multi-agent.default': { 'multi-agent-research': true }, 'grok-multi-agent.second': { 'multi-agent-research': true } },
      routing: { profile: 'deep', intent: 'comparison', execution_surface: 'research-job' },
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('retries retryable GMA failures within policy and sends nothing after cancellation or exhausted deadline', async () => {
    const retryTransport = new ScriptedGmaTransport([429, 200]);
    const retryProvider = gmaProvider(retryTransport);
    const sleeps: number[] = [];
    const retryExecution = await new PlanExecutor({
      ports_by_instance: new Map([['grok-multi-agent.default', { multi_agent_research: retryProvider }]]),
      sleep: async (ms) => { sleeps.push(ms); },
    }).execute(gmaPlan({ max_attempts: 2, backoff_ms: 500, max_backoff_ms: 2_000 }), { query: 'facet', limit: 5, profile: 'deep', intent: 'comparison' }, 5_000, undefined, {
      scope: 'research-job', completed_once_per_job_invocation_ids: new Set(), research_brief: 'complete brief', operation_budget_ms: 5_000,
    });
    expect(retryTransport.requests).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    expect(retryExecution.outcomes[0]).toMatchObject({ state: 'succeeded', attempts: [{ state: 'failed' }, { state: 'succeeded' }] });

    const cancelledTransport = new ScriptedGmaTransport([200]);
    const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'));
    const cancelledExecution = await new PlanExecutor({ ports_by_instance: new Map([['grok-multi-agent.default', { multi_agent_research: gmaProvider(cancelledTransport) }]]) })
      .execute(gmaPlan(), { query: 'facet', limit: 5, profile: 'deep', intent: 'comparison' }, 5_000, cancelled.signal, {
        scope: 'research-job', completed_once_per_job_invocation_ids: new Set(), research_brief: 'complete brief', operation_budget_ms: 5_000,
      });
    expect(cancelledTransport.requests).toHaveLength(0);
    expect(cancelledExecution.outcomes[0]).toMatchObject({ state: 'cancelled', attempts: [] });

    const deadlineTransport = new NeverResolvingTransport();
    const deadlineExecution = await new PlanExecutor({ ports_by_instance: new Map([['grok-multi-agent.default', { multi_agent_research: gmaProvider(deadlineTransport) }]]) })
      .execute(gmaPlan({ max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 }, 20), { query: 'facet', limit: 5, profile: 'deep', intent: 'comparison' }, 30, undefined, {
        scope: 'research-job', completed_once_per_job_invocation_ids: new Set(), research_brief: 'complete brief', operation_budget_ms: 30,
      });
    expect(deadlineTransport.requests).toHaveLength(1);
    expect(deadlineExecution.outcomes[0]).toMatchObject({ state: 'timed_out', attempts: [{ state: 'timed_out' }] });
  });

  it('sends one exact fixed Chat Completions request, retains URL-matched evidence, and publishes the typed fifth artifact', async () => {
    const home = await temporaryRoot();
    const transport = new GmaTransport();
    const app = composition(home, transport, true);
    const receipt = await app.runtime.researchStart({ query: 'Compare <alpha> & beta', profile: 'deep', intent: 'comparison', max_sources: 25 });
    const snapshot = (await app.store.readExecutionSnapshot(receipt.job.job_id))!;
    const frozenSearch = createSearchFromSnapshot(snapshot, {
      NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret', NB_SEARCH_GROK_API_KEY: 'direct-secret',
    }, { transport, now: () => new Date('2026-08-30T00:00:00.000Z') });
    const completed = await new ResearchRunner(app.store, frozenSearch, undefined, monotonicClock()).run(receipt.job.job_id);
    expect(completed.state).toBe('succeeded');
    const requests = transport.requests.filter((request) => isRecord(request.body) && request.body['model'] === 'grok-4.20-multi-agent-xhigh');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST', url: 'https://direct.test/v1/chat/completions',
      headers: { Authorization: 'Bearer direct-secret', 'Content-Type': 'application/json' },
      response_type: 'text', max_response_bytes: 1_048_576,
      body: {
        model: 'grok-4.20-multi-agent-xhigh', max_tokens: 4096, temperature: 0.1, stream: false,
        reasoning: { effort: 'xhigh' },
        messages: [expect.objectContaining({ role: 'system' }), { role: 'user', content: '<query>Compare &lt;alpha&gt; &amp; beta</query>' }],
      },
    });
    expect(Object.keys(requests[0]!.body as object)).toEqual(['model', 'messages', 'max_tokens', 'temperature', 'stream', 'reasoning']);

    const gma = await app.store.readArtifact(receipt.job.job_id, 'multi_agent_research');
    expect(gma).toMatchObject({ state: 'final', revision: completed.artifact_revision });
    expect(gma.items.map((item) => (item as { kind: string }).kind)).toEqual(['metadata', 'answer', 'result', 'result', 'angle', 'claim', 'conflict', 'follow_up_query', 'summary']);
    expect(gma.items[0]).toMatchObject({
      provider_id: 'grok-multi-agent', expected_agent_count: 16, backend_trace_observable: false,
      claim_linked_citations: false, evidence_linkage: 'model_declared_url_matched', semantic_verification: false,
    });
    expect(gma.items.find((item) => (item as { kind?: string }).kind === 'claim')).toMatchObject({ evidence_urls: ['https://evidence.test/article'] });
    const capabilities = await app.store.readArtifact(receipt.job.job_id, 'capabilities');
    const outcome = capabilities.items.find((item) => (item as { capability?: string }).capability === 'multi-agent-research') as Record<string, unknown>;
    expect(outcome).toMatchObject({
      state: 'succeeded', result: { delivery: 'artifact', artifact: { artifact_id: 'multi_agent_research', artifact_revision: completed.artifact_revision, media_type: 'application/x-ndjson' } },
      preview: { expected_agent_count: 16, backend_trace_observable: false, semantic_verification: false, evidence_map_available: true },
    });
    const ref = ((outcome['result'] as { artifact: { byte_length: number; sha256: string } }).artifact);
    const rawArtifact = await readFile(join(app.store.root, receipt.job.job_id, 'artifacts', 'revisions', String(completed.artifact_revision), 'multi_agent_research.jsonl'));
    expect(ref).toMatchObject({ byte_length: rawArtifact.byteLength, sha256: createHash('sha256').update(rawArtifact).digest('hex') });
    const sources = await app.store.readArtifact(receipt.job.job_id, 'sources');
    expect(JSON.stringify(sources.items)).toContain('https://evidence.test/article');
    expect(JSON.stringify(sources.items)).not.toContain('bounded synthesis');
    expect(JSON.stringify(await app.store.readArtifact(receipt.job.job_id, 'report'))).not.toContain('bounded synthesis');
  });

  it('publishes partial answer-only output without fabricating citations or backend trace and preserves retrieval evidence', async () => {
    const home = await temporaryRoot();
    const transport = new GmaTransport('partial');
    const app = composition(home, transport, true);
    const receipt = await app.runtime.researchStart({ query: 'partial research', profile: 'deep', intent: 'news', max_sources: 5 });
    const snapshot = (await app.store.readExecutionSnapshot(receipt.job.job_id))!;
    const search = createSearchFromSnapshot(snapshot, {
      NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret', NB_SEARCH_GROK_API_KEY: 'direct-secret',
    }, { transport });
    const completed = await new ResearchRunner(app.store, search, undefined, monotonicClock()).run(receipt.job.job_id);
    expect(completed.state).toBe('partial');
    const capability = (await app.store.readArtifact(receipt.job.job_id, 'capabilities')).items.find((item) => (item as { capability?: string }).capability === 'multi-agent-research');
    expect(capability).toMatchObject({ state: 'partial', preview: { answer_available: true, result_count: 0, evidence_map_available: false, semantic_verification: false } });
    const artifact = await app.store.readArtifact(receipt.job.job_id, 'multi_agent_research');
    expect(artifact.items.map((item) => (item as { kind: string }).kind)).toEqual(['metadata', 'answer', 'summary']);
    expect(JSON.stringify(artifact.items)).not.toMatch(/actual_agent|worker_count|tool_calls|semantic_verification":true/);
    expect((await app.store.readArtifact(receipt.job.job_id, 'sources')).items.length).toBeGreaterThan(0);
  });

  it('keeps the previous five-file revision visible when GMA artifact publication fails', async () => {
    const home = await temporaryRoot();
    const store = new JobStore(join(home, 'jobs'));
    const { job } = await store.createOrReuse({ query: 'atomic', max_sources: 5, max_duration_ms: 60_000 });
    const firstItems = [{ schema_version: 1, kind: 'metadata', marker: 'first' }];
    await store.writeArtifacts(job.job_id, 'checkpoint', { summary: { marker: 'first' }, report: 'first', sources: [], capabilities: [], multi_agent_research: firstItems });
    const internals = store as unknown as { atomicWrite(path: string, value: string): Promise<void> };
    const original = internals.atomicWrite.bind(store);
    internals.atomicWrite = async (path, value) => {
      if (path.endsWith('multi_agent_research.jsonl')) throw new Error('injected fifth artifact failure');
      await original(path, value);
    };
    await expect(store.writeArtifacts(job.job_id, 'final', {
      summary: { marker: 'second' }, report: 'second', sources: [], capabilities: [],
      multi_agent_research: [{ schema_version: 1, kind: 'metadata', marker: 'second' }],
    })).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
    expect(await store.readArtifact(job.job_id, 'summary')).toEqual({ state: 'checkpoint', revision: 1, items: [{ marker: 'first' }] });
    expect(await store.readArtifact(job.job_id, 'multi_agent_research')).toEqual({ state: 'checkpoint', revision: 1, items: firstItems });
    expect((await readFile(join(store.root, job.job_id, 'job.json'), 'utf8'))).toContain('"artifact_revision": 1');
  });

  it('pages worst-case GMA records whole and rejects a cursor after the revision changes', async () => {
    const home = await temporaryRoot();
    const store = new JobStore(join(home, 'jobs'));
    const { job } = await store.createOrReuse({ query: 'paging', max_sources: 5, max_duration_ms: 60_000 });
    const first = { schema_version: 1, kind: 'answer', text: '界'.repeat(5_500), claim_linked_citations: false, evidence_map_available: false, evidence_linkage: 'model_declared_url_matched', semantic_verification: false };
    const second = { schema_version: 1, kind: 'claim', index: 0, id: 'c_0123456789', text: 'c'.repeat(600), confidence: 'unknown', evidence_strength: 'unknown', evidence_urls: Array.from({ length: 6 }, (_, index) => `https://evidence-${String(index)}.test/${'u'.repeat(1_900)}`) };
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(18_000);
    expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(18_000);
    await store.writeArtifacts(job.job_id, 'checkpoint', { summary: {}, report: '', sources: [], capabilities: [], multi_agent_research: [first, second] });
    const service = new ResearchService(store, { async launch() {} }, () => 'request');
    const page = await service.read({ job_id: job.job_id, artifact: 'multi_agent_research', page_size: 2 });
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(page.items).toEqual([first]);
    expect(page.compaction).toEqual({ applied: false, items_truncated: 0, bytes_omitted: 0, max_bytes: 24 * 1024 });
    expect(page.next_cursor).toBeTypeOf('string');
    const tail = await service.read({ job_id: job.job_id, artifact: 'multi_agent_research', cursor: page.next_cursor, page_size: 2 });
    expect(tail.items).toEqual([second]);
    await store.writeArtifacts(job.job_id, 'final', { summary: {}, report: '', sources: [], capabilities: [], multi_agent_research: [first, second] });
    await expect(service.read({ job_id: job.job_id, artifact: 'multi_agent_research', cursor: page.next_cursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps seven strict public operations and exposes only safe async route/readiness facts', async () => {
    const home = await temporaryRoot();
    const transport = new GmaTransport();
    const app = composition(home, transport, false);
    const capabilities = await app.runtime.capabilities();
    expect(transport.requests).toHaveLength(0);
    expect(capabilities.providers['grok-multi-agent']).toEqual({ configured: true });
    expect(capabilities.capability_routes?.find((item) => item.capability === 'multi-agent-research')).toMatchObject({
      operations: ['research_start'], async_only: true, route_mode: 'overlay', ready: true,
    });
    expect(capabilities.research).toMatchObject({ artifacts: ['summary', 'report', 'sources', 'capabilities', 'multi_agent_research'], multi_agent_async_only: true });
    expect(JSON.stringify(capabilities)).not.toMatch(/direct\.test|grok-4\.20|xhigh|direct-secret|worker_grant/);
    expect(() => searchInputSchema.parse({ query: 'q', profile: 'gma' })).toThrow();
    expect(() => searchInputSchema.parse({ query: 'q', provider: 'grok-multi-agent' })).toThrow();
    expect(researchReadInputSchema.parse({ job_id: '00000000-0000-4000-8000-000000000000', artifact: 'multi_agent_research' }).artifact).toBe('multi_agent_research');
  });

  it('guards snapshotless old jobs from live GMA activation and preserves their artifact shape', async () => {
    const home = await temporaryRoot();
    const transport = new GmaTransport();
    const guarded = createRuntimeComposition({
      NB_SEARCH_HOME: home, NB_SEARCH_EXA_API_KEY: 'exa', NB_SEARCH_TAVILY_API_KEY: 'tavily',
      NB_SEARCH_GROK_BASE_URL: 'https://direct.test/v1', NB_SEARCH_GROK_API_KEY: 'direct', NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true',
    }, { transport, launcher: { async launch() {} }, cwd: home, homeDirectory: home, snapshotless_legacy_guard: true });
    const { job } = await guarded.store.createOrReuse({ query: 'legacy queued', max_sources: 5, max_duration_ms: 60_000, profile: 'deep', intent: 'comparison' });
    const jobPath = join(guarded.store.root, job.job_id, 'job.json');
    const legacy = JSON.parse(await readFile(jobPath, 'utf8')) as Record<string, unknown>;
    delete legacy['artifact_revision'];
    const artifacts = legacy['artifacts'] as Record<string, unknown>;
    delete artifacts['capabilities']; delete artifacts['multi_agent_research'];
    await writeFile(jobPath, JSON.stringify(legacy, null, 2));
    const completed = await new ResearchRunner(guarded.store, guarded.search, undefined, monotonicClock()).run(job.job_id);
    expect(completed.state).toBe('succeeded');
    expect(transport.models).not.toContain('grok-4.20-multi-agent-xhigh');
    const persisted = JSON.parse(await readFile(jobPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('artifact_revision');
    expect(persisted['artifacts']).not.toHaveProperty('capabilities');
    expect(persisted['artifacts']).not.toHaveProperty('multi_agent_research');
    expect(await guarded.store.readArtifact(job.job_id, 'multi_agent_research')).toEqual({ state: 'unavailable', revision: 0, items: [] });
  });

  it('binds snapshot4 and idempotency to route, model, effort, grant, and policy while ignoring secret-only rotation', async () => {
    const home = await temporaryRoot();
    const baseEnv = {
      NB_SEARCH_HOME: home, NB_SEARCH_EXA_API_KEY: 'exa', NB_SEARCH_TAVILY_API_KEY: 'tavily',
      NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true', NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: 'https://gma.test/v1',
      NB_SEARCH_GROK_MULTI_AGENT_API_KEY: 'secret-one', NB_SEARCH_GROK_MULTI_AGENT_MODEL: 'base-model',
      NB_SEARCH_GROK_MULTI_AGENT_EFFORT: 'high', NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'false',
      NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '240000', ALT_GMA_KEY: 'secret-one',
    };
    const base = await captureSnapshot(home, baseEnv);
    const secretRotated = await captureSnapshot(home, { ...baseEnv, NB_SEARCH_GROK_MULTI_AGENT_API_KEY: 'secret-two' });
    expect(base.snapshot_fingerprint).toBe(secretRotated.snapshot_fingerprint);
    expect(JSON.stringify(base)).not.toMatch(/secret-one|secret-two/);

    const route = await captureSnapshot(home, { ...baseEnv, NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: 'true' });
    const model = await captureSnapshot(home, { ...baseEnv, NB_SEARCH_GROK_MULTI_AGENT_MODEL: 'changed-model' });
    const effort = await captureSnapshot(home, { ...baseEnv, NB_SEARCH_GROK_MULTI_AGENT_EFFORT: 'low' });
    const policy = await captureSnapshot(home, { ...baseEnv, NB_SEARCH_GROK_MULTI_AGENT_TIMEOUT_MS: '250000', NB_SEARCH_RETRY_MAX_ATTEMPTS: '3' });
    const grant = await captureSnapshot(home, baseEnv, {
      credential_slots: { 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'ALT_GMA_KEY' } },
    });
    for (const changed of [route, model, effort, policy, grant]) expect(changed.snapshot_fingerprint).not.toBe(base.snapshot_fingerprint);
    expect(route.plan.routing?.multi_agent_route).toBe('replacement');
    expect(grant.credential_bindings.find((item) => item.credential_slot_id === 'grok-multi-agent.default')?.worker_grant).toEqual({ kind: 'environment', name: 'ALT_GMA_KEY' });

    const store = new JobStore(join(home, 'idempotency-proof'));
    const request = { query: 'snapshot drift', max_sources: 5, max_duration_ms: 900_000, profile: 'deep', intent: 'comparison' as const };
    const first = await store.createOrReuse(request, 'stable-key', base);
    expect((await store.createOrReuse(request, 'stable-key', secretRotated)).job.job_id).toBe(first.job.job_id);
    for (const changed of [route, model, effort, policy, grant]) {
      await expect(store.createOrReuse(request, 'stable-key', changed)).rejects.toMatchObject({ code: 'JOB_CONFLICT' });
    }
  });
});

function composition(home: string, transport: HttpTransport, replaceGrok: boolean) {
  return createRuntimeComposition({
    NB_SEARCH_HOME: home,
    NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret',
    NB_SEARCH_GROK_BASE_URL: 'https://direct.test/v1', NB_SEARCH_GROK_API_KEY: 'direct-secret',
    NB_SEARCH_GROK_MULTI_AGENT_ENABLED: 'true', NB_SEARCH_GROK_MULTI_AGENT_REPLACE_GROK: String(replaceGrok),
  }, { transport, launcher: { async launch() {} }, now: () => new Date('2026-08-30T00:00:00.000Z'), cwd: home, homeDirectory: home });
}

class GmaTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly models: string[] = [];
  constructor(private readonly gmaMode: 'complete' | 'partial' = 'complete') {}
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const body = isRecord(request.body) ? request.body : {};
    const model = typeof body['model'] === 'string' ? body['model'] : undefined;
    if (model !== undefined) this.models.push(model);
    if (model === 'grok-4.20-multi-agent-xhigh') {
      const content = this.gmaMode === 'partial' ? { answer: 'partial synthesis' } : {
        answer: 'bounded synthesis',
        results: [
          { title: 'Evidence', url: 'https://evidence.test/article', snippet: 'primary evidence', published_date: '2026-08-29', source: 'spoofed-x' },
          { title: 'Signal', url: 'https://x.com/example/status/1', snippet: 'current signal' },
        ],
        angles: ['official evidence'],
        claims: [{ text: 'Atomic claim', confidence: 'high', evidence_strength: 'direct', evidence_urls: ['https://evidence.test/article', 'https://unmatched.test'] }],
        conflicts: [{ topic: 'Open point', description: 'Sources differ.', evidence_urls: ['https://x.com/example/status/1'] }],
        follow_up_queries: ['remaining gap'],
        actual_agent_count: 99,
      };
      return chatResponse(content) as HttpResponse<T>;
    }
    if (model === 'grok-4.1-fast') return chatResponse({ results: [{ title: 'Grok', url: 'https://grok.test/source', snippet: 'grok evidence' }] }) as HttpResponse<T>;
    if (body['type'] === 'deep' && isRecord(body['contents'])) return { status: 200, body: { resolvedSearchType: 'deep', output: { content: 'research-light synthesis', grounding: [] } } as T };
    if (request.headers?.['x-api-key'] !== undefined) return { status: 200, body: { results: [{ title: 'Exa', url: 'https://exa.test/source', highlights: ['exa evidence'] }] } as T };
    return { status: 200, body: { results: [{ title: 'Tavily', url: 'https://tavily.test/source', content: 'tavily evidence' }] } as T };
  }
}

function chatResponse(content: unknown): HttpResponse<string> {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}

class StaticGmaTransport implements HttpTransport {
  constructor(private readonly content: unknown) {}
  async send<T>(): Promise<HttpResponse<T>> { return chatResponse(this.content) as HttpResponse<T>; }
}

class ScriptedGmaTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly statuses: number[]) {}
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const status = this.statuses.shift() ?? 200;
    if (status !== 200) return { status, body: '' as T };
    return chatResponse({
      answer: 'complete', results: [{ title: 'Evidence', url: 'https://retry.test/source' }],
      claims: [{ text: 'claim', evidence_urls: ['https://retry.test/source'] }],
    }) as HttpResponse<T>;
  }
}

class NeverResolvingTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return await new Promise<HttpResponse<T>>(() => undefined);
  }
}

function gmaProviderWithContent(content: unknown, apiKey = 'sentinel'): GrokMultiAgentProvider {
  return new GrokMultiAgentProvider({
    apiKey, baseUrl: 'https://relay.test/v1', model: 'grok-4.20-multi-agent-xhigh', reasoningEffort: 'xhigh',
    transport: new StaticGmaTransport(content), providerInstanceId: 'grok-multi-agent.default', credentialSlotId: 'grok-multi-agent.default',
  });
}

function gmaProvider(transport: HttpTransport): GrokMultiAgentProvider {
  return new GrokMultiAgentProvider({
    apiKey: 'sentinel', baseUrl: 'https://relay.test/v1', model: 'grok-4.20-multi-agent-xhigh', reasoningEffort: 'xhigh',
    transport, providerInstanceId: 'grok-multi-agent.default', credentialSlotId: 'grok-multi-agent.default',
  });
}

function gmaRequest() {
  return {
    capability: 'multi-agent-research' as const, query: 'q', brief: 'q', limit: 5, profile: 'deep', intent: 'comparison' as const,
    request_time_utc: '2026-08-30T00:00:00.000Z', signal: new AbortController().signal,
  };
}

function gmaPlan(
  retry: RetryPolicyConfig = { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 },
  timeoutMs = 1_000,
): SearchPlan {
  return {
    plan_version: '3', profile_id: 'deep', routing: { profile: 'deep', intent: 'comparison', execution_surface: 'research-job', multi_agent_route: 'explicit' },
    stages: [{ stage_id: 'stage-1', kind: 'parallel', invocations: [{
      invocation_id: 'gma-invocation', provider_id: 'grok-multi-agent', provider_instance_id: 'grok-multi-agent.default',
      credential_slot_id: 'grok-multi-agent.default', capability: 'multi-agent-research', role: 'primary_synthesis', trigger: 'explicit',
      timeout_ms: timeoutMs, retry, failure_policy: 'affects-state', execution_scope: 'once-per-job',
    }] }], omissions: [], plan_fingerprint: 'hand-authored-gma-plan',
  };
}

function gmaConfigTuple(resolved: ReturnType<typeof resolveConfiguration>): [string | undefined, unknown, unknown, unknown, number | undefined, string | undefined] {
  const instance = resolved.config.provider_instances['grok-multi-agent.default'];
  return [instance?.base_url, instance?.options['model'], instance?.options['reasoning_effort'], instance?.options['replace_grok'], instance?.timeout_ms, resolved.secret_bindings.get('grok-multi-agent.default')?.value];
}

async function captureSnapshot(home: string, env: NodeJS.ProcessEnv, config: CanonicalConfigPatch = {}): Promise<ExecutionSnapshot> {
  const app = createRuntimeComposition(env, { config, cwd: home, homeDirectory: home, transport: new GmaTransport(), launcher: { async launch() {} } });
  const receipt = await app.runtime.researchStart({ query: 'snapshot drift', max_sources: 5, profile: 'deep', intent: 'comparison' });
  return (await app.store.readExecutionSnapshot(receipt.job.job_id))!;
}

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `nb-search-l5-${String(Math.random()).slice(2)}`);
  roots.push(root); await mkdir(root, { recursive: true }); return root;
}
function monotonicClock(): () => number { let value = 0; return () => { value += 10; return value; }; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
