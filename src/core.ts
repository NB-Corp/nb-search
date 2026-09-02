import type { AppConfiguration, LaneBinding } from './config.ts';
import type { FetchInput, SearchRunInput } from './contracts.ts';
import { NbSearchError, publicError } from './errors.ts';
import { assertAttemptBudget, executeUnits, mergeResultLists, resolveFetchLane, type ResolvedSearchSelection, type UnitResult } from './planner.ts';
import type { FetchEnvelope, Hint, JsonValue, LaneOutcome, LogicalStatus, QueryProviderValue, SearchLogicalOutput, SearchResultsOutput, SearchTypedOutput } from './types.ts';
import { SCHEMA_VERSION } from './types.ts';

export class QueryEngine {
  constructor(private readonly app: AppConfiguration, private readonly now: () => Date = () => new Date()) {}
  async execute(input: SearchRunInput, selected: ResolvedSearchSelection, signal?: AbortSignal): Promise<SearchLogicalOutput> {
    const queries = typeof input.query === 'string' ? [input.query] : [...input.query]; const execution = this.app.resolved.config.execution; const units = queries.flatMap((query, queryIndex) => selected.lanes.map((lane) => ({ lane: lane.id, provider_instance_id: lane.config.provider_instance_id, query_index: queryIndex, run: async (unitSignal: AbortSignal) => { const value = await lane.query_provider!.execute({ query, limit: input.max_results ?? 8, ...(input.freshness === undefined ? {} : { freshness: input.freshness }), request_time_utc: this.now().toISOString(), signal: unitSignal }); return validateProviderOutput(value, lane.query_operation!.output.channel, lane.query_provider!.name); } }))); assertAttemptBudget(units.length, execution.retry_count, execution.max_provider_calls);
    const results = await executeUnits(units, { timeout_ms: input.timeout_ms ?? execution.search_timeout_ms, max_concurrency: execution.max_concurrency, retry_count: execution.retry_count, max_provider_calls: execution.max_provider_calls, signal });
    return selected.channel === 'results' ? this.resultsOutput(selected, units, results, input.max_results ?? 8) : this.typedOutput(selected, results);
  }
  private resultsOutput(selected: ResolvedSearchSelection, units: readonly { lane: string; query_index: number }[], execution: readonly UnitResult<QueryProviderValue>[], limit: number): SearchResultsOutput {
    const lists = execution.flatMap((item, index) => item.value?.channel === 'results' ? [{ lane: selected.lanes.find((lane) => lane.id === item.lane)!, query_index: units[index]!.query_index, rows: item.value.value.results }] : []); const merged = mergeResultLists(lists, limit); const outcomes = aggregateOutcomes(selected.lanes, execution, (item) => item.value?.channel === 'results' ? item.value.value.results.length : 0); const status = deriveStatus(execution, merged.results.length); return { channel: 'results', schema_id: 'nb-search.results@1', status, lanes: selected.selection.lanes, results: merged.results, lane_outcomes: outcomes, merge_summary: { input_rows: merged.input_rows, canonical_dedup: merged.canonical_dedup, independent_evidence_groups: merged.independent_evidence_groups, result_count: merged.results.length }, hints: execution.flatMap(errorHint) };
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
  async fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchEnvelope> {
    let resolved; try { resolved = resolveFetchLane(input.lane, this.app); } catch (error) { return failedFetch(input.lane, error); }
    const execution = this.app.resolved.config.execution; const policy = execution.fetch; const maxChars = Math.min(input.max_content_chars ?? policy.max_content_chars, policy.max_content_chars); const lane = resolved.lane;
    const results = await executeUnits([{ lane: lane.id, provider_instance_id: lane.config.provider_instance_id, run: async (unitSignal) => await lane.fetch_provider!.fetch({ url: input.url, signal: unitSignal, max_response_bytes: policy.max_response_bytes, max_content_chars: maxChars, max_redirects: policy.max_redirects }) }], { timeout_ms: input.timeout_ms ?? execution.fetch_timeout_ms, max_concurrency: 1, retry_count: execution.retry_count, max_provider_calls: execution.max_provider_calls, signal }); const item = results[0]!; const documents = item.value === undefined ? [] : [{ source_lane: lane.id, ...item.value }]; const status = deriveStatus(results, documents.length); const warnings = item.value?.warnings ?? []; return { schema_version: SCHEMA_VERSION, mode: 'fetch', selection: { source: resolved.source, lane: lane.id }, status, lane_outcomes: [{ lane: lane.id, ok: item.state === 'succeeded', state: item.state, duration_ms: item.duration_ms, result_count: documents.length, warnings, ...(item.error === undefined ? {} : { error: item.error }) }], documents, hints: [...results.flatMap(errorHint), ...warnings] };
  }
}
function aggregateOutcomes<T>(lanes: readonly LaneBinding[], results: readonly UnitResult<T>[], count: (item: UnitResult<T>) => number): LaneOutcome[] { return lanes.map((lane) => { const items = results.filter((item) => item.lane === lane.id); const failed = items.find((item) => item.state !== 'succeeded'); const resultCount = items.reduce((sum, item) => sum + count(item), 0); return { lane: lane.id, ok: failed === undefined, state: failed?.state ?? (resultCount === 0 ? 'empty' : 'succeeded'), duration_ms: items.reduce((sum, item) => sum + item.duration_ms, 0), result_count: resultCount, warnings: [], ...(failed?.error === undefined ? {} : { error: failed.error }) }; }); }
function deriveStatus<T>(execution: readonly UnitResult<T>[], outputCount: number): LogicalStatus { const failed = execution.filter((item) => item.state !== 'succeeded'); if (failed.length === 0) return outputCount === 0 ? 'empty' : 'succeeded'; if (outputCount > 0) return 'partial'; if (failed.every((item) => item.state === 'timeout')) return 'timed_out'; if (failed.every((item) => item.state === 'cancelled')) return 'cancelled'; return 'failed'; }
function errorHint<T>(item: UnitResult<T>): Hint[] { return item.error === undefined ? [] : [{ code: item.error.code, message: item.error.message, data: { lane: item.lane, retryable: item.error.retryable } }]; }
function failedFetch(lane: string | undefined, error: unknown): FetchEnvelope { const safe = publicError(error); return { schema_version: SCHEMA_VERSION, mode: 'fetch', selection: { source: lane === undefined ? 'default' : 'lane', ...(lane === undefined ? {} : { lane }) }, status: 'failed', lane_outcomes: [], documents: [], hints: [{ code: safe.code, message: safe.message, data: { retryable: safe.retryable } }] }; }
export function outputByteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
export function outputExceedsInlineLimit(value: unknown, maximum: number): boolean { return outputByteLength(value) > maximum; }
export function outputTooLargeError(max: number): NbSearchError { return new NbSearchError('OUTPUT_TOO_LARGE', `Synchronous query output exceeds ${String(max)} bytes.`); }
