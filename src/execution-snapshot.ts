import { readFileSync } from 'node:fs';

import type { ProviderInstanceConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import type { ResolvedConfiguration, SecretBinding, WorkerGrant } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import type { SearchPlan } from './planner.ts';
import type { ProviderRegistry } from './provider-registry.ts';

export const EXECUTION_SNAPSHOT_VERSION = '1' as const;
export const ARTIFACT_CONTRACT_VERSION = '1' as const;

export interface SnapshotProviderInstance {
  provider_instance_id: string;
  config: ProviderInstanceConfig;
}

export interface SnapshotCredentialBinding {
  credential_slot_id: string;
  provider_id: string;
  worker_grant: WorkerGrant;
}

export interface ExecutionSnapshot {
  snapshot_version: typeof EXECUTION_SNAPSHOT_VERSION;
  artifact_contract_version: typeof ARTIFACT_CONTRACT_VERSION;
  plan: SearchPlan;
  plan_fingerprint: string;
  config_revision: string;
  config_fingerprint: string;
  registry_revision: string;
  registry_fingerprint: string;
  provider_instances: readonly SnapshotProviderInstance[];
  credential_bindings: readonly SnapshotCredentialBinding[];
  snapshot_fingerprint: string;
}

export function createExecutionSnapshot(
  plan: SearchPlan,
  resolved: ResolvedConfiguration,
  registry: ProviderRegistry,
): ExecutionSnapshot {
  const selectedIds = new Set(plan.stages.flatMap((stage) => stage.invocations.map((item) => item.provider_instance_id)));
  const providerInstances = [...selectedIds].sort().map((instanceId): SnapshotProviderInstance => {
    const config = resolved.config.provider_instances[instanceId];
    if (config === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Planned provider instance ${instanceId} is missing.`);
    return { provider_instance_id: instanceId, config: structuredClone(config) };
  });
  const selectedSlots = new Set(providerInstances.flatMap((item) => item.config.credential_slot_id === undefined ? [] : [item.config.credential_slot_id]));
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
    };
  });
  const base = {
    snapshot_version: EXECUTION_SNAPSHOT_VERSION,
    artifact_contract_version: ARTIFACT_CONTRACT_VERSION,
    plan: structuredClone(plan),
    plan_fingerprint: plan.plan_fingerprint,
    config_revision: resolved.config_revision,
    config_fingerprint: resolved.config_fingerprint,
    registry_revision: registry.revision(),
    registry_fingerprint: registry.fingerprint(),
    provider_instances: providerInstances,
    credential_bindings: bindings,
  };
  return deepFreeze({ ...base, snapshot_fingerprint: stableFingerprint(base) });
}

export function validateExecutionSnapshot(value: unknown): ExecutionSnapshot {
  if (!isRecord(value) || value['snapshot_version'] !== EXECUTION_SNAPSHOT_VERSION
    || value['artifact_contract_version'] !== ARTIFACT_CONTRACT_VERSION
    || typeof value['snapshot_fingerprint'] !== 'string'
    || !isRecord(value['plan']) || !Array.isArray(value['provider_instances']) || !Array.isArray(value['credential_bindings'])) {
    throw new NbSearchError('JOB_STORE_ERROR', 'Research execution snapshot is invalid.');
  }
  const candidate = value as unknown as ExecutionSnapshot;
  const { snapshot_fingerprint: fingerprint, ...base } = candidate;
  if (stableFingerprint(base) !== fingerprint || candidate.plan.plan_fingerprint !== candidate.plan_fingerprint) {
    throw new NbSearchError('JOB_STORE_ERROR', 'Research execution snapshot fingerprint does not match.');
  }
  return deepFreeze(structuredClone(candidate));
}

export function resolveSnapshotBindings(
  snapshot: ExecutionSnapshot,
  env: NodeJS.ProcessEnv,
  opaqueGrants: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, SecretBinding> {
  const bindings = new Map<string, SecretBinding>();
  for (const binding of snapshot.credential_bindings) {
    const value = resolveWorkerGrant(binding.worker_grant, env, opaqueGrants);
    if (value === undefined) {
      throw new NbSearchError('CONFIGURATION_ERROR', `Worker credential grant is unavailable for slot ${binding.credential_slot_id}.`);
    }
    bindings.set(binding.credential_slot_id, {
      credential_slot_id: binding.credential_slot_id,
      provider_id: binding.provider_id,
      value,
      worker_grant: binding.worker_grant,
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
  if (typeof raw === 'string') return nonempty(raw);
  return isRecord(raw) && typeof raw['apiKey'] === 'string' ? nonempty(raw['apiKey']) : undefined;
}

function nonempty(value: string | undefined): string | undefined { const item = value?.trim(); return item === '' ? undefined : item }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

