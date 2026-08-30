import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { NbSearchError, invalidInput } from './errors.ts';
import type { ExecutionSnapshot } from './execution-snapshot.ts';
import type { OperationContext } from './contracts.ts';
import { isTerminalState, JobStore } from './job-store.ts';
import { Logger, queryFingerprint } from './logging.ts';
import type {
  ArtifactState, JobRecord, JobState, ResearchArtifact, ResearchCancelEnvelope, ResearchListEnvelope, ResearchReadEnvelope,
  ResearchRequest, ResearchStartEnvelope, SearchEnvelope, Searcher, SearchResult,
} from './types.ts';
import { MANAGEMENT_TEXT_MAX_BYTES, RESEARCH_PAGE_MAX_BYTES, SCHEMA_VERSION } from './types.ts';

export interface WorkerLauncher { launch(jobId: string, jobsRoot?: string): Promise<void> }
export type ExecutionSnapshotFactory = (request: ResearchRequest) => ExecutionSnapshot;

export class DetachedWorkerLauncher implements WorkerLauncher {
  constructor(
    private readonly workerPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}
  async launch(jobId: string, jobsRoot?: string): Promise<void> {
    await new Promise<void>((resolveLaunch, reject) => {
      const child = this.spawnProcess(process.execPath, [this.workerPath, jobId, ...(jobsRoot === undefined ? [] : [jobsRoot])], {
        detached: true, stdio: 'ignore', windowsHide: true, env: this.env,
      });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolveLaunch(); });
    });
  }
}

export class ResearchService {
  constructor(
    private readonly store: JobStore,
    private readonly launcher: WorkerLauncher,
    private readonly requestId: () => string = randomUUID,
    private readonly snapshotFactory?: ExecutionSnapshotFactory,
  ) {}

