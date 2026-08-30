import { setTimeout as delay } from 'node:timers/promises';

import type { CanonicalConfig, RetryPolicyConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import { NbSearchError, publicError } from './errors.ts';
import type { ProviderRegistry } from './provider-registry.ts';
import { safeErrorMessage } from './redaction.ts';
import type {
  AttemptState, ProviderCapability, ProviderResult, ProviderSearchRequest, PublicError, SearchAttempt, SearchProvider,
} from './types.ts';

export const PLAN_SCHEMA_VERSION = '1' as const;

export interface HealthSnapshot {
  unavailable_provider_capabilities: readonly string[];
  rate_limited_credential_slots: readonly string[];
  unavailable_model_instances: readonly string[];
  unready_credential_slots: readonly string[];
}

export type HealthCause = 'transient_provider_capability' | 'rate_limit_credential_slot' | 'model_instance' | 'credential_readiness';
export interface HealthEvent { cause: HealthCause; identity: string; at: string; error_code?: string }
export interface HealthStore {
  snapshot(): HealthSnapshot;
  record(event: HealthEvent): void;
}

export class NoopHealthStore implements HealthStore {
  snapshot(): HealthSnapshot { return emptyHealthSnapshot(); }
  record(): void { /* Deliberately stateless. */ }
}

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

export interface PlanInvocation {
  invocation_id: string;
  provider_id: string;
  provider_instance_id: string;
  credential_slot_id?: string;
  capability: ProviderCapability;
  role: string;
  trigger: string;
  timeout_ms: number;
  retry: RetryPolicyConfig;
}

export interface PlanStage {
  stage_id: string;
  kind: 'parallel' | 'fallback' | 'augmentation';
  invocations: readonly PlanInvocation[];
}

export interface SearchPlan {
  plan_version: typeof PLAN_SCHEMA_VERSION;
  profile_id: string;
  stages: readonly PlanStage[];
  plan_fingerprint: string;
}

export interface CompilePlanOptions {
  config: CanonicalConfig;
  registry: ProviderRegistry;
  readiness: Readonly<Record<string, boolean>>;
  health?: HealthSnapshot;
  profile_id?: string;
}

export function compileSearchPlan(options: CompilePlanOptions): SearchPlan {
  const profileId = options.profile_id ?? options.config.default_profile_id;
  const profile = options.config.profiles[profileId];
  if (profile === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Search profile ${profileId} is not configured.`);
  const health = options.health ?? emptyHealthSnapshot();
  const usedBriefSlots = new Set<string>();
  const stages: PlanStage[] = [];
  profile.stages.forEach((sourceStage, stageIndex) => {
    const invocations: PlanInvocation[] = [];
    sourceStage.invocations.forEach((sourceInvocation, invocationIndex) => {
      const instance = options.config.provider_instances[sourceInvocation.provider_instance_id];
      if (instance === undefined || !instance.enabled || options.readiness[sourceInvocation.provider_instance_id] !== true) return;
      const descriptor = options.registry.descriptor(instance.provider_id);
      if (descriptor === undefined || !descriptor.capabilities.includes(sourceInvocation.capability)) return;
      const healthIdentity = `${sourceInvocation.provider_instance_id}:${sourceInvocation.capability}`;
      if (health.unavailable_provider_capabilities.includes(healthIdentity)) return;
      if (health.unavailable_model_instances.includes(sourceInvocation.provider_instance_id)) return;
      if (instance.credential_slot_id !== undefined
        && (health.unready_credential_slots.includes(instance.credential_slot_id)
          || health.rate_limited_credential_slots.includes(instance.credential_slot_id))) return;
      const briefSlot = `${sourceInvocation.capability}:${sourceInvocation.role}:${sourceInvocation.trigger}`;
      if (sourceInvocation.capability === 'multi-agent-research' && usedBriefSlots.has(briefSlot)) return;
      usedBriefSlots.add(briefSlot);
      const retry: RetryPolicyConfig = {
        ...instance.retry,
        ...sourceInvocation.retry,
      };
      const seed = {
        profile_id: profileId, stage_index: stageIndex, invocation_index: invocationIndex,
        provider_instance_id: sourceInvocation.provider_instance_id, capability: sourceInvocation.capability,
        role: sourceInvocation.role, trigger: sourceInvocation.trigger,
      };
      invocations.push({
        invocation_id: `inv-${String(stageIndex + 1)}-${String(invocationIndex + 1)}-${stableFingerprint(seed).slice(0, 10)}`,
        provider_id: instance.provider_id,
        provider_instance_id: sourceInvocation.provider_instance_id,
        ...(instance.credential_slot_id === undefined ? {} : { credential_slot_id: instance.credential_slot_id }),
        capability: sourceInvocation.capability,
        role: sourceInvocation.role,
        trigger: sourceInvocation.trigger,
        timeout_ms: sourceInvocation.timeout_ms ?? instance.timeout_ms,
        retry,
      });
    });
    if (invocations.length > 0) stages.push({ stage_id: `stage-${String(stageIndex + 1)}`, kind: sourceStage.kind, invocations });
  });
  const base = { plan_version: PLAN_SCHEMA_VERSION, profile_id: profileId, stages };
  return deepFreeze({ ...base, plan_fingerprint: stableFingerprint(base) });
}

export function isSearchPlanExecutable(plan: SearchPlan): boolean {
  return plan.stages.some((stage) => stage.invocations.length > 0);
}

export interface InvocationOutcome {
  invocation: PlanInvocation;
  attempts: SearchAttempt[];
  results: readonly ProviderResult[];
}

export interface PlanExecution {
  outcomes: readonly InvocationOutcome[];
  caller_cancelled: boolean;
  deadline_exceeded: boolean;
}

export interface PlanExecutorOptions {
  providers: ReadonlyMap<string, SearchProvider>;
  health?: HealthStore;
  now?: () => Date;
  monotonicNow?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class PlanExecutor {
  private readonly health: HealthStore;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly options: PlanExecutorOptions) {
    this.health = options.health ?? new NoopHealthStore();
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  }

  async execute(
    plan: SearchPlan,
    request: Omit<ProviderSearchRequest, 'signal'>,
    budgetMs: number,
    callerSignal?: AbortSignal,
  ): Promise<PlanExecution> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true)), budgetMs);
    const signal = callerSignal === undefined ? deadline.signal : AbortSignal.any([callerSignal, deadline.signal]);
    const outcomes: InvocationOutcome[] = [];
    try {
      for (const stage of plan.stages) {
        if (signal.aborted) break;
        if (stage.kind === 'fallback') {
          for (const invocation of stage.invocations) {
            const outcome = await this.runInvocation(invocation, request, signal, callerSignal, deadline.signal);
            outcomes.push(outcome);
            if (outcome.results.length > 0) break;
            if (signal.aborted) break;
          }
        } else {
          const stageOutcomes = await Promise.all(stage.invocations.map(async (invocation) =>
            await this.runInvocation(invocation, request, signal, callerSignal, deadline.signal)));
          outcomes.push(...stageOutcomes);
        }
      }
    } finally { clearTimeout(timer); }
    return {
      outcomes,
      caller_cancelled: callerSignal?.aborted === true,
      deadline_exceeded: callerSignal?.aborted !== true && deadline.signal.aborted,
    };
  }

  private async runInvocation(
    invocation: PlanInvocation,
    request: Omit<ProviderSearchRequest, 'signal'>,
    outerSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    overallDeadlineSignal: AbortSignal,
  ): Promise<InvocationOutcome> {
    const provider = this.options.providers.get(invocation.provider_instance_id);
    if (provider === undefined) {
      const error = new NbSearchError('CONFIGURATION_ERROR', `Provider instance ${invocation.provider_instance_id} is unavailable.`, false, invocation.provider_id);
      return { invocation, results: [], attempts: [attemptRecord(invocation, 1, 'failed', 0, 0, error.toPublic())] };
    }
    const invocationDeadline = new AbortController();
    const timer = setTimeout(() => invocationDeadline.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Provider invocation deadline was exceeded.', true)), invocation.timeout_ms);
    const signal = AbortSignal.any([outerSignal, invocationDeadline.signal]);
    const attempts: SearchAttempt[] = [];
    try {
      for (let attempt = 1; attempt <= invocation.retry.max_attempts; attempt += 1) {
        const started = this.monotonicNow();
        try {
          const results = await raceWithAbort(provider.search({ ...request, signal }), signal);
          attempts.push(attemptRecord(invocation, attempt, results.length === 0 ? 'empty' : 'succeeded', elapsed(started, this.monotonicNow()), results.length));
          return { invocation, attempts, results };
        } catch (error) {
          const callerCancelled = callerSignal?.aborted === true;
          const overallDeadline = !callerCancelled && overallDeadlineSignal.aborted;
          const localDeadline = !callerCancelled && !overallDeadline && invocationDeadline.signal.aborted;
          const safe = classifyError(error, provider, invocation, callerCancelled, overallDeadline || localDeadline);
          const state: AttemptState = callerCancelled ? 'cancelled' : overallDeadline || localDeadline ? 'timed_out' : 'failed';
          attempts.push(attemptRecord(invocation, attempt, state, elapsed(started, this.monotonicNow()), 0, publicError(safe)));
          const terminal = attempt >= invocation.retry.max_attempts || signal.aborted || !safe.retryable;
          if (terminal) {
            this.recordHealth(invocation, safe, callerCancelled, overallDeadline, localDeadline);
            return { invocation, attempts, results: [] };
          }
          const exponential = Math.min(invocation.retry.max_backoff_ms, invocation.retry.backoff_ms * (2 ** (attempt - 1)));
          const backoff = safe.retryAfterMs ?? exponential;
          try { await this.sleep(backoff, signal); } catch { return { invocation, attempts, results: [] }; }
        }
      }
      return { invocation, attempts, results: [] };
    } finally { clearTimeout(timer); }
  }

  private recordHealth(
    invocation: PlanInvocation,
    error: NbSearchError,
    callerCancelled: boolean,
    overallDeadline: boolean,
    localDeadline: boolean,
  ): void {
    if (callerCancelled || overallDeadline || error.code === 'PROVIDER_AUTH' || error.code === 'CONFIGURATION_ERROR') return;
    if (error.code === 'PROVIDER_RATE_LIMIT' && invocation.credential_slot_id !== undefined) {
      this.health.record({
        cause: 'rate_limit_credential_slot', identity: invocation.credential_slot_id,
        at: this.now().toISOString(), error_code: error.code,
      });
      return;
    }
    if ((error.code === 'PROVIDER_UNAVAILABLE' && error.retryable) || localDeadline) {
      this.health.record({
        cause: 'transient_provider_capability', identity: `${invocation.provider_instance_id}:${invocation.capability}`,
        at: this.now().toISOString(), error_code: error.code,
      });
    }
  }
}

function classifyError(
  error: unknown,
  provider: SearchProvider,
  invocation: PlanInvocation,
  cancelled: boolean,
  timedOut: boolean,
): NbSearchError {
  if (cancelled) return new NbSearchError('CANCELLED', 'Search was cancelled.');
  if (timedOut) return new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true, invocation.provider_id);
  if (error instanceof NbSearchError) {
    return new NbSearchError(error.code, safeErrorMessage(error, provider.redactions), error.retryable, error.provider ?? invocation.provider_id, {
      cause: error, retryAfterMs: error.retryAfterMs,
    });
  }
  return new NbSearchError('PROVIDER_UNAVAILABLE', safeErrorMessage(error, provider.redactions), true, invocation.provider_id);
}

function attemptRecord(
  invocation: PlanInvocation,
  attempt: number,
  state: AttemptState,
  durationMs: number,
  resultCount: number,
  error?: PublicError,
): SearchAttempt {
  return {
    provider: invocation.provider_id,
    provider_instance_id: invocation.provider_instance_id,
    ...(invocation.credential_slot_id === undefined ? {} : { credential_slot_id: invocation.credential_slot_id }),
    invocation_id: invocation.invocation_id,
    capability: invocation.capability,
    role: invocation.role,
    trigger: invocation.trigger,
    attempt,
    state,
    duration_ms: durationMs,
    result_count: resultCount,
    ...(error === undefined ? {} : { error }),
  };
}

function emptyHealthSnapshot(): {
  unavailable_provider_capabilities: string[];
  rate_limited_credential_slots: string[];
  unavailable_model_instances: string[];
  unready_credential_slots: string[];
} {
  return {
    unavailable_provider_capabilities: [], rate_limited_credential_slots: [],
    unavailable_model_instances: [], unready_credential_slots: [],
  };
}
function elapsed(started: number, completed: number): number { return Math.max(0, Math.round(completed - started)); }
async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
