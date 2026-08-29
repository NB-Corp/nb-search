import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfiguration, type AppConfiguration } from './config.ts';
import { SearchService } from './core.ts';
import { JobStore } from './job-store.ts';
import { DetachedWorkerLauncher, ResearchService, type WorkerLauncher } from './research.ts';
import { NbSearchRuntimeImpl } from './runtime.ts';
import type { JsonTransport } from './transport.ts';

export interface RuntimeComposition {
  config: AppConfiguration;
  runtime: NbSearchRuntimeImpl;
  search: SearchService;
  store: JobStore;
}

export interface CompositionOptions {
  transport?: JsonTransport;
  launcher?: WorkerLauncher;
  requestId?: () => string;
  now?: () => Date;
}

export function createRuntimeComposition(
  env: NodeJS.ProcessEnv = process.env,
  options: CompositionOptions = {},
): RuntimeComposition {
  const config = loadConfiguration(env, options.transport);
  const requestId = options.requestId ?? randomUUID;
  const search = new SearchService({ providers: config.providers, requestId, now: options.now });
  const store = new JobStore(config.jobs_root, options.now);
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
  const launcher = options.launcher ?? new DetachedWorkerLauncher(workerPath, env);
  const research = new ResearchService(store, launcher, requestId);
  const runtime = new NbSearchRuntimeImpl({
    search,
    research,
    requestId,
    providerConfigured: config.provider_configured,
    retentionHours: config.retention_hours,
  });
  return { config, runtime, search, store };
}