  async start(
    input: { query: string; max_sources?: number; max_duration_ms?: number; idempotency_key?: string },
    context: OperationContext = {},
  ): Promise<ResearchStartEnvelope> {
    const query = input.query.trim();
    if (query.length < 1 || query.length > 8000) throw invalidInput('query must contain 1 to 8000 characters.');
    const maxSources = boundedInteger(input.max_sources ?? 30, 5, 100, 'max_sources');
    const maxDurationMs = boundedInteger(input.max_duration_ms ?? 900_000, 60_000, 3_600_000, 'max_duration_ms');
    if (input.idempotency_key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotency_key)) {
      throw invalidInput('idempotency_key must match [A-Za-z0-9._:-]{1,128}.');
    }
    assertActive(context.signal);
    const request = { query, max_sources: maxSources, max_duration_ms: maxDurationMs };
    const snapshot = this.snapshotFactory?.(request);
    const created = await this.store.createOrReuse(request, input.idempotency_key, snapshot);
    if (!created.reused) {
      try {
        if (context.signal?.aborted === true) {
          await this.store.requestCancel(created.job.job_id);
          throw new NbSearchError('CANCELLED', 'Research start was cancelled.');
        }
        await this.launcher.launch(created.job.job_id, this.store.root);
      }
      catch (error) {
        if (error instanceof NbSearchError && error.code === 'CANCELLED') throw error;
        await this.store.transition(created.job.job_id, 'failed', {
          phase: 'failed', error: new NbSearchError('WORKER_START_FAILED', 'The research worker did not start.', true, undefined, { cause: error }).toPublic(),
        });
        throw new NbSearchError('WORKER_START_FAILED', 'The research worker did not start.', true);
      }
    }
    const current = await this.store.read(created.job.job_id);
    return {
      schema_version: SCHEMA_VERSION, request_id: context.requestId ?? this.requestId(), mode: 'research_start', reused: created.reused,
      job: { job_id: current.job_id, state: current.state, created_at: current.created_at }, poll_after_ms: 1000,
    };
  }

  async status(jobId: string, operationRequestId?: string) {
    const job = await this.store.reconcileStale(jobId);
    return {
      schema_version: SCHEMA_VERSION, request_id: operationRequestId ?? this.requestId(), mode: 'research_status' as const, job_id: job.job_id,
      state: job.state, phase: job.phase, created_at: job.created_at, updated_at: job.updated_at,
      ...(job.started_at === undefined ? {} : { started_at: job.started_at }),
      ...(job.completed_at === undefined ? {} : { completed_at: job.completed_at }),
      progress: job.progress, artifacts: job.artifacts, ...(job.error === undefined ? {} : { error: job.error }),
      ...(isTerminalState(job.state) ? {} : { poll_after_ms: 1000 }),
    };
  }

  async read(
    input: { job_id: string; artifact?: ResearchArtifact; cursor?: string; page_size?: number },
    operationRequestId?: string,
  ): Promise<ResearchReadEnvelope> {
    const artifact = input.artifact ?? 'report';
    const pageSize = boundedInteger(input.page_size ?? 10, 1, 100, 'page_size');
    const job = await this.store.reconcileStale(input.job_id);
    const content = await this.store.readArtifact(input.job_id, artifact);
    const offset = decodeCursor(input.cursor, artifact, content.state);
    const selected = content.items.slice(offset, offset + pageSize);
    let bounded = selected.map((item) => boundItem(item, RESEARCH_PAGE_MAX_BYTES - 2048));
    let envelope = researchReadEnvelope(
      operationRequestId ?? this.requestId(), job, artifact, content.state, offset, content.items.length, bounded,
    );
    while (jsonBytes(envelope) > RESEARCH_PAGE_MAX_BYTES && bounded.length > 1) {
      bounded = bounded.slice(0, -1);
      envelope = researchReadEnvelope(
        envelope.request_id, job, artifact, content.state, offset, content.items.length, bounded,
      );
    }
    if (jsonBytes(envelope) > RESEARCH_PAGE_MAX_BYTES && bounded.length === 1) {
      const empty = researchReadEnvelope(
        envelope.request_id, job, artifact, content.state, offset, content.items.length, [],
      );
      const itemBudget = Math.max(512, RESEARCH_PAGE_MAX_BYTES - jsonBytes(empty) - 64);
      bounded = [boundItem(selected[0], itemBudget)];
      envelope = researchReadEnvelope(
        envelope.request_id, job, artifact, content.state, offset, content.items.length, bounded,
      );
    }
    if (jsonBytes(envelope) > RESEARCH_PAGE_MAX_BYTES) {
      throw new NbSearchError('INTERNAL', 'Research artifact page compaction failed.');
    }
    return envelope;
  }

  async list(
    input: { states?: readonly JobState[]; cursor?: string; limit?: number },
    operationRequestId?: string,
  ): Promise<ResearchListEnvelope> {
    const limit = boundedInteger(input.limit ?? 20, 1, 100, 'limit');
    if (input.states !== undefined) for (const state of input.states) if (!ALL_STATES.has(state)) throw invalidInput(`Unknown research state: ${state}.`);
    const offset = decodeListCursor(input.cursor);
    const records = await this.store.listRecords(input.states);
    const selected = records.slice(offset, offset + limit);
    let items = selected.map((job) => ({ job_id: job.job_id, state: job.state, created_at: job.created_at, updated_at: job.updated_at, artifacts: job.artifacts }));
    let envelope: ResearchListEnvelope = {
      schema_version: SCHEMA_VERSION, request_id: operationRequestId ?? this.requestId(), mode: 'research_list', items,
      ...(offset + items.length < records.length ? { next_cursor: encodeListCursor(offset + items.length) } : {}),
    };
    while (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MANAGEMENT_TEXT_MAX_BYTES && items.length > 1) {
      items = items.slice(0, -1);
      envelope = { ...envelope, items, next_cursor: encodeListCursor(offset + items.length) };
    }
    return envelope;
  }

  async cancel(jobId: string, operationRequestId?: string): Promise<ResearchCancelEnvelope> {
    const result = await this.store.requestCancel(jobId);
    return { schema_version: SCHEMA_VERSION, request_id: operationRequestId ?? this.requestId(), mode: 'research_cancel', job_id: jobId, state: result.job.state, accepted: result.accepted };
  }
}

