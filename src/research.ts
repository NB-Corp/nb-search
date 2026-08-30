import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { NbSearchError, invalidInput } from './errors.ts';
import type { ExecutionSnapshot } from './execution-snapshot.ts';
import type { OperationContext } from './contracts.ts';
import { isTerminalState, JobStore } from './job-store.ts';
import { Logger, queryFingerprint } from './logging.ts';
import type {
  ArtifactState, CapabilityAugmentation, CapabilityCapture, JobRecord, JobState, MultiAgentResearchArtifactItem, ResearchArtifact, ResearchCancelEnvelope, ResearchListEnvelope, ResearchReadEnvelope,
  Freshness, ProfileId, ResearchRequest, ResearchStartEnvelope, SearchEnvelope, SearchIntent, SearchProfileId, Searcher, SearchResult,
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
    private readonly defaultProfileId: ProfileId = 'default',
  ) {}

  async start(
    input: {
      query: string; max_sources?: number; max_duration_ms?: number; idempotency_key?: string;
      profile?: SearchProfileId; intent?: SearchIntent; freshness?: Freshness;
    },
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
    const request: ResearchRequest = {
      query, max_sources: maxSources, max_duration_ms: maxDurationMs, profile: input.profile ?? this.defaultProfileId,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
    };
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
      artifact_revision: job.artifact_revision,
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
    const offset = decodeCursor(input.cursor, artifact, content.state, content.revision);
    const selected = content.items.slice(offset, offset + pageSize);
    let bounded = artifact === 'multi_agent_research'
      ? selected.map((item) => ({ item, truncated: false, originalBytes: jsonBytes(item), boundedBytes: jsonBytes(item) }))
      : selected.map((item) => boundItem(item, RESEARCH_PAGE_MAX_BYTES - 2048));
    let envelope = researchReadEnvelope(
      operationRequestId ?? this.requestId(), job, artifact, content.state, content.revision, offset, content.items.length, bounded,
    );
    while (jsonBytes(envelope) > RESEARCH_PAGE_MAX_BYTES && bounded.length > 1) {
      bounded = bounded.slice(0, -1);
      envelope = researchReadEnvelope(
        envelope.request_id, job, artifact, content.state, content.revision, offset, content.items.length, bounded,
      );
    }
    if (jsonBytes(envelope) > RESEARCH_PAGE_MAX_BYTES && bounded.length === 1) {
      if (artifact === 'multi_agent_research') throw new NbSearchError('INTERNAL', 'Multi-agent research artifact item exceeds the page bound.');
      const empty = researchReadEnvelope(
        envelope.request_id, job, artifact, content.state, content.revision, offset, content.items.length, [],
      );
      const itemBudget = Math.max(512, RESEARCH_PAGE_MAX_BYTES - jsonBytes(empty) - 64);
      bounded = [boundItem(selected[0], itemBudget)];
      envelope = researchReadEnvelope(
        envelope.request_id, job, artifact, content.state, content.revision, offset, content.items.length, bounded,
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
    let items = selected.map((job) => ({ job_id: job.job_id, state: job.state, created_at: job.created_at, updated_at: job.updated_at, artifacts: job.artifacts, artifact_revision: job.artifact_revision }));
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
      const completedOnce = new Set<string>();
      const collected = new Map<string, SearchResult>();
      const capabilityCaptures: CapabilityCapture[] = [];
      let deadlineReached = false;

      for (let operation = 0; operation < operationLimit && collected.size < job.request.max_sources; operation += 1) {
        if (await this.store.cancelRequested(jobId)) return await this.finishCancelled(jobId);
        const remainingMs = Math.floor(deadline - this.monotonicNow());
        if (remainingMs < 1000) { deadlineReached = true; break; }
        let retainedAugmentations: SearchEnvelope['augmentations'];
        let retainedCapabilities: readonly CapabilityCapture[] = [];
        const operationBudgetMs = this.searcher.researchOperationBudgetMs?.(operation, remainingMs)
          ?? Math.min(operation === 0 && hasCapabilityRoute(job.request) ? 120_000 : 45_000, remainingMs);
        const result = await this.searcher.search({
          query: researchOperationQuery(job.request.query, operation),
          max_results: Math.min(20, job.request.max_sources - collected.size),
          ...(this.searcher.researchOperationBudgetMs === undefined ? { timeout_ms: operationBudgetMs } : {}),
          signal: controller.signal,
          ...(job.request.profile === undefined ? {} : { profile: job.request.profile }),
          ...(job.request.intent === undefined ? {} : { intent: job.request.intent }),
          ...(job.request.freshness === undefined ? {} : { freshness: job.request.freshness }),
        }, undefined, {
          scope: 'research-job', completed_once_per_job_invocation_ids: completedOnce,
          capture_augmentations: (items) => { retainedAugmentations = [...structuredClone(items)]; },
          capture_capabilities: (items) => { retainedCapabilities = structuredClone(items); },
          research_brief: job.request.query,
          operation_budget_ms: operationBudgetMs,
        });
        for (const capture of retainedCapabilities) if (!capabilityCaptures.some((item) => item.invocation_id === capture.invocation_id)) capabilityCaptures.push(capture);
        if (retainedAugmentations !== undefined && retainedAugmentations.length > 0) result.augmentations = retainedAugmentations;
        operations.push(result);
        mergeResearchResults(collected, result.results, job.request.max_sources);
        deadlineReached = this.monotonicNow() >= deadline;
        const checkpoint = collectionEnvelope(job, operations, [...collected.values()], started, this.monotonicNow(), deadlineReached);
        job = await this.store.writeArtifacts(jobId, 'checkpoint', evidenceArtifacts(job, checkpoint, capabilityCaptures, job.artifact_revision + 1), {
          phase: 'collecting',
          progress: { completed_units: collected.size, total_units: job.request.max_sources },
        });
        if (await this.store.cancelRequested(jobId)) return await this.finishCancelled(jobId);
        if (deadlineReached || result.state === 'cancelled') break;
      }

      if (await this.store.cancelRequested(jobId)) return await this.finishCancelled(jobId);
      const result = collectionEnvelope(job, operations, [...collected.values()], started, this.monotonicNow(), deadlineReached);
      job = await this.store.writeArtifacts(jobId, 'final', evidenceArtifacts(job, result, capabilityCaptures, job.artifact_revision + 1));
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

function hasCapabilityRoute(request: ResearchRequest): boolean {
  return ((request.profile === 'default' || request.profile === 'deep') && (request.intent === 'factual' || request.intent === 'tutorial'))
    || (request.profile === 'deep' && (request.intent === 'status' || request.intent === 'comparison' || request.intent === 'exploratory' || request.intent === 'news'));
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
  const augmentations = operations.flatMap((operation) => operation.augmentations ?? [])
    .filter((item, index, array) => array.findIndex((candidate) => candidate.invocation_id === item.invocation_id) === index);
  const operationStates = operations.map((operation) => operation.state);
  let state: SearchEnvelope['state'];
  if (results.length > 0) {
    state = deadlineReached || operationStates.some((value) => value === 'partial' || value === 'failed' || value === 'timed_out' || value === 'cancelled')
      ? 'partial'
      : 'succeeded';
  } else if (operationStates.includes('cancelled')) state = 'cancelled';
  else if (operationStates.includes('partial')) state = 'partial';
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
    ...(augmentations.length === 0 ? {} : { augmentations }),
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

function evidenceArtifacts(
  job: JobRecord,
  result: SearchEnvelope,
  captures: readonly CapabilityCapture[] = [],
  artifactRevision = job.artifact_revision + 1,
) {
  const gma = projectMultiAgentResearchArtifact(captures[0]);
  const capabilityOutcomes: CapabilityAugmentation[] = [
    ...(result.augmentations ?? []),
    ...projectMultiAgentResearchOutcome(captures[0], gma.items, artifactRevision),
  ];
  const summary = {
    kind: 'bounded_evidence_report', query: job.request.query, state: result.state,
    source_count: result.results.length, provider_attempts: result.attempts, warnings: result.warnings,
    capability_outcomes: capabilityOutcomes.map((item) => ({
      capability: item.capability, state: item.state, provider_id: item.provider_id,
      provider_instance_id: item.provider_instance_id, invocation_id: item.invocation_id, failure_policy: item.failure_policy,
      ...(item.capability === 'multi-agent-research' && (item.state === 'succeeded' || item.state === 'partial')
        ? { artifact_available: true, result_count: item.preview.result_count, claim_count: item.preview.claim_count }
        : item.capability === 'multi-agent-research' ? { artifact_available: false } : {}),
    })),
    provider_synthesis_available: capabilityOutcomes.some((item) => item.state === 'succeeded'
      || (item.capability === 'multi-agent-research' && item.state === 'partial' && item.preview.answer_available)),
    synthesis_claimed: false,
  };
  const lines = [
    '# Research Evidence Report', '', `State: ${result.state}`, `Sources: ${String(result.results.length)}`, '',
    'This is a deterministic evidence collection report. Inspect the cited sources before relying on material claims.', '',
    ...result.results.flatMap((item, index) => [`## ${String(index + 1)}. ${item.title || item.url}`, item.url, item.snippet, '']),
  ];
  return { summary, report: lines.join('\n'), sources: result.results, capabilities: capabilityOutcomes, multi_agent_research: gma.items };
}

function projectMultiAgentResearchArtifact(capture: CapabilityCapture | undefined): { items: MultiAgentResearchArtifactItem[] } {
  const result = capture?.result;
  if (capture === undefined || result === undefined || (capture.state !== 'succeeded' && capture.state !== 'partial') || result.completeness === 'empty') return { items: [] };
  const evidenceMapAvailable = result.trace.claims.length > 0;
  const items: MultiAgentResearchArtifactItem[] = [{
    schema_version: 1, kind: 'metadata', capability: 'multi-agent-research', provider_id: 'grok-multi-agent',
    provider_instance_id: capture.provider_instance_id, invocation_id: capture.invocation_id, role: 'primary_synthesis',
    model: result.model, reasoning_effort: result.reasoning_effort, api_mode: 'chat_completions',
    expected_agent_count: result.expected_agent_count, backend_trace_observable: false, claim_linked_citations: false,
    evidence_map_available: evidenceMapAvailable, evidence_linkage: 'model_declared_url_matched', semantic_verification: false,
  }];
  if (result.answer !== undefined) items.push({
    schema_version: 1, kind: 'answer', text: result.answer, claim_linked_citations: false,
    evidence_map_available: evidenceMapAvailable, evidence_linkage: 'model_declared_url_matched', semantic_verification: false,
  });
  result.results.forEach((item, index) => items.push({
    schema_version: 1, kind: 'result', index, title: item.title, url: item.url,
    ...(item.snippet === undefined ? {} : { snippet: item.snippet }), ...(item.published_at === undefined ? {} : { published_at: item.published_at }),
    source_type: item.metadata.source_type, supports_claim_ids: item.metadata.supports_claim_ids,
  }));
  result.trace.angles.forEach((text, index) => items.push({ schema_version: 1, kind: 'angle', index, text }));
  result.trace.claims.forEach((item, index) => items.push({ schema_version: 1, kind: 'claim', index, ...item }));
  result.trace.conflicts.forEach((item, index) => items.push({ schema_version: 1, kind: 'conflict', index, ...item }));
  result.trace.follow_up_queries.forEach((text, index) => items.push({ schema_version: 1, kind: 'follow_up_query', index, text }));
  items.push({
    schema_version: 1, kind: 'summary', completeness: result.completeness as 'complete' | 'partial',
    result_count: result.results.length, angle_count: result.trace.angles.length, claim_count: result.trace.claims.length,
    conflict_count: result.trace.conflicts.length, follow_up_query_count: result.trace.follow_up_queries.length,
    source_mix: result.trace.source_mix, linked_evidence_count: result.trace.linked_evidence_count, omissions: result.trace.omissions,
  });
  for (const item of items) if (jsonBytes(item) > 18_000) throw new NbSearchError('INTERNAL', 'Multi-agent research artifact record exceeds the publication bound.');
  return { items };
}

function projectMultiAgentResearchOutcome(
  capture: CapabilityCapture | undefined,
  items: readonly MultiAgentResearchArtifactItem[],
  artifactRevision: number,
): CapabilityAugmentation[] {
  if (capture === undefined) return [];
  const base = {
    capability: 'multi-agent-research' as const, provider_id: capture.provider_id,
    provider_instance_id: capture.provider_instance_id, ...(capture.credential_slot_id === undefined ? {} : { credential_slot_id: capture.credential_slot_id }),
    invocation_id: capture.invocation_id, failure_policy: capture.failure_policy, attempt_count: capture.attempt_count,
  };
  const result = capture.result;
  if ((capture.state === 'succeeded' || capture.state === 'partial') && result !== undefined && result.completeness !== 'empty') {
    const bytes = Buffer.from(jsonLines(items), 'utf8');
    return [{
      ...base, state: capture.state,
      result: { delivery: 'artifact', artifact: {
        artifact_id: 'multi_agent_research', artifact_revision: artifactRevision, capability: 'multi-agent-research',
        artifact_kind: 'multi_agent_research', media_type: 'application/x-ndjson', byte_length: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } },
      preview: {
        answer_available: result.answer !== undefined, result_count: result.results.length, angle_count: result.trace.angles.length,
        claim_count: result.trace.claims.length, conflict_count: result.trace.conflicts.length,
        follow_up_query_count: result.trace.follow_up_queries.length, expected_agent_count: result.expected_agent_count,
        backend_trace_observable: false, evidence_map_available: result.trace.claims.length > 0,
        evidence_linkage: 'model_declared_url_matched', semantic_verification: false, omissions: result.trace.omissions,
      },
    }];
  }
  if (capture.state === 'empty' || result?.completeness === 'empty') return [{ ...base, state: 'empty' }];
  return [{ ...base, state: capture.state as 'unavailable' | 'failed' | 'timed_out' | 'cancelled', error: capture.error ?? new NbSearchError('CAPABILITY_UNAVAILABLE', 'The selected capability is unavailable.').toPublic() }];
}
function researchTerminal(result: SearchEnvelope): Extract<JobState, 'succeeded' | 'partial' | 'failed' | 'timed_out' | 'cancelled'> {
  if (result.state === 'succeeded' || result.state === 'empty') return 'succeeded';
  return result.state;
}
function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalidInput(`${field} must be an integer from ${String(min)} to ${String(max)}.`);
  return value;
}
function encodeCursor(offset: number, artifact: ResearchArtifact, state: string, revision: number): string { return Buffer.from(JSON.stringify({ v: 2, offset, artifact, state, revision })).toString('base64url') }
function decodeCursor(cursor: string | undefined, artifact: ResearchArtifact, state: string, revision: number): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown; artifact?: unknown; state?: unknown; revision?: unknown };
    if (parsed.v !== 2 || parsed.artifact !== artifact || parsed.state !== state || parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error();
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
  artifactRevision: number,
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
    artifact_revision: artifactRevision,
    items,
    ...(offset + items.length < totalItems ? { next_cursor: encodeCursor(offset + items.length, artifact, artifactState, artifactRevision) } : {}),
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
  } else if (isRecord(item) && item['kind'] === 'bounded_evidence_report') {
    bounded = compactSummaryItem(item, budget);
  } else if (isRecord(item) && (item['capability'] === 'answer' || item['capability'] === 'research-light')) {
    bounded = compactCapabilityItem(item, budget);
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

function compactCapabilityItem(record: Record<string, unknown>, budget: number): Record<string, unknown> {
  const projected = structuredClone(record);
  const value = isRecord(projected['result']) && isRecord(projected['result']['value']) ? projected['result']['value'] : undefined;
  const urls = value !== undefined && Array.isArray(value['supporting_urls']) ? value['supporting_urls'] : undefined;
  if (urls !== undefined) for (const item of urls) if (isRecord(item)) delete item['title'];
  while (jsonBytes(projected) > budget && urls !== undefined && urls.length > 0) {
    urls.pop();
    if (value !== undefined) value['supporting_urls_omitted'] = Number(value['supporting_urls_omitted'] ?? 0) + 1;
  }
  if (jsonBytes(projected) > budget && isRecord(projected['error'])) delete projected['error']['message'];
  if (jsonBytes(projected) > budget) throw new NbSearchError('INTERNAL', 'Capability artifact item exceeds the page bound.');
  return projected;
}

function compactSummaryItem(record: Record<string, unknown>, budget: number): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    kind: 'bounded_evidence_report',
    ...(typeof record['query'] === 'string' ? { query: truncateUtf8(record['query'], 2048) } : {}),
    ...(typeof record['state'] === 'string' ? { state: record['state'] } : {}),
    ...(typeof record['source_count'] === 'number' ? { source_count: record['source_count'] } : {}),
    ...(typeof record['synthesis_claimed'] === 'boolean' ? { synthesis_claimed: record['synthesis_claimed'] } : {}),
    ...(typeof record['provider_synthesis_available'] === 'boolean' ? { provider_synthesis_available: record['provider_synthesis_available'] } : {}),
    capability_outcomes: Array.isArray(record['capability_outcomes']) ? record['capability_outcomes'].slice(0, 16).flatMap((item) => {
      if (!isRecord(item)) return [];
      return [{
        capability: item['capability'], state: item['state'], provider_id: item['provider_id'],
        provider_instance_id: item['provider_instance_id'], invocation_id: item['invocation_id'], failure_policy: item['failure_policy'],
      }];
    }) : [],
    warnings: Array.isArray(record['warnings']) ? record['warnings'].slice(0, 16).map((item) => truncateUtf8(String(item), 512)) : [],
    provider_attempts: Array.isArray(record['provider_attempts'])
      ? record['provider_attempts'].map((item) => compactAttempt(item)) : [],
  };
  while (jsonBytes(projected) > budget) {
    const attempts = projected['provider_attempts'] as Record<string, unknown>[];
    const withMessages = attempts.flatMap((outer) => Array.isArray(outer['upstream_attempts']) ? outer['upstream_attempts'] as Record<string, unknown>[] : [])
      .find((nested) => isRecord(nested['error']) && typeof nested['error']['message'] === 'string' && nested['error']['message'].length > 32);
    if (withMessages !== undefined && isRecord(withMessages['error']) && typeof withMessages['error']['message'] === 'string') {
      withMessages['error']['message'] = truncateUtf8(withMessages['error']['message'], Math.max(32, Math.floor(withMessages['error']['message'].length / 2)));
      continue;
    }
    const outer = [...attempts].reverse().find((item) => Array.isArray(item['upstream_attempts']) && item['upstream_attempts'].length > 0);
    if (outer !== undefined && Array.isArray(outer['upstream_attempts'])) {
      outer['upstream_attempts'].pop();
      outer['upstream_attempts_omitted'] = Number(outer['upstream_attempts_omitted'] ?? 0) + 1;
      continue;
    }
    const withOuterMessage = attempts.find((item) => isRecord(item['error']) && typeof item['error']['message'] === 'string');
    if (withOuterMessage !== undefined && isRecord(withOuterMessage['error'])) {
      delete withOuterMessage['error']['message'];
      continue;
    }
    const optionalKey = ['credential_slot_id', 'capability', 'role', 'trigger', 'duration_ms']
      .find((key) => attempts.some((item) => item[key] !== undefined));
    if (optionalKey !== undefined) {
      attempts.forEach((item) => delete item[optionalKey]);
      continue;
    }
    if (Array.isArray(projected['warnings']) && projected['warnings'].length > 0) {
      projected['warnings'].pop();
      continue;
    }
    if (typeof projected['query'] === 'string' && projected['query'].length > 64) {
      projected['query'] = truncateUtf8(projected['query'], Math.max(64, Math.floor(projected['query'].length / 2)));
      continue;
    }
    break;
  }
  return projected;
}

function compactAttempt(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { provider: 'unknown', attempt: 1, state: 'failed', duration_ms: 0, result_count: 0 };
  const projected: Record<string, unknown> = {};
  for (const key of ['provider', 'provider_instance_id', 'credential_slot_id', 'invocation_id', 'capability', 'role', 'trigger', 'attempt', 'state', 'duration_ms', 'result_count'] as const) {
    if (value[key] !== undefined) projected[key] = structuredClone(value[key]);
  }
  if (isRecord(value['error'])) projected['error'] = {
    ...(value['error']['code'] === undefined ? {} : { code: value['error']['code'] }),
    ...(typeof value['error']['message'] === 'string' ? { message: truncateUtf8(value['error']['message'], 512) } : {}),
    ...(typeof value['error']['retryable'] === 'boolean' ? { retryable: value['error']['retryable'] } : {}),
  };
  if (Array.isArray(value['upstream_attempts'])) projected['upstream_attempts'] = value['upstream_attempts'].map((item) => {
    if (!isRecord(item)) return { provider: 'unknown', state: 'unknown', duration_ms: 0, result_count: 0 };
    const nested = structuredClone(item);
    if (isRecord(nested['error']) && typeof nested['error']['message'] === 'string') nested['error']['message'] = truncateUtf8(nested['error']['message'], 512);
    return nested;
  });
  if (typeof value['upstream_attempts_omitted'] === 'number') projected['upstream_attempts_omitted'] = value['upstream_attempts_omitted'];
  return projected;
}

function compactSourceItem(record: Record<string, unknown>, budget: number): Record<string, unknown> {
  let textLimit = 4096;
  let arrayLimit = 8;
  let includeOptional = true;
  let candidate = sourceProjection(record, textLimit, arrayLimit, includeOptional);
  while (jsonBytes(candidate) > budget && (textLimit > 32 || arrayLimit > 1)) {
    if (includeOptional) {
      includeOptional = false;
      candidate = sourceProjection(record, textLimit, arrayLimit, includeOptional);
      continue;
    }
    textLimit = Math.max(32, Math.floor(textLimit / 2));
    arrayLimit = Math.max(1, Math.floor(arrayLimit / 2));
    candidate = sourceProjection(record, textLimit, arrayLimit, includeOptional);
  }
  return candidate;
}

function sourceProjection(
  record: Record<string, unknown>,
  textLimit: number,
  arrayLimit: number,
  includeOptional: boolean,
): Record<string, unknown> {
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
        ...(!includeOptional || value['provider_instance_id'] === undefined ? {} : { provider_instance_id: truncateUtf8(String(value['provider_instance_id']), Math.min(256, textLimit)) }),
        ...(!includeOptional || value['credential_slot_id'] === undefined ? {} : { credential_slot_id: truncateUtf8(String(value['credential_slot_id']), Math.min(256, textLimit)) }),
        ...(!includeOptional || value['invocation_id'] === undefined ? {} : { invocation_id: truncateUtf8(String(value['invocation_id']), Math.min(256, textLimit)) }),
        ...(!includeOptional || value['capability'] === undefined ? {} : { capability: truncateUtf8(String(value['capability']), Math.min(128, textLimit)) }),
        ...(!includeOptional || value['role'] === undefined ? {} : { role: truncateUtf8(String(value['role']), Math.min(128, textLimit)) }),
        ...(!includeOptional || value['trigger'] === undefined ? {} : { trigger: truncateUtf8(String(value['trigger']), Math.min(128, textLimit)) }),
        ...(typeof value['rank'] === 'number' ? { rank: value['rank'] } : {}),
        ...(value['original_url'] === undefined ? {} : { original_url: truncateUtf8(String(value['original_url']), textLimit) }),
        ...(Array.isArray(value['upstream']) ? {
          upstream: value['upstream'].slice(0, arrayLimit).flatMap((item) => isRecord(item) && typeof item['provider'] === 'string'
            ? [{ provider: truncateUtf8(item['provider'], Math.min(128, textLimit)) }] : []),
          upstream_omitted: Number(value['upstream_omitted'] ?? 0) + Math.max(0, value['upstream'].length - arrayLimit),
        } : {}),
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
function jsonLines(items: readonly unknown[]): string { return items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '') }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
const ALL_STATES = new Set<JobState>(['queued', 'running', 'cancelling', 'succeeded', 'partial', 'failed', 'timed_out', 'cancelled']);
function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new NbSearchError('CANCELLED', 'The operation was cancelled.');
}
