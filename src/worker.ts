#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFetchJobRunnerFromSnapshot, createQueryJobRunnerFromSnapshot } from './app.ts';
import { NbSearchError, publicError } from './errors.ts';
import { JobStore } from './job-store.ts';

export async function runWorker(jobId: string, env: NodeJS.ProcessEnv = process.env, explicitJobsRoot?: string): Promise<void> { const jobsRoot = resolve(explicitJobsRoot ?? env['NB_SEARCH_JOBS_ROOT'] ?? resolve(env['NB_SEARCH_HOME'] ?? resolve(homedir(), '.nb-search'), 'jobs')); const store = new JobStore(jobsRoot); await store.prune(); try { const snapshot = await store.readExecutionSnapshot(jobId); const runner = snapshot.kind === 'search' ? createQueryJobRunnerFromSnapshot(snapshot, store, env) : createFetchJobRunnerFromSnapshot(snapshot, store, env); await runner.run(jobId); } catch (error) { const job = await store.read(jobId); if (job.state === 'queued') { const safe = error instanceof NbSearchError ? error : new NbSearchError('INTERNAL', 'The worker failed.', false, undefined, { cause: error }); await store.transition(jobId, 'failed', { error: publicError(safe) }); return; } throw error; } }
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const jobId = process.argv[2]; const jobsRoot = process.argv[3]; if (jobId === undefined) { process.stderr.write('worker job_id is required.\n'); process.exitCode = 2; } else await runWorker(jobId, process.env, jobsRoot); }