export class ResearchRunner {
  constructor(
    private readonly store: JobStore,
    private readonly searcher: Searcher,
    private readonly logger = new Logger('warn'),
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}
  async run(jobId: string): Promise<JobRecord> {
    const ownerToken = randomBytes(16).toString('hex');
    let job = await this.store.claim(jobId, ownerToken);
    const controller = new AbortController();
    const heartbeat = setInterval(() => { void this.store.heartbeat(jobId, ownerToken).catch(() => controller.abort()); }, 5000);
    const cancelPoll = setInterval(() => { void this.store.cancelRequested(jobId).then((requested) => { if (requested) controller.abort(); }); }, 250);
    this.logger.write('info', 'research_started', { job_id: jobId, query_fingerprint: queryFingerprint(job.request.query), state: job.state });
    try {
      const started = this.monotonicNow();
      const deadline = started + job.request.max_duration_ms;
      const operationLimit = Math.max(1, Math.ceil(job.request.max_sources / 20));
      const operations: SearchEnvelope[] = [];
      const collected = new Map<string, SearchResult>();
      let deadlineReached = false;

      for (let operation = 0; operation < operationLimit && collected.size < job.request.max_sources; operation += 1) {
        if (await this.store.cancelRequested(jobId)) return await this.finishCancelled(jobId);
        const remainingMs = Math.floor(deadline - this.monotonicNow());
        if (remainingMs < 1000) { deadlineReached = true; break; }
        const result = await this.searcher.search({
          query: researchOperationQuery(job.request.query, operation),
          max_results: Math.min(20, job.request.max_sources - collected.size),
          timeout_ms: Math.min(45_000, remainingMs),
          signal: controller.signal,
        });
        operations.push(result);
        mergeResearchResults(collected, result.results, job.request.max_sources);
        deadlineReached = this.monotonicNow() >= deadline;
        const checkpoint = collectionEnvelope(job, operations, [...collected.values()], started, this.monotonicNow(), deadlineReached);
        await this.store.writeArtifacts(jobId, 'checkpoint', evidenceArtifacts(job, checkpoint), {
          phase: 'collecting',
          progress: { completed_units: collected.size, total_units: job.request.max_sources },
        });
        if (await this.store.cancelRequested(jobId)) return await this.finishCancelled(jobId);
        if (deadlineReached || result.state === 'cancelled') break;
      }

      if (await this.store.cancelRequested(jobId)) return await this.finishCancelled(jobId);
      const result = collectionEnvelope(job, operations, [...collected.values()], started, this.monotonicNow(), deadlineReached);
      await this.store.writeArtifacts(jobId, 'final', evidenceArtifacts(job, result));
      const terminal = researchTerminal(result);
      return await this.store.transition(jobId, terminal, {
        phase: terminal === 'succeeded' || terminal === 'partial' ? 'complete' : terminal,
        progress: { completed_units: result.results.length, total_units: job.request.max_sources },
        ...(result.error === undefined ? {} : { error: result.error }), lease: undefined,
      });
    } catch (error) {
      job = await this.store.read(jobId);
      if (job.state === 'cancelling' || await this.store.cancelRequested(jobId)) {
        if (job.state === 'running') await this.store.transition(jobId, 'cancelling', { phase: 'cancelling' });
        return await this.store.transition(jobId, 'cancelled', { phase: 'cancelled', lease: undefined });
      }
      return await this.store.transition(jobId, 'failed', {
        phase: 'failed', lease: undefined, error: new NbSearchError('INTERNAL', 'The research worker failed.').toPublic(),
      });
    } finally {
      clearInterval(heartbeat); clearInterval(cancelPoll);
    }
  }

  private async finishCancelled(jobId: string): Promise<JobRecord> {
    const current = await this.store.read(jobId);
    if (current.state === 'running') await this.store.transition(jobId, 'cancelling', { phase: 'cancelling' });
    return await this.store.transition(jobId, 'cancelled', { phase: 'cancelled', lease: undefined, error: undefined });
  }
}

function mergeResearchResults(target: Map<string, SearchResult>, incoming: readonly SearchResult[], limit: number): void {
  for (const item of incoming) {
    const existing = target.get(item.url);
    if (existing !== undefined) {
      for (const provider of item.providers) if (!existing.providers.includes(provider)) existing.providers.push(provider);
      for (const provenance of item.provenance) {
        if (!existing.provenance.some((candidate) => candidate.provider === provenance.provider
          && candidate.provider_instance_id === provenance.provider_instance_id
          && candidate.invocation_id === provenance.invocation_id
          && candidate.original_url === provenance.original_url)) {
          existing.provenance.push(structuredClone(provenance));
        }
      }
      if (existing.snippet === '' && item.snippet !== '') existing.snippet = item.snippet;
      continue;
    }
    if (target.size >= limit) break;
    target.set(item.url, structuredClone(item));
  }
}

const RESEARCH_FOCUSES = [
  '',
  'Focus on primary and official sources.',
  'Focus on independent technical evidence.',
  'Focus on recent authoritative analysis.',
  'Focus on corroborating sources and contrary evidence.',
] as const;

