import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { JobStore } from '../src/job-store.ts';
import { Logger } from '../src/logging.ts';
import { DetachedWorkerLauncher, ResearchRunner, ResearchService } from '../src/research.ts';
import type { SearchEnvelope, SearchResult, Searcher } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('research lifecycle', () => {
  it('runs one job to final evidence artifacts through the shared search service', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'evidence', max_sources: 5, max_duration_ms: 60_000 });
    const searcher: Searcher = { async search() { return searchEnvelope('succeeded'); } };

    const completed = await new ResearchRunner(store, searcher).run(job.job_id);

    expect(completed).toMatchObject({
      state: 'succeeded', phase: 'complete', artifacts: { summary: 'final', report: 'final', sources: 'final' },
      progress: { completed_units: 1, total_units: 5 },
    });
    const report = await store.readArtifact(job.job_id, 'report');
    expect(report.state).toBe('final');
    expect(String(report.items[0])).toContain('deterministic evidence collection report');
  });

  it('turns a durable cancel marker into the irreversible cancelled state', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'cancel me', max_sources: 5, max_duration_ms: 60_000 });
    const searcher: Searcher = {
      async search(request) {
        return await new Promise<SearchEnvelope>((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        });
      },
    };
    const pending = new ResearchRunner(store, searcher).run(job.job_id);
    await waitFor(async () => (await store.read(job.job_id)).state === 'running');
    expect(await store.requestCancel(job.job_id)).toMatchObject({ accepted: true, job: { state: 'cancelling' } });
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ state: 'cancelled', phase: 'cancelled' });
    await expect(store.transition(job.job_id, 'running')).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
  });

  it('pages checkpoint artifacts and invalidates cursors after final replacement', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'page', max_sources: 5, max_duration_ms: 60_000 });
    await store.writeArtifacts(job.job_id, 'checkpoint', {
      summary: {}, report: 'a'.repeat(9000), sources: [],
    });
    const service = new ResearchService(store, { async launch() {} }, () => 'request');
    const first = await service.read({ job_id: job.job_id, artifact: 'report', page_size: 1 });
    expect(first).toMatchObject({ artifact_state: 'checkpoint', items: ['a'.repeat(4000)] });
    expect(first.next_cursor).toBeTypeOf('string');
    await store.writeArtifacts(job.job_id, 'final', { summary: {}, report: 'final', sources: [] });
    await expect(service.read({ job_id: job.job_id, artifact: 'report', cursor: first.next_cursor }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('collects more than twenty unique sources through bounded search operations and checkpoints each operation', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'broad evidence', max_sources: 55, max_duration_ms: 120_000 });
    const requests: Array<{ query: string; max_results?: number; timeout_ms?: number }> = [];
    const writes: Array<{ state: string; sourceCount: number }> = [];
    let call = 0;
    const searcher: Searcher = {
      async search(request) {
        requests.push({ query: request.query, max_results: request.max_results, timeout_ms: request.timeout_ms });
        const results = Array.from({ length: request.max_results ?? 0 }, (_, index) => source(call, index));
        call += 1;
        return searchEnvelopeWithResults(results);
      },
    };
    const originalWriteArtifacts = store.writeArtifacts.bind(store);
    store.writeArtifacts = async (jobId, state, artifacts, checkpoint) => {
      writes.push({ state, sourceCount: artifacts.sources.length });
      return await originalWriteArtifacts(jobId, state, artifacts, checkpoint);
    };

    const completed = await new ResearchRunner(store, searcher).run(job.job_id);

    expect(requests.map(({ max_results, timeout_ms }) => ({ max_results, timeout_ms }))).toEqual([
      { max_results: 20, timeout_ms: 45_000 },
      { max_results: 20, timeout_ms: 45_000 },
      { max_results: 15, timeout_ms: 45_000 },
    ]);
    expect(new Set(requests.map((request) => request.query)).size).toBe(3);
    expect(requests.every((request) => request.query.length <= 4000)).toBe(true);
    expect(writes).toEqual([
      { state: 'checkpoint', sourceCount: 20 },
      { state: 'checkpoint', sourceCount: 40 },
      { state: 'checkpoint', sourceCount: 55 },
      { state: 'final', sourceCount: 55 },
    ]);
    expect(completed).toMatchObject({ state: 'succeeded', progress: { completed_units: 55, total_units: 55 } });
    expect((await store.readArtifact(job.job_id, 'sources')).items).toHaveLength(55);
  });

  it('spends the declared research deadline across multiple sync-bounded operations', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'deadline', max_sources: 100, max_duration_ms: 60_000 });
    const timeouts: number[] = [];
    let monotonic = 0;
    const searcher: Searcher = {
      async search(request) {
        timeouts.push(request.timeout_ms ?? 0);
        monotonic += request.timeout_ms ?? 0;
        return searchEnvelopeWithResults([], 'timed_out');
      },
    };

    const completed = await new ResearchRunner(store, searcher, new Logger('error'), () => monotonic).run(job.job_id);

    expect(timeouts).toEqual([45_000, 15_000]);
    expect(timeouts.every((timeout) => timeout <= 45_000)).toBe(true);
    expect(completed).toMatchObject({ state: 'timed_out', error: { code: 'DEADLINE_EXCEEDED' } });
  });

  it('keeps every artifact page within 24 KiB and reports adversarial item truncation', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'page', max_sources: 5, max_duration_ms: 60_000 });
    const oversized = {
      title: 't'.repeat(24_300),
      url: `https://example.test/${'u'.repeat(30_000)}`,
      snippet: 's'.repeat(40_000),
      providers: ['exa'],
      provenance: [{ provider: 'exa', rank: 0, original_url: `https://origin.test/${'o'.repeat(30_000)}`, metadata: { huge: 'm'.repeat(40_000) } }],
      metadata: { huge: 'm'.repeat(40_000) },
    };
    await store.writeArtifacts(job.job_id, 'checkpoint', {
      summary: { metadata: 'x'.repeat(80_000) },
      report: '😀'.repeat(20_000),
      sources: [oversized, { title: 'next', url: 'https://next.test/', snippet: '', providers: [], provenance: [] }],
    });
    const service = new ResearchService(store, { async launch() {} }, () => 'request');

    for (const artifact of ['summary', 'report', 'sources'] as const) {
      let cursor: string | undefined;
      do {
        const page = await service.read({ job_id: job.job_id, artifact, page_size: artifact === 'sources' ? 1 : 100, ...(cursor === undefined ? {} : { cursor }) });
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(24 * 1024);
        if (artifact === 'summary' || (artifact === 'sources' && cursor === undefined)) {
          expect(page.compaction).toMatchObject({ applied: true, items_truncated: 1, max_bytes: 24 * 1024 });
          expect(page.compaction.bytes_omitted).toBeGreaterThan(0);
        }
        cursor = page.next_cursor;
      } while (cursor !== undefined);
    }

    const first = await service.read({ job_id: job.job_id, artifact: 'sources', page_size: 1 });
    expect(first.next_cursor).toBeTypeOf('string');
    const second = await service.read({ job_id: job.job_id, artifact: 'sources', page_size: 1, cursor: first.next_cursor });
    expect(second.items[0]).toMatchObject({ title: 'next', url: 'https://next.test/' });
  });

  it('uses a fixed worker entrypoint and job ID in a hidden detached process', async () => {
    const calls: unknown[][] = [];
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => undefined;
    const fakeSpawn = ((...args: unknown[]) => {
      calls.push(args);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as unknown as typeof spawn;
    const launcher = new DetachedWorkerLauncher('C:\\fixed\\worker.mjs', { SAFE: '1' }, 'win32', fakeSpawn);
    const jobId = crypto.randomUUID();

    await launcher.launch(jobId);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(['C:\\fixed\\worker.mjs', jobId]);
    expect(calls[0]?.[2]).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore', env: { SAFE: '1' } });
  });
});

