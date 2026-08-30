import { describe, expect, it } from 'vitest';

import { resolveConfiguration } from '../src/config-sources.ts';
import { SearchService } from '../src/core.ts';
import { NbSearchError } from '../src/errors.ts';
import {
  compileSearchPlan, InMemoryHealthStore, PlanExecutor, type SearchPlan,
} from '../src/planner.ts';
import {
  builtInProviderRegistrations, ProviderRegistry, type ProviderRegistration,
} from '../src/provider-registry.ts';
import type { ProviderResult, ProviderSearchRequest, SearchProvider } from '../src/types.ts';

describe('profile compiler and plan executor', () => {
  it('compiles stable identities and keeps results in plan order when completion reverses', async () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const resolved = resolveConfiguration({
      env: { EXA_API_KEY: 'secret' },
      config: {
        provider_instances: {
          'exa.secondary': {
            provider_id: 'exa', enabled: true, credential_slot_id: 'exa.default', timeout_ms: 5_000,
            retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 }, options: {},
          },
        },
        profiles: {
          default: { stages: [{ kind: 'parallel', invocations: [
            { provider_instance_id: 'exa.default', capability: 'retrieval', role: 'first', trigger: 'always' },
            { provider_instance_id: 'exa.secondary', capability: 'retrieval', role: 'second', trigger: 'always' },
          ] }] },
        },
      },
    });
    const readiness = { 'exa.default': true, 'exa.secondary': true, 'tavily.default': false };
    const first = compileSearchPlan({ config: resolved.config, registry, readiness });
    const second = compileSearchPlan({ config: resolved.config, registry, readiness });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.stages[0]?.invocations.map((item) => [item.provider_instance_id, item.role, item.trigger])).toEqual([
      ['exa.default', 'first', 'always'], ['exa.secondary', 'second', 'always'],
    ]);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const providers = [
      fakeProvider('exa.default', async () => { await firstGate; return [{ title: 'First', url: 'https://first.test' }]; }),
      fakeProvider('exa.secondary', async () => { releaseFirst(); return [{ title: 'Second', url: 'https://second.test' }]; }),
    ];
    const response = await new SearchService({ providers, plan: first }).search({ query: 'q' });
    expect(response.results.map((item) => item.url)).toEqual(['https://first.test/', 'https://second.test/']);
    expect(response.attempts.map((item) => item.provider_instance_id)).toEqual(['exa.default', 'exa.secondary']);
    expect(response.results.map((item) => item.provenance[0]?.provider_instance_id)).toEqual(['exa.default', 'exa.secondary']);
  });

  it('executes fallback sequentially while retaining one multi-agent brief slot', async () => {
    const fakeRegistration: ProviderRegistration = {
      descriptor: {
        provider_id: 'fake-gma', adapter_version: 'test', capabilities: ['multi-agent-research'],
        activation: { kind: 'explicit', required: false },
        operations: [{ capability: 'multi-agent-research', method: 'POST', response_type: 'json', path: '/research' }],
        auth: { kind: 'none' }, option_keys: [], option_schema: { type: 'object' },
      },
      create: () => ({}),
    };
    const registry = new ProviderRegistry([...builtInProviderRegistrations(), fakeRegistration]);
    const resolved = resolveConfiguration({
      env: { EXA_API_KEY: 'secret' },
      config: {
        provider_instances: {
          'fake.one': {
            provider_id: 'fake-gma', enabled: true, timeout_ms: 5_000,
            retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 }, options: {},
          },
        },
        profiles: {
          default: { stages: [
            { kind: 'fallback', invocations: [
              { provider_instance_id: 'exa.default', capability: 'retrieval', role: 'first', trigger: 'always' },
              { provider_instance_id: 'tavily.default', capability: 'retrieval', role: 'second', trigger: 'always' },
            ] },
            { kind: 'augmentation', invocations: [
              { provider_instance_id: 'fake.one', capability: 'multi-agent-research', role: 'brief', trigger: 'complex' },
            ] },
          ] },
        },
      },
    });
    const plan = compileSearchPlan({
      config: resolved.config, registry,
      readiness: { 'exa.default': true, 'tavily.default': true, 'fake.one': true },
    });
    expect(plan.stages[1]?.invocations).toHaveLength(1);

    const calls: string[] = [];
    const providers = new Map<string, SearchProvider>([
      ['exa.default', fakeProvider('exa.default', async () => { calls.push('exa.default'); return []; })],
      ['tavily.default', fakeProvider('tavily.default', async () => { calls.push('tavily.default'); return [{ title: 'ok', url: 'https://ok.test' }]; }, 'tavily')],
    ]);
    const fallbackOnly: SearchPlan = { ...plan, stages: [plan.stages[0]!], plan_fingerprint: 'fallback-test' };
    const execution = await new PlanExecutor({ providers }).execute(fallbackOnly, { query: 'q', limit: 3 }, 5_000);
    expect(calls).toEqual(['exa.default', 'tavily.default']);
    expect(execution.outcomes).toHaveLength(2);
  });

  it('rejects duplicate selected operation keys before unready invocations become omissions', () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const resolved = resolveConfiguration({
      env: {},
      config: { profiles: { default: { stages: [{ kind: 'parallel', invocations: [
        { provider_instance_id: 'tavily.default', capability: 'answer', role: 'answer-one', trigger: 'always' },
        { provider_instance_id: 'tavily.default', capability: 'answer', role: 'answer-two', trigger: 'always' },
      ] }] } } },
    });
    expect(() => compileSearchPlan({
      config: resolved.config, registry, readiness: { 'tavily.default': false },
      capability_readiness: { 'tavily.default': { answer: false } },
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('duplicate provider operation') }));
  });

  it('owns retry-after and records only terminal rate-limit health without treating auth as transient', async () => {
    const health = new InMemoryHealthStore();
    const sleeps: number[] = [];
    let calls = 0;
    const provider = fakeProvider('exa.default', async () => {
      calls += 1;
      if (calls === 1) throw new NbSearchError('PROVIDER_RATE_LIMIT', 'limited', true, 'exa', { retryAfterMs: 250 });
      return [{ title: 'ok', url: 'https://ok.test' }];
    });
    const plan = oneInvocationPlan({ max_attempts: 2, backoff_ms: 10, max_backoff_ms: 100 });
    const executor = new PlanExecutor({
      providers: new Map([['exa.default', provider]]), health,
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const execution = await executor.execute(plan, { query: 'q', limit: 3 }, 5_000);
    expect(sleeps).toEqual([250]);
    expect(execution.outcomes[0]?.attempts.map((item) => item.state)).toEqual(['failed', 'succeeded']);
    expect(health.history()).toEqual([]);

    const exhaustedHealth = new InMemoryHealthStore();
    const limited = fakeProvider('exa.default', async () => {
      throw new NbSearchError('PROVIDER_RATE_LIMIT', 'limited', true, 'exa', { retryAfterMs: 250 });
    });
    await new PlanExecutor({
      providers: new Map([['exa.default', limited]]), health: exhaustedHealth,
      sleep: async () => undefined,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }).execute(plan, { query: 'q', limit: 3 }, 5_000);
    expect(exhaustedHealth.history()).toEqual([expect.objectContaining({
      cause: 'rate_limit_credential_slot', identity: 'exa.default', error_code: 'PROVIDER_RATE_LIMIT',
    })]);

    const authHealth = new InMemoryHealthStore();
    const auth = fakeProvider('exa.default', async () => { throw new NbSearchError('PROVIDER_AUTH', 'bad key', false, 'exa'); });
    const authExecution = await new PlanExecutor({ providers: new Map([['exa.default', auth]]), health: authHealth })
      .execute(plan, { query: 'q', limit: 3 }, 5_000);
    expect(authExecution.outcomes[0]?.attempts).toHaveLength(1);
    expect(authHealth.history()).toEqual([]);
  });

  it('records transient provider health but excludes caller cancellation and empty outcomes', async () => {
    const transientHealth = new InMemoryHealthStore();
    const transient = fakeProvider('exa.default', async () => {
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'temporary', true, 'exa');
    });
    const singleAttempt = oneInvocationPlan({ max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 });
    await new PlanExecutor({ providers: new Map([['exa.default', transient]]), health: transientHealth })
      .execute(singleAttempt, { query: 'q', limit: 3 }, 5_000);
    expect(transientHealth.history()).toContainEqual(expect.objectContaining({
      cause: 'transient_provider_capability', identity: 'exa.default:retrieval',
    }));

    const neutralHealth = new InMemoryHealthStore();
    const empty = fakeProvider('exa.default', async () => []);
    await new PlanExecutor({ providers: new Map([['exa.default', empty]]), health: neutralHealth })
      .execute(singleAttempt, { query: 'q', limit: 3 }, 5_000);
    expect(neutralHealth.history()).toEqual([]);

    const controller = new AbortController();
    const waiting = fakeProvider('exa.default', async ({ signal }) => await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = new PlanExecutor({ providers: new Map([['exa.default', waiting]]), health: neutralHealth })
      .execute(singleAttempt, { query: 'q', limit: 3 }, 5_000, controller.signal);
    controller.abort();
    expect((await pending).caller_cancelled).toBe(true);
    expect(neutralHealth.history()).toEqual([]);
  });

  it('keeps a provider after a recovered transient retry and excludes it only after exhaustion', async () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const resolved = resolveConfiguration({ env: { NB_SEARCH_EXA_API_KEY: 'secret' } });
    const readiness = { 'exa.default': true, 'tavily.default': false };
    const recoveredHealth = new InMemoryHealthStore();
    let calls = 0;
    const recovered = fakeProvider('exa.default', async () => {
      calls += 1;
      if (calls === 1) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'temporary', true, 'exa');
      return [{ title: 'ok', url: 'https://ok.test' }];
    });
    const retryPlan = oneInvocationPlan({ max_attempts: 2, backoff_ms: 0, max_backoff_ms: 0 });
    const recoveredExecution = await new PlanExecutor({
      providers: new Map([['exa.default', recovered]]), health: recoveredHealth, sleep: async () => undefined,
    }).execute(retryPlan, { query: 'q', limit: 3 }, 5_000);
    expect(recoveredExecution.outcomes[0]?.attempts.map((attempt) => attempt.state)).toEqual(['failed', 'succeeded']);
    expect(recoveredHealth.snapshot().unavailable_provider_capabilities).toEqual([]);
    expect(compileSearchPlan({
      config: resolved.config, registry, readiness, health: recoveredHealth.snapshot(),
    }).stages[0]?.invocations).toHaveLength(1);

    const exhaustedHealth = new InMemoryHealthStore();
    const exhausted = fakeProvider('exa.default', async () => {
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'temporary', true, 'exa');
    });
    await new PlanExecutor({
      providers: new Map([['exa.default', exhausted]]), health: exhaustedHealth, sleep: async () => undefined,
    }).execute(retryPlan, { query: 'q', limit: 3 }, 5_000);
    expect(exhaustedHealth.snapshot().unavailable_provider_capabilities).toEqual(['exa.default:retrieval']);
    expect(compileSearchPlan({
      config: resolved.config, registry, readiness, health: exhaustedHealth.snapshot(),
    }).stages).toEqual([]);

    const nonretryableHealth = new InMemoryHealthStore();
    const nonretryable = fakeProvider('exa.default', async () => {
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'client failure', false, 'exa');
    });
    await new PlanExecutor({ providers: new Map([['exa.default', nonretryable]]), health: nonretryableHealth })
      .execute(retryPlan, { query: 'q', limit: 3 }, 5_000);
    expect(nonretryableHealth.history()).toEqual([]);
  });
});

function fakeProvider(
  instanceId: string,
  search: (request: ProviderSearchRequest) => Promise<readonly ProviderResult[]>,
  providerId: 'exa' | 'tavily' = 'exa',
): SearchProvider {
  return { name: providerId, provider_id: providerId, provider_instance_id: instanceId, credential_slot_id: `${providerId}.default`, search };
}

function oneInvocationPlan(retry: { max_attempts: number; backoff_ms: number; max_backoff_ms: number }): SearchPlan {
  return {
    plan_version: '1', profile_id: 'default', plan_fingerprint: 'test-plan',
    stages: [{ stage_id: 'stage-1', kind: 'parallel', invocations: [{
      invocation_id: 'inv-1', provider_id: 'exa', provider_instance_id: 'exa.default', credential_slot_id: 'exa.default',
      capability: 'retrieval', role: 'primary', trigger: 'always', timeout_ms: 5_000, retry,
    }] }],
  };
}
