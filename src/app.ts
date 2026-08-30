import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CanonicalConfigPatch } from './config-schema.ts';
import { loadConfiguration, type AppConfiguration } from './config.ts';
import { SearchService } from './core.ts';
import {
  assertSnapshotRegistry, createExecutionSnapshot, resolveSnapshotBindings, type ExecutionSnapshot,
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
import type { ProfileId, SearchProvider } from './types.ts';

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
  cwd?: string;
  homeDirectory?: string;
  snapshotless_legacy_guard?: boolean;
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
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  });
  const requestId = options.requestId ?? randomUUID;
  const planningConfig = options.snapshotless_legacy_guard === true
    ? withoutMultiAgentResearch(config.resolved.config) : config.resolved.config;
  const health = new NoopHealthStore();
  const healthSnapshot = health.snapshot();
  const profilePlans = new Map(Object.keys(planningConfig.profiles).sort().map((profileId) => [
    profileId,
    compileSearchPlan({
      config: planningConfig,
      registry: config.registry,
      readiness: config.provider_readiness,
      capability_readiness: config.capability_readiness,
      health: healthSnapshot,
      routing: { profile: profileId },
    }),
  ]));
  const plan = profilePlans.get(planningConfig.default_profile_id);
  if (plan === undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'The default search profile could not be compiled.');
  const search = new SearchService({
    providers: config.providers, plan,
    plans: profilePlans as ReadonlyMap<ProfileId, typeof plan>,
    defaultProfileId: planningConfig.default_profile_id,
    portsByInstance: config.ports_by_instance,
    planFactory: (routing) => compileSearchPlan({
      config: planningConfig, registry: config.registry, readiness: config.provider_readiness,
      capability_readiness: config.capability_readiness, health: health.snapshot(), routing,
    }),
    requestId, now: options.now,
  });
  const store = new JobStore(config.jobs_root, options.now);
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
  const launcher = options.launcher ?? new DetachedWorkerLauncher(workerPath, env);
  const research = new ResearchService(
    store,
    launcher,
    requestId,
    (request) => {
      const profile = request.profile ?? planningConfig.default_profile_id;
      if (!profilePlans.has(profile)) throw new NbSearchError('INVALID_INPUT', `Search profile ${profile} is not configured.`);
      const selectedPlan = compileSearchPlan({
        config: planningConfig, registry: config.registry, readiness: config.provider_readiness,
        capability_readiness: config.capability_readiness, health: health.snapshot(),
        routing: { profile, ...(request.intent === undefined ? {} : { intent: request.intent }), ...(request.freshness === undefined ? {} : { freshness: request.freshness }), execution_surface: 'research-job' },
      });
      return createExecutionSnapshot(selectedPlan, config.resolved, config.registry, {
        profile,
        ...(request.intent === undefined ? {} : { intent: request.intent }),
        ...(request.freshness === undefined ? {} : { freshness: request.freshness }),
      });
    },
    planningConfig.default_profile_id,
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
      ready_capabilities: (config.registry.descriptor(instance.provider_id)?.capabilities ?? [])
        .filter((capability) => config.capability_readiness[instanceId]?.[capability] === true),
    }));
  const profileIds = [...new Set(['default', 'fast', 'deep', ...Object.keys(config.resolved.config.profiles)])].sort();
  const profiles = profileIds.map((profileId) => {
    const profile = config.resolved.config.profiles[profileId];
    const specialized = profilePlans.get(profileId);
    return {
      profile_id: profileId,
      ready: specialized !== undefined && isSearchPlanExecutable(specialized),
      stage_count: specialized === undefined ? profile?.stages.length ?? 0
        : new Set([...specialized.stages.map((stage) => stage.stage_id), ...(specialized.omissions ?? []).map((item) => item.stage_id)]).size,
    };
  });
  const profileDiagnostics = profiles.filter((profile) => !profile.ready).map((profile) => ({
    code: 'PROFILE_UNREADY',
    source: 'profile',
    path: `profiles.${profile.profile_id}`,
    message: 'Profile has no executable invocations for the resolved provider capabilities and readiness.',
  }));
  const profileOwner = (profileId: string): string | undefined => config.resolved.provenance.find((item) => item.path === `profiles.${profileId}`)?.source;
  const compatibilityOwned = (profileId: string): boolean => {
    const owner = profileOwner(profileId); return owner === 'defaults' || owner?.startsWith('compatibility:') === true;
  };
  const gmaInstance = config.resolved.config.provider_instances['grok-multi-agent.default'];
  const gmaActive = gmaInstance?.provider_id === 'grok-multi-agent' && gmaInstance.enabled;
  const gmaMode = gmaInstance?.options['replace_grok'] === true ? 'replacement' as const : 'overlay' as const;
  const runtime = new NbSearchRuntimeImpl({
    search,
    research,
    requestId,
    providerConfigured: config.provider_configured,
    retentionHours: config.retention_hours,
    providerInstances,
    profiles,
    capabilityRoutes: [
      ...((['default', 'deep'] as const).filter(compatibilityOwned).length === 0 || config.resolved.config.provider_instances['tavily.default'] === undefined ? [] : [{ capability: 'answer' as const, provider_instance_id: 'tavily.default', profile_ids: (['default', 'deep'] as const).filter(compatibilityOwned), intent_in: ['factual', 'tutorial'] as const, operations: ['search', 'research_start'] as const, failure_policy: 'affects-state' as const, execution_scope: 'once-per-job' as const, ready: config.capability_readiness['tavily.default']?.answer === true }]),
      ...(compatibilityOwned('deep') && config.resolved.config.provider_instances['exa.default'] !== undefined ? [{ capability: 'research-light' as const, provider_instance_id: 'exa.default', profile_ids: ['deep'] as const, intent_in: ['status', 'comparison', 'exploratory', 'news'] as const, operations: gmaActive ? ['search'] as const : ['search', 'research_start'] as const, failure_policy: 'report-only' as const, execution_scope: 'once-per-job' as const, ready: config.capability_readiness['exa.default']?.['research-light'] === true }] : []),
      ...(compatibilityOwned('deep') && gmaActive ? [{ capability: 'multi-agent-research' as const, provider_instance_id: 'grok-multi-agent.default', profile_ids: ['deep'] as const, intent_in: ['status', 'comparison', 'exploratory', 'news'] as const, operations: ['research_start'] as const, failure_policy: 'affects-state' as const, execution_scope: 'once-per-job' as const, async_only: true as const, route_mode: gmaMode, ready: config.capability_readiness['grok-multi-agent.default']?.['multi-agent-research'] === true }] : []),
    ],
    configurationDiagnostics: [
      ...config.diagnostics.map((item) => ({
        code: item.code, source: item.source,
        ...(item.path !== undefined && /^(provider_instances|credential_slots|profiles)(\.|$)/.test(item.path) ? { path: item.path } : {}),
        message: item.message,
      })),
      ...profileDiagnostics,
    ],
  });
  return { config, runtime, search, store };
}

