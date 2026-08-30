import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeComposition, createSearchFromSnapshot } from '../src/app.ts';
import { stableFingerprint } from '../src/config-schema.ts';
import { researchStartInputSchema, searchInputSchema } from '../src/contracts.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { validateExecutionSnapshot, type ExecutionSnapshot } from '../src/execution-snapshot.ts';
import { compileSearchPlan, PlanExecutor, type SearchPlan } from '../src/planner.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import type { JsonRequest, JsonResponse, JsonTransport } from '../src/transport.ts';
import type { ProviderSearchRequest, SearchProvider } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe('L1 legacy configuration and direct routing', () => {
  it('preserves first-existing lookup, BOM parsing, complete aliases, and legacy policies', async () => {
    const root = await temporaryRoot();
    const homePath = join(root, 'home', '.openclaw', 'credentials', 'search.json');
    await mkdir(join(homePath, '..'), { recursive: true });
    await writeFile(homePath, JSON.stringify({ exa: 'home-key' }));
    const missing = join(root, 'missing.json');
    expect(resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: missing }, cwd: root, homeDirectory: join(root, 'home'),
    }).legacy_path).toBe(homePath);

    const directoryCandidate = join(root, 'not-a-credential-file');
    await mkdir(directoryCandidate);
    expect(resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: directoryCandidate }, cwd: root, homeDirectory: join(root, 'home'),
    }).legacy_path).toBe(homePath);

    const selected = join(root, 'selected.json');
    await writeFile(selected, `\uFEFF${JSON.stringify({
      exa: { apiKey: 'exa-file', apiUrl: 'https://nested-exa.test' },
      tavily: 'tavily-file',
      exaApiBase: 'https://top-exa.test',
      tavilyBaseUrl: 'https://top-tavily.test',
      searchLayer: {
        requestTimeoutSeconds: '12',
        providerTimeouts: { exa: 20, tavily: '5' },
        retry: { maxAttempts: '3', backoffMs: '700' },
      },
    })}`);
    const resolved = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: selected }, cwd: root, homeDirectory: join(root, 'home'),
    });
    expect(resolved.legacy_path).toBe(selected);
    expect(resolved.secret_bindings.get('exa.default')?.value).toBe('exa-file');
    expect(resolved.secret_bindings.get('tavily.default')?.value).toBe('tavily-file');
    expect(resolved.config.provider_instances['exa.default']).toMatchObject({
      base_url: 'https://top-exa.test', timeout_ms: 12_000,
      retry: { max_attempts: 3, backoff_ms: 700, max_backoff_ms: 2_000 },
    });
    expect(resolved.config.provider_instances['tavily.default']).toMatchObject({
      base_url: 'https://top-tavily.test', timeout_ms: 5_000,
    });

    await writeFile(selected, '{malformed');
    const malformed = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: selected }, cwd: root, homeDirectory: join(root, 'home'),
    });
    expect(malformed.legacy_path).toBe(selected);
    expect(malformed.secret_bindings.has('exa.default')).toBe(false);
    expect(malformed.diagnostics).toContainEqual(expect.objectContaining({ code: 'LEGACY_INVALID', path: selected }));
  });

  it('applies new environment aliases over old aliases and invalid legacy policy values fall back safely', async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, 'legacy.json');
    await writeFile(legacyPath, JSON.stringify({
      exa: 'file-exa', tavily: 'file-tavily',
      searchLayer: {
        requestTimeoutSeconds: false,
        providerTimeouts: { exa: -1, tavily: 'not-a-number' },
        retry: { maxAttempts: true, backoffMs: -1 },
      },
    }));
    const fallback = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: legacyPath }, cwd: root, homeDirectory: root,
    });
    expect(fallback.config.provider_instances['exa.default']).toMatchObject({
      timeout_ms: 20_000, retry: { max_attempts: 2, backoff_ms: 500 },
    });
    expect(fallback.diagnostics.filter((item) => item.code === 'LEGACY_INVALID').length).toBeGreaterThanOrEqual(4);

    const resolved = resolveConfiguration({
      env: {
        SEARCH_LAYER_CREDENTIALS: legacyPath,
        EXA_API_KEY: 'old-exa', NB_SEARCH_EXA_API_KEY: 'new-exa',
        TAVILY_API_KEY: 'old-tavily', NB_SEARCH_TAVILY_API_KEY: 'new-tavily',
        EXA_API_BASE: 'https://old-base-exa.test', EXA_API_URL: 'https://old-url-exa.test',
        NB_SEARCH_EXA_BASE_URL: 'https://new-exa.test',
        TAVILY_API_BASE: 'https://old-base-tavily.test', TAVILY_API_URL: 'https://old-url-tavily.test',
        NB_SEARCH_EXA_TIMEOUT_MS: '1234',
        SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: '2', SEARCH_LAYER_TAVILY_TIMEOUT_SECONDS: '3',
      },
      cwd: root, homeDirectory: root,
    });
    expect(resolved.secret_bindings.get('exa.default')?.value).toBe('new-exa');
    expect(resolved.secret_bindings.get('tavily.default')?.value).toBe('new-tavily');
    expect(resolved.config.provider_instances['exa.default']).toMatchObject({ base_url: 'https://new-exa.test', timeout_ms: 1234 });
    expect(resolved.config.provider_instances['tavily.default']).toMatchObject({ base_url: 'https://old-base-tavily.test', timeout_ms: 2000 });

    expect(() => resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_EXA_TIMEOUT_MS: '99' }, cwd: root, homeDirectory: root,
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));

    const canonicalPath = join(root, 'canonical.json');
    await writeFile(canonicalPath, JSON.stringify({ provider_instances: { 'exa.default': { timeout_ms: 7_777 } } }));
    const inherited = resolveConfiguration({
      env: {
        SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath,
        SEARCH_LAYER_EXA_TIMEOUT_SECONDS: 'invalid', SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS: 'invalid',
      },
      cwd: root, homeDirectory: root,
    });
    expect(inherited.config.provider_instances['exa.default']?.timeout_ms).toBe(7_777);
    expect(inherited.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'environment', message: expect.stringContaining('SEARCH_LAYER_EXA_TIMEOUT_SECONDS') }),
      expect.objectContaining({ source: 'environment', message: expect.stringContaining('SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS') }),
    ]));
  });

  it('uses an arbitrary canonical default profile internally while explicit public profiles stay strict', async () => {
    const root = await temporaryRoot();
    const legacyPath = await emptyLegacy(root);
    const transport = new CaptureTransport();
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, SEARCH_LAYER_CREDENTIALS: legacyPath,
      NB_SEARCH_EXA_API_KEY: 'exa-key', NB_SEARCH_TAVILY_API_KEY: 'tavily-key',
    }, {
      transport,
      launcher: { async launch() { /* Inspect the queued snapshot without starting a process. */ } },
      config: {
        profiles: {
          'custom-canonical': { stages: [{ kind: 'parallel', invocations: [{
            provider_instance_id: 'tavily.default', capability: 'retrieval', role: 'primary', trigger: 'always',
          }] }] },
        },
        default_profile_id: 'custom-canonical',
      },
    });

    await composition.runtime.search({ query: 'implicit custom' });
    expect(transport.requests.map((request) => request.url)).toEqual(['https://api.tavily.com/search']);
    transport.requests.length = 0;
    await composition.runtime.search({ query: 'explicit public', profile: 'default' });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://api.exa.ai/search', 'https://api.tavily.com/search',
    ]);
    expect(searchInputSchema.safeParse({ query: 'q', profile: 'custom-canonical' }).success).toBe(false);

    const receipt = await composition.runtime.researchStart({ query: 'custom snapshot', max_sources: 5, max_duration_ms: 60_000 });
    const raw = JSON.parse(await readFile(join(root, 'jobs', receipt.job.job_id, 'execution.json'), 'utf8')) as unknown;
    const snapshot = validateExecutionSnapshot(raw);
    expect(snapshot).toMatchObject({
      routing: { profile: 'custom-canonical' }, plan: { profile_id: 'custom-canonical' },
      provider_instances: [{ provider_instance_id: 'tavily.default' }],
    });

    const foundation = structuredClone(snapshot) as Omit<ExecutionSnapshot, 'routing'> & { routing?: ExecutionSnapshot['routing'] };
    delete foundation.routing;
    const { snapshot_fingerprint: _oldFingerprint, ...foundationBase } = foundation;
    foundation.snapshot_fingerprint = stableFingerprint(foundationBase);
    expect(validateExecutionSnapshot(foundation)).toMatchObject({ routing: { profile: 'custom-canonical' } });

    transport.requests.length = 0;
    const replay = createSearchFromSnapshot(snapshot, { NB_SEARCH_TAVILY_API_KEY: 'worker-key' }, { transport });
    await replay.search({ query: 'worker replay' });
    expect(transport.requests.map((request) => request.url)).toEqual(['https://api.tavily.com/search']);
  });

  it('compiles deterministic default/deep parallel and fast fallback routes', async () => {
    const root = await temporaryRoot();
    const legacyPath = await emptyLegacy(root);
    const resolved = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_EXA_API_KEY: 'exa', NB_SEARCH_TAVILY_API_KEY: 'tavily' },
      cwd: root, homeDirectory: root,
    });
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const readiness = { 'exa.default': true, 'tavily.default': true };
    const plans = Object.fromEntries(['default', 'deep', 'fast'].map((profile) => [profile, compileSearchPlan({
      config: resolved.config, registry, readiness, profile_id: profile,
    })]));
    expect(plans['default']?.stages.map((stage) => [stage.kind, ...stage.invocations.map((item) => item.provider_instance_id)]))
      .toEqual([['parallel', 'exa.default', 'tavily.default']]);
    expect(plans['deep']?.stages.map((stage) => [stage.kind, ...stage.invocations.map((item) => item.provider_instance_id)]))
      .toEqual([['parallel', 'exa.default', 'tavily.default']]);
    expect(plans['fast']?.stages.map((stage) => [stage.kind, ...stage.invocations.map((item) => item.provider_instance_id)]))
      .toEqual([['fallback', 'exa.default', 'tavily.default']]);
    expect(compileSearchPlan({ config: resolved.config, registry, readiness, profile_id: 'fast' })).toEqual(plans['fast']);
  });

  it('maps routing and freshness to provider payloads while preserving the default payload', async () => {
    const root = await temporaryRoot();
    const legacyPath = await emptyLegacy(root);
    const transport = new CaptureTransport();
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, SEARCH_LAYER_CREDENTIALS: legacyPath,
      NB_SEARCH_EXA_API_KEY: 'exa-key', NB_SEARCH_TAVILY_API_KEY: 'tavily-key',
    }, { transport, now: () => new Date('2026-08-30T12:00:00.000Z') });

    await composition.runtime.search({ query: 'default' });
    expect(transport.requests[0]?.body).toEqual({
      query: 'default', numResults: 8, type: 'auto', contents: { highlights: { maxCharacters: 1200 } },
    });
    expect(transport.requests[1]?.body).toEqual({
      api_key: 'tavily-key', query: 'default', max_results: 8, include_answer: false,
    });

    transport.requests.length = 0;
    await composition.runtime.search({ query: 'routed', profile: 'deep', intent: 'exploratory', freshness: 'pw' });
    expect(transport.requests[0]?.body).toMatchObject({
      type: 'deep', startPublishedDate: '2026-08-23T12:00:00.000Z',
    });
    expect(transport.requests[1]?.body).toMatchObject({ include_answer: false, days: 7 });

    transport.requests.length = 0;
    await composition.runtime.search({ query: 'status', profile: 'fast', intent: 'status', freshness: 'pd' });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://api.exa.ai/search', 'https://api.tavily.com/search',
    ]);
    expect(transport.requests[0]?.body).toMatchObject({ type: 'fast', startPublishedDate: '2026-08-29T12:00:00.000Z' });
  });

  it('persists routing in snapshots and idempotency, then replays it after request drift', async () => {
    const root = await temporaryRoot();
    const legacyPath = await emptyLegacy(root);
    const composition = createRuntimeComposition({
      NB_SEARCH_HOME: root, SEARCH_LAYER_CREDENTIALS: legacyPath,
      NB_SEARCH_EXA_API_KEY: 'exa-start', NB_SEARCH_TAVILY_API_KEY: 'tavily-start',
    }, { launcher: { async launch() { /* Inspect the queued snapshot without starting a process. */ } } });
    const input = {
      query: 'snapshot', max_sources: 5, max_duration_ms: 60_000,
      profile: 'deep' as const, intent: 'exploratory' as const, freshness: 'pw' as const, idempotency_key: 'route-key',
    };
    const receipt = await composition.runtime.researchStart(input);
    const snapshot = JSON.parse(await readFile(join(root, 'jobs', receipt.job.job_id, 'execution.json'), 'utf8')) as ExecutionSnapshot;
    expect(snapshot).toMatchObject({
      routing: { profile: 'deep', intent: 'exploratory', freshness: 'pw' },
      plan: { profile_id: 'deep' },
      provider_instances: [
        { provider_instance_id: 'exa.default', config: { timeout_ms: 20_000, retry: { max_attempts: 2, backoff_ms: 500 } } },
        { provider_instance_id: 'tavily.default' },
      ],
    });
    expect((await composition.runtime.researchStart(input)).reused).toBe(true);
    await expect(composition.runtime.researchStart({ ...input, freshness: 'pd' }))
      .rejects.toMatchObject({ code: 'JOB_CONFLICT' });

    const transport = new CaptureTransport();
    const replay = createSearchFromSnapshot(snapshot, {
      NB_SEARCH_EXA_API_KEY: 'exa-worker', NB_SEARCH_TAVILY_API_KEY: 'tavily-worker',
    }, { transport, now: () => new Date('2026-08-30T12:00:00.000Z') });
    await replay.search({ query: 'snapshot', profile: 'fast', intent: 'news', freshness: 'pd' });
    expect(transport.requests[0]?.body).toMatchObject({
      type: 'deep', startPublishedDate: '2026-08-23T12:00:00.000Z',
    });
    expect(transport.requests[1]?.body).toMatchObject({ days: 7 });
  });

  it('rejects unsupported routing values and clamps retries/sleeps to the outer budget', async () => {
    for (const value of ['unknown', '', 'DEFAULT']) {
      expect(searchInputSchema.safeParse({ query: 'q', profile: value }).success).toBe(false);
      expect(researchStartInputSchema.safeParse({ query: 'q', intent: value }).success).toBe(false);
      expect(searchInputSchema.safeParse({ query: 'q', freshness: value }).success).toBe(false);
    }

    let tick = 0;
    const clock = [0, 0, 1, 2, 80, 101];
    const sleeps: number[] = [];
    const provider: SearchProvider = {
      name: 'exa', provider_instance_id: 'exa.default', credential_slot_id: 'exa.default',
      async search(_request: ProviderSearchRequest) { throw new Error('retryable'); },
    };
    const execution = await new PlanExecutor({
      providers: new Map([['exa.default', provider]]),
      monotonicNow: () => clock[tick++] ?? 101,
      sleep: async (ms) => { sleeps.push(ms); },
    }).execute(singlePlan(), { query: 'q', limit: 1 }, 100);
    expect(sleeps).toEqual([20]);
    expect(execution.deadline_exceeded).toBe(true);
    expect(execution.outcomes[0]?.attempts.map((attempt) => attempt.state)).toEqual(['failed', 'timed_out']);
  });

  it('applies provider timeout per attempt while keeping the request deadline outermost', async () => {
    let calls = 0;
    const provider: SearchProvider = {
      name: 'exa', provider_instance_id: 'exa.default', credential_slot_id: 'exa.default',
      async search({ signal }: ProviderSearchRequest) {
        calls += 1;
        return await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const plan = singlePlan();
    const invocation = plan.stages[0]!.invocations[0]!;
    const shortPlan: SearchPlan = {
      ...plan,
      stages: [{ ...plan.stages[0]!, invocations: [{ ...invocation, timeout_ms: 10, retry: { ...invocation.retry, backoff_ms: 0 } }] }],
    };
    const execution = await new PlanExecutor({ providers: new Map([['exa.default', provider]]) })
      .execute(shortPlan, { query: 'q', limit: 1 }, 1_000);
    expect(calls).toBe(2);
    expect(execution.deadline_exceeded).toBe(false);
    expect(execution.outcomes[0]?.attempts.map((attempt) => attempt.state)).toEqual(['timed_out', 'timed_out']);
  });
});

class CaptureTransport implements JsonTransport {
  readonly requests: JsonRequest[] = [];
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    this.requests.push(request);
    return { status: 200, body: { results: [] } as T };
  }
}

function singlePlan(): SearchPlan {
  return {
    plan_version: '1', profile_id: 'default', plan_fingerprint: 'l1-budget',
    stages: [{ stage_id: 'stage-1', kind: 'parallel', invocations: [{
      invocation_id: 'inv-1', provider_id: 'exa', provider_instance_id: 'exa.default', credential_slot_id: 'exa.default',
      capability: 'retrieval', role: 'primary', trigger: 'always', timeout_ms: 500,
      retry: { max_attempts: 2, backoff_ms: 500, max_backoff_ms: 500 },
    }] }],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-l1-'));
  roots.push(root);
  return root;
}

async function emptyLegacy(root: string): Promise<string> {
  const path = join(root, 'legacy.json');
  await writeFile(path, '{}');
  return path;
}
