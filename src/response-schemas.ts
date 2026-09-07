import { z } from 'zod';
import { SCHEMA_VERSION } from './types.ts';

const openObject = <T extends z.core.$ZodLooseShape>(shape: T) => z.object(shape).passthrough();

const safeNonnegativeInt = z.number().int().nonnegative();
const logicalStatusSchema = z.enum(['succeeded', 'empty', 'partial', 'failed', 'timed_out', 'cancelled']);
const jobStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const queryExecutionSchema = z.enum(['sync', 'async']);
const outputChannelSchema = z.enum(['results', 'typed']);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const uuidSchema = z.uuid();
const jsonValueSchema = z.json();
const unknownRecordSchema = z.record(z.string(), z.unknown());

const publicErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'CONFIGURATION_ERROR', 'LANE_NOT_REGISTERED', 'LANE_NOT_CONFIGURED',
  'LANE_NOT_SELECTABLE', 'LANE_EXECUTION_UNSUPPORTED', 'MIXED_OUTPUT_UNSUPPORTED',
  'PRESET_NOT_FOUND', 'PRESET_UNAVAILABLE', 'DEFAULT_NOT_CONFIGURED', 'FETCH_DEFAULT_NOT_CONFIGURED',
  'FETCH_CHAIN_UNAVAILABLE', 'FETCH_PIPELINE_UNSUPPORTED', 'FETCH_EGRESS_DENIED',
  'FETCH_SCOPE_NOT_FOUND', 'FETCH_FILE_BLOCKED', 'BUDGET_EXCEEDED', 'OUTPUT_TOO_LARGE',
  'FETCH_BLOCKED', 'FETCH_BYTES_LIMIT', 'FETCH_CONTENT_TYPE_REJECTED', 'FETCH_HTTP_ERROR',
  'QUALITY_GATE_FAILED', 'PROVIDER_AUTH', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE',
  'DEADLINE_EXCEEDED', 'CANCELLED', 'JOB_NOT_FOUND', 'JOB_CONFLICT', 'JOB_STORE_ERROR',
  'WORKER_START_FAILED', 'WORKER_LOST', 'INTERNAL',
]);

const publicErrorSchema = openObject({
  code: publicErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  provider: z.string().optional(),
  retry_after_ms: safeNonnegativeInt.optional(),
  data: unknownRecordSchema.optional(),
});

const hintSchema = openObject({
  code: z.string(),
  message: z.string(),
  data: unknownRecordSchema.optional(),
});

const upstreamAttributionSchema = openObject({
  provider: z.string(),
});

const upstreamErrorSchema = openObject({
  code: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
});

const upstreamAttemptStateSchema = z.enum(['succeeded', 'empty', 'skipped', 'failed', 'timed_out', 'cancelled', 'unknown']);
const upstreamAttemptSchema = openObject({
  provider: z.string(),
  state: upstreamAttemptStateSchema,
  duration_ms: safeNonnegativeInt,
  result_count: safeNonnegativeInt,
  attempt: safeNonnegativeInt.optional(),
  capability: z.string().optional(),
  role: z.string().optional(),
  trigger: z.string().optional(),
  error: upstreamErrorSchema.optional(),
});

const providerResultSchema = openObject({
  title: z.string(),
  url: z.string(),
  snippet: z.string().optional(),
  published_at: z.string().optional(),
  site_name: z.string().optional(),
  score: z.number().optional(),
  metadata: unknownRecordSchema.optional(),
  upstream_attribution: z.array(upstreamAttributionSchema).optional(),
  upstream_attribution_omitted: safeNonnegativeInt.optional(),
});

const laneOutcomeStateSchema = z.enum(['succeeded', 'empty', 'failed', 'timeout', 'cancelled', 'skipped']);
const laneOutcomeSchema = openObject({
  lane: z.string(),
  ok: z.boolean(),
  state: laneOutcomeStateSchema,
  duration_ms: safeNonnegativeInt,
  result_count: safeNonnegativeInt,
  warnings: z.array(hintSchema),
  error: publicErrorSchema.optional(),
});