function searchEnvelope(state: SearchEnvelope['state']): SearchEnvelope {
  return {
    schema_version: '1.0', request_id: 'search', mode: 'search', state, query: 'evidence',
    results: [{
      title: 'Source', url: 'https://example.test/', snippet: 'evidence', providers: ['exa'],
      provenance: [{ provider: 'exa', rank: 0, original_url: 'https://example.test/' }],
    }],
    attempts: [{ provider: 'exa', attempt: 1, state: 'succeeded', duration_ms: 1, result_count: 1 }],
    warnings: [],
    timing: {
      started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:00.001Z',
      duration_ms: 1, budget_ms: 20_000,
    },
    compaction: { applied: false, snippets_shortened: 0, results_omitted: 0, max_bytes: 32 * 1024 },
  };
}

function source(call: number, index: number): SearchResult {
  return {
    title: `Source ${String(call)}-${String(index)}`,
    url: `https://example.test/${String(call)}/${String(index)}`,
    snippet: 'evidence',
    providers: ['exa'],
    provenance: [{ provider: 'exa', rank: index, original_url: `https://example.test/${String(call)}/${String(index)}` }],
  };
}

function searchEnvelopeWithResults(results: SearchResult[], state: SearchEnvelope['state'] = 'succeeded'): SearchEnvelope {
  return {
    schema_version: '1.0', request_id: 'search', mode: 'search', state, query: 'evidence', results,
    attempts: [{
      provider: 'exa', attempt: 1, state: state === 'timed_out' ? 'timed_out' : results.length === 0 ? 'empty' : 'succeeded',
      duration_ms: 1, result_count: results.length,
      ...(state === 'timed_out' ? { error: { code: 'DEADLINE_EXCEEDED', message: 'Search deadline was exceeded.', retryable: true, provider: 'exa' as const } } : {}),
    }],
    warnings: [],
    ...(state === 'timed_out' ? { error: { code: 'DEADLINE_EXCEEDED' as const, message: 'Search deadline was exceeded.', retryable: true } } : {}),
    timing: {
      started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:00.001Z',
      duration_ms: 1, budget_ms: 45_000,
    },
    compaction: { applied: false, snippets_shortened: 0, results_omitted: 0, max_bytes: 32 * 1024 },
  };
}

async function jobsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-research-'));
  roots.push(root);
  return join(root, 'jobs');
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for research state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
