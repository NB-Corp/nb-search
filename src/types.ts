export const SCHEMA_VERSION = '3.0' as const;
export const FRESHNESS_VALUES = ['pd', 'pw', 'pm', 'py'] as const;
export const FETCH_INPUT_KINDS = ['url', 'inline_text', 'inline_bytes', 'file'] as const;
export const FETCH_REPRESENTATIONS = ['markdown', 'text'] as const;
export const FETCH_EXECUTION_MODES = ['sync', 'async'] as const;
export type Freshness = typeof FRESHNESS_VALUES[number];
export type FetchInputKind = typeof FETCH_INPUT_KINDS[number];
export type FetchRepresentation = typeof FETCH_REPRESENTATIONS[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ProviderName = string;
export type ProviderId = string;
export type ProviderInstanceId = string;
export type CredentialSlotId = string;
export type QueryExecution = 'sync' | 'async';
export type OutputChannel = 'results' | 'typed';
export type LaneLatency = 'fast' | 'medium' | 'slow';
export type LaneCost = 'free' | 'cheap' | 'expensive';

export type PublicErrorCode =
  | 'INVALID_INPUT' | 'CONFIGURATION_ERROR' | 'LANE_NOT_REGISTERED' | 'LANE_NOT_CONFIGURED'
  | 'LANE_NOT_SELECTABLE' | 'LANE_EXECUTION_UNSUPPORTED' | 'MIXED_OUTPUT_UNSUPPORTED'
  | 'PRESET_NOT_FOUND' | 'PRESET_UNAVAILABLE' | 'DEFAULT_NOT_CONFIGURED' | 'FETCH_DEFAULT_NOT_CONFIGURED'
  | 'FETCH_CHAIN_UNAVAILABLE' | 'FETCH_PIPELINE_UNSUPPORTED' | 'FETCH_EGRESS_DENIED' | 'FETCH_SCOPE_NOT_FOUND' | 'FETCH_FILE_BLOCKED'
  | 'BUDGET_EXCEEDED' | 'OUTPUT_TOO_LARGE' | 'FETCH_BLOCKED' | 'FETCH_BYTES_LIMIT'
  | 'FETCH_CONTENT_TYPE_REJECTED' | 'FETCH_HTTP_ERROR' | 'QUALITY_GATE_FAILED'
  | 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED' | 'CANCELLED' | 'JOB_NOT_FOUND' | 'JOB_CONFLICT' | 'JOB_STORE_ERROR'
  | 'WORKER_START_FAILED' | 'WORKER_LOST' | 'INTERNAL';
export interface PublicError { code: PublicErrorCode; message: string; retryable: boolean; provider?: ProviderName; retry_after_ms?: number; data?: Readonly<Record<string, unknown>> }
export interface Hint { code: string; message: string; data?: Readonly<Record<string, unknown>> }

export type FetchSource =
  | { kind: 'url'; url: string }
  | { kind: 'inline_text'; content: string; media_type: 'text/html' | 'text/plain' | 'text/markdown'; base_url?: string }
  | { kind: 'inline_bytes'; content_base64: string; media_type: string; filename?: string }
  | { kind: 'file'; path: string; scope: string };
export type FetchStageRole = 'acquire' | 'extract' | 'convert' | 'reader';
export interface FetchPipelineDescriptor {
  operation_id: string;
  schema_id: 'nb-search.fetch@1';
  input_kinds: readonly FetchInputKind[];
  media_types: readonly string[];
  representations: readonly FetchRepresentation[];
  execution_modes: readonly QueryExecution[];
  egress: 'none' | 'url' | 'content';
  stages: readonly { id: string; role: FetchStageRole }[];
}
export type FetchOperationDescriptor = FetchPipelineDescriptor;
export type QueryOperationOutput = { channel: 'results'; schema_id: 'nb-search.results@1' } | { channel: 'typed'; schema_id: string };
export interface QueryOperationDescriptor { operation_id: string; output: QueryOperationOutput; built_in_async: boolean }
export interface QueryExecutionRequest { query: string; limit: number; freshness?: Freshness; request_time_utc: string; signal: AbortSignal }
export interface QueryResultsValue { results: readonly ProviderResult[]; hints?: readonly Hint[]; upstream_attempts?: readonly UpstreamAttempt[]; upstream_attempts_omitted?: number }
export type QueryProviderValue = { channel: 'results'; value: QueryResultsValue } | { channel: 'typed'; data: JsonValue };
export interface QueryProvider { readonly name: ProviderName; readonly redactions?: readonly string[]; execute(request: QueryExecutionRequest): Promise<QueryProviderValue> }

export interface FetchWarning extends Hint {}
export interface FetchProviderRequest { source: FetchSource; representation: FetchRepresentation; signal: AbortSignal; max_source_bytes: number; max_response_bytes: number; max_content_chars: number; max_redirects: number; file_scopes: readonly FetchFileScope[] }
export interface FetchProviderResult { url?: string; final_url?: string; title?: string; content: string; content_type: string; media_type: string; representation: FetchRepresentation; format: 'text'; byte_length: number; truncated: boolean; warnings: FetchWarning[] }
export interface FetchProvider { readonly name: ProviderName; readonly redactions?: readonly string[]; fetch(request: FetchProviderRequest): Promise<FetchProviderResult> }
export interface FetchDocument extends FetchProviderResult { source_lane: string }
export interface FetchFileScope { id: string; root: string; media_types?: readonly string[] }

export interface ProviderResult {
  title: string; url: string; snippet?: string; published_at?: string; site_name?: string; score?: number;
  metadata?: Readonly<Record<string, unknown>>; upstream_attribution?: readonly UpstreamResultAttribution[]; upstream_attribution_omitted?: number;
}
export interface UpstreamResultAttribution { provider: ProviderName }
export type UpstreamAttemptState = 'succeeded' | 'empty' | 'skipped' | 'failed' | 'timed_out' | 'cancelled' | 'unknown';
export interface UpstreamError { code?: string; message?: string; retryable?: boolean }
export interface UpstreamAttempt { provider: ProviderName; state: UpstreamAttemptState; duration_ms: number; result_count: number; attempt?: number; capability?: string; role?: string; trigger?: string; error?: UpstreamError }
export interface ProviderSearchResponse { results: readonly ProviderResult[]; hints?: readonly Hint[]; upstream_attempts?: readonly UpstreamAttempt[]; upstream_attempts_omitted?: number }
export type ProviderSearchReturn = readonly ProviderResult[] | ProviderSearchResponse;
export interface ProviderSearchRequest { query: string; limit: number; signal: AbortSignal; freshness?: Freshness; request_time_utc?: string }
export interface SearchProvider { readonly name: ProviderName; readonly redactions?: readonly string[]; search(request: ProviderSearchRequest): Promise<ProviderSearchReturn> }

export interface SupportingUrl { url: string; title?: string; source: 'provider-result' | 'provider-grounding' }
export interface ProviderAnswerCapabilityRequest { capability: 'answer'; query: string; limit: number; freshness?: Freshness; request_time_utc: string; signal: AbortSignal }
export interface ProviderAnswerCapabilityResult { capability: 'answer'; text?: string; supporting_results: readonly ProviderResult[] }
export interface AnswerProvider { readonly name: ProviderName; readonly redactions?: readonly string[]; answer(request: ProviderAnswerCapabilityRequest): Promise<ProviderAnswerCapabilityResult> }
export interface ProviderResearchLightCapabilityRequest { capability: 'research-light'; query: string; retrieval_result_count: number; freshness?: Freshness; request_time_utc: string; signal: AbortSignal }
export interface ProviderResearchLightCapabilityResult { capability: 'research-light'; synthesis?: string; supporting_urls: readonly SupportingUrl[]; resolved_type: string }
export interface ResearchLightProvider { readonly name: ProviderName; readonly redactions?: readonly string[]; researchLight(request: ProviderResearchLightCapabilityRequest): Promise<ProviderResearchLightCapabilityResult> }
export type GmaEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type GmaConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type GmaEvidenceStrength = 'direct' | 'indirect' | 'background' | 'unknown';
export interface GmaResultMetadata extends Readonly<Record<string, unknown>> { source_type: 'web' | 'x'; supports_claim_ids: readonly string[] }
export interface GmaResult extends ProviderResult { metadata: GmaResultMetadata }
export interface GmaClaim { id: string; text: string; confidence: GmaConfidence; evidence_strength: GmaEvidenceStrength; evidence_urls: readonly string[] }
export interface GmaConflict { topic: string; description: string; evidence_urls: readonly string[] }
export interface GmaOmissions { results: number; angles: number; claims: number; conflicts: number; follow_up_queries: number; evidence_urls: number; sensitive_semantic_items: number }
export interface GmaTrace { angles: readonly string[]; claims: readonly GmaClaim[]; conflicts: readonly GmaConflict[]; follow_up_queries: readonly string[]; source_mix: { web: number; x: number }; linked_evidence_count: number; omissions: GmaOmissions }
export interface ProviderMultiAgentResearchCapabilityRequest { capability: 'multi-agent-research'; query: string; brief: string; limit: number; request_time_utc: string; signal: AbortSignal }
export interface ProviderMultiAgentResearchCapabilityResult { capability: 'multi-agent-research'; completeness: 'complete' | 'partial' | 'empty'; answer?: string; results: readonly GmaResult[]; trace: GmaTrace; model: string; reasoning_effort: GmaEffort; api_mode: 'chat_completions'; expected_agent_count: 4 | 16; backend_trace_observable: false; evidence_linkage: 'model_declared_url_matched'; semantic_verification: false }
export interface MultiAgentResearchProvider { readonly name: 'grok-multi-agent'; readonly redactions?: readonly string[]; research(request: ProviderMultiAgentResearchCapabilityRequest): Promise<ProviderMultiAgentResearchCapabilityResult> }

export type LaneAttemptState = 'succeeded' | 'empty' | 'failed' | 'timeout' | 'cancelled';
export type LaneOutcomeState = LaneAttemptState | 'skipped';
export interface LaneAttempt { lane: string; provider_instance_id: string; attempt: number; state: LaneAttemptState; duration_ms: number; error?: PublicError }
export interface LaneOutcome { lane: string; ok: boolean; state: LaneOutcomeState; duration_ms: number; result_count: number; warnings: Hint[]; error?: PublicError }
export interface SearchSelection { source: 'default' | 'lane' | 'lanes' | 'preset'; lanes: string[]; requested?: string | string[] }
export interface ResultProvenance { lane: string; provider_instance_id: string; query_index: number; rank: number; original_url: string; evidence_groups: string[]; upstream?: readonly UpstreamResultAttribution[] }
export interface SearchResult { title: string; url: string; snippet: string; published_at?: string; site_name?: string; rrf_score?: number; evidence_groups: string[]; provenance: ResultProvenance[] }
export type LogicalStatus = 'succeeded' | 'empty' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
export interface SearchResultsOutput { channel: 'results'; schema_id: 'nb-search.results@1'; status: LogicalStatus; lanes: string[]; results: SearchResult[]; lane_outcomes: LaneOutcome[]; merge_summary: { input_rows: number; canonical_dedup: number; independent_evidence_groups: number; result_count: number }; hints: Hint[] }
export interface SearchTypedOutput { channel: 'typed'; lane: string; schema_id: string; status: LogicalStatus; data?: JsonValue; lane_outcomes: LaneOutcome[]; hints: Hint[] }
export type SearchLogicalOutput = SearchResultsOutput | SearchTypedOutput;
export interface SearchRunSyncEnvelope { schema_version: typeof SCHEMA_VERSION; action: 'run'; execution: 'sync'; selection?: SearchSelection; status: LogicalStatus; output?: SearchLogicalOutput; error?: PublicError; hints: Hint[] }

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobKind = 'search' | 'fetch';
export interface ArtifactRef { media_type: 'application/json'; byte_length: number; sha256: string; expires_at: string }
export interface JobReceipt { job_id: string; state: JobState; created_at: string }
export interface SearchRunAsyncEnvelope { schema_version: typeof SCHEMA_VERSION; action: 'run'; execution: 'async'; selection?: SearchSelection; status: 'queued' | 'failed'; channel?: OutputChannel; schema_id?: string; job?: JobReceipt; reused?: boolean; poll_after_ms?: number; error?: PublicError; hints: Hint[] }
export interface SearchGetEnvelope { schema_version: typeof SCHEMA_VERSION; action: 'get'; job_id: string; state: JobState; cancel_requested: boolean; created_at: string; updated_at: string; started_at?: string; completed_at?: string; artifact?: ArtifactRef; error?: PublicError; poll_after_ms?: number }
export interface ArtifactChunk { index: number; offset: number; byte_length: number; data_base64: string }
export interface SearchReadEnvelope { schema_version: typeof SCHEMA_VERSION; action: 'read'; job_id: string; state: JobState; artifact?: ArtifactRef; chunks: ArtifactChunk[]; next_cursor?: string }
export interface SearchCancelEnvelope { schema_version: typeof SCHEMA_VERSION; action: 'cancel'; job_id: string; state: JobState; cancel_requested: boolean }
export type SearchEnvelope = SearchRunSyncEnvelope | SearchRunAsyncEnvelope | SearchGetEnvelope | SearchReadEnvelope | SearchCancelEnvelope;

export interface FetchRunSyncEnvelope { schema_version: typeof SCHEMA_VERSION; mode: 'fetch'; action: 'run'; execution: 'sync'; selection: { source: 'default' | 'pipeline'; pipeline?: string }; status: LogicalStatus; lane_outcomes: LaneOutcome[]; documents: FetchDocument[]; hints: Hint[]; error?: PublicError }
export interface FetchRunAsyncEnvelope { schema_version: typeof SCHEMA_VERSION; mode: 'fetch'; action: 'run'; execution: 'async'; selection?: { source: 'default' | 'pipeline'; pipeline?: string }; status: 'queued' | 'failed'; schema_id?: 'nb-search.fetch@1'; job?: JobReceipt; reused?: boolean; poll_after_ms?: number; error?: PublicError; hints: Hint[] }
export interface FetchGetEnvelope extends SearchGetEnvelope { mode: 'fetch' }
export interface FetchReadEnvelope extends SearchReadEnvelope { mode: 'fetch' }
export interface FetchCancelEnvelope extends SearchCancelEnvelope { mode: 'fetch' }
export type FetchEnvelope = FetchRunSyncEnvelope | FetchRunAsyncEnvelope | FetchGetEnvelope | FetchReadEnvelope | FetchCancelEnvelope;
export interface CapabilityIssue { code: string; execution?: QueryExecution }
export interface CapabilityEnvelope {
  schema_version: typeof SCHEMA_VERSION; revision: string;
  search: { default_lane?: string; lanes: Array<{ id: string; output: QueryOperationOutput; execution_modes: QueryExecution[]; availability: 'ready' | 'unavailable'; issues: CapabilityIssue[]; latency: LaneLatency; cost: LaneCost }>; presets: Array<{ name: string; lanes: string[]; execution_modes: QueryExecution[]; availability: 'ready' | 'unavailable'; issues: CapabilityIssue[] }>; limits: { max_queries: number; max_results: number; max_timeout_ms: number; max_inline_bytes: number } };
  fetch: {
    default_representation: 'markdown';
    inputs: Array<{ kind: FetchInputKind; enabled: boolean; max_bytes: number; media_types?: string[]; scope_ids?: string[] }>;
    chains: Array<{ input_kind: FetchInputKind; representation: FetchRepresentation; pipelines: string[] }>;
    pipelines: Array<{ id: string; input_kinds: FetchInputKind[]; media_types: string[]; representations: FetchRepresentation[]; execution_modes: QueryExecution[]; egress: 'none' | 'url' | 'content'; stages: Array<{ id: string; role: FetchStageRole }>; availability: 'ready' | 'unavailable'; issues: CapabilityIssue[]; latency: LaneLatency; cost: LaneCost }>;
    limits: { max_source_bytes: number; max_response_bytes: number; max_content_chars: number; max_redirects: number; max_timeout_ms: number; max_inline_bytes: number };
  };
  jobs: { result_ttl_seconds: number; cancel_supported: true };
}
export interface ErrorEnvelope { error: PublicError }
