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

export type ProviderName = 'exa' | 'tavily' | (string & {});
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
}
export interface ProviderResult {
  title: string; url: string; snippet?: string; published_at?: string; site_name?: string; score?: number;
  metadata?: Readonly<Record<string, unknown>>;
}
export interface SearchProvider {
  readonly name: ProviderName; readonly redactions?: readonly string[];
  readonly provider_id?: ProviderId;
  readonly provider_instance_id?: ProviderInstanceId;
  readonly credential_slot_id?: CredentialSlotId;
  search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]>;
}
export type AttemptState = 'succeeded' | 'empty' | 'failed' | 'timed_out' | 'cancelled';
export interface SearchAttempt {
  provider: ProviderName; attempt: number; state: AttemptState; duration_ms: number; result_count: number; error?: PublicError;
  provider_instance_id?: ProviderInstanceId; credential_slot_id?: CredentialSlotId; invocation_id?: InvocationId;
  capability?: ProviderCapability; role?: string; trigger?: string;
}
export interface ResultProvenance {
  provider: ProviderName; rank: number; original_url: string; metadata?: Readonly<Record<string, unknown>>;
  provider_instance_id?: ProviderInstanceId; credential_slot_id?: CredentialSlotId; invocation_id?: InvocationId;
  capability?: ProviderCapability; role?: string; trigger?: string;
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
  timing: { started_at: string; completed_at: string; duration_ms: number; budget_ms: number };
  compaction: { applied: boolean; snippets_shortened: number; results_omitted: number; max_bytes: number };
}
export interface Searcher { search(request: SearchRequest): Promise<SearchEnvelope> }

export type JobState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
export type TerminalJobState = Extract<JobState, 'succeeded' | 'partial' | 'failed' | 'timed_out' | 'cancelled'>;
export type ResearchArtifact = 'summary' | 'report' | 'sources';
export type ArtifactState = 'unavailable' | 'checkpoint' | 'final';
export interface ResearchRequest {
  query: string; max_sources: number; max_duration_ms: number;
  profile?: ProfileId; intent?: SearchIntent; freshness?: Freshness;
}
export interface JobProgress { completed_units: number; total_units?: number }
export interface JobArtifacts { summary: ArtifactState; report: ArtifactState; sources: ArtifactState }
export interface JobRecord {
  schema_version: typeof SCHEMA_VERSION; job_id: string; state: JobState; phase: string; request: ResearchRequest;
  request_hash: string; idempotency_hash?: string; created_at: string; updated_at: string; started_at?: string;
  completed_at?: string; progress: JobProgress; artifacts: JobArtifacts; cancel_requested_at?: string;
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
}
export interface ResearchReadEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_read'; job_id: string; job_state: JobState;
  artifact: ResearchArtifact; artifact_state: ArtifactState; items: unknown[]; next_cursor?: string;
  compaction: { applied: boolean; items_truncated: number; bytes_omitted: number; max_bytes: number };
}
export interface ResearchListItem { job_id: string; state: JobState; created_at: string; updated_at: string; artifacts: JobArtifacts }
export interface ResearchListEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_list'; items: ResearchListItem[]; next_cursor?: string;
}
export interface ResearchCancelEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'research_cancel'; job_id: string; state: JobState; accepted: boolean;
}

export interface CapabilityEnvelope {
  schema_version: typeof SCHEMA_VERSION; request_id: string; mode: 'capabilities'; version: '0.1.0';
  search: { max_results: 20; max_timeout_ms: 45000 };
  research: { max_sources: 100; max_duration_ms: 3600000; detached_worker: true; guaranteed_process_survival: false };
  providers: {
    exa: { configured: boolean }; tavily: { configured: boolean };
    instances?: Array<{
      provider_id: ProviderId; provider_instance_id: ProviderInstanceId; credential_slot_id?: CredentialSlotId;
      enabled: boolean; ready: boolean; capabilities: readonly ProviderCapability[];
    }>;
  };
  profiles?: Array<{ profile_id: ProfileId; ready: boolean; stage_count: number }>;
  persistence: { durable_jobs: true; cancellation_markers: true; retention_hours: number; stale_after_ms: 30000 };
  transport: { mcp: 'stdio'; cli_direct_service: true };
  diagnostics: {
    network_probe_performed: false;
    configuration?: Array<{ code: string; source: string; path?: string; message: string }>;
  };
}

export interface ErrorEnvelope { error: PublicError }
