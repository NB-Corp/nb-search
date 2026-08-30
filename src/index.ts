import { createRuntimeComposition } from './app.ts';
import type { CanonicalConfigPatch } from './config-schema.ts';
import type { ProviderRegistration } from './provider-registry.ts';
import type { NbSearchRuntime } from './runtime.ts';

export {
  capabilitiesInputSchema,
  freshnessSchema,
  researchCancelInputSchema,
  researchListInputSchema,
  researchReadInputSchema,
  researchStartInputSchema,
  researchStatusInputSchema,
  searchInputSchema,
  searchIntentSchema,
  searchProfileSchema,
} from './contracts.ts';
export type {
  CapabilitiesInput,
  OperationContext,
  ResearchCancelInput,
  ResearchListInput,
  ResearchReadInput,
  ResearchStartInput,
  ResearchStatusInput,
  SearchInput,
} from './contracts.ts';
export type { NbSearchRuntime } from './runtime.ts';
export {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_PROFILE_ID,
  parseConfigPatch,
  parseResolvedConfig,
  stableFingerprint,
  stableJson,
} from './config-schema.ts';
export type {
  CanonicalConfig,
  CanonicalConfigPatch,
  CredentialSlotConfig,
  ProfileConfig,
  ProfileInvocationConfig,
  ProfileStageConfig,
  ProviderInstanceConfig,
  ProviderInstancePatch,
  RetryPolicyConfig,
} from './config-schema.ts';
export { defaultConfiguration, resolveConfiguration } from './config-sources.ts';
export type {
  ConfigurationDiagnostic,
  ConfigurationProvenance,
  ResolvedConfiguration,
  ResolveConfigurationOptions,
  SecretBinding,
  SecretBindings,
  WorkerGrant,
} from './config-sources.ts';
export {
  builtInProviderRegistrations,
  ProviderRegistry,
  REGISTRY_SCHEMA_VERSION,
} from './provider-registry.ts';
export type {
  ProviderDescriptor,
  ProviderCapabilityRequest,
  ProviderAnswerResult,
  AnswerProvider,
  ResearchLightProvider,
  MultiAgentResearchProvider,
  ProviderFactoryContext,
  ProviderPorts,
  ProviderRegistration,
} from './provider-registry.ts';
export {
  compileSearchPlan,
  InMemoryHealthStore,
  NoopHealthStore,
  PLAN_SCHEMA_VERSION,
  PlanExecutor,
} from './planner.ts';
export type {
  CompilePlanOptions,
  HealthCause,
  HealthEvent,
  HealthSnapshot,
  HealthStore,
  InvocationOutcome,
  PlanExecution,
  PlanInvocation,
  PlanStage,
  SearchPlan,
} from './planner.ts';
export {
  ARTIFACT_CONTRACT_VERSION,
  createExecutionSnapshot,
  EXECUTION_SNAPSHOT_VERSION,
  LEGACY_EXECUTION_SNAPSHOT_VERSION,
  M1_REGISTRY_FINGERPRINT,
  M1_REGISTRY_REVISION,
  resolveSnapshotBindings,
  validateExecutionSnapshot,
} from './execution-snapshot.ts';
export type {
  ExecutionSnapshot,
  SnapshotCredentialBinding,
  SnapshotProviderInstance,
} from './execution-snapshot.ts';
export type { HttpRequest, HttpResponse, HttpTransport, JsonRequest, JsonResponse, JsonTransport } from './transport.ts';
export { ResponseLimitError } from './transport.ts';
export type {
  ArtifactState,
  AttemptState,
  CapabilityEnvelope,
  ErrorEnvelope,
  JobArtifacts,
  JobProgress,
  JobReceipt,
  JobState,
  JobStatusEnvelope,
  ProviderName,
  ProviderId,
  ProviderInstanceId,
  CredentialSlotId,
  InvocationId,
  ProfileId,
  SearchProfileId,
  SearchIntent,
  Freshness,
  ProviderCapability,
  ProviderSearchResponse,
  ProviderSearchReturn,
  ProviderResult,
  PublicError,
  PublicErrorCode,
  ResearchArtifact,
  ResearchCancelEnvelope,
  ResearchListEnvelope,
  ResearchListItem,
  ResearchReadEnvelope,
  ResearchStartEnvelope,
  ResultProvenance,
  SearchAttempt,
  SearchEnvelope,
  SearchResult,
  SearchState,
  UpstreamAttempt,
  UpstreamAttemptState,
  UpstreamError,
  UpstreamResultAttribution,
  TerminalJobState,
} from './types.ts';

export interface CreateNbSearchRuntimeOptions {
  /** Environment-shaped configuration supplied by the embedding composition root. */
  env?: NodeJS.ProcessEnv;
  /** Canonical host configuration applied after environment sources. */
  config?: CanonicalConfigPatch;
  /** Request-scoped composition overrides applied at the highest precedence. */
  overrides?: CanonicalConfigPatch;
  /** Explicit code registrations; the runtime never discovers provider modules dynamically. */
  provider_registrations?: readonly ProviderRegistration[];
}

export function createNbSearchRuntime(options: CreateNbSearchRuntimeOptions = {}): NbSearchRuntime {
  return createRuntimeComposition(options.env, {
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.provider_registrations === undefined ? {} : { provider_registrations: options.provider_registrations }),
  }).runtime;
}