function withoutMultiAgentResearch(config: AppConfiguration['resolved']['config']): AppConfiguration['resolved']['config'] {
  const cloned = structuredClone(config);
  for (const profile of Object.values(cloned.profiles)) {
    profile.stages = profile.stages.flatMap((stage) => {
      const invocations = stage.invocations.filter((item) => item.capability !== 'multi-agent-research');
      return invocations.length === 0 ? [] : [{ ...stage, invocations }];
    });
  }
  const gma = cloned.provider_instances['grok-multi-agent.default'];
  if (gma !== undefined) gma.enabled = false;
  return cloned;
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
  assertSnapshotRegistry(snapshot, registry);
  const bindings = resolveSnapshotBindings(snapshot, env);
  const transport = options.transport ?? new FetchJsonTransport();
  const providers: SearchProvider[] = [];
  const portsByInstance = new Map<string, import('./provider-registry.ts').ProviderPorts>();
  const executableInstanceIds = new Set(snapshot.plan.stages.flatMap((stage) => stage.invocations.map((item) => item.provider_instance_id)));
  for (const item of snapshot.provider_instances) {
    if (!executableInstanceIds.has(item.provider_instance_id)) continue;
    const credential = item.config.credential_slot_id === undefined ? undefined : bindings.get(item.config.credential_slot_id);
    const ports = registry.create(item.provider_instance_id, item.config, {
      ...(credential === undefined ? {} : { credential }),
      transports: { http: transport },
      clock: options.now ?? (() => new Date()),
    });
    portsByInstance.set(item.provider_instance_id, ports);
    if (ports.retrieval !== undefined) providers.push(ports.retrieval);
  }
  return new SearchService({
    providers,
    portsByInstance,
    plan: snapshot.plan,
    plans: new Map([[snapshot.routing.profile, snapshot.plan]]),
    defaultProfileId: snapshot.routing.profile,
    routing: snapshot.routing,
    routingLocked: true,
    requestId: options.requestId,
    now: options.now,
  });
}
