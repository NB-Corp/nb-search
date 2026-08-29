import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { NbSearchError, invalidInput, isRetryableProviderError, publicError } from './errors.ts';
import { safeErrorMessage } from './redaction.ts';
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
}

interface ProviderOutcome { attempts: SearchAttempt[]; results: readonly ProviderResult[] }

export class SearchService {
  private readonly now: () => Date;
  private readonly requestId: () => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly options: SearchServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? randomUUID;
    this.sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  }

  async search(request: SearchRequest, operationRequestId?: string): Promise<SearchEnvelope> {
    const query = request.query.trim();
    if (query.length < 1 || query.length > 4000) throw invalidInput('query must contain 1 to 4000 characters.');
    const maxResults = boundedInteger(request.max_results ?? 8, 1, 20, 'max_results');
    const budgetMs = boundedInteger(request.timeout_ms ?? 20_000, 1000, 45_000, 'timeout_ms');
    const requestId = operationRequestId ?? this.requestId();
    const startedAt = this.now();
    if (this.options.providers.length === 0) {
      return compactEnvelope(baseEnvelope(requestId, query, 'failed', startedAt, this.now(), budgetMs, [], [], [],
        new NbSearchError('CONFIGURATION_ERROR', 'No search provider is configured.').toPublic()));
    }

    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true)), budgetMs);
    const signal = request.signal === undefined ? deadline.signal : AbortSignal.any([request.signal, deadline.signal]);
    let outcomes: ProviderOutcome[];
    try {
      outcomes = await Promise.all(this.options.providers.map((provider) => this.runProvider(provider, query, maxResults, signal, request.signal, deadline.signal)));
    } finally {
      clearTimeout(timeout);
    }
    const attempts = outcomes.flatMap((outcome) => outcome.attempts);
    const results = mergeResults(this.options.providers, outcomes, maxResults);
    const callerCancelled = request.signal?.aborted === true;
    const deadlineExceeded = !callerCancelled && deadline.signal.aborted;
    const state = deriveState(results, attempts, callerCancelled, deadlineExceeded);
    const warnings = state === 'partial'
      ? [deadline.signal.aborted ? 'The deadline was reached; useful results were preserved.' : 'One or more providers did not complete successfully.']
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

  private async runProvider(
    provider: SearchProvider,
    query: string,
    limit: number,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const attempts: SearchAttempt[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = performance.now();
      try {
        const results = await raceWithAbort(provider.search({ query, limit, signal }), signal);
        attempts.push({ provider: provider.name, attempt, state: results.length === 0 ? 'empty' : 'succeeded', duration_ms: elapsed(started), result_count: results.length });
        return { attempts, results };
      } catch (error) {
        const cancelled = callerSignal?.aborted === true;
        const timedOut = !cancelled && deadlineSignal.aborted;
        const safe = cancelled
          ? new NbSearchError('CANCELLED', 'Search was cancelled.')
          : timedOut
            ? new NbSearchError('DEADLINE_EXCEEDED', 'Search deadline was exceeded.', true, provider.name)
            : error instanceof NbSearchError
              ? new NbSearchError(error.code, safeErrorMessage(error, provider.redactions), error.retryable, error.provider ?? provider.name, { cause: error })
              : new NbSearchError('PROVIDER_UNAVAILABLE', safeErrorMessage(error, provider.redactions), true, provider.name);
        attempts.push({ provider: provider.name, attempt, state: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed', duration_ms: elapsed(started), result_count: 0, error: publicError(safe) });
        if (attempt === 2 || signal.aborted || !isRetryableProviderError(safe)) return { attempts, results: [] };
        try { await this.sleep(attempt * 100, signal); } catch { return { attempts, results: [] }; }
      }
    }
    return { attempts, results: [] };
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

function mergeResults(providers: readonly SearchProvider[], outcomes: readonly ProviderOutcome[], limit: number): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  providers.forEach((provider, providerIndex) => {
    const outcome = outcomes[providerIndex];
    if (outcome === undefined) return;
    outcome.results.forEach((item, rank) => {
      const url = normalizeUrl(item.url);
      if (url === undefined) return;
      const provenance: ResultProvenance = { provider: provider.name, rank, original_url: item.url,
        ...(item.metadata === undefined ? {} : { metadata: item.metadata }) };
      const existing = merged.get(url);
      if (existing !== undefined) {
        if (!existing.providers.includes(provider.name)) existing.providers.push(provider.name);
        existing.provenance.push(provenance);
        if (existing.snippet === '' && item.snippet !== undefined) existing.snippet = cleanText(item.snippet);
        return;
      }
      merged.set(url, {
        title: cleanText(item.title), url, snippet: cleanText(item.snippet ?? ''),
        ...(item.published_at === undefined ? {} : { published_at: item.published_at }),
        ...(item.site_name === undefined ? {} : { site_name: item.site_name }),
        ...(item.score === undefined ? {} : { score: item.score }), providers: [provider.name], provenance: [provenance],
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
  const finalByProvider = new Map(attempts.map((item) => [item.provider, item]));
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
function elapsed(started: number): number { return Math.max(0, Math.round(performance.now() - started)) }
async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
}