const resultProvenanceSchema = openObject({
  lane: z.string(),
  provider_instance_id: z.string(),
  query_index: safeNonnegativeInt,
  rank: safeNonnegativeInt,
  original_url: z.string(),
  evidence_groups: z.array(z.string()),
  upstream: z.array(upstreamAttributionSchema).optional(),
});

const searchResultSchema = openObject({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  published_at: z.string().optional(),
  site_name: z.string().optional(),
  rrf_score: z.number().optional(),
  evidence_groups: z.array(z.string()),
  provenance: z.array(resultProvenanceSchema),
});

const mergeSummarySchema = openObject({
  input_rows: safeNonnegativeInt,
  canonical_dedup: safeNonnegativeInt,
  independent_evidence_groups: safeNonnegativeInt,
  result_count: safeNonnegativeInt,
});

const searchSelectionSchema = openObject({
  source: z.enum(['default', 'lane', 'lanes', 'preset']),
  lanes: z.array(z.string()),
  requested: z.union([z.string(), z.array(z.string())]).optional(),
});

const searchResultsOutputSchema = openObject({
  channel: z.literal('results'),
  schema_id: z.literal('nb-search.results@1'),
  status: logicalStatusSchema,
  lanes: z.array(z.string()),
  results: z.array(searchResultSchema),
  lane_outcomes: z.array(laneOutcomeSchema),
  merge_summary: mergeSummarySchema,
  hints: z.array(hintSchema),
});

const searchTypedOutputSchema = openObject({
  channel: z.literal('typed'),
  lane: z.string(),
  schema_id: z.string().min(1),
  status: logicalStatusSchema,
  data: jsonValueSchema.optional(),
  lane_outcomes: z.array(laneOutcomeSchema),
  hints: z.array(hintSchema),
});

export const searchLogicalOutputSchema = z.union([searchResultsOutputSchema, searchTypedOutputSchema]);

const jobReceiptSchema = openObject({
  job_id: uuidSchema,
  state: jobStateSchema,
  created_at: isoTimestampSchema,
});

const artifactRefSchema = openObject({
  media_type: z.literal('application/json'),
  byte_length: safeNonnegativeInt,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: isoTimestampSchema,
});

const canonicalBase64Schema = z.string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'data_base64 must be canonical base64');

const artifactChunkSchema = openObject({
  index: safeNonnegativeInt,
  offset: safeNonnegativeInt,
  byte_length: safeNonnegativeInt,
  data_base64: canonicalBase64Schema,
}).superRefine((value, context) => {
  if (Buffer.from(value.data_base64, 'base64').byteLength !== value.byte_length) {
    context.addIssue({ code: 'custom', path: ['data_base64'], message: 'data_base64 length must match byte_length' });
  }
});

const fetchStageRoleSchema = z.enum(['acquire', 'extract', 'convert', 'reader']);
const fetchInputKindSchema = z.enum(['url', 'inline_text', 'inline_bytes', 'file']);
const fetchRepresentationSchema = z.enum(['markdown', 'text']);
const fetchPipelineDescriptorSchema = openObject({
  operation_id: z.string(),
  schema_id: z.literal('nb-search.fetch@1'),
  input_kinds: z.array(fetchInputKindSchema),
  media_types: z.array(z.string()),
  representations: z.array(fetchRepresentationSchema),
  execution_modes: z.array(queryExecutionSchema),
  egress: z.enum(['none', 'url', 'content']),
  stages: z.array(openObject({ id: z.string(), role: fetchStageRoleSchema })),
});

const queryOperationOutputSchema = z.union([
  openObject({ channel: z.literal('results'), schema_id: z.literal('nb-search.results@1') }),
  openObject({ channel: z.literal('typed'), schema_id: z.string().min(1) }),
]);
const queryOperationDescriptorSchema = openObject({
  operation_id: z.string(),
  output: queryOperationOutputSchema,
  built_in_async: z.boolean(),
});

