import { randomUUID } from 'node:crypto';
import { NbSearchError, invalidInput } from './errors.ts';
import { PlanExecutor, type InvocationOutcome, type SearchPlan } from './planner.ts';
import type {
  Freshness, ProfileId, ProviderResult, ResultProvenance, SearchAttempt, SearchEnvelope, SearchIntent,
  SearchProvider, SearchRequest, SearchResult, SearchState,
} from './types.ts';
import { FRESHNESS_VALUES, SCHEMA_VERSION, SEARCH_INTENTS, SEARCH_PROFILE_IDS, SEARCH_TEXT_MAX_BYTES } from './types.ts';
import { normalizeUrl } from './url.ts';

export interface SearchServiceOptions {
  providers: readonly SearchProvider[];
  now?: () => Date;
  requestId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  plan?: SearchPlan;
  plans?: ReadonlyMap<ProfileId, SearchPlan>;
  defaultProfileId?: ProfileId;
  routing?: { profile: ProfileId; intent?: SearchIntent; freshness?: Freshness };
  routingLocked?: boolean;
  executor?: PlanExecutor;
}

export class SearchService {
  private readonly now: () => Date;
  private readonly requestId: () => string;
  private readonly plan: SearchPlan;
  private readonly plans: ReadonlyMap<ProfileId, SearchPlan>;
  private readonly executor: PlanExecutor;
  constructor(private readonly options: SearchServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? randomUUID;
    this.plan = options.plan ?? legacyPlan(options.providers);
    this.plans = options.plans ?? new Map([['default', this.plan]]);
    const providers = new Map<string, SearchProvider>();
    options.providers.forEach((provider, index) => providers.set(instanceIdentity(provider, index), provider));
    this.executor = options.executor ?? new PlanExecutor({
      providers,
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  async search(request: SearchRequest, operationRequestId?: string): Promise<SearchEnvelope> {
    const query = request.query.trim();
    if (query.length < 1 || query.length > 4000) throw invalidInput('query must contain 1 to 4000 characters.');
    const maxResults = boundedInteger(request.max_results ?? 8, 1, 20, 'max_results');
    const budgetMs = boundedInteger(request.timeout_ms ?? 20_000, 1000, 45_000, 'timeout_ms');
    const requestId = operationRequestId ?? this.requestId();
    const startedAt = this.now();
    const locked = this.options.routingLocked === true;
    const routedRequest = locked ? { ...request, ...this.options.routing } : { ...this.options.routing, ...request };
    const profile = validatedRouting(
      locked ? undefined : request.profile,
      routedRequest.intent,
      routedRequest.freshness,
      routedRequest.profile ?? this.options.defaultProfileId ?? this.plan.profile_id,
    );
    const plan = this.plans.get(profile) ?? (profile === this.plan.profile_id ? this.plan : undefined);
    if (plan === undefined) throw invalidInput(`profile ${profile} is not configured.`);
    if (plan.stages.length === 0) {
      return compactEnvelope(baseEnvelope(requestId, query, 'failed', startedAt, this.now(), budgetMs, [], [], [],
        new NbSearchError('CONFIGURATION_ERROR', 'No search provider is configured.').toPublic()));
    }

    const execution = await this.executor.execute(plan, {
      query, limit: maxResults, profile,
      ...(routedRequest.intent === undefined ? {} : { intent: routedRequest.intent }),
      ...(routedRequest.freshness === undefined ? {} : { freshness: routedRequest.freshness }),
    }, budgetMs, request.signal);
    const outcomes = execution.outcomes;
    const attempts = outcomes.flatMap((outcome) => outcome.attempts);
    const results = mergeResults(outcomes, maxResults);
    const callerCancelled = execution.caller_cancelled;
    const deadlineExceeded = execution.deadline_exceeded;
    const state = deriveState(results, attempts, callerCancelled, deadlineExceeded);
    const warnings = state === 'partial'
      ? [deadlineExceeded ? 'The deadline was reached; useful results were preserved.' : 'One or more providers did not complete successfully.']
      : [];
    const terminalError = results.length === 0 && (state === 'failed' || state === 'timed_out' || state === 'cancelled')
      ? state === 'cancelled'
        ? new NbSearchError('CANCELLED', 'Search was cancelled.').toPublic()
        : state === 'timed_out'
          ? new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true).toPublic()
          : attempts.findLast((item) => item.error !== undefined)?.error
      : undefined;
    return compactEnvelope(baseEnvelope(requestId, query, state, startedAt, this.now(), budgetMs, results, attempts, warnings, terminalError));
  }

}

function validatedRouting(
  explicitProfile: ProfileId | undefined,
  intent: SearchRequest['intent'],
  freshness: SearchRequest['freshness'],
  resolvedProfile: ProfileId,
): ProfileId {
  if (explicitProfile !== undefined && !(SEARCH_PROFILE_IDS as readonly string[]).includes(explicitProfile)) {
    throw invalidInput('profile must be default, fast, or deep.');
  }
  if (intent !== undefined && !(SEARCH_INTENTS as readonly string[]).includes(intent)) {
    throw invalidInput('intent must be factual, status, comparison, tutorial, exploratory, news, or resource.');
  }
  if (freshness !== undefined && !(FRESHNESS_VALUES as readonly string[]).includes(freshness)) {
    throw invalidInput('freshness must be pd, pw, pm, or py.');
  }
  return resolvedProfile;
}

function baseEnvelope(
  requestId: string, query: string, state: SearchState, startedAt: Date, completedAt: Date, budgetMs: number,
  results: SearchResult[], attempts: SearchAttempt[], warnings: string[], error?: SearchEnvelope['error'],
): SearchEnvelope {
  return {
    schema_version: SCHEMA_VERSION, request_id: requestId, mode: 'search', state, query, results, attempts, warnings,
    ...(error === undefined ? {} : { error }),
    timing: { started_at: startedAt.toISOString(), completed_at: completedAt.toISOString(), duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()), budget_ms: budgetMs },
    compaction: { applied: false, snippets_shortened: 0, results_omitted: 0, max_bytes: SEARCH_TEXT_MAX_BYTES },
  };
}

function mergeResults(outcomes: readonly InvocationOutcome[], limit: number): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  outcomes.forEach((outcome) => {
    const invocation = outcome.invocation;
    outcome.results.forEach((item, rank) => {
      const url = normalizeUrl(item.url);
      if (url === undefined) return;
      const provenance: ResultProvenance = {
        provider: invocation.provider_id,
        provider_instance_id: invocation.provider_instance_id,
        ...(invocation.credential_slot_id === undefined ? {} : { credential_slot_id: invocation.credential_slot_id }),
        invocation_id: invocation.invocation_id,
        capability: invocation.capability,
        role: invocation.role,
        trigger: invocation.trigger,
        rank, original_url: item.url,
        ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
        ...(item.upstream_attribution === undefined || item.upstream_attribution.length === 0
          ? {} : { upstream: structuredClone(item.upstream_attribution) }),
        ...(item.upstream_attribution_omitted === undefined || item.upstream_attribution_omitted === 0
          ? {} : { upstream_omitted: item.upstream_attribution_omitted }) };
      const existing = merged.get(url);
      if (existing !== undefined) {
        if (!existing.providers.includes(invocation.provider_id)) existing.providers.push(invocation.provider_id);
        existing.provenance.push(provenance);
        if (existing.snippet === '' && item.snippet !== undefined) existing.snippet = cleanText(item.snippet);
        return;
      }
      merged.set(url, {
        title: cleanText(item.title), url, snippet: cleanText(item.snippet ?? ''),
        ...(item.published_at === undefined ? {} : { published_at: item.published_at }),
        ...(item.site_name === undefined ? {} : { site_name: item.site_name }),
        ...(item.score === undefined ? {} : { score: item.score }), providers: [invocation.provider_id], provenance: [provenance],
      });
    });
  });
  return [...merged.values()].slice(0, limit);
}

