import type { AppConfiguration, LaneBinding } from './config.ts';
import { resolveSearchTimeout } from './config-sources.ts';
import type { FetchRunInput, SearchRunInput } from './contracts.ts';
import { NbSearchError, publicError } from './errors.ts';
import { assertFetchQuality } from './fetch-quality.ts';
import { parsePublicUrl } from './fetch-security.ts';
import { validateLocalSource } from './fetch-sources.ts';
import { assertAttemptBudget, executeUnits, mergeResultLists, resolveFetchPipelines, type ResolvedFetchSelection, type ResolvedSearchSelection, type UnitResult } from './planner.ts';
import type { FetchRunSyncEnvelope, Hint, JsonValue, LaneOutcome, LogicalStatus, PublicError, QueryProviderValue, SearchLogicalOutput, SearchResultsOutput, SearchTypedOutput } from './types.ts';
import { SCHEMA_VERSION } from './types.ts';

export class QueryEngine {
  constructor(private readonly app: AppConfiguration, private readonly now: () => Date = () => new Date()) {}
  async execute(input: SearchRunInput, selected: ResolvedSearchSelection, signal?: AbortSignal): Promise<SearchLogicalOutput> {
    const queries = typeof input.query === 'string' ? [input.query] : [...input.query]; const execution = this.app.resolved.config.execution; const units = queries.flatMap((query, queryIndex) => selected.lanes.map((lane) => ({ lane: lane.id, provider_instance_id: lane.config.provider_instance_id, query_index: queryIndex, run: async (unitSignal: AbortSignal) => { const value = await lane.query_provider!.execute({ query, limit: input.max_results ?? 8, ...(input.freshness === undefined ? {} : { freshness: input.freshness }), request_time_utc: this.now().toISOString(), signal: unitSignal }); return validateProviderOutput(value, lane.query_operation!.output.channel, lane.query_provider!.name); } }))); assertAttemptBudget(units.length, execution.retry_count, execution.max_provider_calls);
    const results = await executeUnits(units, { timeout_ms: resolveSearchTimeout(input.timeout_ms, selected.lanes.map((lane) => ({ provider_id: lane.provider_id, operation_id: lane.query_operation!.operation_id })), execution.search_timeout_ms, this.app.resolved.explicit_search_timeout_ms), max_concurrency: execution.max_concurrency, retry_count: execution.retry_count, max_provider_calls: execution.max_provider_calls, signal });
    return selected.channel === 'results' ? this.resultsOutput(selected, units, results, input.max_results ?? 8) : this.typedOutput(selected, results);
  }
  private resultsOutput(selected: ResolvedSearchSelection, units: readonly { lane: string; query_index: number }[], execution: readonly UnitResult<QueryProviderValue>[], limit: number): SearchResultsOutput {
    const lists = execution.flatMap((item, index) => item.value?.channel === 'results' ? [{ lane: selected.lanes.find((lane) => lane.id === item.lane)!, query_index: units[index]!.query_index, rows: item.value.value.results }] : []); const merged = mergeResultLists(lists, limit); const outcomes = aggregateOutcomes(selected.lanes, execution, (item) => item.value?.channel === 'results' ? item.value.value.results.length : 0); const status = deriveStatus(execution, merged.results.length); const providerHints = execution.flatMap((item) => item.value?.channel === 'results' ? (item.value.value.hints ?? []).map((hint) => ({ ...hint, data: { lane: item.lane, ...hint.data } })) : []); return { channel: 'results', schema_id: 'nb-search.results@1', status, lanes: selected.selection.lanes, results: merged.results, lane_outcomes: outcomes, merge_summary: { input_rows: merged.input_rows, canonical_dedup: merged.canonical_dedup, independent_evidence_groups: merged.independent_evidence_groups, result_count: merged.results.length }, hints: [...execution.flatMap(errorHint), ...providerHints] };
  }
  private typedOutput(selected: ResolvedSearchSelection, execution: readonly UnitResult<QueryProviderValue>[]): SearchTypedOutput {
    const values = execution.flatMap((item) => item.value?.channel === 'typed' ? [item.value.data] : []); const outcomes = aggregateOutcomes(selected.lanes, execution, (item) => item.value?.channel === 'typed' ? 1 : 0); const status = deriveStatus(execution, values.length); const data: JsonValue | undefined = values.length === 0 ? undefined : values.length === 1 ? values[0] : values; return { channel: 'typed', lane: selected.lanes[0]!.id, schema_id: selected.schema_id, status, ...(data === undefined ? {} : { data }), lane_outcomes: outcomes, hints: execution.flatMap(errorHint) };
  }
}
function validateProviderOutput(value: QueryProviderValue, expected: 'results' | 'typed', provider: string): QueryProviderValue {
  if (value === null || typeof value !== 'object' || value.channel !== expected) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider output channel did not match the registered operation.', false, provider);
  if (expected === 'results') {
    if (value.channel !== 'results' || value.value === null || typeof value.value !== 'object' || !Array.isArray(value.value.results)) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider returned an invalid results output.', false, provider);
    return value;
  }
  if (value.channel !== 'typed') throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider output channel did not match the registered operation.', false, provider);
  try { const encoded = JSON.stringify(value.data); if (encoded === undefined) throw new Error(); return { channel: 'typed', data: JSON.parse(encoded) as JsonValue }; }
  catch (error) { throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider returned an invalid typed JSON output.', false, provider, { cause: error }); }
}
export class FetchService {
  constructor(private readonly app: AppConfiguration) {}
  async fetch(input: FetchRunInput, resolved: ResolvedFetchSelection, signal?: AbortSignal): Promise<FetchRunSyncEnvelope> {
    const execution = this.app.resolved.config.execution; const policy = execution.fetch; const representation = input.representation ?? 'markdown'; const maxChars = Math.min(input.max_content_chars ?? policy.max_content_chars, policy.max_content_chars); const timeout = input.timeout_ms ?? execution.fetch_timeout_ms; const deadlineAt = performance.now() + timeout; const budget = { used: 0 }; const outcomes: LaneOutcome[] = []; const hints: Hint[] = []; let terminalStatus: LogicalStatus = 'failed'; let attempted = false;
    for (const lane of resolved.lanes) {
      if (input.source.kind !== 'url' && lane.fetch_operation!.egress !== 'none') { const error = new NbSearchError('FETCH_EGRESS_DENIED', `Fetch pipeline ${lane.id} cannot receive local or inline content.`).toPublic(); outcomes.push({ lane: lane.id, ok: false, state: 'skipped', duration_ms: 0, result_count: 0, warnings: [], error }); hints.push({ code: error.code, message: error.message, data: { lane: lane.id, retryable: false } }); continue; }
      if (lane.availability !== 'ready') { const error = new NbSearchError('LANE_NOT_CONFIGURED', `Fetch pipeline ${lane.id} is unavailable.`).toPublic(); outcomes.push({ lane: lane.id, ok: false, state: 'skipped', duration_ms: 0, result_count: 0, warnings: [], error }); hints.push({ code: error.code, message: error.message, data: { lane: lane.id, retryable: false } }); continue; }
      attempted = true;
      const results = await executeUnits([{ lane: lane.id, provider_instance_id: lane.config.provider_instance_id, run: async (unitSignal) => { const value = await lane.fetch_provider!.fetch({ source: input.source, representation, signal: unitSignal, max_source_bytes: policy.max_source_bytes, max_response_bytes: policy.max_response_bytes, max_content_chars: maxChars, max_redirects: policy.max_redirects, file_scopes: this.app.resolved.config.fetch.file_scopes }); if (!lane.fetch_operation!.media_types.includes(value.media_type)) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', `Fetch pipeline ${lane.id} returned an unsupported media type.`); if (value.representation !== representation) throw new NbSearchError('PROVIDER_UNAVAILABLE', `Fetch pipeline ${lane.id} returned the wrong representation.`); assertFetchQuality(value.content, policy.quality); return value; } }], { timeout_ms: timeout, deadline_at: deadlineAt, attempt_budget: budget, max_concurrency: 1, retry_count: execution.retry_count, max_provider_calls: execution.max_provider_calls, signal });
      const item = results[0]!; const warnings = item.value?.warnings ?? []; outcomes.push({ lane: lane.id, ok: item.state === 'succeeded', state: item.state, duration_ms: item.duration_ms, result_count: item.value === undefined ? 0 : 1, warnings, ...(item.error === undefined ? {} : { error: item.error }) }); hints.push(...errorHint(item), ...warnings);
      if (item.value !== undefined) return { schema_version: SCHEMA_VERSION, mode: 'fetch', action: 'run', execution: 'sync', selection: resolved.source === 'pipeline' ? { source: 'pipeline', pipeline: lane.id } : { source: 'default' }, status: 'succeeded', lane_outcomes: outcomes, documents: [{ source_lane: lane.id, ...item.value }], hints };
      if (item.state === 'timeout') terminalStatus = 'timed_out'; else if (item.state === 'cancelled') terminalStatus = 'cancelled';
      if (item.error === undefined || fetchFailureAction(item.error) === 'terminal') break;
      if (budget.used >= execution.max_provider_calls) { const error = new NbSearchError('BUDGET_EXCEEDED', 'The provider attempt limit was reached.').toPublic(); hints.push({ code: error.code, message: error.message, data: { retryable: false } }); break; }
    }
    if (!attempted) hints.push({ code: 'FETCH_CHAIN_UNAVAILABLE', message: 'No configured fetch pipeline is available.' });
    return { schema_version: SCHEMA_VERSION, mode: 'fetch', action: 'run', execution: 'sync', selection: resolved.source === 'pipeline' ? { source: 'pipeline', pipeline: resolved.requested } : { source: 'default' }, status: terminalStatus, lane_outcomes: outcomes, documents: [], hints };
  }
  async preflight(input: FetchRunInput, execution: 'sync' | 'async'): Promise<ResolvedFetchSelection> { if (input.source.kind === 'url') parsePublicUrl(input.source.url); const resolved = resolveFetchPipelines(input, this.app, execution); if (input.source.kind !== 'url' && resolved.lanes.some((lane) => lane.fetch_operation!.egress === 'none')) await validateLocalSource(input.source, this.app.resolved.config.fetch.file_scopes, this.app.resolved.config.execution.fetch.max_source_bytes); return resolved; }
}
function fetchFailureAction(error: PublicError): 'fallback' | 'terminal' {
  switch (error.code) {
    case 'FETCH_BLOCKED': case 'FETCH_CONTENT_TYPE_REJECTED': case 'CANCELLED': case 'DEADLINE_EXCEEDED': case 'BUDGET_EXCEEDED': return 'terminal';
    case 'FETCH_HTTP_ERROR': { const status = error.data?.['status']; return status === 404 || status === 410 ? 'terminal' : 'fallback'; }
    case 'QUALITY_GATE_FAILED': case 'FETCH_BYTES_LIMIT': case 'PROVIDER_AUTH': case 'PROVIDER_RATE_LIMIT': case 'PROVIDER_UNAVAILABLE': case 'INTERNAL': return 'fallback';
    default: return 'fallback';
  }
}
function aggregateOutcomes<T>(lanes: readonly LaneBinding[], results: readonly UnitResult<T>[], count: (item: UnitResult<T>) => number): LaneOutcome[] { return lanes.map((lane) => { const items = results.filter((item) => item.lane === lane.id); const failed = items.find((item) => item.state !== 'succeeded'); const resultCount = items.reduce((sum, item) => sum + count(item), 0); return { lane: lane.id, ok: failed === undefined, state: failed?.state ?? (resultCount === 0 ? 'empty' : 'succeeded'), duration_ms: items.reduce((sum, item) => sum + item.duration_ms, 0), result_count: resultCount, warnings: [], ...(failed?.error === undefined ? {} : { error: failed.error }) }; }); }
function deriveStatus<T>(execution: readonly UnitResult<T>[], outputCount: number): LogicalStatus { const failed = execution.filter((item) => item.state !== 'succeeded'); if (failed.length === 0) return outputCount === 0 ? 'empty' : 'succeeded'; if (outputCount > 0) return 'partial'; if (failed.every((item) => item.state === 'timeout')) return 'timed_out'; if (failed.every((item) => item.state === 'cancelled')) return 'cancelled'; return 'failed'; }
function errorHint<T>(item: UnitResult<T>): Hint[] { return item.error === undefined ? [] : [{ code: item.error.code, message: item.error.message, data: { lane: item.lane, retryable: item.error.retryable, ...item.error.data } }]; }
export function outputByteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
export function outputExceedsInlineLimit(value: unknown, maximum: number): boolean { return outputByteLength(value) > maximum; }
export function outputTooLargeError(max: number): NbSearchError { return new NbSearchError('OUTPUT_TOO_LARGE', `Synchronous output exceeds ${String(max)} bytes.`); }
