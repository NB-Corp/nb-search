import { createRuntimeComposition, createCapturedRuntimeComposition } from './app.ts';
import type { ResolvedConfiguration } from './config-sources.ts';
export { resolveCapturedConfiguration, bindCapturedConfiguration, defaultConfiguration } from './config-sources.ts';
export type { ResolvedConfiguration, ResolveConfigurationOptions } from './config-sources.ts';
export { runWorker } from './worker-runtime.ts';
export { captureFetchFileIdentity } from './fetch-sources.ts';
export type { WorkerLauncher } from './query-jobs.ts';
export * from './fetch-routing-contracts.ts';
import type { CanonicalConfigPatch } from './config-schema.ts';
import type { ProviderRegistration } from './provider-registry.ts';
import type { LocalNbSearchRuntime } from './runtime.ts';
import type { HttpTransport } from './transport.ts';
import { NbSearchError } from './errors.ts';

export type { HttpRequest, HttpResponse, HttpTransport } from './transport.ts';
export { ResponseLimitError } from './transport.ts';
export type { ScriptContext, ScriptRequest, ScriptResults, ScriptModule } from './providers/script.ts';
export { resolveProviderOperation } from './provider-operation.ts';
export type { ResolvedProviderOperation } from './provider-operation.ts';

export { createNbSearchRemoteClient } from './remote-client.ts';
export type { CreateNbSearchRemoteClientOptions } from './remote-client.ts';
export { NbSearchRemoteError, REMOTE_PROTOCOL_VERSION } from './remote-protocol.ts';
export type { RemoteErrorCode } from './remote-protocol.ts';
export { capabilitiesInputSchema, fetchActionInputSchema, fetchInputSchema, freshnessSchema, searchInputSchema } from './contracts.ts';
export type { CapabilitiesInput, FetchCancelInput, FetchGetInput, FetchInput, FetchReadInput, FetchRunInput, OperationContext, SearchCancelInput, SearchGetInput, SearchInput, SearchReadInput, SearchRunInput } from './contracts.ts';
export type { NbSearchRuntime, LocalNbSearchRuntime, KeyUsageInput } from './runtime.ts';
export type { KeyUsage } from './key-scheduler.ts';
export { CONFIG_SCHEMA_VERSION, parseConfigPatch, parseResolvedConfig, stableFingerprint, stableJson } from './config-schema.ts';
export type { CanonicalConfig, CanonicalConfigPatch, CredentialSlotConfig, DefaultsConfig, ExecutionConfig, FetchChainConfig, FetchQualityConfig, LaneConfig, PresetConfig, ProviderInstanceConfig, ProviderInstancePatch } from './config-schema.ts';
export { builtInProviderRegistrations, ProviderRegistry, REGISTRY_SCHEMA_VERSION } from './provider-registry.ts';
export type { ProviderDescriptor, ProviderFactoryContext, ProviderPorts, ProviderRegistration } from './provider-registry.ts';
export type { ArtifactChunk, ArtifactRef, CapabilityEnvelope, CapabilityIssue, CapabilityIssueCode, CapabilityProviderDescriptor, CapabilityProviderInstance, ErrorEnvelope, FetchCancelEnvelope, FetchDocument, FetchEnvelope, FetchFileScope, FetchGetEnvelope, FetchInputKind, FetchOperationDescriptor, FetchPipelineDescriptor, FetchProvider, FetchProviderRequest, FetchProviderResult, FetchReadEnvelope, FetchRepresentation, FetchRunAsyncEnvelope, FetchRunSyncEnvelope, FetchSource, FetchStageRole, FetchWarning, Freshness, Hint, JobKind, JobReceipt, JobState, JsonValue, LaneCost, LaneLatency, LaneOutcome, LaneOutcomeState, LogicalStatus, OutputChannel, ProviderId, ProviderInstanceId, ProviderName, ProviderResult, PublicError, PublicErrorCode, QueryExecution, QueryExecutionRequest, QueryOperationDescriptor, QueryOperationOutput, QueryProvider, QueryProviderValue, SearchCancelEnvelope, SearchEnvelope, SearchGetEnvelope, SearchLogicalOutput, SearchReadEnvelope, SearchResult, SearchResultsOutput, SearchRunAsyncEnvelope, SearchRunSyncEnvelope, SearchSelection, SearchTypedOutput } from './types.ts';

export interface CreateNbSearchRuntimeOptions { env?: NodeJS.ProcessEnv; config?: CanonicalConfigPatch; overrides?: CanonicalConfigPatch; provider_registrations?: readonly ProviderRegistration[]; http_transport?: HttpTransport; launcher?: import('./query-jobs.ts').WorkerLauncher }
function compositionOptions(options: CreateNbSearchRuntimeOptions) {
  if (options.http_transport !== undefined && (options.http_transport === null || typeof options.http_transport.send !== 'function')) throw new NbSearchError('CONFIGURATION_ERROR', 'http_transport must implement send.');
  if (options.launcher !== undefined && (options.launcher === null || typeof options.launcher.launch !== 'function')) throw new NbSearchError('CONFIGURATION_ERROR', 'launcher must implement launch.');
  return { launcher: options.launcher, config: options.config, overrides: options.overrides, provider_registrations: options.provider_registrations, transport: options.http_transport, disable_detached_async: options.http_transport !== undefined };
}
export function createNbSearchRuntime(options: CreateNbSearchRuntimeOptions = {}): LocalNbSearchRuntime { return createRuntimeComposition(options.env, compositionOptions(options)).runtime; }
/** Composes the captured, already-resolved configuration without reading config files or applying sources twice. Secrets remain in-process. */
export function createCapturedNbSearchRuntime(resolved: ResolvedConfiguration, options: Omit<CreateNbSearchRuntimeOptions, 'config' | 'overrides'> = {}): LocalNbSearchRuntime { return createCapturedRuntimeComposition(resolved, options.env ?? process.env, compositionOptions(options)).runtime; }
