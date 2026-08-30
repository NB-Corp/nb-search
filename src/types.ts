export const SCHEMA_VERSION = '1.0' as const;
export const SEARCH_TEXT_MAX_BYTES = 32 * 1024;
export const MANAGEMENT_TEXT_MAX_BYTES = 16 * 1024;
export const RESEARCH_PAGE_MAX_BYTES = 24 * 1024;
export const SEARCH_PROFILE_IDS = ['default', 'fast', 'deep'] as const;
export const SEARCH_INTENTS = ['factual', 'status', 'comparison', 'tutorial', 'exploratory', 'news', 'resource'] as const;
export const FRESHNESS_VALUES = ['pd', 'pw', 'pm', 'py'] as const;

export type SearchProfileId = typeof SEARCH_PROFILE_IDS[number];
export type SearchIntent = typeof SEARCH_INTENTS[number];
export type Freshness = typeof FRESHNESS_VALUES[number];

export type ProviderName = 'exa' | 'tavily' | 'grok' | (string & {});
export type ProviderId = ProviderName;
export type ProviderInstanceId = string;
export type CredentialSlotId = string;
export type InvocationId = string;
export type ProfileId = string;
export type ProviderCapability = 'retrieval' | 'answer' | 'research-light' | 'multi-agent-research';
export type PublicErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIGURATION_ERROR'
  | 'CAPABILITY_UNAVAILABLE'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'JOB_NOT_FOUND'
  | 'JOB_CONFLICT'
  | 'JOB_STORE_ERROR'
  | 'WORKER_START_FAILED'
  | 'WORKER_LOST'
  | 'INTERNAL';

export interface PublicError {
  code: PublicErrorCode; message: string; retryable: boolean; provider?: ProviderName; retry_after_ms?: number;
}
export interface ProviderSearchRequest {
  query: string; limit: number; signal: AbortSignal;
  profile?: ProfileId; intent?: SearchIntent; freshness?: Freshness;
  request_time_utc?: string;
}
export interface ProviderCapabilityRequestBase {
  query: string; profile: ProfileId; intent?: SearchIntent; freshness?: Freshness;
  request_time_utc: string; signal: AbortSignal;
}
export interface ProviderRetrievalCapabilityRequest extends ProviderCapabilityRequestBase {
  capability: 'retrieval'; limit: number;
}
export interface ProviderAnswerCapabilityRequest extends ProviderCapabilityRequestBase {
  capability: 'answer'; limit: number;
}
export interface ProviderResearchLightCapabilityRequest extends ProviderCapabilityRequestBase {
  capability: 'research-light'; retrieval_result_count: number;
}
export type ProviderCapabilityRequest = ProviderRetrievalCapabilityRequest | ProviderAnswerCapabilityRequest | ProviderResearchLightCapabilityRequest;
export interface ProviderResult {
  title: string; url: string; snippet?: string; published_at?: string; site_name?: string; score?: number;
  metadata?: Readonly<Record<string, unknown>>;
  upstream_attribution?: readonly UpstreamResultAttribution[];
  upstream_attribution_omitted?: number;
}
export type UpstreamAttemptState = 'succeeded' | 'empty' | 'skipped' | 'failed' | 'timed_out' | 'cancelled' | 'unknown';
export interface UpstreamError { code?: string; message?: string; retryable?: boolean }
export interface UpstreamAttempt {
  provider: ProviderName; state: UpstreamAttemptState; duration_ms: number; result_count: number;
  attempt?: number; capability?: ProviderCapability; role?: string; trigger?: string; error?: UpstreamError;
}
export interface UpstreamResultAttribution { provider: ProviderName }
export interface ProviderSearchResponse {
  results: readonly ProviderResult[];
  upstream_attempts?: readonly UpstreamAttempt[];
  upstream_attempts_omitted?: number;
}
export interface SupportingUrl { url: string; title?: string; source: 'provider-result' | 'provider-grounding' }
export interface ProviderRetrievalCapabilityResult {
  capability: 'retrieval'; results: readonly ProviderResult[];
  upstream_attempts?: readonly UpstreamAttempt[]; upstream_attempts_omitted?: number;
}
export interface ProviderAnswerCapabilityResult {
  capability: 'answer'; text?: string; supporting_results: readonly ProviderResult[];
}
export interface ProviderResearchLightCapabilityResult {
  capability: 'research-light'; synthesis?: string; supporting_urls: readonly SupportingUrl[]; resolved_type: string;
}
export type ProviderCapabilityResult = ProviderRetrievalCapabilityResult | ProviderAnswerCapabilityResult | ProviderResearchLightCapabilityResult;
export type ProviderSearchReturn = readonly ProviderResult[] | ProviderSearchResponse;
export interface SearchProvider {
  readonly name: ProviderName; readonly redactions?: readonly string[];
  readonly provider_id?: ProviderId;
  readonly provider_instance_id?: ProviderInstanceId;
  readonly credential_slot_id?: CredentialSlotId;
  search(request: ProviderSearchRequest): Promise<ProviderSearchReturn>;
}
export interface AnswerProvider {
  readonly name: ProviderName; readonly redactions?: readonly string[];
  readonly provider_id?: ProviderId; readonly provider_instance_id?: ProviderInstanceId; readonly credential_slot_id?: CredentialSlotId;
  answer(request: ProviderAnswerCapabilityRequest): Promise<ProviderAnswerCapabilityResult>;
}
export interface ResearchLightProvider {
  readonly name: ProviderName; readonly redactions?: readonly string[];
  readonly provider_id?: ProviderId; readonly provider_instance_id?: ProviderInstanceId; readonly credential_slot_id?: CredentialSlotId;
  researchLight(request: ProviderResearchLightCapabilityRequest): Promise<ProviderResearchLightCapabilityResult>;
}
export type AttemptState = 'succeeded' | 'empty' | 'failed' | 'timed_out' | 'cancelled';
export interface SearchAttempt {
  provider: ProviderName; attempt: number; state: AttemptState; duration_ms: number; result_count: number; error?: PublicError;
  provider_instance_id?: ProviderInstanceId; credential_slot_id?: CredentialSlotId; invocation_id?: InvocationId;
  capability?: ProviderCapability; role?: string; trigger?: string;
  failure_policy?: 'affects-state' | 'report-only'; execution_scope?: 'per-operation' | 'once-per-job';
  upstream_attempts?: readonly UpstreamAttempt[]; upstream_attempts_omitted?: number;
}
export type CapabilityOutcomeState = 'succeeded' | 'empty' | 'unavailable' | 'failed' | 'timed_out' | 'cancelled';
export interface CitationStatus { claim_linked_citations: false; evidence_map_available: false; semantic_verification: false }
export interface PublicAnswerResult {
  capability: 'answer'; text: string; supporting_urls: SupportingUrl[]; supporting_urls_omitted: number; citation_status: CitationStatus;
}
export interface PublicResearchLightResult {
  capability: 'research-light'; synthesis: string; supporting_urls: SupportingUrl[]; supporting_urls_omitted: number;
  resolved_type: string; citation_status: CitationStatus;
}
export interface CapabilityArtifactRef<C extends ProviderCapability = ProviderCapability> {
  artifact_id: string; capability: C; artifact_kind: string; media_type: string; byte_length: number; sha256: string;
}
export type CapabilityDelivery<C extends ProviderCapability, T> =
  | { delivery: 'inline'; value: T }
  | { delivery: 'artifact'; artifact: CapabilityArtifactRef<C> };