function deriveState(
  results: readonly SearchResult[],
  attempts: readonly SearchAttempt[],
  callerCancelled: boolean,
  deadlineExceeded: boolean,
): SearchState {
  if (callerCancelled) return 'cancelled';
  if (results.length === 0 && deadlineExceeded) return 'timed_out';
  const completed = attempts.filter((item) => item.state === 'succeeded' || item.state === 'empty');
  const finalByProvider = new Map(attempts.map((item) => [item.invocation_id ?? item.provider_instance_id ?? item.provider, item]));
  const failedFinal = [...finalByProvider.values()].filter((item) => item.state !== 'succeeded' && item.state !== 'empty');
  if (results.length > 0) return failedFinal.length > 0 ? 'partial' : 'succeeded';
  if (completed.length > 0 && failedFinal.length === 0) return 'empty';
  if (failedFinal.length > 0 && failedFinal.every((item) => item.state === 'timed_out')) return 'timed_out';
  return 'failed';
}

function compactEnvelope(envelope: SearchEnvelope): SearchEnvelope {
  const originalCount = envelope.results.length;
  let shortened = 0;
  let nestedCompacted = false;
  let metadataCompacted = false;
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const result = envelope.results.find((item) => item.snippet.length > 512);
    if (result === undefined) break;
    result.snippet = `${result.snippet.slice(0, Math.max(256, Math.floor(result.snippet.length * 0.65))).trimEnd()}…`;
    shortened += 1;
  }
  if (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    for (const result of envelope.results) for (const provenance of result.provenance) {
      if (provenance.metadata !== undefined) { delete provenance.metadata; metadataCompacted = true; }
    }
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const nestedError = envelope.attempts.flatMap((attempt) => attempt.upstream_attempts ?? [])
      .find((attempt) => (attempt.error?.message?.length ?? 0) > 64);
    if (nestedError?.error?.message === undefined) break;
    nestedError.error.message = `${nestedError.error.message.slice(0, Math.max(32, Math.floor(nestedError.error.message.length * 0.6))).trimEnd()}…`;
    nestedCompacted = true;
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const outer = [...envelope.attempts].reverse().find((attempt) => (attempt.upstream_attempts?.length ?? 0) > 0);
    if (outer?.upstream_attempts === undefined) break;
    const mutable = [...outer.upstream_attempts];
    mutable.pop();
    outer.upstream_attempts = mutable;
    outer.upstream_attempts_omitted = (outer.upstream_attempts_omitted ?? 0) + 1;
    nestedCompacted = true;
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const provenance = envelope.results.flatMap((result) => result.provenance)
      .findLast((item) => (item.upstream?.length ?? 0) > 0);
    if (provenance?.upstream === undefined) break;
    const mutable = [...provenance.upstream];
    mutable.pop();
    provenance.upstream = mutable;
    provenance.upstream_omitted = (provenance.upstream_omitted ?? 0) + 1;
    nestedCompacted = true;
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES && envelope.results.length > 0) envelope.results.pop();
  envelope.compaction = {
    applied: shortened > 0 || metadataCompacted || nestedCompacted || envelope.results.length < originalCount,
    snippets_shortened: shortened,
    results_omitted: originalCount - envelope.results.length,
    max_bytes: SEARCH_TEXT_MAX_BYTES,
  };
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES && envelope.results.length > 0) {
    envelope.results.pop();
    envelope.compaction.applied = true;
    envelope.compaction.results_omitted = originalCount - envelope.results.length;
  }
  return envelope;
}

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function cleanText(value: string): string { return value.replace(/\s+/g, ' ').trim() }
function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalidInput(`${field} must be an integer from ${String(min)} to ${String(max)}.`);
  return value;
}
function instanceIdentity(provider: SearchProvider, index: number): string {
  return provider.provider_instance_id ?? `${provider.name}.default${index === 0 ? '' : `.${String(index + 1)}`}`;
}

function legacyPlan(providers: readonly SearchProvider[]): SearchPlan {
  const invocations = providers.map((provider, index) => ({
    invocation_id: `legacy-${String(index + 1)}-${instanceIdentity(provider, index)}`,
    provider_id: provider.provider_id ?? provider.name,
    provider_instance_id: instanceIdentity(provider, index),
    ...(provider.credential_slot_id === undefined ? {} : { credential_slot_id: provider.credential_slot_id }),
    capability: 'retrieval' as const,
    role: 'primary',
    trigger: 'always',
    timeout_ms: 45_000,
    retry: { max_attempts: 2, backoff_ms: 100, max_backoff_ms: 2_000 },
  }));
  return {
    plan_version: '1', profile_id: 'legacy',
    stages: invocations.length === 0 ? [] : [{ stage_id: 'stage-1', kind: 'parallel', invocations }],
    plan_fingerprint: 'legacy-m1',
  };
}
