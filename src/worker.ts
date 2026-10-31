#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorker } from './worker-runtime.ts';
export { runWorker } from './worker-runtime.ts';
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const jobId = process.argv[2]; const jobsRoot = process.argv[3]; if (jobId === undefined) { process.stderr.write('worker job_id is required.\n'); process.exitCode = 2; } else await runWorker(jobId, process.env, jobsRoot); }