interface CapabilityAugmentationBase {
  provider_id: ProviderId; provider_instance_id: ProviderInstanceId; credential_slot_id?: CredentialSlotId;
  invocation_id: InvocationId; failure_policy: 'affects-state' | 'report-only'; attempt_count: number;
}
type CapabilityTerminal<C extends 'answer' | 'research-light', T> =
  | (CapabilityAugmentationBase & { capability: C; state: 'succeeded'; result: CapabilityDelivery<C, T>; error?: never })
  | (CapabilityAugmentationBase & { capability: C; state: 'empty'; result?: never; error?: never })
  | (CapabilityAugmentationBase & { capability: C; state: 'unavailable' | 'failed' | 'timed_out' | 'cancelled'; result?: never; error: PublicError });
export type CapabilityAugmentation = CapabilityTerminal<'answer', PublicAnswerResult> | CapabilityTerminal<'research-light', PublicResearchLightResult>;
export interface ResultProvenance {
  provider: ProviderName; rank: number; original_url: string; metadata?: Readonly<Record<string, unknown>>;
  provider_instance_id?: ProviderInstanceId; credential_slot_id?: CredentialSlotId; invocation_id?: InvocationId;
  capability?: ProviderCapability; role?: string; trigger?: string;
  upstream?: readonly UpstreamResultAttribution[]; upstream_omitted?: number;
}
export interface SearchResult {
  title: string; url: string; snippet: string; published_at?: string; site_name?: string; score?: number;
  providers: ProviderName[]; provenance: ResultProvenance[];
}
export type SearchState = 'succeeded' | 'empty' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
export interface SearchRequest {
  query: string; max_results?: number; timeout_ms?: number; signal?: AbortSignal;
  profile?: ProfileId; intent?: SearchIntent; freshness?: Freshness;
}
export interface SearchEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'search'; state: SearchState; query: string;
  results: SearchResult[]; attempts: SearchAttempt[]; warnings: string[]; error?: PublicError;
  augmentations?: CapabilityAugmentation[];
  timing: { started_at: string; completed_at: string; duration_ms: number; budget_ms: number };
  compaction: { applied: boolean; snippets_shortened: number; results_omitted: number; max_bytes: number; attempts_omitted?: number; supporting_urls_omitted?: number };
}
export interface Searcher {
  search(request: SearchRequest, operationRequestId?: string, executionContext?: {
    scope: 'sync' | 'research-job'; completed_once_per_job_invocation_ids: ReadonlySet<InvocationId>;
    capture_augmentations?: (items: readonly CapabilityAugmentation[]) => void;
  }): Promise<SearchEnvelope>;
}

