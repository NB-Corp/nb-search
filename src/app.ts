import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CanonicalConfigPatch } from './config-schema.ts';
import { loadConfiguration, type AppConfiguration } from './config.ts';
import { SearchService } from './core.ts';
import {
  createExecutionSnapshot, resolveSnapshotBindings, type ExecutionSnapshot,
} from './execution-snapshot.ts';
import { NbSearchError } from './errors.ts';
import { JobStore } from './job-store.ts';
import { compileSearchPlan, isSearchPlanExecutable, NoopHealthStore } from './planner.ts';
import {
  builtInProviderRegistrations, ProviderRegistry, type ProviderRegistration,
} from './provider-registry.ts';
import { DetachedWorkerLauncher, ResearchService, type WorkerLauncher } from './research.ts';
import { NbSearchRuntimeImpl } from './runtime.ts';
import { FetchJsonTransport, type JsonTransport } from './transport.ts';
import type { SearchProvider } from './types.ts';

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
  config?: CanonicalConfigPatch;
  overrides?: CanonicalConfigPatch;
  provider_registrations?: readonly ProviderRegistration[];
}

export function createRuntimeComposition(
  env: NodeJS.ProcessEnv = process.env,
  options: CompositionOptions = {},
): RuntimeComposition {
  const config = loadConfiguration(env, options.transport, {
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.provider_registrations === undefined ? {} : { provider_registrations: options.provider_registrations }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const requestId = options.requestId ?? randomUUID;
  const health = new NoopHealthStore();
  const healthSnapshot = health.snapshot();
  const profilePlans = new Map(Object.keys(config.resolved.config.profiles).sort().map((profileId) => [
    profileId,
    compileSearchPlan({
      config: config.resolved.config,
      registry: config.registry,
      readiness: config.provider_readiness,
      health: healthSnapshot,
      profile_id: profileId,
    }),
  ]));
  const plan = profilePlans.get(config.resolved.config.default_profile_id);
  if (plan === undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'The default search profile could not be compiled.');
  const search = new SearchService({ providers: config.providers, plan, requestId, now: options.now });
  const store = new JobStore(config.jobs_root, options.now);
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
  const launcher = options.launcher ?? new DetachedWorkerLauncher(workerPath, env);
  const research = new ResearchService(
    store,
    launcher,
    requestId,
    () => createExecutionSnapshot(plan, config.resolved, config.registry),
  );
  const providerInstances = Object.entries(config.resolved.config.provider_instances)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([instanceId, instance]) => ({
      provider_id: instance.provider_id,
      provider_instance_id: instanceId,
      ...(instance.credential_slot_id === undefined ? {} : { credential_slot_id: instance.credential_slot_id }),
      enabled: instance.enabled,
      ready: config.provider_readiness[instanceId] === true,
      capabilities: config.registry.descriptor(instance.provider_id)?.capabilities ?? [],
    }));
  const profiles = Object.entries(config.resolved.config.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([profileId, profile]) => ({
      profile_id: profileId,
      ready: isSearchPlanExecutable(profilePlans.get(profileId)!),
      stage_count: profile.stages.length,
    }));
  const profileDiagnostics = profiles.filter((profile) => !profile.ready).map((profile) => ({
    code: 'PROFILE_UNREADY',
    source: 'profile',
    path: `profiles.${profile.profile_id}`,
    message: 'Profile has no executable invocations for the resolved provider capabilities and readiness.',
  }));
  const runtime = new NbSearchRuntimeImpl({
    search,
    research,
    requestId,
    providerConfigured: config.provider_configured,
    retentionHours: config.retention_hours,
    providerInstances,
    profiles,
    configurationDiagnostics: [
      ...config.diagnostics.map((item) => ({
        code: item.code, source: item.source, ...(item.path === undefined ? {} : { path: item.path }), message: item.message,
      })),
      ...profileDiagnostics,
    ],
  });
  return { config, runtime, search, store };
}

export function createSearchFromSnapshot(
  snapshot: ExecutionSnapshot,
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<CompositionOptions, 'transport' | 'provider_registrations' | 'requestId' | 'now'> = {},
): SearchService {
  const registry = new ProviderRegistry([
    ...builtInProviderRegistrations(),
    ...(options.provider_registrations ?? []),
  ]);
  if (registry.fingerprint() !== snapshot.registry_fingerprint || registry.revision() !== snapshot.registry_revision) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Worker provider registry does not match the execution snapshot.');
  }
  const bindings = resolveSnapshotBindings(snapshot, env);
  const transport = options.transport ?? new FetchJsonTransport();
  const providers: SearchProvider[] = [];
  for (const item of snapshot.provider_instances) {
    const credential = item.config.credential_slot_id === undefined ? undefined : bindings.get(item.config.credential_slot_id);
    const ports = registry.create(item.provider_instance_id, item.config, {
      ...(credential === undefined ? {} : { credential }),
      transports: { http: transport },
      clock: options.now ?? (() => new Date()),
    });
    if (ports.retrieval !== undefined) providers.push(ports.retrieval);
  }
  return new SearchService({
    providers,
    plan: snapshot.plan,
    requestId: options.requestId,
    now: options.now,
  });
}
