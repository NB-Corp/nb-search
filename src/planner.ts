import { setTimeout as delay } from 'node:timers/promises';

import type { CanonicalConfig, RetryPolicyConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import { NbSearchError, publicError } from './errors.ts';
import type { ProviderPorts, ProviderRegistry } from './provider-registry.ts';
import { safeErrorMessage } from './redaction.ts';
import type {
  AttemptState, CapabilityOutcomeState, Freshness, ProviderCapability, ProviderCapabilityResult, ProviderResult,
  ProviderSearchRequest, PublicError, SearchAttempt, SearchIntent, SearchProvider, ProviderSearchResponse,
  ProviderSearchReturn,
} from './types.ts';
import { normalizeUrl } from './url.ts';

export const PLAN_SCHEMA_VERSION = '2' as const;

export interface HealthSnapshot {
  unavailable_provider_capabilities: readonly string[];
  rate_limited_credential_slots: readonly string[];
  unavailable_model_instances: readonly string[];
  unready_credential_slots: readonly string[];
}
export type HealthCause = 'transient_provider_capability' | 'rate_limit_credential_slot' | 'model_instance' | 'credential_readiness';
export interface HealthEvent { cause: HealthCause; identity: string; at: string; error_code?: string }
export interface HealthStore { snapshot(): HealthSnapshot; record(event: HealthEvent): void }
export class NoopHealthStore implements HealthStore { snapshot(): HealthSnapshot { return emptyHealthSnapshot(); } record(): void {} }
export class InMemoryHealthStore implements HealthStore {
  private readonly events: HealthEvent[] = [];
  record(event: HealthEvent): void { this.events.push(structuredClone(event)); }
  snapshot(): HealthSnapshot {
    const snapshot = emptyHealthSnapshot();
    for (const event of this.events) {
      if (event.cause === 'transient_provider_capability') snapshot.unavailable_provider_capabilities.push(event.identity);
      else if (event.cause === 'rate_limit_credential_slot') snapshot.rate_limited_credential_slots.push(event.identity);
      else if (event.cause === 'model_instance') snapshot.unavailable_model_instances.push(event.identity);
      else snapshot.unready_credential_slots.push(event.identity);
    }
    return snapshot;
  }
  history(): readonly HealthEvent[] { return structuredClone(this.events); }
}

export type FailurePolicy = 'affects-state' | 'report-only';
export type ExecutionScope = 'per-operation' | 'once-per-job';
export interface PlanInvocation {
  invocation_id: string; provider_id: string; provider_instance_id: string; credential_slot_id?: string;
  capability: ProviderCapability; role: string; trigger: string; timeout_ms: number; retry: RetryPolicyConfig;
  failure_policy?: FailurePolicy; execution_scope?: ExecutionScope;
}
export interface PlanStage { stage_id: string; kind: 'parallel' | 'fallback' | 'augmentation'; invocations: readonly PlanInvocation[] }
export interface PlanOmission {
  stage_id: string; stage_index: number; invocation_index: number; invocation_id: string; provider_id: string;
  provider_instance_id: string; credential_slot_id?: string; capability: ProviderCapability; role: string; trigger: string;
  failure_policy: FailurePolicy; execution_scope: ExecutionScope;
  reason: 'instance-unready' | 'capability-unready' | 'health-suppressed';
}
export interface SearchPlan {
  plan_version: typeof PLAN_SCHEMA_VERSION | '1'; profile_id: string; stages: readonly PlanStage[]; omissions?: readonly PlanOmission[];
  routing?: { profile: string; intent?: SearchIntent; freshness?: Freshness }; plan_fingerprint: string;
}
export interface CompilePlanOptions {
  config: CanonicalConfig; registry: ProviderRegistry;
  readiness?: Readonly<Record<string, boolean>>;
  capability_readiness?: Readonly<Record<string, Readonly<Partial<Record<ProviderCapability, boolean>>>>>;
  health?: HealthSnapshot; profile_id?: string;
  routing?: { profile: string; intent?: SearchIntent; freshness?: Freshness };
}

export function compileSearchPlan(options: CompilePlanOptions): SearchPlan {
  const profileId = options.routing?.profile ?? options.profile_id ?? options.config.default_profile_id;
  const profile = options.config.profiles[profileId];
  if (profile === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Search profile ${profileId} is not configured.`);
  const routing = { profile: profileId, ...(options.routing?.intent === undefined ? {} : { intent: options.routing.intent }), ...(options.routing?.freshness === undefined ? {} : { freshness: options.routing.freshness }) };
  const health = options.health ?? emptyHealthSnapshot();
  const usedBriefSlots = new Set<string>();
  const usedOperations = new Set<string>();
  const stages: PlanStage[] = [];
  const omissions: PlanOmission[] = [];
  profile.stages.forEach((sourceStage, stageIndex) => {
    const invocations: PlanInvocation[] = [];
    sourceStage.invocations.forEach((sourceInvocation, invocationIndex) => {
      if (!conditionMatches(sourceInvocation.when, routing.intent)) return;
      const instance = options.config.provider_instances[sourceInvocation.provider_instance_id];
      if (instance === undefined) return;
      const descriptor = options.registry.descriptor(instance.provider_id);
      const defaults = defaultSemantics(sourceInvocation.capability);
      const failurePolicy = sourceInvocation.failure_policy ?? defaults.failure_policy;
      const executionScope = sourceInvocation.execution_scope ?? defaults.execution_scope;
      const seed = { profile_id: profileId, stage_index: stageIndex, invocation_index: invocationIndex, provider_instance_id: sourceInvocation.provider_instance_id, capability: sourceInvocation.capability, role: sourceInvocation.role, trigger: sourceInvocation.trigger };
      const invocationId = `inv-${String(stageIndex + 1)}-${String(invocationIndex + 1)}-${stableFingerprint(seed).slice(0, 10)}`;
      const operationPath = capabilityPath(instance.options, sourceInvocation.capability, descriptor?.operations.find((item) => item.capability === sourceInvocation.capability)?.path ?? '');
      const operationKey = `${sourceInvocation.provider_instance_id}:${sourceInvocation.capability}:${operationPath}`;
      if (usedOperations.has(operationKey)) throw new NbSearchError('CONFIGURATION_ERROR', `Search profile ${profileId} selects duplicate provider operation ${operationKey}.`);
      usedOperations.add(operationKey);
      const healthIdentity = `${sourceInvocation.provider_instance_id}:${sourceInvocation.capability}`;
      const healthSuppressed = health.unavailable_provider_capabilities.includes(healthIdentity)
        || health.unavailable_model_instances.includes(sourceInvocation.provider_instance_id)
        || (instance.credential_slot_id !== undefined && (health.unready_credential_slots.includes(instance.credential_slot_id) || health.rate_limited_credential_slots.includes(instance.credential_slot_id)));
      const instanceReady = instance.enabled && (options.readiness === undefined || options.readiness[sourceInvocation.provider_instance_id] === true);
      const descriptorSupports = descriptor?.capabilities.includes(sourceInvocation.capability) === true;
      const capabilityReady = options.capability_readiness?.[sourceInvocation.provider_instance_id]?.[sourceInvocation.capability]
        ?? (instanceReady && descriptorSupports);
      if (!instanceReady || !descriptorSupports || !capabilityReady || healthSuppressed) {
        if (sourceInvocation.capability !== 'retrieval') omissions.push({
          stage_id: `stage-${String(stageIndex + 1)}`, stage_index: stageIndex, invocation_index: invocationIndex,
          invocation_id: invocationId, provider_id: instance.provider_id, provider_instance_id: sourceInvocation.provider_instance_id,
          ...(instance.credential_slot_id === undefined ? {} : { credential_slot_id: instance.credential_slot_id }),
          capability: sourceInvocation.capability, role: sourceInvocation.role, trigger: sourceInvocation.trigger,
          failure_policy: failurePolicy, execution_scope: executionScope,
          reason: healthSuppressed ? 'health-suppressed' : instanceReady && descriptorSupports ? 'capability-unready' : 'instance-unready',
        });
        return;
      }
      const briefSlot = `${sourceInvocation.capability}:${sourceInvocation.role}:${sourceInvocation.trigger}`;
      if (sourceInvocation.capability === 'multi-agent-research' && usedBriefSlots.has(briefSlot)) return;
      usedBriefSlots.add(briefSlot);
      const capabilityPolicy = instance.capability_policies?.[sourceInvocation.capability];
      const retry: RetryPolicyConfig = { ...instance.retry, ...capabilityPolicy?.retry, ...sourceInvocation.retry };
      invocations.push({
        invocation_id: invocationId, provider_id: instance.provider_id, provider_instance_id: sourceInvocation.provider_instance_id,
        ...(instance.credential_slot_id === undefined ? {} : { credential_slot_id: instance.credential_slot_id }),
        capability: sourceInvocation.capability, role: sourceInvocation.role, trigger: sourceInvocation.trigger,
        timeout_ms: sourceInvocation.timeout_ms ?? capabilityPolicy?.timeout_ms ?? instance.timeout_ms, retry,
        failure_policy: failurePolicy, execution_scope: executionScope,
      });
    });
    if (invocations.length > 0) stages.push({ stage_id: `stage-${String(stageIndex + 1)}`, kind: sourceStage.kind, invocations });
  });
  const base = { plan_version: PLAN_SCHEMA_VERSION, profile_id: profileId, stages, omissions, routing };
  return deepFreeze({ ...base, plan_fingerprint: stableFingerprint(base) });
}

export function isSearchPlanExecutable(plan: SearchPlan): boolean { return plan.stages.some((stage) => stage.invocations.length > 0); }
export function hasSelectedPlanWork(plan: SearchPlan): boolean { return isSearchPlanExecutable(plan) || (plan.omissions?.length ?? 0) > 0; }

export interface InvocationOutcome {
  invocation: PlanInvocation; attempts: SearchAttempt[]; state: CapabilityOutcomeState;
  result?: ProviderCapabilityResult; results: readonly ProviderResult[]; error?: PublicError;
}
export interface PlanExecution {
  outcomes: readonly InvocationOutcome[]; omissions: readonly PlanOmission[];
  caller_cancelled: boolean; deadline_exceeded: boolean; completed_once_per_job_invocation_ids: ReadonlySet<string>;
}
export interface PlanExecutionContext {
  scope: 'sync' | 'research-job'; completed_once_per_job_invocation_ids: ReadonlySet<string>;
  capture_augmentations?: (items: readonly import('./types.ts').CapabilityAugmentation[]) => void;
}
export interface PlanExecutorOptions {
  providers?: ReadonlyMap<string, SearchProvider>; ports_by_instance?: ReadonlyMap<string, ProviderPorts>;
  health?: HealthStore; now?: () => Date; monotonicNow?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class PlanExecutor {
  private readonly health: HealthStore;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly ports: ReadonlyMap<string, ProviderPorts>;
  constructor(private readonly options: PlanExecutorOptions) {
    this.health = options.health ?? new NoopHealthStore();
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    this.ports = options.ports_by_instance ?? new Map([...(options.providers ?? new Map()).entries()].map(([id, provider]) => [id, { retrieval: provider }]));
  }

  async execute(
    plan: SearchPlan,
    request: Omit<ProviderSearchRequest, 'signal'>,
    budgetMs: number,
    callerSignal?: AbortSignal,
    context: PlanExecutionContext = { scope: 'sync', completed_once_per_job_invocation_ids: new Set() },
  ): Promise<PlanExecution> {
    const deadlineAt = this.monotonicNow() + budgetMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true)), budgetMs);
    const signal = callerSignal === undefined ? deadline.signal : AbortSignal.any([callerSignal, deadline.signal]);
    const outcomes: InvocationOutcome[] = [];
    const completed = new Set(context.completed_once_per_job_invocation_ids);
    const selectedOmissions = (plan.omissions ?? []).filter((item) => item.execution_scope !== 'once-per-job' || !completed.has(item.invocation_id));
    for (const omission of selectedOmissions) if (omission.execution_scope === 'once-per-job') completed.add(omission.invocation_id);
    try {
      for (const stage of plan.stages) {
        if (signal.aborted) break;
        const eligible = stage.invocations.filter((item) => (item.execution_scope ?? defaultSemantics(item.capability).execution_scope) !== 'once-per-job' || !completed.has(item.invocation_id));
        if (eligible.length === 0) continue;
        const retrievalCount = normalizedRetrievalResultCount(outcomes);
        if (stage.kind === 'fallback') {
          for (const invocation of eligible) {
            const outcome = await this.runInvocation(invocation, request, retrievalCount, signal, callerSignal, deadline, deadlineAt);
            outcomes.push(outcome);
            if ((invocation.execution_scope ?? defaultSemantics(invocation.capability).execution_scope) === 'once-per-job') completed.add(invocation.invocation_id);
            if (outcome.state === 'succeeded') break;
            if (signal.aborted) break;
          }
        } else {
          const stageOutcomes = await Promise.all(eligible.map(async (invocation) => await this.runInvocation(invocation, request, retrievalCount, signal, callerSignal, deadline, deadlineAt)));
          outcomes.push(...stageOutcomes);
          for (const invocation of eligible) if ((invocation.execution_scope ?? defaultSemantics(invocation.capability).execution_scope) === 'once-per-job') completed.add(invocation.invocation_id);
        }
      }
    } finally { clearTimeout(timer); }
    if (signal.aborted) {
      const completedOutcomeIds = new Set(outcomes.map((item) => item.invocation.invocation_id));
      for (const invocation of plan.stages.flatMap((stage) => stage.invocations)) {
        if (invocation.capability === 'retrieval' || completedOutcomeIds.has(invocation.invocation_id)
          || ((invocation.execution_scope ?? defaultSemantics(invocation.capability).execution_scope) === 'once-per-job'
            && context.completed_once_per_job_invocation_ids.has(invocation.invocation_id))) continue;
        const cancelled = callerSignal?.aborted === true;
        const error = cancelled
          ? new NbSearchError('CANCELLED', 'Search was cancelled.', false, invocation.provider_id).toPublic()
          : new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true, invocation.provider_id).toPublic();
        outcomes.push({ invocation, attempts: [], state: cancelled ? 'cancelled' : 'timed_out', results: [], error });
        if ((invocation.execution_scope ?? defaultSemantics(invocation.capability).execution_scope) === 'once-per-job') completed.add(invocation.invocation_id);
      }
    }
    return { outcomes, omissions: selectedOmissions, caller_cancelled: callerSignal?.aborted === true, deadline_exceeded: callerSignal?.aborted !== true && deadline.signal.aborted, completed_once_per_job_invocation_ids: completed };
  }

  private async runInvocation(
    invocation: PlanInvocation, request: Omit<ProviderSearchRequest, 'signal'>, retrievalCount: number,
    outerSignal: AbortSignal, callerSignal: AbortSignal | undefined, overallDeadline: AbortController, deadlineAt: number,
  ): Promise<InvocationOutcome> {
    const ports = this.ports.get(invocation.provider_instance_id);
    const provider = capabilityPort(ports, invocation.capability);
    if (provider === undefined) {
      const error = new NbSearchError('CAPABILITY_UNAVAILABLE', `Provider capability ${invocation.provider_instance_id}:${invocation.capability} is unavailable.`, false, invocation.provider_id).toPublic();
      return { invocation, state: 'unavailable', results: [], attempts: [], error };
    }
    const attempts: SearchAttempt[] = [];
    for (let attempt = 1; attempt <= invocation.retry.max_attempts; attempt += 1) {
      const remainingMs = Math.floor(deadlineAt - this.monotonicNow());
      if (remainingMs <= 0) {
        if (!overallDeadline.signal.aborted) overallDeadline.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true));
        const error = new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true, invocation.provider_id).toPublic();
        attempts.push(attemptRecord(invocation, attempt, 'timed_out', 0, 0, error));
        return { invocation, state: 'timed_out', attempts, results: [], error };
      }
      const attemptDeadline = new AbortController();
      const timer = setTimeout(() => attemptDeadline.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Provider invocation deadline was exceeded.', true)), Math.min(invocation.timeout_ms, remainingMs));
      const signal = AbortSignal.any([outerSignal, attemptDeadline.signal]);
      try {
        const started = this.monotonicNow();
        try {
          const result = await raceWithAbort(callCapability(provider, invocation.capability, request, retrievalCount, signal), signal);
          const results = result.capability === 'retrieval' ? result.results : result.capability === 'answer' ? result.supporting_results : [];
          const success = usableResult(result);
          const resultCount = result.capability === 'retrieval' ? result.results.length : success ? 1 : 0;
          attempts.push(attemptRecord(invocation, attempt, success ? 'succeeded' : 'empty', elapsed(started, this.monotonicNow()), resultCount, undefined,
            result.capability === 'retrieval' ? result.upstream_attempts : undefined,
            result.capability === 'retrieval' ? result.upstream_attempts_omitted : undefined));
          return { invocation, attempts, state: success ? 'succeeded' : 'empty', result, results };
        } catch (error) {
          const callerCancelled = callerSignal?.aborted === true;
          const overallDeadlineReached = !callerCancelled && overallDeadline.signal.aborted;
          const localDeadline = !callerCancelled && !overallDeadlineReached && attemptDeadline.signal.aborted;
          const safe = classifyError(error, provider, invocation, callerCancelled, overallDeadlineReached || localDeadline);
          const state: AttemptState = callerCancelled ? 'cancelled' : overallDeadlineReached || localDeadline ? 'timed_out' : 'failed';
          attempts.push(attemptRecord(invocation, attempt, state, elapsed(started, this.monotonicNow()), 0, publicError(safe)));
          const terminal = attempt >= invocation.retry.max_attempts || outerSignal.aborted || !safe.retryable;
          if (terminal) {
            this.recordHealth(invocation, safe, callerCancelled, overallDeadlineReached, localDeadline);
            return { invocation, attempts, state, results: [], error: publicError(safe) };
          }
          const exponential = Math.min(invocation.retry.max_backoff_ms, invocation.retry.backoff_ms * (2 ** (attempt - 1)));
          const backoff = Math.min(safe.retryAfterMs ?? exponential, Math.max(0, Math.floor(deadlineAt - this.monotonicNow())));
          if (backoff > 0) try { await this.sleep(backoff, outerSignal); } catch {
            const cancelled = callerSignal?.aborted === true;
            const timedOut = !cancelled && overallDeadline.signal.aborted;
            const terminalError = cancelled
              ? new NbSearchError('CANCELLED', 'Search was cancelled.', false, invocation.provider_id).toPublic()
              : timedOut ? new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true, invocation.provider_id).toPublic() : attempts.at(-1)?.error;
            return { invocation, attempts, state: cancelled ? 'cancelled' : timedOut ? 'timed_out' : state, results: [], error: terminalError };
          }
        }
      } finally { clearTimeout(timer); }
    }
    return { invocation, attempts, state: 'failed', results: [], error: attempts.at(-1)?.error };
  }

  private recordHealth(invocation: PlanInvocation, error: NbSearchError, callerCancelled: boolean, overallDeadline: boolean, localDeadline: boolean): void {
    if (callerCancelled || overallDeadline || error.code === 'PROVIDER_AUTH' || error.code === 'CONFIGURATION_ERROR') return;
    if (error.code === 'PROVIDER_RATE_LIMIT' && invocation.credential_slot_id !== undefined) this.health.record({ cause: 'rate_limit_credential_slot', identity: invocation.credential_slot_id, at: this.now().toISOString(), error_code: error.code });
    else if ((error.code === 'PROVIDER_UNAVAILABLE' && error.retryable) || localDeadline) this.health.record({ cause: 'transient_provider_capability', identity: `${invocation.provider_instance_id}:${invocation.capability}`, at: this.now().toISOString(), error_code: error.code });
  }
}

function conditionMatches(condition: { intent_in?: readonly SearchIntent[]; intent_not_in?: readonly SearchIntent[] } | undefined, intent: SearchIntent | undefined): boolean {
  if (condition?.intent_in !== undefined) return intent !== undefined && condition.intent_in.includes(intent);
  if (condition?.intent_not_in !== undefined) return intent === undefined || !condition.intent_not_in.includes(intent);
  return true;
}
function defaultSemantics(capability: ProviderCapability): { failure_policy: FailurePolicy; execution_scope: ExecutionScope } {
  if (capability === 'research-light') return { failure_policy: 'report-only', execution_scope: 'once-per-job' };
  if (capability === 'answer' || capability === 'multi-agent-research') return { failure_policy: 'affects-state', execution_scope: 'once-per-job' };
  return { failure_policy: 'affects-state', execution_scope: 'per-operation' };
}
function capabilityPath(options: Readonly<Record<string, unknown>>, capability: ProviderCapability, fallback: string): string {
  const key = capability === 'retrieval' ? 'search_path' : capability === 'answer' ? 'answer_path' : capability === 'research-light' ? 'research_light_path' : '';
  return key !== '' && typeof options[key] === 'string' ? options[key] as string : fallback;
}
function capabilityPort(ports: ProviderPorts | undefined, capability: ProviderCapability): SearchProvider | NonNullable<ProviderPorts['answer']> | NonNullable<ProviderPorts['research_light']> | undefined {
  if (capability === 'retrieval') return ports?.retrieval;
  if (capability === 'answer') return ports?.answer;
  if (capability === 'research-light') return ports?.research_light;
  return undefined;
}
async function callCapability(
  provider: SearchProvider | NonNullable<ProviderPorts['answer']> | NonNullable<ProviderPorts['research_light']>,
  capability: ProviderCapability, request: Omit<ProviderSearchRequest, 'signal'>, retrievalCount: number, signal: AbortSignal,
): Promise<ProviderCapabilityResult> {
  const base = { query: request.query, profile: request.profile ?? 'default', ...(request.intent === undefined ? {} : { intent: request.intent }), ...(request.freshness === undefined ? {} : { freshness: request.freshness }), request_time_utc: request.request_time_utc ?? new Date().toISOString(), signal };
  if (capability === 'retrieval') {
    const returned = await (provider as SearchProvider).search({ ...request, signal });
    const normalized = normalizeProviderResponse(returned);
    return { capability: 'retrieval', results: normalized.results, ...(normalized.upstream_attempts === undefined ? {} : { upstream_attempts: normalized.upstream_attempts }), ...(normalized.upstream_attempts_omitted === undefined ? {} : { upstream_attempts_omitted: normalized.upstream_attempts_omitted }) };
  }
  if (capability === 'answer') return await (provider as NonNullable<ProviderPorts['answer']>).answer({ ...base, capability: 'answer', limit: request.limit });
  if (capability === 'research-light') return await (provider as NonNullable<ProviderPorts['research_light']>).researchLight({ ...base, capability: 'research-light', retrieval_result_count: retrievalCount });
  throw new NbSearchError('CAPABILITY_UNAVAILABLE', 'Selected capability is unavailable.');
}
function usableResult(result: ProviderCapabilityResult): boolean {
  return result.capability === 'retrieval' ? result.results.length > 0 : result.capability === 'answer' ? (result.text?.trim().length ?? 0) > 0 : (result.synthesis?.trim().length ?? 0) > 0;
}
export function normalizedRetrievalResultCount(outcomes: readonly InvocationOutcome[]): number {
  const urls = new Set<string>();
  for (const outcome of outcomes) for (const item of outcome.results) { const url = normalizeUrl(item.url); if (url !== undefined) urls.add(url); }
  return urls.size;
}
function classifyError(error: unknown, provider: { redactions?: readonly string[] }, invocation: PlanInvocation, cancelled: boolean, timedOut: boolean): NbSearchError {
  if (cancelled) return new NbSearchError('CANCELLED', 'Search was cancelled.');
  if (timedOut) return new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true, invocation.provider_id);
  if (error instanceof NbSearchError) return new NbSearchError(error.code, safeErrorMessage(error, provider.redactions), error.retryable, error.provider ?? invocation.provider_id, { cause: error, retryAfterMs: error.retryAfterMs });
  return new NbSearchError('PROVIDER_UNAVAILABLE', safeErrorMessage(error, provider.redactions), true, invocation.provider_id);
}
function attemptRecord(invocation: PlanInvocation, attempt: number, state: AttemptState, durationMs: number, resultCount: number, error?: PublicError, upstreamAttempts?: SearchAttempt['upstream_attempts'], upstreamAttemptsOmitted?: number): SearchAttempt {
  return {
    provider: invocation.provider_id, provider_instance_id: invocation.provider_instance_id,
    ...(invocation.credential_slot_id === undefined ? {} : { credential_slot_id: invocation.credential_slot_id }),
    invocation_id: invocation.invocation_id, capability: invocation.capability, role: invocation.role, trigger: invocation.trigger,
    ...((invocation.failure_policy ?? defaultSemantics(invocation.capability).failure_policy) === 'affects-state' ? {} : { failure_policy: invocation.failure_policy ?? defaultSemantics(invocation.capability).failure_policy }),
    ...((invocation.execution_scope ?? defaultSemantics(invocation.capability).execution_scope) === 'per-operation' ? {} : { execution_scope: invocation.execution_scope ?? defaultSemantics(invocation.capability).execution_scope }),
    attempt, state, duration_ms: durationMs, result_count: resultCount, ...(error === undefined ? {} : { error }),
    ...(upstreamAttempts === undefined || upstreamAttempts.length === 0 ? {} : { upstream_attempts: upstreamAttempts }),
    ...(upstreamAttemptsOmitted === undefined || upstreamAttemptsOmitted === 0 ? {} : { upstream_attempts_omitted: upstreamAttemptsOmitted }),
  };
}
function emptyHealthSnapshot(): { unavailable_provider_capabilities: string[]; rate_limited_credential_slots: string[]; unavailable_model_instances: string[]; unready_credential_slots: string[] } {
  return { unavailable_provider_capabilities: [], rate_limited_credential_slots: [], unavailable_model_instances: [], unready_credential_slots: [] };
}
function elapsed(started: number, completed: number): number { return Math.max(0, Math.round(completed - started)); }
function normalizeProviderResponse(value: ProviderSearchReturn): ProviderSearchResponse { return Array.isArray(value) ? { results: value } : value as ProviderSearchResponse; }
async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); }
  return value;
}
