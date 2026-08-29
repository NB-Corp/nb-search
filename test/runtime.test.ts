import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeComposition } from '../src/app.ts';
import {
  capabilitiesInputSchema, researchCancelInputSchema, researchListInputSchema, researchReadInputSchema,
  researchStartInputSchema, researchStatusInputSchema, searchInputSchema,
} from '../src/contracts.ts';
import type { WorkerLauncher } from '../src/research.ts';
import type { JsonTransport } from '../src/transport.ts';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('NbSearchRuntime contract', () => {
  it('exports seven strict snake_case input schemas', () => {
    expect(searchInputSchema.safeParse({ query: 'q', extra: true }).success).toBe(false);
    expect(researchStartInputSchema.safeParse({ query: 'q', max_sources: 5 }).success).toBe(true);
    expect(researchStatusInputSchema.safeParse({ job_id: crypto.randomUUID() }).success).toBe(true);
    expect(researchReadInputSchema.safeParse({ job_id: crypto.randomUUID(), artifact: 'summary' }).success).toBe(true);
    expect(researchListInputSchema.safeParse({ states: ['running'], limit: 1 }).success).toBe(true);
    expect(researchCancelInputSchema.safeParse({ job_id: crypto.randomUUID(), unknown: 1 }).success).toBe(false);
    expect(capabilitiesInputSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it('uses OperationContext request IDs and AbortSignals without network probes', async () => {
    const home = await temporaryHome();
    let transportCalls = 0;
    const transport: JsonTransport = {
      async send<T>() { transportCalls += 1; return { status: 200, body: { results: [] } as T }; },
    };
    const runtime = createRuntimeComposition({
      NB_SEARCH_HOME: home,
      NB_SEARCH_EXA_API_KEY: 'test-only',
    }, { transport }).runtime;

    const capabilities = await runtime.capabilities({}, { requestId: 'host-request' });
    expect(capabilities).toMatchObject({
      request_id: 'host-request', mode: 'capabilities', providers: { exa: { configured: true } },
      diagnostics: { network_probe_performed: false },
    });
    expect(transportCalls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(runtime.search({ query: 'q' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transportCalls).toBe(0);
  });

  it('creates and reuses durable research jobs through the same runtime', async () => {
    const home = await temporaryHome();
    const launched: string[] = [];
    const launcher: WorkerLauncher = { async launch(jobId) { launched.push(jobId); } };
    const runtime = createRuntimeComposition({ NB_SEARCH_HOME: home }, {
      launcher, requestId: () => 'generated-request',
    }).runtime;

    const first = await runtime.researchStart({
      query: ' durable query ', max_sources: 5, max_duration_ms: 60_000, idempotency_key: 'stable-key',
    }, { requestId: 'start-1' });
    const reused = await runtime.researchStart({
      query: 'durable query', max_sources: 5, max_duration_ms: 60_000, idempotency_key: 'stable-key',
    });

    expect(first).toMatchObject({ request_id: 'start-1', reused: false, job: { state: 'queued' } });
    expect(reused).toMatchObject({ reused: true, job: { job_id: first.job.job_id } });
    expect(launched).toEqual([first.job.job_id]);
    const status = await runtime.researchStatus({ job_id: first.job.job_id });
    expect(status).toMatchObject({ state: 'queued', artifacts: { report: 'unavailable' } });
    const cancelled = await runtime.researchCancel({ job_id: first.job.job_id });
    expect(cancelled).toMatchObject({ accepted: true, state: 'cancelled' });
    const again = await runtime.researchCancel({ job_id: first.job.job_id });
    expect(again).toMatchObject({ accepted: false, state: 'cancelled' });
  });

  it('rejects idempotency conflicts without launching a second worker', async () => {
    const home = await temporaryHome();
    let launches = 0;
    const runtime = createRuntimeComposition({ NB_SEARCH_HOME: home }, {
      launcher: { async launch() { launches += 1; } },
    }).runtime;
    await runtime.researchStart({ query: 'first', idempotency_key: 'same' });
    await expect(runtime.researchStart({ query: 'second', idempotency_key: 'same' }))
      .rejects.toMatchObject({ code: 'JOB_CONFLICT' });
    expect(launches).toBe(1);
  });
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-runtime-'));
  temporaryRoots.push(root);
  return root;
}
