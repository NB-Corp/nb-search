import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { JobStore } from '../src/job-store.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('JobStore', () => {
  it('enforces strict IDs, legal transitions, leases, and durable cancellation markers', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new JobStore(await jobsRoot(), () => now);
    const created = await store.createOrReuse({ query: 'q', max_sources: 5, max_duration_ms: 60_000 });

    expect(created.job.job_id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(store.read('../../private')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.read(created.job.job_id.toUpperCase())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.transition(created.job.job_id, 'succeeded')).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });

    const running = await store.claim(created.job.job_id, 'worker-token');
    expect(running).toMatchObject({ state: 'running', lease: { owner_token: 'worker-token' } });
    await expect(store.heartbeat(created.job.job_id, 'other-token')).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
    now = new Date('2026-01-01T00:00:05.000Z');
    await store.heartbeat(created.job.job_id, 'worker-token');
    const cancelling = await store.requestCancel(created.job.job_id);
    expect(cancelling).toMatchObject({ accepted: true, job: { state: 'cancelling' } });
    expect(await store.cancelRequested(created.job.job_id)).toBe(true);
    expect(JSON.parse(await readFile(join(store.root, created.job.job_id, 'cancel.json'), 'utf8'))).toHaveProperty('requested_at');
    const cancelled = await store.transition(created.job.job_id, 'cancelled');
    expect(cancelled.state).toBe('cancelled');
    await expect(store.transition(created.job.job_id, 'running')).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
  });

  it('writes checkpoint and final artifacts atomically and distinguishes their state', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'q', max_sources: 5, max_duration_ms: 60_000 });
    await store.writeArtifacts(job.job_id, 'checkpoint', {
      summary: { source_count: 1 }, report: 'checkpoint report', sources: [{ url: 'https://example.test' }],
    });
    expect(await store.readArtifact(job.job_id, 'summary')).toEqual({ state: 'checkpoint', items: [{ source_count: 1 }] });
    expect(await store.readArtifact(job.job_id, 'report')).toEqual({ state: 'checkpoint', items: ['checkpoint report'] });
    await store.writeArtifacts(job.job_id, 'final', {
      summary: { source_count: 2 }, report: 'final report', sources: [{ url: 'https://one.test' }, { url: 'https://two.test' }],
    });
    expect(await store.readArtifact(job.job_id, 'sources')).toEqual({
      state: 'final', items: [{ url: 'https://one.test' }, { url: 'https://two.test' }],
    });
    expect((await readdir(join(store.root, job.job_id, 'artifacts'))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('serializes cancellation before terminal completion without leaving an orphan marker', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'race', max_sources: 5, max_duration_ms: 60_000 });
    await store.claim(job.job_id, 'worker');
    const internals = store as unknown as { atomicWrite(path: string, value: string): Promise<void> };
    const originalAtomicWrite = internals.atomicWrite.bind(store);
    let releaseCancel!: () => void;
    let cancelWriteStarted!: () => void;
    const cancelWriteGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const cancelWriteEntered = new Promise<void>((resolve) => { cancelWriteStarted = resolve; });
    let paused = false;
    internals.atomicWrite = async (path, value) => {
      if (!paused && path.endsWith('cancel.json')) {
        paused = true;
        cancelWriteStarted();
        await cancelWriteGate;
      }
      await originalAtomicWrite(path, value);
    };

    const cancellation = store.requestCancel(job.job_id);
    await cancelWriteEntered;
    const completion = store.transition(job.job_id, 'succeeded');
    releaseCancel();

    await expect(cancellation).resolves.toMatchObject({ accepted: true, job: { state: 'cancelling' } });
    await expect(completion).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
    expect(await store.read(job.job_id)).toMatchObject({ state: 'cancelling' });
    expect(await store.cancelRequested(job.job_id)).toBe(true);
  });

  it('lets terminal completion win before cancellation without creating a marker', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'race', max_sources: 5, max_duration_ms: 60_000 });
    await store.claim(job.job_id, 'worker');
    const internals = store as unknown as { atomicWrite(path: string, value: string): Promise<void> };
    const originalAtomicWrite = internals.atomicWrite.bind(store);
    let releaseCompletion!: () => void;
    let completionWriteStarted!: () => void;
    const completionWriteGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const completionWriteEntered = new Promise<void>((resolve) => { completionWriteStarted = resolve; });
    let paused = false;
    internals.atomicWrite = async (path, value) => {
      if (!paused && path.endsWith('job.json') && value.includes('"state": "succeeded"')) {
        paused = true;
        completionWriteStarted();
        await completionWriteGate;
      }
      await originalAtomicWrite(path, value);
    };

    const completion = store.transition(job.job_id, 'succeeded');
    await completionWriteEntered;
    const cancellation = store.requestCancel(job.job_id);
    releaseCompletion();

    await expect(completion).resolves.toMatchObject({ state: 'succeeded' });
    await expect(cancellation).resolves.toMatchObject({ accepted: false, job: { state: 'succeeded' } });
    expect(await readdir(join(store.root, job.job_id))).not.toContain('cancel.json');
  });

  it('reconciles stale leases and preserves cancel intent', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new JobStore(await jobsRoot(), () => now);
    const lost = await store.createOrReuse({ query: 'lost', max_sources: 5, max_duration_ms: 60_000 });
    await store.claim(lost.job.job_id, 'lost-worker');
    now = new Date('2026-01-01T00:01:00.000Z');
    expect(await store.reconcileStale(lost.job.job_id)).toMatchObject({
      state: 'failed', error: { code: 'WORKER_LOST' },
    });

    now = new Date('2026-01-01T01:00:00.000Z');
    const cancelled = await store.createOrReuse({ query: 'cancelled', max_sources: 5, max_duration_ms: 60_000 });
    await store.claim(cancelled.job.job_id, 'worker');
    await store.requestCancel(cancelled.job.job_id);
    now = new Date('2026-01-01T01:01:00.000Z');
    expect(await store.reconcileStale(cancelled.job.job_id)).toMatchObject({ state: 'cancelled' });
  });

  it('prunes only expired terminal jobs with matching real directories', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new JobStore(await jobsRoot(), () => now);
    const expired = await store.createOrReuse({ query: 'expired', max_sources: 5, max_duration_ms: 60_000 });
    await store.claim(expired.job.job_id, 'worker');
    await store.transition(expired.job.job_id, 'succeeded');
    const active = await store.createOrReuse({ query: 'active', max_sources: 5, max_duration_ms: 60_000 });
    const foreign = join(store.root, 'foreign');
    await mkdir(foreign);
    await writeFile(join(foreign, 'sentinel'), 'keep');

    now = new Date('2026-01-05T00:00:00.000Z');
    expect(await store.prune(72 * 60 * 60 * 1000)).toBe(1);
    await expect(store.read(expired.job.job_id)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect((await store.read(active.job.job_id)).state).toBe('queued');
    expect(await readFile(join(foreign, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('rejects a symlinked artifact directory before reading or writing outside the job', async () => {
    const store = new JobStore(await jobsRoot());
    const { job } = await store.createOrReuse({ query: 'q', max_sources: 5, max_duration_ms: 60_000 });
    const outside = await mkdtemp(join(tmpdir(), 'nb-search-outside-'));
    roots.push(outside);
    const artifacts = join(store.root, job.job_id, 'artifacts');
    await rm(artifacts, { recursive: true });
    try {
      await symlink(outside, artifacts, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(store.writeArtifacts(job.job_id, 'checkpoint', { summary: {}, report: 'secret', sources: [] }))
      .rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
    expect(await readdir(outside)).toEqual([]);
  });
});

async function jobsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-store-'));
  roots.push(root);
  return join(root, 'jobs');
}