const capabilityIssueSchema = openObject({
  code: z.string(),
  execution: queryExecutionSchema.optional(),
});
const laneLatencySchema = z.enum(['fast', 'medium', 'slow']);
const laneCostSchema = z.enum(['free', 'cheap', 'expensive']);

const capabilityProviderDescriptorSchema = openObject({
  provider_id: z.string(),
  adapter_version: z.string(),
  query_operations: z.array(queryOperationDescriptorSchema),
  fetch_operations: z.array(fetchPipelineDescriptorSchema),
  activation: openObject({
    credential: z.enum(['required', 'none']),
    endpoint: z.enum(['required', 'optional', 'none']),
  }),
  option_keys: z.array(z.string()),
});

const capabilityProviderInstanceSchema = openObject({
  id: z.string(),
  provider_id: z.string(),
  enabled: z.boolean(),
  availability: z.enum(['ready', 'unavailable']),
  issues: z.array(capabilityIssueSchema),
  credential: openObject({
    requirement: z.enum(['required', 'none', 'unknown']),
    configured: z.boolean(),
    slot_id: z.string().optional(),
  }),
  endpoint: openObject({
    requirement: z.enum(['required', 'optional', 'none', 'unknown']),
    configured: z.boolean(),
  }),
});

const capabilitySearchLaneSchema = openObject({
  id: z.string(),
  output: queryOperationOutputSchema,
  execution_modes: z.array(queryExecutionSchema),
  availability: z.enum(['ready', 'unavailable']),
  issues: z.array(capabilityIssueSchema),
  latency: laneLatencySchema,
  cost: laneCostSchema,
});
const capabilitySearchPresetSchema = openObject({
  name: z.string(),
  lanes: z.array(z.string()),
  execution_modes: z.array(queryExecutionSchema),
  availability: z.enum(['ready', 'unavailable']),
  issues: z.array(capabilityIssueSchema),
});
const capabilitySearchSchema = openObject({
  default_lane: z.string().optional(),
  lanes: z.array(capabilitySearchLaneSchema),
  presets: z.array(capabilitySearchPresetSchema),
  limits: openObject({
    max_queries: safeNonnegativeInt,
    max_results: safeNonnegativeInt,
    max_timeout_ms: safeNonnegativeInt,
    max_inline_bytes: safeNonnegativeInt,
  }),
});

const capabilityFetchInputSchema = openObject({
  kind: fetchInputKindSchema,
  enabled: z.boolean(),
  max_bytes: safeNonnegativeInt,
  media_types: z.array(z.string()).optional(),
  scope_ids: z.array(z.string()).optional(),
});
const capabilityFetchChainSchema = openObject({
  input_kind: fetchInputKindSchema,
  representation: fetchRepresentationSchema,
  pipelines: z.array(z.string()),
});
const capabilityFetchPipelineSchema = openObject({
  id: z.string(),
  input_kinds: z.array(fetchInputKindSchema),
  media_types: z.array(z.string()),
  representations: z.array(fetchRepresentationSchema),
  execution_modes: z.array(queryExecutionSchema),
  egress: z.enum(['none', 'url', 'content']),
  stages: z.array(openObject({ id: z.string(), role: fetchStageRoleSchema })),
  availability: z.enum(['ready', 'unavailable']),
  issues: z.array(capabilityIssueSchema),
  latency: laneLatencySchema,
  cost: laneCostSchema,
});
const capabilityFetchSchema = openObject({
  default_representation: z.literal('markdown'),
  inputs: z.array(capabilityFetchInputSchema),
  chains: z.array(capabilityFetchChainSchema),
  pipelines: z.array(capabilityFetchPipelineSchema),
  limits: openObject({
    max_source_bytes: safeNonnegativeInt,
    max_response_bytes: safeNonnegativeInt,
    max_content_chars: safeNonnegativeInt,
    max_redirects: safeNonnegativeInt,
    max_timeout_ms: safeNonnegativeInt,
    max_inline_bytes: safeNonnegativeInt,
  }),
});