function researchOperationQuery(query: string, operation: number): string {
  const focus = RESEARCH_FOCUSES[operation] ?? `Focus on additional independent evidence batch ${String(operation + 1)}.`;
  const suffix = focus === '' ? '' : `\n\n${focus}`;
  if (query.length + suffix.length <= 4000) return `${query}${suffix}`;
  const separator = '\n…\n';
  const available = Math.max(1, 4000 - suffix.length - separator.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${query.slice(0, headLength)}${separator}${query.slice(-tailLength)}${suffix}`;
}

function collectionEnvelope(
  job: JobRecord,
  operations: readonly SearchEnvelope[],
  results: SearchResult[],
  started: number,
  completed: number,
  deadlineReached: boolean,
): SearchEnvelope {
  const attempts = operations.flatMap((operation) => operation.attempts);
  const operationStates = operations.map((operation) => operation.state);
  let state: SearchEnvelope['state'];
  if (results.length > 0) {
    state = deadlineReached || operationStates.some((value) => value === 'partial' || value === 'failed' || value === 'timed_out' || value === 'cancelled')
      ? 'partial'
      : 'succeeded';
  } else if (operationStates.includes('cancelled')) state = 'cancelled';
  else if (deadlineReached || operationStates.includes('timed_out')) state = 'timed_out';
  else if (operationStates.length > 0 && operationStates.every((value) => value === 'empty')) state = 'empty';
  else state = 'failed';

  const warnings = [...new Set(operations.flatMap((operation) => operation.warnings))];
  if (deadlineReached && results.length > 0) warnings.push('The research deadline was reached; collected sources were preserved.');
  const error = results.length === 0
    ? state === 'timed_out'
      ? new NbSearchError('DEADLINE_EXCEEDED', 'Research deadline was exceeded.', true).toPublic()
      : state === 'cancelled'
        ? new NbSearchError('CANCELLED', 'Research was cancelled.').toPublic()
        : operations.findLast((operation) => operation.error !== undefined)?.error
    : undefined;
  const startedAt = new Date(Date.parse(job.started_at ?? job.created_at) || Date.now());
  const completedAt = new Date(startedAt.getTime() + Math.max(0, Math.round(completed - started)));
  return {
    schema_version: SCHEMA_VERSION,
    request_id: operations[0]?.request_id ?? job.job_id,
    mode: 'search',
    state,
    query: job.request.query,
    results,
    attempts,
    warnings,
    ...(error === undefined ? {} : { error }),
    timing: {
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: Math.max(0, Math.round(completed - started)),
      budget_ms: job.request.max_duration_ms,
    },
    compaction: {
      applied: operations.some((operation) => operation.compaction.applied),
      snippets_shortened: operations.reduce((sum, operation) => sum + operation.compaction.snippets_shortened, 0),
      results_omitted: operations.reduce((sum, operation) => sum + operation.compaction.results_omitted, 0),
      max_bytes: RESEARCH_PAGE_MAX_BYTES,
    },
  };
}

function evidenceArtifacts(job: JobRecord, result: SearchEnvelope) {
  const summary = {
    kind: 'bounded_evidence_report', query: job.request.query, state: result.state,
    source_count: result.results.length, provider_attempts: result.attempts, warnings: result.warnings,
    synthesis_claimed: false,
  };
  const lines = [
    '# Research Evidence Report', '', `State: ${result.state}`, `Sources: ${String(result.results.length)}`, '',
    'This is a deterministic evidence collection report. Inspect the cited sources before relying on material claims.', '',
    ...result.results.flatMap((item, index) => [`## ${String(index + 1)}. ${item.title || item.url}`, item.url, item.snippet, '']),
  ];
  return { summary, report: lines.join('\n'), sources: result.results };
}
function researchTerminal(result: SearchEnvelope): Extract<JobState, 'succeeded' | 'partial' | 'failed' | 'timed_out' | 'cancelled'> {
  if (result.state === 'succeeded' || result.state === 'empty') return 'succeeded';
  return result.state;
}
function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalidInput(`${field} must be an integer from ${String(min)} to ${String(max)}.`);
  return value;
}
function encodeCursor(offset: number, artifact: ResearchArtifact, state: string): string { return Buffer.from(JSON.stringify({ v: 1, offset, artifact, state })).toString('base64url') }
function decodeCursor(cursor: string | undefined, artifact: ResearchArtifact, state: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown; artifact?: unknown; state?: unknown };
    if (parsed.v !== 1 || parsed.artifact !== artifact || parsed.state !== state || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error();
    return Number(parsed.offset);
  } catch { throw invalidInput('cursor is invalid for this artifact revision.'); }
}
function encodeListCursor(offset: number): string { return Buffer.from(JSON.stringify({ v: 1, offset })).toString('base64url') }
function decodeListCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown };
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error(); return Number(parsed.offset);
  } catch { throw invalidInput('cursor is invalid.'); }
}
interface BoundedItem { item: unknown; truncated: boolean; originalBytes: number; boundedBytes: number }

