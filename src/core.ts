import { randomUUID } from 'node:crypto';
import { NbSearchError, invalidInput } from './errors.ts';
import { PlanExecutor, type InvocationOutcome, type SearchPlan } from './planner.ts';
import type {
  ProviderResult, ResultProvenance, SearchAttempt, SearchEnvelope, SearchProvider, SearchRequest, SearchResult, SearchState,
} from './types.ts';
import { SCHEMA_VERSION, SEARCH_TEXT_MAX_BYTES } from './types.ts';
import { normalizeUrl } from './url.ts';

export interface SearchServiceOptions {
  providers: readonly SearchProvider[];
  now?: () => Date;
  requestId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  plan?: SearchPlan;
  executor?: PlanExecutor;
}

export class SearchService {
  private readonly now: () => Date;
  private readonly requestId: () => string;
  private readonly plan: SearchPlan;
  private readonly executor: PlanExecutor;
  constructor(private readonly options: SearchServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? randomUUID;
    this.plan = options.plan ?? legacyPlan(options.providers);
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
    if (this.plan.stages.length === 0) {
      return compactEnvelope(baseEnvelope(requestId, query, 'failed', startedAt, this.now(), budgetMs, [], [], [],
        new NbSearchError('CONFIGURATION_ERROR', 'No search provider is configured.').toPublic()));
    }

    const execution = await this.executor.execute(this.plan, { query, limit: maxResults }, budgetMs, request.signal);
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
        ...(item.metadata === undefined ? {} : { metadata: item.metadata }) };
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
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    const result = envelope.results.find((item) => item.snippet.length > 512);
    if (result === undefined) break;
    result.snippet = `${result.snippet.slice(0, Math.max(256, Math.floor(result.snippet.length * 0.65))).trimEnd()}…`;
    shortened += 1;
  }
  while (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES && envelope.results.length > 0) envelope.results.pop();
  if (byteLength(envelope) > SEARCH_TEXT_MAX_BYTES) {
    for (const result of envelope.results) for (const provenance of result.provenance) delete provenance.metadata;
  }
  envelope.compaction = {
    applied: shortened > 0 || envelope.results.length < originalCount,
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
