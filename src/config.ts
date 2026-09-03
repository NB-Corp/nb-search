import { resolve } from 'node:path';
import type { CanonicalConfigPatch, FetchChainConfig, LaneConfig, ProviderInstanceConfig } from './config-schema.ts';
import { resolveConfiguration, type ResolvedConfiguration } from './config-sources.ts';
import type { DirectFetchIo } from './fetch-security.ts';
import { NbSearchError } from './errors.ts';
import { builtInProviderRegistrations, builtInProviderRegistrationsForInternalTest, ProviderRegistry, type ProviderPorts, type ProviderRegistration } from './provider-registry.ts';
import { FetchJsonTransport, type JsonTransport } from './transport.ts';
import type { FetchOperationDescriptor, FetchProvider, QueryExecution, QueryOperationDescriptor, QueryProvider } from './types.ts';

export interface LaneBinding {
  id: string; config: LaneConfig; instance: ProviderInstanceConfig; provider_id: string; built_in: boolean;
  query_operation?: QueryOperationDescriptor; fetch_operation?: FetchOperationDescriptor; query_provider?: QueryProvider; fetch_provider?: FetchProvider;
  availability: 'ready' | 'unavailable'; issues: string[]; execution_modes: QueryExecution[];
}
export interface AppConfiguration { home: string; jobs_root: string; retention_hours: number; log_level: 'error' | 'warn' | 'info' | 'debug'; resolved: ResolvedConfiguration; registry: ProviderRegistry; ports_by_instance: ReadonlyMap<string, ProviderPorts>; lanes: Readonly<Record<string, LaneBinding>> }
export interface LoadConfigurationOptions { config?: CanonicalConfigPatch; overrides?: CanonicalConfigPatch; provider_registrations?: readonly ProviderRegistration[]; test_only_direct_fetch_io?: DirectFetchIo; cwd?: string; homeDirectory?: string; now?: () => Date }
export function loadConfiguration(env: NodeJS.ProcessEnv = process.env, transport: JsonTransport = new FetchJsonTransport(), options: LoadConfigurationOptions = {}): AppConfiguration {
  const resolved = resolveConfiguration({ env, ...(options.config === undefined ? {} : { config: options.config }), ...(options.overrides === undefined ? {} : { overrides: options.overrides }), ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }) });
  const builtIns = options.test_only_direct_fetch_io === undefined ? builtInProviderRegistrations() : builtInProviderRegistrationsForInternalTest(options.test_only_direct_fetch_io);
  const registry = new ProviderRegistry(builtIns, options.provider_registrations ?? []); const ports = new Map<string, ProviderPorts>();
  for (const [instanceId, instance] of Object.entries(resolved.config.provider_instances)) {
    const descriptor = registry.descriptor(instance.provider_id); if (descriptor === undefined || !instance.enabled) continue;
    const credential = instance.credential_slot_id === undefined ? undefined : resolved.secret_bindings.get(instance.credential_slot_id);
    const configured = (descriptor.activation.credential === 'none' || credential !== undefined) && (descriptor.activation.endpoint !== 'required' || instance.base_url !== undefined);
    if (!configured) continue;
    const created = registry.create(instanceId, instance, { ...(credential === undefined ? {} : { credential }), transports: { http: transport }, clock: options.now ?? (() => new Date()) }); ports.set(instanceId, created);
  }
  const lanes: Record<string, LaneBinding> = {};
  for (const [id, lane] of Object.entries(resolved.config.lanes)) {
    const instance = resolved.config.provider_instances[lane.provider_instance_id]!; const descriptor = registry.descriptor(instance.provider_id); const queryOperation = descriptor?.query_operations.find((item) => item.operation_id === lane.operation_id); const fetchOperation = descriptor?.fetch_operations.find((item) => item.operation_id === lane.operation_id); const instancePorts = ports.get(lane.provider_instance_id); const queryProvider = instancePorts?.query[lane.operation_id]; const fetchProvider = instancePorts?.fetch[lane.operation_id]; const issues: string[] = [];
    if (descriptor === undefined) issues.push('LANE_NOT_REGISTERED'); else if (queryOperation === undefined && fetchOperation === undefined) issues.push('OPERATION_NOT_REGISTERED');
    if (!instance.enabled || (queryOperation !== undefined && queryProvider === undefined) || (fetchOperation !== undefined && fetchProvider === undefined)) issues.push('LANE_NOT_CONFIGURED');
    const ready = issues.length === 0; const builtIn = descriptor !== undefined && registry.isBuiltIn(instance.provider_id); const executionModes: QueryExecution[] = queryOperation !== undefined ? ready ? builtIn && queryOperation.built_in_async ? ['sync', 'async'] : ['sync'] : [] : fetchOperation !== undefined && ready ? builtIn ? [...fetchOperation.execution_modes] : fetchOperation.execution_modes.includes('sync') ? ['sync'] : [] : [];
    lanes[id] = { id, config: lane, instance, provider_id: instance.provider_id, built_in: builtIn, ...(queryOperation === undefined ? {} : { query_operation: queryOperation }), ...(fetchOperation === undefined ? {} : { fetch_operation: fetchOperation }), ...(queryProvider === undefined ? {} : { query_provider: queryProvider }), ...(fetchProvider === undefined ? {} : { fetch_provider: fetchProvider }), availability: ready ? 'ready' : 'unavailable', issues, execution_modes: executionModes };
  }
  validateLaneConfig(resolved.config.defaults, resolved.config.presets, lanes);
  return { home: resolve(resolved.config.home ?? '.'), jobs_root: resolve(resolved.config.jobs_root ?? resolve(resolved.config.home ?? '.', 'jobs')), retention_hours: resolved.config.retention_hours, log_level: resolved.config.log_level, resolved, registry, ports_by_instance: ports, lanes };
}
function validateLaneConfig(defaults: { search_lane?: string; fetch_chain?: readonly FetchChainConfig[] }, presets: Readonly<Record<string, { lanes: readonly string[] }>>, lanes: Readonly<Record<string, LaneBinding>>): void {
  if (defaults.search_lane !== undefined && lanes[defaults.search_lane]?.query_operation === undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'defaults.search_lane must reference a query operation.');
  for (const chain of defaults.fetch_chain ?? []) for (const pipelineId of chain.pipelines) if (lanes[pipelineId]?.fetch_operation === undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'defaults.fetch_chain must reference fetch operations only.');
  for (const [name, preset] of Object.entries(presets)) for (const laneId of preset.lanes) { const binding = lanes[laneId]; if (binding?.query_operation?.output.channel !== 'results') throw new NbSearchError('CONFIGURATION_ERROR', `Preset ${name} must contain registered results lanes only.`); }
}
