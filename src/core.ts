import { randomUUID } from 'node:crypto';
import { NbSearchError, invalidInput } from './errors.ts';
import { hasSelectedPlanWork, PlanExecutor, type InvocationOutcome, type PlanExecutionContext, type SearchPlan } from './planner.ts';
import type { ProviderPorts } from './provider-registry.ts';
import type {
  CapabilityAugmentation, Freshness, ProfileId, ProviderResult, ResultProvenance, SearchAttempt, SearchEnvelope, SearchIntent,
  SearchProvider, SearchRequest, SearchResult, SearchState, SupportingUrl,
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
  portsByInstance?: ReadonlyMap<string, ProviderPorts>;
  planFactory?: (routing: { profile: ProfileId; intent?: SearchIntent; freshness?: Freshness; execution_surface?: 'sync' | 'research-job' }) => SearchPlan;
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
      providers, ...(options.portsByInstance === undefined ? {} : { ports_by_instance: options.portsByInstance }),
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  async search(request: SearchRequest, operationRequestId?: string, executionContext?: PlanExecutionContext): Promise<SearchEnvelope> {
    const query = request.query.trim();
    if (query.length < 1 || query.length > 4000) throw invalidInput('query must contain 1 to 4000 characters.');
    const maxResults = boundedInteger(request.max_results ?? 8, 1, 20, 'max_results');
    const publicBudgetMs = boundedInteger(request.timeout_ms ?? 20_000, 1000, 120_000, 'timeout_ms');
    const budgetMs = executionContext?.scope === 'research-job' && executionContext.operation_budget_ms !== undefined
      ? boundedInteger(executionContext.operation_budget_ms, 1000, 3_600_000, 'operation_budget_ms') : publicBudgetMs;
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
    const routing = { profile, ...(routedRequest.intent === undefined ? {} : { intent: routedRequest.intent }), ...(routedRequest.freshness === undefined ? {} : { freshness: routedRequest.freshness }), execution_surface: executionContext?.scope ?? 'sync' };
    const plan = this.options.planFactory?.(routing) ?? this.plans.get(profile) ?? (profile === this.plan.profile_id ? this.plan : undefined);
    if (plan === undefined) throw invalidInput(`profile ${profile} is not configured.`);
    if (!hasSelectedPlanWork(plan)) {
      return compactEnvelope(baseEnvelope(requestId, query, 'failed', startedAt, this.now(), budgetMs, [], [], [],
        new NbSearchError('CONFIGURATION_ERROR', 'No search provider is configured.').toPublic()));
    }

    const completedBefore = new Set(executionContext?.completed_once_per_job_invocation_ids ?? []);
    const execution = await this.executor.execute(plan, {
      query, limit: maxResults, profile, request_time_utc: startedAt.toISOString(),
      ...(routedRequest.intent === undefined ? {} : { intent: routedRequest.intent }),
      ...(routedRequest.freshness === undefined ? {} : { freshness: routedRequest.freshness }),
    }, budgetMs, request.signal, executionContext);
    if (executionContext?.completed_once_per_job_invocation_ids instanceof Set) {
      for (const invocationId of execution.completed_once_per_job_invocation_ids) executionContext.completed_once_per_job_invocation_ids.add(invocationId);
    }
    const outcomes = execution.outcomes;
    const attempts = outcomes.flatMap((outcome) => outcome.attempts);
    const results = mergeResults(outcomes, maxResults);
    const augmentations = projectAugmentations(execution, plan);
    executionContext?.capture_augmentations?.(structuredClone(augmentations ?? []));
    executionContext?.capture_capabilities?.(structuredClone(projectCapabilityCaptures(execution)));
    const callerCancelled = execution.caller_cancelled;
    const deadlineExceeded = execution.deadline_exceeded;
    const state = deriveState(results, outcomes, execution.omissions, callerCancelled, deadlineExceeded, plan, completedBefore);
    const warnings = capabilityWarnings(augmentations, outcomes, execution.omissions, state, deadlineExceeded, callerCancelled);
    const terminalError = callerCancelled && state === 'cancelled'
      ? new NbSearchError('CANCELLED', 'Search was cancelled.').toPublic()
      : deadlineExceeded && (state === 'partial' || state === 'timed_out')
        ? new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true).toPublic()
        : results.length === 0 && (state === 'failed' || state === 'timed_out' || state === 'cancelled')
          ? state === 'cancelled'
        ? new NbSearchError('CANCELLED', 'Search was cancelled.').toPublic()
        : state === 'timed_out'
          ? new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true).toPublic()
          : [...outcomes].reverse().find((item) => (item.invocation.failure_policy ?? 'affects-state') === 'affects-state' && item.error !== undefined)?.error
            ?? (execution.omissions.findLast((item) => item.failure_policy === 'affects-state') === undefined ? undefined
              : new NbSearchError('CAPABILITY_UNAVAILABLE', 'The requested capability is unavailable.').toPublic())
          : undefined;
    return compactEnvelope(baseEnvelope(requestId, query, state, startedAt, this.now(), budgetMs, results, attempts, warnings, terminalError, augmentations));
  }

  researchOperationBudgetMs(operation: number, remainingMs: number): number {
    if (operation > 0) return Math.min(45_000, remainingMs);
    const gmaTimeout = this.plan.stages.flatMap((stage) => stage.invocations)
      .filter((item) => item.capability === 'multi-agent-research')
      .reduce((maximum, item) => Math.max(maximum, item.timeout_ms), 0);
    return Math.min(gmaTimeout > 0 ? Math.max(120_000, gmaTimeout) : 120_000, remainingMs);
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
  augmentations?: CapabilityAugmentation[],
): SearchEnvelope {
  return {
    schema_version: SCHEMA_VERSION, request_id: requestId, mode: 'search', state, query, results, attempts, warnings,
    ...(error === undefined ? {} : { error }),
    ...(augmentations === undefined || augmentations.length === 0 ? {} : { augmentations }),
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
  outcomes: readonly InvocationOutcome[],
  omissions: readonly import('./planner.ts').PlanOmission[],
  callerCancelled: boolean,
  deadlineExceeded: boolean,
  plan: SearchPlan,
  completedBefore: ReadonlySet<string>,
): SearchState {
  if (callerCancelled) return 'cancelled';
  const required = outcomes.filter((item) => (item.invocation.failure_policy ?? 'affects-state') === 'affects-state');
  const failedFinal = required.filter((item) => item.state !== 'succeeded' && item.state !== 'empty');
  const answer = required.find((item) => item.invocation.capability === 'answer');
  const answerUnsupported = answer?.state === 'succeeded' && answer.results.every((item) => normalizeUrl(item.url) === undefined);
  const requiredOmissions = omissions.filter((item) => item.failure_policy === 'affects-state');
  const usefulAnswer = answer?.state === 'succeeded';
  const usefulGma = required.some((item) => item.invocation.capability === 'multi-agent-research'
    && (item.state === 'succeeded' || item.state === 'partial'));
  const usefulRetrieval = required.some((item) => item.invocation.capability === 'retrieval' && item.results.some((result) => normalizeUrl(result.url) !== undefined));
  const compatibilityGma = plan.routing?.multi_agent_route === 'replacement' || plan.routing?.multi_agent_route === 'overlay';
  const selectedGmaIds = new Set([
    ...plan.stages.flatMap((stage) => stage.invocations.filter((item) => item.capability === 'multi-agent-research').map((item) => item.invocation_id)),
    ...(plan.omissions ?? []).filter((item) => item.capability === 'multi-agent-research').map((item) => item.invocation_id),
  ]);
  const gmaRequiredThisOperation = compatibilityGma && [...selectedGmaIds].some((id) => !completedBefore.has(id));
  const gmaSatisfied = required.some((item) => item.invocation.capability === 'multi-agent-research' && item.state === 'succeeded');
  if (deadlineExceeded) return results.length > 0 || usefulAnswer || usefulGma ? 'partial' : 'timed_out';
  if (results.length > 0 || usefulAnswer || usefulGma) return failedFinal.length > 0 || requiredOmissions.length > 0
    || answerUnsupported || (usefulAnswer && !usefulRetrieval) || (gmaRequiredThisOperation && (!gmaSatisfied || !usefulRetrieval)) ? 'partial' : 'succeeded';
  if (required.length > 0 && required.every((item) => item.state === 'empty') && requiredOmissions.length === 0) return 'empty';
  if (failedFinal.length > 0 && failedFinal.every((item) => item.state === 'timed_out')) return 'timed_out';
  return 'failed';
}

function projectAugmentations(execution: import('./planner.ts').PlanExecution, plan: SearchPlan): CapabilityAugmentation[] | undefined {
  const items: CapabilityAugmentation[] = [];
  for (const outcome of execution.outcomes) {
    const invocation = outcome.invocation;
    if (invocation.capability !== 'answer' && invocation.capability !== 'research-light') continue;
    const base = { capability: invocation.capability, provider_id: invocation.provider_id, provider_instance_id: invocation.provider_instance_id,
      ...(invocation.credential_slot_id === undefined ? {} : { credential_slot_id: invocation.credential_slot_id }), invocation_id: invocation.invocation_id,
      failure_policy: invocation.failure_policy ?? (invocation.capability === 'research-light' ? 'report-only' : 'affects-state'), attempt_count: outcome.attempts.length } as const;
    if (outcome.state === 'succeeded' && outcome.result?.capability === 'answer' && outcome.result.text !== undefined) {
      const supporting = providerResultSupportingUrls(outcome.result.supporting_results);
      items.push({ ...base, capability: 'answer', state: 'succeeded', result: { delivery: 'inline', value: { capability: 'answer', text: outcome.result.text, supporting_urls: supporting, supporting_urls_omitted: 0, citation_status: citationStatus() } } });
    } else if (outcome.state === 'succeeded' && outcome.result?.capability === 'research-light' && outcome.result.synthesis !== undefined) {
      items.push({ ...base, capability: 'research-light', state: 'succeeded', result: { delivery: 'inline', value: { capability: 'research-light', synthesis: outcome.result.synthesis, supporting_urls: [...outcome.result.supporting_urls], supporting_urls_omitted: 0, resolved_type: outcome.result.resolved_type, citation_status: citationStatus() } } });
    } else if (outcome.state === 'empty') items.push({ ...base, state: 'empty' } as CapabilityAugmentation);
    else items.push({ ...base, state: outcome.state, error: outcome.error ?? new NbSearchError('CAPABILITY_UNAVAILABLE', 'The selected capability is unavailable.').toPublic() } as CapabilityAugmentation);
  }
  for (const omission of execution.omissions) if (omission.capability === 'answer' || omission.capability === 'research-light') items.push({
    capability: omission.capability, provider_id: omission.provider_id, provider_instance_id: omission.provider_instance_id,
    ...(omission.credential_slot_id === undefined ? {} : { credential_slot_id: omission.credential_slot_id }), invocation_id: omission.invocation_id,
    failure_policy: omission.failure_policy, attempt_count: 0, state: 'unavailable',
    error: new NbSearchError('CAPABILITY_UNAVAILABLE', 'The selected capability is unavailable.', false, omission.provider_id).toPublic(),
  } as CapabilityAugmentation);
  const order = new Map([
    ...plan.stages.flatMap((stage, stageIndex) => stage.invocations.map((item, invocationIndex) => [item.invocation_id, stageIndex * 10_000 + invocationIndex] as const)),
    ...(plan.omissions ?? []).map((item) => [item.invocation_id, item.stage_index * 10_000 + item.invocation_index] as const),
  ]);
  items.sort((left, right) => (order.get(left.invocation_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.invocation_id) ?? Number.MAX_SAFE_INTEGER));
  return items.length === 0 ? undefined : items;
}

function projectCapabilityCaptures(execution: import('./planner.ts').PlanExecution): import('./types.ts').CapabilityCapture[] {
  const captures: import('./types.ts').CapabilityCapture[] = [];
  for (const outcome of execution.outcomes) {
    if (outcome.invocation.capability !== 'multi-agent-research') continue;
    captures.push({
      capability: 'multi-agent-research', provider_id: outcome.invocation.provider_id,
      provider_instance_id: outcome.invocation.provider_instance_id,
      ...(outcome.invocation.credential_slot_id === undefined ? {} : { credential_slot_id: outcome.invocation.credential_slot_id }),
      invocation_id: outcome.invocation.invocation_id, failure_policy: outcome.invocation.failure_policy ?? 'affects-state',
      attempt_count: outcome.attempts.length, state: outcome.state,
      ...(outcome.result?.capability === 'multi-agent-research' ? { result: outcome.result } : {}),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
  }
  for (const omission of execution.omissions) if (omission.capability === 'multi-agent-research') captures.push({
    capability: 'multi-agent-research', provider_id: omission.provider_id, provider_instance_id: omission.provider_instance_id,
    ...(omission.credential_slot_id === undefined ? {} : { credential_slot_id: omission.credential_slot_id }),
    invocation_id: omission.invocation_id, failure_policy: omission.failure_policy, attempt_count: 0, state: 'unavailable',
    error: new NbSearchError('CAPABILITY_UNAVAILABLE', 'The selected capability is unavailable.', false, omission.provider_id).toPublic(),
  });
  return captures;
}

function providerResultSupportingUrls(results: readonly ProviderResult[]): SupportingUrl[] {
  const seen = new Set<string>(); const items: SupportingUrl[] = [];
  for (const result of results) { const url = normalizeUrl(result.url); if (url === undefined || seen.has(url)) continue; seen.add(url); const title = truncateUtf8(cleanText(result.title), 512); items.push({ url, ...(title === '' ? {} : { title }), source: 'provider-result' }); if (items.length >= 5) break; }
  return items;
}
function citationStatus(): { claim_linked_citations: false; evidence_map_available: false; semantic_verification: false } { return { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false }; }
function capabilityWarnings(
  augmentations: readonly CapabilityAugmentation[] | undefined,
  outcomes: readonly InvocationOutcome[],
  omissions: readonly import('./planner.ts').PlanOmission[],
  state: SearchState,
  deadlineExceeded: boolean,
  callerCancelled: boolean,
): string[] {
  if (callerCancelled) return [];
  const warnings: string[] = [];
  if (state === 'partial' && deadlineExceeded) warnings.push('The deadline was reached; useful results were preserved.');
  else if (state === 'partial' && outcomes.some((item) => item.invocation.capability === 'retrieval' && item.state !== 'succeeded' && item.state !== 'empty')) warnings.push('One or more providers did not complete successfully.');
  for (const item of augmentations ?? []) {
    if (item.capability === 'answer' && item.state !== 'succeeded') warnings.push('The requested answer capability did not complete successfully.');
    else if (item.capability === 'answer' && item.state === 'succeeded' && item.result.delivery === 'inline' && item.result.value.supporting_urls.length === 0) warnings.push('The generated answer has no same-operation supporting URL.');
    else if (item.capability === 'research-light' && item.state !== 'succeeded') warnings.push('Optional research-light augmentation did not complete successfully.');
  }
  for (const outcome of outcomes) if (outcome.invocation.capability === 'multi-agent-research') {
    if (outcome.state === 'partial') warnings.push('Multi-agent research completed with incomplete answer or evidence structure.');
    else if (outcome.state !== 'succeeded') warnings.push('The requested multi-agent research capability did not complete successfully.');
  }
  if (omissions.some((item) => item.capability === 'multi-agent-research')) warnings.push('The requested multi-agent research capability did not complete successfully.');
  return [...new Set(warnings)];
}

function compactEnvelope(envelope: SearchEnvelope): SearchEnvelope {
  const originalCount = envelope.results.length;
  let shortened = 0;
  let nestedCompacted = false;
  let metadataCompacted = false;
  let attemptsOmitted = 0;
  let supportingUrlsOmitted = 0;
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
    const withMessage = [...envelope.attempts].reverse().find((attempt) => (attempt.error?.message.length ?? 0) > 96);
    if (withMessage?.error?.message === undefined) break;
    withMessage.error.message = `${withMessage.error.message.slice(0, Math.max(64, Math.floor(withMessage.error.message.length * 0.6))).trimEnd()}…`;
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const finalIndexes = new Map<string, number>();
    envelope.attempts.forEach((attempt, index) => finalIndexes.set(attempt.invocation_id ?? attempt.provider_instance_id ?? attempt.provider, index));
    let removed = false;
    for (let index = envelope.attempts.length - 1; index >= 0; index -= 1) {
      const attempt = envelope.attempts[index]!;
      const key = attempt.invocation_id ?? attempt.provider_instance_id ?? attempt.provider;
      if (finalIndexes.get(key) === index) continue;
      envelope.attempts.splice(index, 1); attemptsOmitted += 1; removed = true; break;
    }
    if (!removed) break;
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const supporting = (envelope.augmentations ?? []).flatMap((item) => item.state === 'succeeded' && item.result.delivery === 'inline' ? [item.result.value.supporting_urls] : []);
    const titled = supporting.flat().findLast((item) => item.title !== undefined);
    if (titled !== undefined) { delete titled.title; continue; }
    const tail = supporting.findLast((items) => items.length > 0);
    if (tail === undefined) break;
    tail.pop(); supportingUrlsOmitted += 1;
    for (const item of envelope.augmentations ?? []) if (item.state === 'succeeded' && item.result.delivery === 'inline') item.result.value.supporting_urls_omitted = supportingUrlsOmitted;
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
    ...(attemptsOmitted === 0 ? {} : { attempts_omitted: attemptsOmitted }),
    ...(supportingUrlsOmitted === 0 ? {} : { supporting_urls_omitted: supportingUrlsOmitted }),
  };
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES && envelope.results.length > 0) {
    envelope.results.pop();
    envelope.compaction.applied = true;
    envelope.compaction.results_omitted = originalCount - envelope.results.length;
  }
  if (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) throw new NbSearchError('INTERNAL', 'Search envelope compaction failed.');
  return envelope;
}

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function cleanText(value: string): string { return value.replace(/\s+/g, ' ').trim() }
function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  let end = value.length; while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maximum) end -= 1; return value.slice(0, end);
}
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
