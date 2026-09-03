import type { ProviderInstanceConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import type { SecretBinding } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import { ExaContentsFetchProvider, FirecrawlScrapeFetchProvider, JinaReaderFetchProvider, TavilyExtractFetchProvider } from './fetch-providers.ts';
import { DirectFetchProvider, type DirectFetchIo } from './fetch-security.ts';
import { Context7DocsProvider } from './providers/context7.ts';
import { GitHubRepositoriesProvider } from './providers/github.ts';
import { ZhipuSearchProvider } from './providers/zhipu.ts';
import { ExaProvider, ExaResearchLightProvider, GrokMultiAgentProvider, GrokProvider, TavilyAnswerProvider, TavilyProvider, validateGmaEffort, validateGrokBaseUrl, validateGrokModel, validateProviderBaseUrl, validateSearchPath } from './providers.ts';
import type { HttpTransport } from './transport.ts';
import type { FetchOperationDescriptor, FetchProvider, JsonValue, ProviderId, QueryOperationDescriptor, QueryProvider, QueryProviderValue } from './types.ts';

export const REGISTRY_SCHEMA_VERSION = '1' as const;
export interface ProviderDescriptor { provider_id: ProviderId; adapter_version: string; query_operations: readonly QueryOperationDescriptor[]; fetch_operation?: FetchOperationDescriptor; activation: { credential: 'required' | 'none'; endpoint: 'required' | 'optional' | 'none' }; option_keys: readonly string[] }
export interface ProviderFactoryContext { instance_id: string; instance: ProviderInstanceConfig; credential?: SecretBinding; transports: { http: HttpTransport }; clock: () => Date }
export interface ProviderPorts { query: Readonly<Record<string, QueryProvider>>; fetch?: FetchProvider }
export interface ProviderRegistration { descriptor: ProviderDescriptor; validate?(instanceId: string, instance: ProviderInstanceConfig): void; create(context: ProviderFactoryContext): ProviderPorts }
interface RegisteredProvider { registration: ProviderRegistration; built_in: boolean }
export class ProviderRegistry {
  private readonly registrations = new Map<ProviderId, RegisteredProvider>();
  constructor(builtIns: readonly ProviderRegistration[] = [], custom: readonly ProviderRegistration[] = []) { for (const item of builtIns) this.register(item, true); for (const item of custom) this.register(item, false); }
  private register(registration: ProviderRegistration, builtIn: boolean): void { validateRegistration(registration); const descriptor = deepFreeze(structuredClone(registration.descriptor)); const canonical: ProviderRegistration = Object.freeze({ descriptor, ...(registration.validate === undefined ? {} : { validate: registration.validate }), create: registration.create }); const id = descriptor.provider_id; if (this.registrations.has(id)) throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${id} is registered more than once.`); this.registrations.set(id, { registration: canonical, built_in: builtIn }); }
  descriptor(providerId: ProviderId): ProviderDescriptor | undefined { return this.registrations.get(providerId)?.registration.descriptor }
  requireDescriptor(providerId: ProviderId): ProviderDescriptor { const descriptor = this.descriptor(providerId); if (descriptor === undefined) throw new NbSearchError('LANE_NOT_REGISTERED', `Provider ${providerId} is not registered.`); return descriptor }
  isBuiltIn(providerId: ProviderId): boolean { return this.registrations.get(providerId)?.built_in === true }
  descriptors(): readonly ProviderDescriptor[] { return [...this.registrations.values()].map((item) => item.registration.descriptor).sort((a, b) => a.provider_id.localeCompare(b.provider_id)); }
  create(instanceId: string, instance: ProviderInstanceConfig, context: Omit<ProviderFactoryContext, 'instance_id' | 'instance'>): ProviderPorts { const item = this.registrations.get(instance.provider_id); if (item === undefined) throw new NbSearchError('LANE_NOT_REGISTERED', `Provider ${instance.provider_id} is not registered.`); item.registration.validate?.(instanceId, instance); return item.registration.create({ ...context, instance_id: instanceId, instance }); }
  operation(providerId: ProviderId, operationId: string): QueryOperationDescriptor | undefined { return this.descriptor(providerId)?.query_operations.find((item) => item.operation_id === operationId) }
  operationFingerprint(providerId: ProviderId, operationId: string): string { const descriptor = this.requireDescriptor(providerId); const operation = descriptor.query_operations.find((item) => item.operation_id === operationId); if (operation === undefined) throw new NbSearchError('LANE_NOT_REGISTERED', `Operation ${providerId}:${operationId} is not registered.`); return stableFingerprint({ registry_schema: REGISTRY_SCHEMA_VERSION, provider_id: providerId, adapter_version: descriptor.adapter_version, operation }); }
}
const DESCRIPTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
function validateRegistration(registration: ProviderRegistration): void {
  const descriptor = (registration as unknown as { descriptor?: unknown; create?: unknown }).descriptor;
  if (!isRecord(descriptor) || typeof (registration as unknown as { create?: unknown }).create !== 'function') throw invalidDescriptor();
  const descriptorKeys = descriptor['fetch_operation'] === undefined ? ['activation', 'adapter_version', 'option_keys', 'provider_id', 'query_operations'] : ['activation', 'adapter_version', 'fetch_operation', 'option_keys', 'provider_id', 'query_operations'];
  if (!exactKeys(descriptor, descriptorKeys) || !stableId(descriptor['provider_id']) || !stableId(descriptor['adapter_version']) || !Array.isArray(descriptor['query_operations']) || !Array.isArray(descriptor['option_keys']) || !isRecord(descriptor['activation'])) throw invalidDescriptor();
  const activation = descriptor['activation'];
  if (!exactKeys(activation, ['credential', 'endpoint']) || (activation['credential'] !== 'required' && activation['credential'] !== 'none') || (activation['endpoint'] !== 'required' && activation['endpoint'] !== 'optional' && activation['endpoint'] !== 'none')) throw invalidDescriptor();
  if (!descriptor['option_keys'].every(stableId) || new Set(descriptor['option_keys']).size !== descriptor['option_keys'].length) throw invalidDescriptor();
  const operationIds = new Set<string>();
  for (const candidate of descriptor['query_operations']) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['built_in_async', 'operation_id', 'output']) || !stableId(candidate['operation_id']) || operationIds.has(candidate['operation_id']) || typeof candidate['built_in_async'] !== 'boolean' || !isRecord(candidate['output'])) throw invalidDescriptor();
    operationIds.add(candidate['operation_id']);
    const output = candidate['output'];
    if (!exactKeys(output, ['channel', 'schema_id'])) throw invalidDescriptor();
    if (output['channel'] === 'results') { if (output['schema_id'] !== 'nb-search.results@1') throw invalidDescriptor(); }
    else if (output['channel'] === 'typed') { if (!stableId(output['schema_id'])) throw invalidDescriptor(); }
    else throw invalidDescriptor();
  }
  const fetch = descriptor['fetch_operation'];
  if (fetch !== undefined && (!isRecord(fetch) || !exactKeys(fetch, ['operation_id', 'schema_id']) || !stableId(fetch['operation_id']) || fetch['schema_id'] !== 'nb-search.fetch@1' || operationIds.has(fetch['operation_id']))) throw invalidDescriptor();
}
function stableId(value: unknown): value is string { return typeof value === 'string' && DESCRIPTOR_ID.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
function invalidDescriptor(): NbSearchError { return new NbSearchError('CONFIGURATION_ERROR', 'Provider registration descriptor is invalid.'); }
export function builtInProviderRegistrations(): readonly ProviderRegistration[] { return registrationsWithDirectFetchIo(undefined); }
export function builtInProviderRegistrationsForInternalTest(testIo: DirectFetchIo): readonly ProviderRegistration[] { return registrationsWithDirectFetchIo(testIo); }
function registrationsWithDirectFetchIo(io: DirectFetchIo | undefined): readonly ProviderRegistration[] { return [directRegistration(io), jinaRegistration, exaRegistration, tavilyRegistration, firecrawlRegistration, context7Registration, zhipuRegistration, githubRegistration, grokRegistration, gmaRegistration]; }
function directRegistration(io: DirectFetchIo | undefined): ProviderRegistration { return { descriptor: { provider_id: 'direct-http', adapter_version: '1', query_operations: [], fetch_operation: { operation_id: 'fetch', schema_id: 'nb-search.fetch@1' }, activation: { credential: 'none', endpoint: 'none' }, option_keys: [] }, validate: (id, instance) => validateKnownOptions(id, instance, []), create: () => ({ query: {}, fetch: new DirectFetchProvider(io) }) }; }
const jinaRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'jina-reader', adapter_version: '1', query_operations: [], fetch_operation: { operation_id: 'reader', schema_id: 'nb-search.fetch@1' }, activation: { credential: 'none', endpoint: 'optional' }, option_keys: [] },
  validate(id, instance) { validateKnownOptions(id, instance, []); if (instance.base_url !== undefined) validateProviderBaseUrl(instance.base_url); },
  create(context) { return { query: {}, fetch: new JinaReaderFetchProvider({ ...(context.credential === undefined ? {} : { apiKey: context.credential.value }), transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }) }) }; },
};
const exaRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'exa', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }, { operation_id: 'synthesis', output: { channel: 'typed', schema_id: 'nb-search.synthesis@1' }, built_in_async: true }], fetch_operation: { operation_id: 'contents', schema_id: 'nb-search.fetch@1' }, activation: { credential: 'required', endpoint: 'optional' }, option_keys: ['search_path', 'synthesis_path'] },
  validate: (id, instance) => validateRelay(id, instance, ['search_path', 'synthesis_path']),
  create(context) { const credential = requireCredential(context); const common = commonOptions(context, credential); const searchPath = option(context.instance, 'search_path'); const synthesisPath = option(context.instance, 'synthesis_path'); const results = new ExaProvider({ ...common, ...(searchPath === undefined ? {} : { searchPath }) }); const synthesis = new ExaResearchLightProvider({ ...common, ...(synthesisPath === undefined ? {} : { operationPath: synthesisPath }) }); return { query: { search: resultsProvider(results), synthesis: { name: 'exa', redactions: synthesis.redactions, async execute(request) { const value = await synthesis.researchLight({ capability: 'research-light', query: request.query, retrieval_result_count: request.limit, ...(request.freshness === undefined ? {} : { freshness: request.freshness }), request_time_utc: request.request_time_utc, signal: request.signal }); return typed({ text: value.synthesis ?? '', supporting_urls: value.supporting_urls, resolved_type: value.resolved_type, citation_status: citationStatus() }); } } }, fetch: new ExaContentsFetchProvider({ apiKey: credential.value, transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }) }) }; },
};
const tavilyRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'tavily', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }, { operation_id: 'synthesis', output: { channel: 'typed', schema_id: 'nb-search.synthesis@1' }, built_in_async: true }], fetch_operation: { operation_id: 'extract', schema_id: 'nb-search.fetch@1' }, activation: { credential: 'required', endpoint: 'optional' }, option_keys: ['search_path', 'synthesis_path'] },
  validate: (id, instance) => validateRelay(id, instance, ['search_path', 'synthesis_path']),
  create(context) { const credential = requireCredential(context); const common = commonOptions(context, credential); const searchPath = option(context.instance, 'search_path'); const synthesisPath = option(context.instance, 'synthesis_path'); const results = new TavilyProvider({ ...common, ...(searchPath === undefined ? {} : { searchPath }) }); const synthesis = new TavilyAnswerProvider({ ...common, ...(synthesisPath === undefined ? {} : { operationPath: synthesisPath }) }); return { query: { search: resultsProvider(results), synthesis: { name: 'tavily', redactions: synthesis.redactions, async execute(request) { const value = await synthesis.answer({ capability: 'answer', query: request.query, limit: request.limit, ...(request.freshness === undefined ? {} : { freshness: request.freshness }), request_time_utc: request.request_time_utc, signal: request.signal }); return typed({ text: value.text ?? '', supporting_urls: value.supporting_results.map((item) => ({ url: item.url, ...(item.title === '' ? {} : { title: item.title }), source: 'provider-result' })), citation_status: citationStatus() }); } } }, fetch: new TavilyExtractFetchProvider({ apiKey: credential.value, transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }) }) }; },
};
const firecrawlRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'firecrawl', adapter_version: '1', query_operations: [], fetch_operation: { operation_id: 'scrape', schema_id: 'nb-search.fetch@1' }, activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
  validate(id, instance) { validateKnownOptions(id, instance, []); if (instance.base_url !== undefined) validateProviderBaseUrl(instance.base_url); },
  create(context) { const credential = requireCredential(context); return { query: {}, fetch: new FirecrawlScrapeFetchProvider({ apiKey: credential.value, transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }) }) }; },
};
const context7Registration: ProviderRegistration = {
  descriptor: { provider_id: 'context7', adapter_version: '1', query_operations: [{ operation_id: 'docs', output: { channel: 'typed', schema_id: 'nb-search.docs-context@1' }, built_in_async: true }], activation: { credential: 'none', endpoint: 'optional' }, option_keys: [] },
  validate: (id, instance) => validateKnownOptions(id, instance, []),
  create(context) { const provider = new Context7DocsProvider({ ...(context.credential === undefined ? {} : { apiKey: context.credential.value }), transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }), clock: context.clock }); return { query: { docs: provider } }; },
};
const zhipuRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'zhipu', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
  validate: (id, instance) => validateKnownOptions(id, instance, []),
  create(context) { const credential = requireCredential(context); const provider = new ZhipuSearchProvider({ apiKey: credential.value, transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }), clock: context.clock }); return { query: { search: resultsProvider(provider) } }; },
};
const githubRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'github', adapter_version: '1', query_operations: [{ operation_id: 'repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
  validate: (id, instance) => validateKnownOptions(id, instance, []),
  create(context) { const provider = new GitHubRepositoriesProvider({ ...(context.credential === undefined ? {} : { token: context.credential.value }), transport: context.transports.http, clock: context.clock }); return { query: { repositories: resultsProvider(provider) } }; },
};
const grokRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'grok', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], activation: { credential: 'required', endpoint: 'required' }, option_keys: ['model'] },
  validate(id, instance) { validateKnownOptions(id, instance, ['model']); if (instance.base_url !== undefined) validateGrokBaseUrl(instance.base_url); validateGrokModel(instance.options['model']); },
  create(context) { const credential = requireCredential(context); if (context.instance.base_url === undefined) throw incomplete(context.instance_id); const provider = new GrokProvider({ apiKey: credential.value, baseUrl: context.instance.base_url, model: context.instance.options['model'] as string, transport: context.transports.http, providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id, clock: context.clock }); return { query: { search: resultsProvider(provider) } }; },
};
const gmaRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'grok-multi-agent', adapter_version: '1', query_operations: [{ operation_id: 'research', output: { channel: 'typed', schema_id: 'nb-search.multi-agent-research@1' }, built_in_async: true }], activation: { credential: 'required', endpoint: 'required' }, option_keys: ['model', 'reasoning_effort'] },
  validate(id, instance) { validateKnownOptions(id, instance, ['model', 'reasoning_effort']); if (instance.base_url !== undefined) validateGrokBaseUrl(instance.base_url); validateGrokModel(instance.options['model']); validateGmaEffort(instance.options['reasoning_effort']); },
  create(context) { const credential = requireCredential(context); if (context.instance.base_url === undefined) throw incomplete(context.instance_id); const provider = new GrokMultiAgentProvider({ apiKey: credential.value, baseUrl: context.instance.base_url, model: context.instance.options['model'] as string, reasoningEffort: context.instance.options['reasoning_effort'] as import('./types.ts').GmaEffort, transport: context.transports.http, providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id, clock: context.clock }); return { query: { research: { name: 'grok-multi-agent', redactions: provider.redactions, async execute(request) { const value = await provider.research({ capability: 'multi-agent-research', query: request.query, brief: request.query, limit: request.limit, request_time_utc: request.request_time_utc, signal: request.signal }); return typed(value); } } } }; },
};
function resultsProvider(provider: import('./types.ts').SearchProvider): QueryProvider { return { name: provider.name, redactions: provider.redactions, async execute(request) { const returned = await provider.search({ query: request.query, limit: request.limit, ...(request.freshness === undefined ? {} : { freshness: request.freshness }), request_time_utc: request.request_time_utc, signal: request.signal }); const value = Array.isArray(returned) ? { results: returned } : returned; return { channel: 'results', value: value as import('./types.ts').QueryResultsValue }; } }; }
function typed(value: unknown): QueryProviderValue { return { channel: 'typed', data: toJson(value) } }
function toJson(value: unknown): JsonValue { const encoded = JSON.stringify(value); if (encoded === undefined) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Typed provider returned non-JSON output.'); try { return JSON.parse(encoded) as JsonValue; } catch (error) { throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Typed provider returned non-JSON output.', false, undefined, { cause: error }); } }
function commonOptions(context: ProviderFactoryContext, credential: SecretBinding) { return { apiKey: credential.value, transport: context.transports.http, ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }), providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id, clock: context.clock }; }
function validateRelay(id: string, instance: ProviderInstanceConfig, keys: readonly string[]): void { validateKnownOptions(id, instance, keys); if (instance.base_url !== undefined) validateProviderBaseUrl(instance.base_url); for (const key of keys) { const value = instance.options[key]; if (value !== undefined) { if (typeof value !== 'string') throw invalidOption(id); validateSearchPath(value); } } }
function validateKnownOptions(id: string, instance: ProviderInstanceConfig, keys: readonly string[]): void { if (Object.keys(instance.options).some((key) => !keys.includes(key))) throw invalidOption(id) }
function option(instance: ProviderInstanceConfig, key: string): string | undefined { return typeof instance.options[key] === 'string' ? instance.options[key] : undefined }
function invalidOption(id: string): NbSearchError { return new NbSearchError('CONFIGURATION_ERROR', `Provider instance ${id} has invalid options.`) }
function incomplete(id: string): NbSearchError { return new NbSearchError('LANE_NOT_CONFIGURED', `Provider instance ${id} is incomplete.`) }
function requireCredential(context: ProviderFactoryContext): SecretBinding { if (context.credential === undefined || context.credential.credential_slot_id !== context.instance.credential_slot_id) throw incomplete(context.instance_id); return context.credential }
function citationStatus(): { claim_linked_citations: false; evidence_map_available: false; semantic_verification: false } { return { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false } }