function researchReadEnvelope(
  requestId: string,
  job: JobRecord,
  artifact: ResearchArtifact,
  artifactState: ArtifactState,
  offset: number,
  totalItems: number,
  bounded: readonly BoundedItem[],
): ResearchReadEnvelope {
  const items = bounded.map((item) => item.item);
  const bytesOmitted = bounded.reduce((sum, item) => sum + Math.max(0, item.originalBytes - item.boundedBytes), 0);
  return {
    schema_version: SCHEMA_VERSION,
    request_id: requestId,
    mode: 'research_read',
    job_id: job.job_id,
    job_state: job.state,
    artifact,
    artifact_state: artifactState,
    items,
    ...(offset + items.length < totalItems ? { next_cursor: encodeCursor(offset + items.length, artifact, artifactState) } : {}),
    compaction: {
      applied: bounded.some((item) => item.truncated),
      items_truncated: bounded.filter((item) => item.truncated).length,
      bytes_omitted: bytesOmitted,
      max_bytes: RESEARCH_PAGE_MAX_BYTES,
    },
  };
}

function boundItem(item: unknown, budget: number): BoundedItem {
  const originalBytes = jsonBytes(item);
  if (originalBytes <= budget) return { item, truncated: false, originalBytes, boundedBytes: originalBytes };

  let bounded: unknown;
  if (typeof item === 'string') {
    bounded = truncateUtf8(item, Math.max(32, budget - 2));
  } else if (isRecord(item) && ('url' in item || 'provenance' in item)) {
    bounded = compactSourceItem(item, budget);
  } else {
    const markerOverhead = jsonBytes({ truncated: true, original_bytes: originalBytes, preview: '' });
    bounded = {
      truncated: true,
      original_bytes: originalBytes,
      preview: truncateUtf8(JSON.stringify(item) ?? String(item), Math.max(32, budget - markerOverhead - 16)),
    };
  }
  const boundedBytes = jsonBytes(bounded);
  if (boundedBytes > budget) {
    bounded = { truncated: true, original_bytes: originalBytes };
  }
  return { item: bounded, truncated: true, originalBytes, boundedBytes: jsonBytes(bounded) };
}

function compactSourceItem(record: Record<string, unknown>, budget: number): Record<string, unknown> {
  let textLimit = 4096;
  let arrayLimit = 8;
  let candidate = sourceProjection(record, textLimit, arrayLimit);
  while (jsonBytes(candidate) > budget && (textLimit > 32 || arrayLimit > 1)) {
    textLimit = Math.max(32, Math.floor(textLimit / 2));
    arrayLimit = Math.max(1, Math.floor(arrayLimit / 2));
    candidate = sourceProjection(record, textLimit, arrayLimit);
  }
  return candidate;
}

function sourceProjection(record: Record<string, unknown>, textLimit: number, arrayLimit: number): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ['title', 'url', 'snippet', 'published_at', 'site_name'] as const) {
    if (typeof record[key] === 'string') projected[key] = truncateUtf8(record[key], textLimit);
  }
  if (typeof record['score'] === 'number') projected['score'] = record['score'];
  if (Array.isArray(record['providers'])) {
    projected['providers'] = record['providers'].slice(0, arrayLimit).map((value) => truncateUtf8(String(value), Math.min(256, textLimit)));
  }
  if (Array.isArray(record['provenance'])) {
    projected['provenance'] = record['provenance'].slice(0, arrayLimit).map((value) => {
      if (!isRecord(value)) return { value: truncateUtf8(String(value), Math.min(256, textLimit)) };
      return {
        ...(value['provider'] === undefined ? {} : { provider: truncateUtf8(String(value['provider']), Math.min(256, textLimit)) }),
        ...(typeof value['rank'] === 'number' ? { rank: value['rank'] } : {}),
        ...(value['original_url'] === undefined ? {} : { original_url: truncateUtf8(String(value['original_url']), textLimit) }),
      };
    });
  }
  projected['_nb_search_compaction'] = { applied: true, metadata_omitted: true };
  return projected;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 3) return '';
  let low = 0;
  let high = value.length;
  const contentBudget = maxBytes - Buffer.byteLength('…', 'utf8');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= contentBudget) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? '')) end -= 1;
  return `${value.slice(0, end)}…`;
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8') }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
const ALL_STATES = new Set<JobState>(['queued', 'running', 'cancelling', 'succeeded', 'partial', 'failed', 'timed_out', 'cancelled']);
function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new NbSearchError('CANCELLED', 'The operation was cancelled.');
}