export const capabilityEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  revision: z.string(),
  providers: openObject({
    descriptors: z.array(capabilityProviderDescriptorSchema),
    instances: z.array(capabilityProviderInstanceSchema),
  }),
  search: capabilitySearchSchema,
  fetch: capabilityFetchSchema,
  jobs: openObject({
    result_ttl_seconds: safeNonnegativeInt,
    cancel_supported: z.literal(true),
  }),
});

const fetchDocumentSchema = openObject({
  url: z.string().optional(),
  final_url: z.string().optional(),
  title: z.string().optional(),
  content: z.string(),
  content_type: z.string(),
  media_type: z.string(),
  representation: fetchRepresentationSchema,
  format: z.literal('text'),
  byte_length: safeNonnegativeInt,
  truncated: z.boolean(),
  warnings: z.array(hintSchema),
  source_lane: z.string(),
});

const fetchSelectionSchema = openObject({
  source: z.enum(['default', 'pipeline']),
  pipeline: z.string().optional(),
}).superRefine((value, context) => {
  if (value.source === 'pipeline' && value.pipeline === undefined) {
    context.addIssue({ code: 'custom', path: ['pipeline'], message: 'pipeline selection requires pipeline' });
  }
  if (value.source === 'default' && value.pipeline !== undefined) {
    context.addIssue({ code: 'custom', path: ['pipeline'], message: 'default selection cannot include pipeline' });
  }
});

const searchRunSyncEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  action: z.literal('run'),
  execution: z.literal('sync'),
  selection: searchSelectionSchema.optional(),
  status: logicalStatusSchema,
  output: searchLogicalOutputSchema.optional(),
  error: publicErrorSchema.optional(),
  hints: z.array(hintSchema),
}).superRefine((value, context) => {
  if (value.status === 'succeeded' && value.output === undefined) {
    context.addIssue({ code: 'custom', path: ['output'], message: 'succeeded search runs require output' });
  }
  if (value.output !== undefined && value.output.status !== value.status) {
    context.addIssue({ code: 'custom', path: ['output', 'status'], message: 'output status must match envelope status' });
  }
});

const searchRunAsyncEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  action: z.literal('run'),
  execution: z.literal('async'),
  selection: searchSelectionSchema.optional(),
  status: z.enum(['queued', 'failed']),
  channel: outputChannelSchema.optional(),
  schema_id: z.string().min(1).optional(),
  job: jobReceiptSchema.optional(),
  reused: z.boolean().optional(),
  poll_after_ms: safeNonnegativeInt.optional(),
  error: publicErrorSchema.optional(),
  hints: z.array(hintSchema),
}).superRefine((value, context) => {
  if (value.status === 'queued' && value.job === undefined) {
    context.addIssue({ code: 'custom', path: ['job'], message: 'queued async runs require job' });
  }
  if (value.status === 'failed' && value.error === undefined) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed async runs require error' });
  }
  if (value.status === 'failed' && value.reused === true && (value.job === undefined || value.job.state !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['job'], message: 'reused failed async runs require a failed job receipt' });
  }
  if (value.channel === 'results' && value.schema_id !== 'nb-search.results@1') {
    context.addIssue({ code: 'custom', path: ['schema_id'], message: 'results channel requires nb-search.results@1' });
  }
  if (value.channel === 'typed' && value.schema_id === undefined) {
    context.addIssue({ code: 'custom', path: ['schema_id'], message: 'typed channel requires schema_id' });
  }
});

const searchGetEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  action: z.literal('get'),
  job_id: uuidSchema,
  state: jobStateSchema,
  cancel_requested: z.boolean(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  started_at: isoTimestampSchema.optional(),
  completed_at: isoTimestampSchema.optional(),
  artifact: artifactRefSchema.optional(),
  error: publicErrorSchema.optional(),
  poll_after_ms: safeNonnegativeInt.optional(),
});

const searchReadEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  action: z.literal('read'),
  job_id: uuidSchema,
  state: jobStateSchema,
  artifact: artifactRefSchema.optional(),
  chunks: z.array(artifactChunkSchema),
  next_cursor: z.string().min(1).optional(),
});

const searchCancelEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  action: z.literal('cancel'),
  job_id: uuidSchema,
  state: jobStateSchema,
  cancel_requested: z.boolean(),
});

export const searchEnvelopeSchema = z.union([
  searchRunSyncEnvelopeSchema,
  searchRunAsyncEnvelopeSchema,
  searchGetEnvelopeSchema,
  searchReadEnvelopeSchema,
  searchCancelEnvelopeSchema,
]).superRefine((value, context) => {
  if ((value as Record<string, unknown>)['mode'] === 'fetch') {
    context.addIssue({ code: 'custom', path: ['mode'], message: 'search envelopes cannot carry fetch mode' });
  }
});

export const fetchRunSyncEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  mode: z.literal('fetch'),
  action: z.literal('run'),
  execution: z.literal('sync'),
  selection: fetchSelectionSchema,
  status: logicalStatusSchema,
  lane_outcomes: z.array(laneOutcomeSchema),
  documents: z.array(fetchDocumentSchema),
  hints: z.array(hintSchema),
  error: publicErrorSchema.optional(),
});

const fetchRunAsyncEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  mode: z.literal('fetch'),
  action: z.literal('run'),
  execution: z.literal('async'),
  selection: fetchSelectionSchema.optional(),
  status: z.enum(['queued', 'failed']),
  schema_id: z.literal('nb-search.fetch@1').optional(),
  job: jobReceiptSchema.optional(),
  reused: z.boolean().optional(),
  poll_after_ms: safeNonnegativeInt.optional(),
  error: publicErrorSchema.optional(),
  hints: z.array(hintSchema),
}).superRefine((value, context) => {
  if (value.status === 'queued' && value.job === undefined) {
    context.addIssue({ code: 'custom', path: ['job'], message: 'queued async runs require job' });
  }
  if (value.status === 'failed' && value.error === undefined) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed async runs require error' });
  }
  if (value.status === 'failed' && value.reused === true && (value.job === undefined || value.job.state !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['job'], message: 'reused failed async runs require a failed job receipt' });
  }
});

const fetchGetEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  mode: z.literal('fetch'),
  action: z.literal('get'),
  job_id: uuidSchema,
  state: jobStateSchema,
  cancel_requested: z.boolean(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  started_at: isoTimestampSchema.optional(),
  completed_at: isoTimestampSchema.optional(),
  artifact: artifactRefSchema.optional(),
  error: publicErrorSchema.optional(),
  poll_after_ms: safeNonnegativeInt.optional(),
});

const fetchReadEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  mode: z.literal('fetch'),
  action: z.literal('read'),
  job_id: uuidSchema,
  state: jobStateSchema,
  artifact: artifactRefSchema.optional(),
  chunks: z.array(artifactChunkSchema),
  next_cursor: z.string().min(1).optional(),
});

const fetchCancelEnvelopeSchema = openObject({
  schema_version: z.literal(SCHEMA_VERSION),
  mode: z.literal('fetch'),
  action: z.literal('cancel'),
  job_id: uuidSchema,
  state: jobStateSchema,
  cancel_requested: z.boolean(),
});


export const fetchEnvelopeSchema = z.union([
  fetchRunSyncEnvelopeSchema,
  fetchRunAsyncEnvelopeSchema,
  fetchGetEnvelopeSchema,
  fetchReadEnvelopeSchema,
  fetchCancelEnvelopeSchema,
]);

void providerResultSchema;
void upstreamAttemptSchema;
