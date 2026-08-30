import { readFileSync } from 'node:fs';

import type { ProviderInstanceConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import type { ResolvedConfiguration, SecretBinding, WorkerGrant } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import type { SearchPlan } from './planner.ts';
import { REGISTRY_SCHEMA_VERSION, type ProviderDescriptor, type ProviderRegistry } from './provider-registry.ts';
import type { ProviderCapability } from './types.ts';
import { FRESHNESS_VALUES, SEARCH_INTENTS, type Freshness, type ProfileId, type SearchIntent } from './types.ts';

export const EXECUTION_SNAPSHOT_VERSION = '4' as const;
export const PREVIOUS_EXECUTION_SNAPSHOT_VERSION = '3' as const;
export const RETRIEVAL_EXECUTION_SNAPSHOT_VERSION = '2' as const;
export const LEGACY_EXECUTION_SNAPSHOT_VERSION = '1' as const;
export const ARTIFACT_CONTRACT_VERSION = '3' as const;
export const M1_REGISTRY_REVISION = 'registry-1-a66d6be4db9ec72f' as const;
export const M1_REGISTRY_FINGERPRINT = 'a66d6be4db9ec72f6a995019da3253fb14f835cbbd3b5401969b12091f7d57f4' as const;

export interface SnapshotProviderInstance {
  provider_instance_id: string;
  config: ProviderInstanceConfig;
  connection_origin?: { kind: 'configured' } | { kind: 'inherited'; provider_instance_id: 'grok.default' };
}

export interface SnapshotCredentialBinding {
  credential_slot_id: string;
  provider_id: string;
  worker_grant: WorkerGrant;
  inherited_from_slot_id?: string;
}

export interface ExecutionSnapshot {
  snapshot_version: typeof EXECUTION_SNAPSHOT_VERSION | typeof PREVIOUS_EXECUTION_SNAPSHOT_VERSION | typeof RETRIEVAL_EXECUTION_SNAPSHOT_VERSION | typeof LEGACY_EXECUTION_SNAPSHOT_VERSION;
  artifact_contract_version: typeof ARTIFACT_CONTRACT_VERSION | '2' | '1';
  plan: SearchPlan;
  plan_fingerprint: string;
  config_revision: string;
  config_fingerprint: string;
  registry_revision: string;
  registry_fingerprint: string;
  routing: { profile: ProfileId; intent?: SearchIntent; freshness?: Freshness; execution_surface?: 'sync' | 'research-job'; multi_agent_route?: 'none' | 'replacement' | 'overlay' | 'explicit' };
  provider_instances: readonly SnapshotProviderInstance[];
  credential_bindings: readonly SnapshotCredentialBinding[];
  selected_provider_descriptors?: readonly SelectedProviderDescriptor[];
  snapshot_fingerprint: string;
}

export interface SelectedProviderDescriptor {
  provider_id: string; selected_capabilities: readonly ProviderCapability[];
  selected_capability_versions: Readonly<Partial<Record<ProviderCapability, string>>>;
  operations: readonly ProviderDescriptor['operations'][number][]; auth: ProviderDescriptor['auth'];
  relevant_option_schema: Readonly<Record<string, unknown>>; descriptor_fingerprint: string;
}

export function createExecutionSnapshot(
  plan: SearchPlan,
  resolved: ResolvedConfiguration,
  registry: ProviderRegistry,
  routing: { profile?: ProfileId; intent?: SearchIntent; freshness?: Freshness } = {},
): ExecutionSnapshot {
  const selectedIds = new Set([
    ...plan.stages.flatMap((stage) => stage.invocations.map((item) => item.provider_instance_id)),
    ...(plan.omissions ?? []).map((item) => item.provider_instance_id),
  ]);
  const providerInstances = [...selectedIds].sort().map((instanceId): SnapshotProviderInstance => {
    const config = resolved.config.provider_instances[instanceId];
    if (config === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Planned provider instance ${instanceId} is missing.`);
    const endpointOwner = resolved.provenance.find((item) => item.path === `provider_instances.${instanceId}.base_url`)?.source;
    return {
      provider_instance_id: instanceId, config: structuredClone(config),
      ...(instanceId !== 'grok-multi-agent.default' ? {} : endpointOwner === 'compatibility:inherited-grok-endpoint'
        ? { connection_origin: { kind: 'inherited' as const, provider_instance_id: 'grok.default' as const } }
        : { connection_origin: { kind: 'configured' as const } }),
    };
  });
  const executableInstanceIds = new Set(plan.stages.flatMap((stage) => stage.invocations.map((item) => item.provider_instance_id)));
  const selectedSlots = new Set(providerInstances.flatMap((item) => !executableInstanceIds.has(item.provider_instance_id) || item.config.credential_slot_id === undefined ? [] : [item.config.credential_slot_id]));
  const bindings = [...selectedSlots].sort().map((slotId): SnapshotCredentialBinding => {
    const binding = resolved.secret_bindings.get(slotId);
    const slot = resolved.config.credential_slots[slotId];
    if (binding === undefined || slot === undefined) {
      throw new NbSearchError('CONFIGURATION_ERROR', `Worker credential grant is missing for slot ${slotId}.`);
    }
    return {
      credential_slot_id: slotId,
      provider_id: slot.provider_id,
      worker_grant: structuredClone(binding.worker_grant),
      ...(binding.inherited_from_slot_id === undefined ? {} : { inherited_from_slot_id: binding.inherited_from_slot_id }),
    };
  });
  const selectedDescriptors = selectedProviderDescriptors(plan, registry);
  const registryFingerprint = stableFingerprint({ schema_version: REGISTRY_SCHEMA_VERSION, descriptors: selectedDescriptors });
  const base = {
    snapshot_version: EXECUTION_SNAPSHOT_VERSION,
    artifact_contract_version: ARTIFACT_CONTRACT_VERSION,
    plan: structuredClone(plan),
    plan_fingerprint: plan.plan_fingerprint,
    config_revision: resolved.config_revision,
    config_fingerprint: resolved.config_fingerprint,
    registry_revision: `registry-${REGISTRY_SCHEMA_VERSION}-${registryFingerprint.slice(0, 16)}`,
    registry_fingerprint: registryFingerprint,
    routing: {
      profile: routing.profile ?? plan.profile_id,
      ...(routing.intent === undefined ? {} : { intent: routing.intent }),
      ...(routing.freshness === undefined ? {} : { freshness: routing.freshness }),
      execution_surface: plan.routing?.execution_surface ?? 'research-job',
      multi_agent_route: plan.routing?.multi_agent_route ?? 'none',
    },
    provider_instances: providerInstances,
    credential_bindings: bindings,
    selected_provider_descriptors: selectedDescriptors,
  };
  return deepFreeze({ ...base, snapshot_fingerprint: stableFingerprint(base) });
}

export function validateExecutionSnapshot(value: unknown): ExecutionSnapshot {
  if (!isRecord(value) || (value['snapshot_version'] !== EXECUTION_SNAPSHOT_VERSION && value['snapshot_version'] !== PREVIOUS_EXECUTION_SNAPSHOT_VERSION && value['snapshot_version'] !== RETRIEVAL_EXECUTION_SNAPSHOT_VERSION && value['snapshot_version'] !== LEGACY_EXECUTION_SNAPSHOT_VERSION)
    || !((value['snapshot_version'] === EXECUTION_SNAPSHOT_VERSION && value['artifact_contract_version'] === ARTIFACT_CONTRACT_VERSION)
      || (value['snapshot_version'] === PREVIOUS_EXECUTION_SNAPSHOT_VERSION && value['artifact_contract_version'] === '2')
      || ((value['snapshot_version'] === RETRIEVAL_EXECUTION_SNAPSHOT_VERSION || value['snapshot_version'] === LEGACY_EXECUTION_SNAPSHOT_VERSION) && value['artifact_contract_version'] === '1'))
    || typeof value['snapshot_fingerprint'] !== 'string'
    || !isRecord(value['plan']) || !Array.isArray(value['provider_instances']) || !Array.isArray(value['credential_bindings'])) {
    throw new NbSearchError('JOB_STORE_ERROR', 'Research execution snapshot is invalid.');
  }
  const candidate = value as unknown as ExecutionSnapshot;
  if (value['routing'] !== undefined && (!isRecord(value['routing'])
    || typeof value['routing']['profile'] !== 'string' || value['routing']['profile'].trim() === ''
    || value['routing']['profile'].length > 256
    || value['routing']['profile'] !== value['plan']['profile_id']
    || (value['routing']['intent'] !== undefined && !(SEARCH_INTENTS as readonly unknown[]).includes(value['routing']['intent']))
    || (value['routing']['freshness'] !== undefined && !(FRESHNESS_VALUES as readonly unknown[]).includes(value['routing']['freshness']))
    || (value['snapshot_version'] === EXECUTION_SNAPSHOT_VERSION && (value['routing']['execution_surface'] !== 'research-job' && value['routing']['execution_surface'] !== 'sync'
      || !['none', 'replacement', 'overlay', 'explicit'].includes(String(value['routing']['multi_agent_route'])))))) {
    throw new NbSearchError('JOB_STORE_ERROR', 'Research execution snapshot routing is invalid.');
  }
  const { snapshot_fingerprint: fingerprint, ...base } = candidate;
  if (stableFingerprint(base) !== fingerprint || planFingerprint(candidate.plan) !== candidate.plan_fingerprint) {
    throw new NbSearchError('JOB_STORE_ERROR', 'Research execution snapshot fingerprint does not match.');
  }
  if (candidate.snapshot_version === EXECUTION_SNAPSHOT_VERSION && (value['routing'] === undefined || candidate.plan.plan_version !== '3'
    || candidate.plan.routing?.profile !== candidate.routing.profile || candidate.plan.routing?.intent !== candidate.routing.intent
    || candidate.plan.routing?.freshness !== candidate.routing.freshness || candidate.plan.routing?.execution_surface !== candidate.routing.execution_surface
    || candidate.plan.routing?.multi_agent_route !== candidate.routing.multi_agent_route)) {
    throw new NbSearchError('JOB_STORE_ERROR', 'Research execution snapshot routing does not match its plan.');
  }
  if (candidate.snapshot_version === LEGACY_EXECUTION_SNAPSHOT_VERSION) validateLegacyM1Snapshot(candidate);
  if (candidate.snapshot_version === PREVIOUS_EXECUTION_SNAPSHOT_VERSION && (candidate.plan.plan_version !== '2'
    || [...candidate.plan.stages.flatMap((stage) => stage.invocations), ...(candidate.plan.omissions ?? [])].some((item) => item.capability === 'multi-agent-research'))) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Version 3 execution snapshots cannot contain multi-agent research.');
  }
  if (candidate.snapshot_version === RETRIEVAL_EXECUTION_SNAPSHOT_VERSION && candidate.plan.stages.some((stage) => stage.invocations.some((item) => item.capability !== 'retrieval'))) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Version 2 execution snapshots may contain retrieval invocations only.');
  }
  const cloned = structuredClone(candidate);
  if (value['routing'] === undefined) {
    cloned.routing = { profile: candidate.plan.profile_id };
  }
  return deepFreeze(cloned);
}

export function resolveSnapshotBindings(
  snapshot: ExecutionSnapshot,
  env: NodeJS.ProcessEnv,
  opaqueGrants: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, SecretBinding> {
  const bindings = new Map<string, SecretBinding>();
  for (const binding of snapshot.credential_bindings) {
    const value = resolveWorkerGrant(binding.worker_grant, env, opaqueGrants);
    if (value === undefined || ((binding.provider_id === 'grok' || binding.provider_id === 'grok-multi-agent') && value.length > 8192)) {
      throw new NbSearchError('CONFIGURATION_ERROR', `Worker credential grant is unavailable for slot ${binding.credential_slot_id}.`);
    }
    bindings.set(binding.credential_slot_id, {
      credential_slot_id: binding.credential_slot_id,
      provider_id: binding.provider_id,
      value,
      worker_grant: binding.worker_grant,
      ...(binding.inherited_from_slot_id === undefined ? {} : { inherited_from_slot_id: binding.inherited_from_slot_id }),
    });
  }
  return bindings;
}

function resolveWorkerGrant(
  grant: WorkerGrant,
  env: NodeJS.ProcessEnv,
  opaqueGrants: Readonly<Record<string, string>>,
): string | undefined {
  if (grant.kind === 'environment') return nonempty(env[grant.name]);
  if (grant.kind === 'opaque') return nonempty(opaqueGrants[grant.id]);
  let value: unknown;
  try { value = JSON.parse(readFileSync(grant.path, 'utf8').replace(/^\uFEFF/, '')) as unknown; }
  catch { return undefined; }
  if (!isRecord(value)) return undefined;
  const raw = value[grant.key];
  if (grant.key === 'grok') {
    return isRecord(raw) && typeof raw['apiKey'] === 'string' ? nonempty(raw['apiKey']) : undefined;
  }
  if (grant.key === 'grokMultiAgent') {
    return isRecord(raw) && typeof raw['apiKey'] === 'string' ? nonempty(raw['apiKey']) : undefined;
  }
  if (grant.key === 'searchGateway' && isRecord(raw)) {
    return nonempty(typeof raw['token'] === 'string' ? raw['token'] : undefined)
      ?? nonempty(typeof raw['apiKey'] === 'string' ? raw['apiKey'] : undefined);
  }
  if (typeof raw === 'string') return nonempty(raw);
  return isRecord(raw) && typeof raw['apiKey'] === 'string' ? nonempty(raw['apiKey']) : undefined;
}

export function assertSnapshotRegistry(snapshot: ExecutionSnapshot, registry: ProviderRegistry): void {
  if (snapshot.snapshot_version === LEGACY_EXECUTION_SNAPSHOT_VERSION) {
    validateLegacyM1Snapshot(snapshot);
    assertCurrentM1DirectWire(registry);
    return;
  }
  if (snapshot.snapshot_version === RETRIEVAL_EXECUTION_SNAPSHOT_VERSION) {
    assertVersion2Registry(snapshot, registry);
    return;
  }
  const expectedDescriptors = selectedProviderDescriptors(snapshot.plan, registry);
  const fingerprint = stableFingerprint({ schema_version: REGISTRY_SCHEMA_VERSION, descriptors: expectedDescriptors });
  if (stableFingerprint(snapshot.selected_provider_descriptors ?? []) !== stableFingerprint(expectedDescriptors)
    || fingerprint !== snapshot.registry_fingerprint || `registry-${REGISTRY_SCHEMA_VERSION}-${fingerprint.slice(0, 16)}` !== snapshot.registry_revision) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Worker provider registry does not match the execution snapshot.');
  }
}

function validateLegacyM1Snapshot(snapshot: ExecutionSnapshot): void {
  if (snapshot.registry_revision !== M1_REGISTRY_REVISION || snapshot.registry_fingerprint !== M1_REGISTRY_FINGERPRINT) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Legacy execution snapshot registry identity is not compatible.');
  }
  const providerIds = selectedProviderIds(snapshot.plan);
  if (providerIds.some((id) => id !== 'exa' && id !== 'tavily')
    || snapshot.provider_instances.some((item) => item.config.provider_id !== 'exa' && item.config.provider_id !== 'tavily')
    || snapshot.provider_instances.some((item) => Object.keys(item.config.options).length !== 0)) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Legacy execution snapshot is outside the bounded M1 compatibility rule.');
  }
}

function assertCurrentM1DirectWire(registry: ProviderRegistry): void {
  const exa = registry.requireDescriptor('exa');
  const tavily = registry.requireDescriptor('tavily');
  const direct = (descriptor: typeof exa, authKind: string, authName: string): boolean =>
    descriptor.capabilities.includes('retrieval')
    && descriptor.operations.some((item) => item.capability === 'retrieval' && item.method === 'POST'
      && item.response_type === 'json' && item.path === '/search')
    && descriptor.auth.kind === authKind && descriptor.auth.name === authName;
  if (!direct(exa, 'api-key-header', 'x-api-key') || !direct(tavily, 'api-key-body', 'api_key')) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Current providers do not preserve the bounded M1 direct wire contract.');
  }
}

function selectedProviderIds(plan: SearchPlan): string[] {
  return [...new Set([...plan.stages.flatMap((stage) => stage.invocations.map((item) => item.provider_id)), ...(plan.omissions ?? []).map((item) => item.provider_id)])].sort();
}

function selectedProviderDescriptors(plan: SearchPlan, registry: ProviderRegistry): SelectedProviderDescriptor[] {
  const capabilityOrder: ProviderCapability[] = ['retrieval', 'answer', 'research-light', 'multi-agent-research'];
  const selected = new Map<string, Set<ProviderCapability>>();
  for (const item of [...plan.stages.flatMap((stage) => stage.invocations), ...(plan.omissions ?? [])]) {
    const values = selected.get(item.provider_id) ?? new Set<ProviderCapability>(); values.add(item.capability); selected.set(item.provider_id, values);
  }
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([providerId, capabilities]) => {
    const descriptor = registry.requireDescriptor(providerId);
    const ordered = capabilityOrder.filter((item) => capabilities.has(item));
    const optionKeys = [...new Set([
      ...(ordered.includes('retrieval') ? descriptor.option_keys.filter((key) => key !== 'answer_path' && key !== 'research_light_path') : []),
      ...(ordered.includes('answer') ? ['answer_path'] : []),
      ...(ordered.includes('research-light') ? ['research_light_path'] : []),
      ...(ordered.includes('multi-agent-research') ? ['model', 'reasoning_effort', 'replace_grok'] : []),
    ])];
    const schemaProperties = isRecord(descriptor.option_schema['properties']) ? descriptor.option_schema['properties'] : {};
    const relevantOptionSchema = { ...descriptor.option_schema, properties: Object.fromEntries(optionKeys.flatMap((key) => schemaProperties[key] === undefined ? [] : [[key, schemaProperties[key]]])) };
    const base = {
      provider_id: providerId, selected_capabilities: ordered,
      selected_capability_versions: Object.fromEntries(ordered.map((capability) => [capability, descriptor.capability_versions?.[capability] ?? descriptor.adapter_version])),
      operations: descriptor.operations.filter((item) => capabilities.has(item.capability)), auth: descriptor.auth,
      relevant_option_schema: relevantOptionSchema,
    };
    return { ...base, descriptor_fingerprint: stableFingerprint(base) };
  });
}

function assertVersion2Registry(snapshot: ExecutionSnapshot, registry: ProviderRegistry): void {
  if (snapshot.plan.plan_version !== '1' || (snapshot.plan.omissions?.length ?? 0) > 0 || snapshot.selected_provider_descriptors !== undefined
    || snapshot.plan.stages.some((stage) => stage.invocations.some((item) => item.capability !== 'retrieval'))
    || snapshot.provider_instances.some((item) => item.config.capability_policies !== undefined
      || item.config.options['answer_path'] !== undefined || item.config.options['research_light_path'] !== undefined)) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Version 2 execution snapshot is outside the retrieval-only compatibility rule.');
  }
  for (const providerId of selectedProviderIds(snapshot.plan)) {
    const descriptor = registry.requireDescriptor(providerId);
    const frozen = FROZEN_L3_DESCRIPTORS[providerId];
    const currentOperation = descriptor.operations.find((item) => item.capability === 'retrieval');
    const frozenOperation = frozen?.operations.find((item) => item.capability === 'retrieval');
    const currentProperties = isRecord(descriptor.option_schema['properties']) ? descriptor.option_schema['properties'] : {};
    const frozenProperties = frozen !== undefined && isRecord(frozen.option_schema['properties']) ? frozen.option_schema['properties'] : {};
    const relevantKeys = providerId === 'exa' || providerId === 'tavily' ? ['search_path'] : frozen?.option_keys ?? [];
    if (frozen === undefined || stableFingerprint(currentOperation) !== stableFingerprint(frozenOperation)
      || stableFingerprint(descriptor.auth) !== stableFingerprint(frozen.auth)
      || relevantKeys.some((key) => stableFingerprint(currentProperties[key]) !== stableFingerprint(frozenProperties[key]))) {
      throw new NbSearchError('CONFIGURATION_ERROR', 'Current registry does not preserve the version 2 retrieval wire.');
    }
  }
  const descriptors = selectedProviderIds(snapshot.plan).map((providerId) => FROZEN_L3_DESCRIPTORS[providerId]);
  if (descriptors.some((item) => item === undefined)) throw new NbSearchError('CONFIGURATION_ERROR', 'Version 2 execution snapshot references an unsupported provider.');
  const fingerprint = stableFingerprint({ schema_version: '1', descriptors });
  if (snapshot.registry_fingerprint !== fingerprint || snapshot.registry_revision !== `registry-1-${fingerprint.slice(0, 16)}`) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Version 2 execution snapshot registry identity is invalid.');
  }
}

const FROZEN_L3_DESCRIPTORS: Readonly<Record<string, ProviderDescriptor>> = {
  exa: {
    provider_id: 'exa', adapter_version: 'l2', capabilities: ['retrieval'], activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-header', name: 'x-api-key' }, option_keys: ['search_path'],
    option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
  },
  tavily: {
    provider_id: 'tavily', adapter_version: 'l2', capabilities: ['retrieval'], activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-body', name: 'api_key' }, option_keys: ['search_path'],
    option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
  },
  grok: {
    provider_id: 'grok', adapter_version: 'l3', capabilities: ['retrieval'], activation: { kind: 'credential', required: true, endpoint: 'required' },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'text', path: '/chat/completions' }],
    auth: { kind: 'bearer-header', name: 'Authorization' }, option_keys: ['model'],
    option_schema: { type: 'object', properties: { model: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' } }, additionalProperties: false },
  },
  'search-gateway': {
    provider_id: 'search-gateway', adapter_version: 'l2', capabilities: ['retrieval'], activation: { kind: 'credential', required: true, endpoint: 'required' },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/v1/aggregate/search' }],
    auth: { kind: 'bearer-header', name: 'Authorization' }, option_keys: ['downstream_profile'],
    option_schema: { type: 'object', properties: { downstream_profile: { type: 'string', minLength: 1, maxLength: 256 } }, additionalProperties: false },
  },
};

function nonempty(value: string | undefined): string | undefined { const item = value?.trim(); return item === '' ? undefined : item }
function planFingerprint(plan: SearchPlan): string {
  const { plan_fingerprint: _fingerprint, ...base } = plan;
  return stableFingerprint(base);
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
