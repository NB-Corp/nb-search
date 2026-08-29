#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRuntimeComposition } from './app.ts';
import { Logger } from './logging.ts';
import { ResearchRunner } from './research.ts';

export async function runWorker(jobId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const app = createRuntimeComposition(env);
  await app.store.prune(app.config.retention_hours * 60 * 60 * 1000);
  const runner = new ResearchRunner(app.store, app.search, new Logger(app.config.log_level));
  await runner.run(jobId);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const jobId = process.argv[2];
  if (jobId === undefined) { process.stderr.write('worker job_id is required.\n'); process.exitCode = 2; }
  else await runWorker(jobId);
}
