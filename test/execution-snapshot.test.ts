import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSearchFromSnapshot } from '../src/app.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { createExecutionSnapshot } from '../src/execution-snapshot.ts';
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
      provider_instances: { 'exa.default': { enabled: false }, 'tavily.default': { enabled: false } },
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
