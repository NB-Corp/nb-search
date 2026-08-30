import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSearchFromSnapshot } from '../src/app.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { createExecutionSnapshot } from '../src/execution-snapshot.ts';
import { M1_REGISTRY_FINGERPRINT, M1_REGISTRY_REVISION, validateExecutionSnapshot } from '../src/execution-snapshot.ts';
import { stableFingerprint } from '../src/config-schema.ts';
import { JobStore } from '../src/job-store.ts';
import { compileSearchPlan } from '../src/planner.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/transport.ts';
import { runWorker } from '../src/worker.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe('durable execution snapshots', () => {
  it('persists safe plan/config/registry identities and binds idempotency to the snapshot', async () => {
    const root = await temporaryRoot();
    const first = snapshotFixture(root, 'https://first.example/v1', 'raw-secret');
    const store = new JobStore(join(root, 'jobs'));
    const request = { query: 'q', max_sources: 5, max_duration_ms: 60_000 };
    const created = await store.createOrReuse(request, 'same-key', first.snapshot);
    const executionPath = join(store.root, created.job.job_id, 'execution.json');
    const raw = await readFile(executionPath, 'utf8');
    expect(raw).not.toContain('raw-secret');
    expect(JSON.parse(raw)).toMatchObject({
      plan_fingerprint: first.snapshot.plan_fingerprint,
      config_revision: first.snapshot.config_revision,
      registry_revision: first.snapshot.registry_revision,
      provider_instances: [{ provider_instance_id: 'exa.default' }],
      credential_bindings: [{ credential_slot_id: 'exa.default', worker_grant: { kind: 'environment', name: 'NB_SEARCH_EXA_API_KEY' } }],
    });
    expect(await store.readExecutionSnapshot(created.job.job_id)).toEqual(first.snapshot);
    expect((await store.createOrReuse(request, 'same-key', first.snapshot)).reused).toBe(true);

    const changed = snapshotFixture(root, 'https://changed.example/v1', 'raw-secret');
    await expect(store.createOrReuse(request, 'same-key', changed.snapshot)).rejects.toMatchObject({ code: 'JOB_CONFLICT' });
  });

  it('replays snapshot provider configuration after env/config drift', async () => {
    const root = await temporaryRoot();
    const fixture = snapshotFixture(root, 'https://snapshot.example/v1', 'start-secret');
    const transport = new CaptureTransport();
    const search = createSearchFromSnapshot(fixture.snapshot, { NB_SEARCH_EXA_API_KEY: 'worker-secret' }, { transport });
    const response = await search.search({ query: 'q' });
    expect(response.state).toBe('empty');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://snapshot.example/v1/search',
      headers: { 'x-api-key': 'worker-secret' },
    });
  });

  it('uses selected descriptor identity and keeps secret-byte changes outside the v4 fingerprint', async () => {
    const root = await temporaryRoot();
    const first = snapshotFixture(root, 'https://snapshot.example/v1', 'first-secret');
    const second = snapshotFixture(root, 'https://snapshot.example/v1', 'second-secret');
    const fullFingerprint = first.registry.fingerprint();

    expect(first.snapshot).toMatchObject({ snapshot_version: '4', artifact_contract_version: '3' });
    expect(first.snapshot.registry_fingerprint).not.toBe(fullFingerprint);
    expect(first.snapshot.registry_fingerprint).toBe(second.snapshot.registry_fingerprint);
    expect(first.snapshot.snapshot_fingerprint).toBe(second.snapshot.snapshot_fingerprint);
    expect(JSON.stringify(first.snapshot)).not.toMatch(/first-secret|second-secret/);
  });

  it('replays only the frozen retrieval-only L3 version 2 descriptor identity', async () => {
    const root = await temporaryRoot();
    const fixture = snapshotFixture(root, 'https://snapshot.example/v1', 'start-secret');
    const stages = fixture.snapshot.plan.stages.map((stage) => ({ ...stage, invocations: stage.invocations.map((item) => {
      const { failure_policy: _failure, execution_scope: _scope, ...legacy } = item; return legacy;
    }) }));
    const planBase = { plan_version: '1' as const, profile_id: fixture.snapshot.plan.profile_id, stages };
    const plan = { ...planBase, plan_fingerprint: stableFingerprint(planBase) };
    const descriptor = {
      provider_id: 'exa', adapter_version: 'l2', capabilities: ['retrieval'], activation: { kind: 'credential', required: true },
      operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
      auth: { kind: 'api-key-header', name: 'x-api-key' }, option_keys: ['search_path'],
      option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
    };
    const registryFingerprint = stableFingerprint({ schema_version: '1', descriptors: [descriptor] });
    const base = {
      ...structuredClone(fixture.snapshot), snapshot_version: '2' as const, artifact_contract_version: '1' as const,
      plan, plan_fingerprint: plan.plan_fingerprint, registry_fingerprint: registryFingerprint,
      registry_revision: `registry-1-${registryFingerprint.slice(0, 16)}`, selected_provider_descriptors: undefined,
      provider_instances: fixture.snapshot.provider_instances.map((item) => ({ ...item, config: { ...item.config, capability_policies: undefined } })),
    };
    const { snapshot_fingerprint: _fingerprint, ...withoutFingerprint } = base;
    const snapshot = validateExecutionSnapshot({ ...withoutFingerprint, snapshot_fingerprint: stableFingerprint(withoutFingerprint) });
    const transport = new CaptureTransport();
    expect((await createSearchFromSnapshot(snapshot, { NB_SEARCH_EXA_API_KEY: 'worker-secret' }, { transport }).search({ query: 'q' })).state).toBe('empty');

    const invalidBase = { ...withoutFingerprint, registry_fingerprint: '0'.repeat(64) };
    const invalid = validateExecutionSnapshot({ ...invalidBase, snapshot_fingerprint: stableFingerprint(invalidBase) });
    expect(() => createSearchFromSnapshot(invalid, { NB_SEARCH_EXA_API_KEY: 'worker-secret' }, { transport })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('replays only the exact bounded M1 direct registry identity', async () => {
    const root = await temporaryRoot();
    const fixture = snapshotFixture(root, 'https://snapshot.example/v1', 'start-secret');
    const legacyBase = {
      ...structuredClone(fixture.snapshot),
      snapshot_version: '1' as const,
      artifact_contract_version: '1' as const,
      registry_revision: M1_REGISTRY_REVISION,
      registry_fingerprint: M1_REGISTRY_FINGERPRINT,
      selected_provider_descriptors: undefined,
      provider_instances: fixture.snapshot.provider_instances.map((item) => ({
        ...item, config: { ...item.config, capability_policies: undefined },
      })),
    };
    const { snapshot_fingerprint: _oldFingerprint, ...withoutFingerprint } = legacyBase;
    const legacy = validateExecutionSnapshot({ ...withoutFingerprint, snapshot_fingerprint: stableFingerprint(withoutFingerprint) });
    const transport = new CaptureTransport();
    const search = createSearchFromSnapshot(legacy, { NB_SEARCH_EXA_API_KEY: 'worker-secret' }, { transport });
    expect((await search.search({ query: 'q' })).state).toBe('empty');

    const incompatibleBase = { ...withoutFingerprint, registry_fingerprint: '0'.repeat(64) };
    expect(() => validateExecutionSnapshot({
      ...incompatibleBase, snapshot_fingerprint: stableFingerprint(incompatibleBase),
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('freezes two provider-bound relay slots sharing one environment grant without its value', async () => {
    const root = await temporaryRoot();
    const resolved = resolveConfiguration({
      env: { SHARED_GATEWAY_TOKEN: 'shared-secret-sentinel' }, cwd: root, homeDirectory: root,
      config: {
        provider_instances: {
          'exa.default': { enabled: false }, 'tavily.default': { enabled: false },
          'exa.gateway': {
            provider_id: 'exa', enabled: true, credential_slot_id: 'exa.gateway', base_url: 'https://gateway.test',
            timeout_ms: 1000, retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 },
            options: { search_path: '/exa/search' },
          },
          'tavily.gateway': {
            provider_id: 'tavily', enabled: true, credential_slot_id: 'tavily.gateway', base_url: 'https://gateway.test',
            timeout_ms: 1000, retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 },
            options: { search_path: '/api/search' },
          },
        },
        credential_slots: {
          'exa.gateway': { provider_id: 'exa', env: 'SHARED_GATEWAY_TOKEN' },
          'tavily.gateway': { provider_id: 'tavily', env: 'SHARED_GATEWAY_TOKEN' },
        },
        profiles: { default: { stages: [{ kind: 'parallel', invocations: [
          { provider_instance_id: 'exa.gateway', capability: 'retrieval', role: 'primary', trigger: 'always' },
          { provider_instance_id: 'tavily.gateway', capability: 'retrieval', role: 'primary', trigger: 'always' },
        ] }] } },
      },
    });
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const plan = compileSearchPlan({
      config: resolved.config, registry, readiness: { 'exa.gateway': true, 'tavily.gateway': true },
    });
    const snapshot = createExecutionSnapshot(plan, resolved, registry);
    expect(snapshot.credential_bindings).toEqual([
      { credential_slot_id: 'exa.gateway', provider_id: 'exa', worker_grant: { kind: 'environment', name: 'SHARED_GATEWAY_TOKEN' } },
      { credential_slot_id: 'tavily.gateway', provider_id: 'tavily', worker_grant: { kind: 'environment', name: 'SHARED_GATEWAY_TOKEN' } },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('shared-secret-sentinel');
  });

  it('fails a snapshotted queued job explicitly when its worker grant is missing', async () => {
    const root = await temporaryRoot();
    const fixture = snapshotFixture(root, 'https://snapshot.example/v1', 'start-secret');
    const store = new JobStore(join(root, 'jobs'));
    const { job } = await store.createOrReuse(
      { query: 'q', max_sources: 5, max_duration_ms: 60_000 }, undefined, fixture.snapshot,
    );
    await runWorker(job.job_id, {}, store.root);
    expect(await store.read(job.job_id)).toMatchObject({
      state: 'failed', phase: 'failed', error: { code: 'CONFIGURATION_ERROR' },
    });
  });

  it('keeps legacy jobs without execution.json readable and cancellable', async () => {
    const root = await temporaryRoot();
    const store = new JobStore(join(root, 'jobs'));
    const { job } = await store.createOrReuse({ query: 'legacy', max_sources: 5, max_duration_ms: 60_000 });
    expect(await store.readExecutionSnapshot(job.job_id)).toBeUndefined();
    expect(await store.read(job.job_id)).toMatchObject({ state: 'queued', request: { query: 'legacy' } });
    expect(await store.requestCancel(job.job_id)).toMatchObject({ accepted: true, job: { state: 'cancelled' } });
  });

  it('executes a legacy job through the current configuration path', async () => {
    const root = await temporaryRoot();
    const store = new JobStore(join(root, 'jobs'));
    const { job } = await store.createOrReuse({ query: 'legacy worker', max_sources: 5, max_duration_ms: 60_000 });
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({
      provider_instances: {
        'exa.default': { enabled: false }, 'tavily.default': { enabled: false }, 'grok.default': { enabled: false },
      },
    }));
    await runWorker(job.job_id, { NB_SEARCH_HOME: root, NB_SEARCH_CONFIG: configPath }, store.root);
    expect(await store.readExecutionSnapshot(job.job_id)).toBeUndefined();
    expect(await store.read(job.job_id)).toMatchObject({
      state: 'failed', error: { code: 'CONFIGURATION_ERROR' },
    });
  });
});

function snapshotFixture(root: string, baseUrl: string, secret: string) {
  const resolved = resolveConfiguration({
    env: { NB_SEARCH_HOME: root, NB_SEARCH_EXA_API_KEY: secret },
    config: {
      provider_instances: {
        'exa.default': { base_url: baseUrl },
        'tavily.default': { enabled: false },
      },
    },
    cwd: root,
    homeDirectory: root,
  });
  const registry = new ProviderRegistry(builtInProviderRegistrations());
  const plan = compileSearchPlan({
    config: resolved.config, registry,
    readiness: { 'exa.default': true, 'tavily.default': false },
  });
  return { resolved, registry, plan, snapshot: createExecutionSnapshot(plan, resolved, registry) };
}

class CaptureTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return { status: 200, body: { results: [] } as T };
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-snapshot-'));
  roots.push(root);
  return root;
}
