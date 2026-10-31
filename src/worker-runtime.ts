import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createFetchJobRunnerFromSnapshot, createQueryJobRunnerFromSnapshot } from './app.ts';
import { NbSearchError, publicError } from './errors.ts';
import { JobStore } from './job-store.ts';

export async function runWorker(jobId: string, env: NodeJS.ProcessEnv = process.env, explicitJobsRoot?: string, onReady?: () => void): Promise<void> { const jobsRoot = resolve(explicitJobsRoot ?? env['NB_SEARCH_JOBS_ROOT'] ?? resolve(env['NB_SEARCH_HOME'] ?? resolve(homedir(), '.nb-search'), 'jobs')); const store = new JobStore(jobsRoot); await store.prune(); try { const snapshot = await store.readExecutionSnapshot(jobId); const runner = snapshot.kind === 'search' ? createQueryJobRunnerFromSnapshot(snapshot, store, env) : createFetchJobRunnerFromSnapshot(snapshot, store, env); onReady?.(); await runner.run(jobId); } catch (error) { const job = await store.read(jobId); if (job.state === 'queued') { const safe = error instanceof NbSearchError ? error : new NbSearchError('INTERNAL', 'The worker failed.', false, undefined, { cause: error }); await store.transition(jobId, 'failed', { error: publicError(safe) }); return; } throw error; } }
