import { createRuntimeComposition } from './app.ts';
import type { CanonicalConfigPatch } from './config-schema.ts';
import type { ProviderRegistration } from './provider-registry.ts';
import type { NbSearchRuntime } from './runtime.ts';
import type { HttpTransport } from './transport.ts';
import { NbSearchError } from './errors.ts';

export type { HttpRequest, HttpResponse, HttpTransport } from './transport.ts';
export { ResponseLimitError } from './transport.ts';

export { createNbSearchRemoteClient } from './remote-client.ts';
export type { CreateNbSearchRemoteClientOptions } from './remote-client.ts';
export { NbSearchRemoteError, REMOTE_PROTOCOL_VERSION } from './remote-protocol.ts';
export type { RemoteErrorCode } from './remote-protocol.ts';
export { capabilitiesInputSchema, fetchActionInputSchema, fetchInputSchema, freshnessSchema, searchInputSchema } from './contracts.ts';
export type { CapabilitiesInput, FetchCancelInput, FetchGetInput, FetchInput, FetchReadInput, FetchRunInput, OperationContext, SearchCancelInput, SearchGetInput, SearchInput, SearchReadInput, SearchRunInput } from './contracts.ts';
export type { NbSearchRuntime } from './runtime.ts';
export { CONFIG_SCHEMA_VERSION, parseConfigPatch, parseResolvedConfig, stableFingerprint, stableJson } from './config-schema.ts';
export type { CanonicalConfig, CanonicalConfigPatch, CredentialSlotConfig, DefaultsConfig, ExecutionConfig, FetchChainConfig, FetchQualityConfig, LaneConfig, PresetConfig, ProviderInstanceConfig, ProviderInstancePatch } from './config-schema.ts';
export { builtInProviderRegistrations, ProviderRegistry, REGISTRY_SCHEMA_VERSION } from './provider-registry.ts';
export type { ProviderDescriptor, ProviderFactoryContext, ProviderPorts, ProviderRegistration } from './provider-registry.ts';
export type { ArtifactChunk, ArtifactRef, CapabilityEnvelope, CapabilityIssue, CapabilityIssueCode, CapabilityProviderDescriptor, CapabilityProviderInstance, ErrorEnvelope, FetchCancelEnvelope, FetchDocument, FetchEnvelope, FetchFileScope, FetchGetEnvelope, FetchInputKind, FetchOperationDescriptor, FetchPipelineDescriptor, FetchProvider, FetchProviderRequest, FetchProviderResult, FetchReadEnvelope, FetchRepresentation, FetchRunAsyncEnvelope, FetchRunSyncEnvelope, FetchSource, FetchStageRole, FetchWarning, Freshness, Hint, JobKind, JobReceipt, JobState, JsonValue, LaneCost, LaneLatency, LaneOutcome, LaneOutcomeState, LogicalStatus, OutputChannel, ProviderId, ProviderInstanceId, ProviderName, ProviderResult, PublicError, PublicErrorCode, QueryExecution, QueryExecutionRequest, QueryOperationDescriptor, QueryOperationOutput, QueryProvider, QueryProviderValue, SearchCancelEnvelope, SearchEnvelope, SearchGetEnvelope, SearchLogicalOutput, SearchReadEnvelope, SearchResult, SearchResultsOutput, SearchRunAsyncEnvelope, SearchRunSyncEnvelope, SearchSelection, SearchTypedOutput } from './types.ts';

export interface CreateNbSearchRuntimeOptions { env?: NodeJS.ProcessEnv; config?: CanonicalConfigPatch; overrides?: CanonicalConfigPatch; provider_registrations?: readonly ProviderRegistration[]; http_transport?: HttpTransport }
export function createNbSearchRuntime(options: CreateNbSearchRuntimeOptions = {}): NbSearchRuntime {
  if (options.http_transport !== undefined && (options.http_transport === null || typeof options.http_transport.send !== 'function')) throw new NbSearchError('CONFIGURATION_ERROR', 'http_transport must implement send.');
  return createRuntimeComposition(options.env, { ...(options.config === undefined ? {} : { config: options.config }), ...(options.overrides === undefined ? {} : { overrides: options.overrides }), ...(options.provider_registrations === undefined ? {} : { provider_registrations: options.provider_registrations }), ...(options.http_transport === undefined ? {} : { transport: options.http_transport, disable_detached_async: true }) }).runtime;
}
