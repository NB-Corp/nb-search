#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRuntimeComposition, createSearchFromSnapshot } from './app.ts';
import { NbSearchError, publicError } from './errors.ts';
import { JobStore } from './job-store.ts';
import { Logger } from './logging.ts';
import { ResearchRunner } from './research.ts';

export async function runWorker(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitJobsRoot?: string,
): Promise<void> {
  const jobsRoot = resolve(explicitJobsRoot ?? env['NB_SEARCH_JOBS_ROOT'] ?? resolve(env['NB_SEARCH_HOME'] ?? resolve(homedir(), '.nb-search'), 'jobs'));
  const bootstrapStore = new JobStore(jobsRoot);
  const snapshot = await bootstrapStore.readExecutionSnapshot(jobId);
  if (snapshot === undefined) {
    const app = createRuntimeComposition({ ...env, NB_SEARCH_JOBS_ROOT: jobsRoot }, { snapshotless_legacy_guard: true });
    await app.store.prune(app.config.retention_hours * 60 * 60 * 1000);
    const runner = new ResearchRunner(app.store, app.search, new Logger(app.config.log_level));
    await runner.run(jobId);
    return;
  }
  try {
    const search = createSearchFromSnapshot(snapshot, env);
    const runner = new ResearchRunner(bootstrapStore, search, new Logger('warn'));
    await runner.run(jobId);
  } catch (error) {
    const safe = error instanceof NbSearchError
      ? error
      : new NbSearchError('INTERNAL', 'The research worker failed.', false, undefined, { cause: error });
    const job = await bootstrapStore.read(jobId);
    if (job.state === 'queued') {
      await bootstrapStore.transition(jobId, 'failed', { phase: 'failed', error: publicError(safe) });
      return;
    }
    throw safe;
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const jobId = process.argv[2];
  const jobsRoot = process.argv[3];
  if (jobId === undefined) { process.stderr.write('worker job_id is required.\n'); process.exitCode = 2; }
  else await runWorker(jobId, process.env, jobsRoot);
}