export type JobState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
export type TerminalJobState = Extract<JobState, 'succeeded' | 'partial' | 'failed' | 'timed_out' | 'cancelled'>;
export type ResearchArtifact = 'summary' | 'report' | 'sources' | 'capabilities';
export type ArtifactState = 'unavailable' | 'checkpoint' | 'final';
export interface ResearchRequest {
  query: string; max_sources: number; max_duration_ms: number;
  profile?: ProfileId; intent?: SearchIntent; freshness?: Freshness;
}
export interface JobProgress { completed_units: number; total_units?: number }
export interface JobArtifacts { summary: ArtifactState; report: ArtifactState; sources: ArtifactState; capabilities: ArtifactState }
export interface JobRecord {
  schema_version: typeof SCHEMA_VERSION; job_id: string; state: JobState; phase: string; request: ResearchRequest;
  request_hash: string; idempotency_hash?: string; created_at: string; updated_at: string; started_at?: string;
  completed_at?: string; progress: JobProgress; artifacts: JobArtifacts; cancel_requested_at?: string;
  artifact_revision: number;
  lease?: { owner_token: string; heartbeat_at: string }; error?: PublicError;
}
export interface JobReceipt { job_id: string; state: JobState; created_at: string }
export interface ResearchStartEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_start'; reused: boolean;
  job: JobReceipt; poll_after_ms: number;
}
export interface JobStatusEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_status'; job_id: string; state: JobState;
  phase: string; created_at: string; updated_at: string; started_at?: string; completed_at?: string;
  progress: JobProgress; artifacts: JobArtifacts; error?: PublicError; poll_after_ms?: number;
  artifact_revision: number;
}
export interface ResearchReadEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_read'; job_id: string; job_state: JobState;
  artifact: ResearchArtifact; artifact_state: ArtifactState; items: unknown[]; next_cursor?: string;
  artifact_revision: number;
  compaction: { applied: boolean; items_truncated: number; bytes_omitted: number; max_bytes: number };
}
export interface ResearchListItem { job_id: string; state: JobState; created_at: string; updated_at: string; artifacts: JobArtifacts; artifact_revision: number }
export interface ResearchListEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_list'; items: ResearchListItem[]; next_cursor?: string;
}
export interface ResearchCancelEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_cancel'; job_id: string; state: JobState; accepted: boolean;
}

export interface CapabilityEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'capabilities'; version: '0.1.0';
  search: { max_results: 20; default_timeout_ms: 20000; max_timeout_ms: 120000 };
  research: { max_sources: 100; max_duration_ms: 3600000; detached_worker: true; guaranteed_process_survival: false; artifacts: readonly ['summary', 'report', 'sources', 'capabilities']; capability_once_per_job: true };
  providers: {
    exa: { configured: boolean }; tavily: { configured: boolean }; grok: { configured: boolean };
    instances?: Array<{
      provider_id: ProviderId; provider_instance_id: ProviderInstanceId; credential_slot_id?: CredentialSlotId;
      enabled: boolean; ready: boolean; capabilities: readonly ProviderCapability[];
      ready_capabilities: readonly ProviderCapability[];
    }>;
  };
  capability_routes?: Array<{
    capability: 'answer' | 'research-light'; provider_instance_id: ProviderInstanceId; profile_ids: readonly SearchProfileId[];
    intent_in: readonly SearchIntent[]; failure_policy: 'affects-state' | 'report-only'; execution_scope: 'once-per-job'; ready: boolean;
  }>;
  profiles?: Array<{ profile_id: ProfileId; ready: boolean; stage_count: number }>;
  persistence: { durable_jobs: true; cancellation_markers: true; retention_hours: number; stale_after_ms: 30000 };
  transport: { mcp: 'stdio'; cli_direct_service: true };
  diagnostics: {
    network_probe_performed: false;
    configuration?: Array<{ code: string; source: string; path?: string; message: string }>;
  };
}

export interface ErrorEnvelope { error: PublicError }
