import { createHash } from 'node:crypto';

import { z } from 'zod';

import { NbSearchError } from './errors.ts';
import type { ProviderCapability } from './types.ts';

export const CONFIG_SCHEMA_VERSION = '1' as const;
export const DEFAULT_PROFILE_ID = 'default';

export interface RetryPolicyConfig {
  max_attempts: number;
  backoff_ms: number;
  max_backoff_ms: number;
}

export interface ProviderInstanceConfig {
  provider_id: string;
  enabled: boolean;
  credential_slot_id?: string;
  base_url?: string;
  timeout_ms: number;
  retry: RetryPolicyConfig;
  options: Readonly<Record<string, unknown>>;
}

export interface CredentialSlotConfig {
  provider_id: string;
  env?: string;
  worker_grant?: string;
}

export interface ProfileInvocationConfig {
  provider_instance_id: string;
  capability: ProviderCapability;
  role: string;
  trigger: string;
  timeout_ms?: number;
  retry?: Partial<RetryPolicyConfig>;
}

export interface ProfileStageConfig {
  kind: 'parallel' | 'fallback' | 'augmentation';
  invocations: readonly ProfileInvocationConfig[];
}

export interface ProfileConfig {
  stages: readonly ProfileStageConfig[];
}

export interface CanonicalConfig {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  home?: string;
  jobs_root?: string;
  retention_hours: number;
  log_level: 'error' | 'warn' | 'info' | 'debug';
  provider_instances: Readonly<Record<string, ProviderInstanceConfig>>;
  credential_slots: Readonly<Record<string, CredentialSlotConfig>>;
  profiles: Readonly<Record<string, ProfileConfig>>;
  default_profile_id: string;
}

export interface CanonicalConfigPatch {
  schema_version?: typeof CONFIG_SCHEMA_VERSION | null;
  home?: string | null;
  jobs_root?: string | null;
  retention_hours?: number | null;
  log_level?: CanonicalConfig['log_level'] | null;
  provider_instances?: Readonly<Record<string, ProviderInstancePatch | null>> | null;
  credential_slots?: Readonly<Record<string, CredentialSlotConfig | null>> | null;
  profiles?: Readonly<Record<string, ProfileConfig | null>> | null;
  default_profile_id?: string | null;
}

export type ProviderInstancePatch = Partial<Omit<ProviderInstanceConfig, 'retry' | 'options'>> & {
  retry?: Partial<RetryPolicyConfig> | null;
  options?: Readonly<Record<string, unknown>> | null;
};

const retrySchema = z.object({
  max_attempts: z.number().int().min(1).max(10),
  backoff_ms: z.number().int().min(0).max(60_000),
  max_backoff_ms: z.number().int().min(0).max(300_000),
}).strict();

const retryPatchSchema = retrySchema.partial().strict();
const providerInstanceSchema = z.object({
  provider_id: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  credential_slot_id: z.string().trim().min(1).max(256).optional(),
  base_url: z.string().url().optional(),
  timeout_ms: z.number().int().min(100).max(3_600_000),
  retry: retrySchema,
  options: z.record(z.string(), z.unknown()),
}).strict();

const providerInstancePatchSchema = providerInstanceSchema.partial().extend({
  retry: retryPatchSchema.nullable().optional(),
  options: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

const credentialSlotSchema = z.object({
  provider_id: z.string().trim().min(1).max(128),
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  worker_grant: z.string().trim().min(1).max(512).optional(),
}).strict().refine((value) => value.env !== undefined || value.worker_grant !== undefined, {
  message: 'credential slot requires env or worker_grant',
});

const invocationSchema = z.object({
  provider_instance_id: z.string().trim().min(1).max(256),
  capability: z.enum(['retrieval', 'answer', 'research-light', 'multi-agent-research']),
  role: z.string().trim().min(1).max(128),
  trigger: z.string().trim().min(1).max(128),
  timeout_ms: z.number().int().min(100).max(3_600_000).optional(),
  retry: retryPatchSchema.optional(),
}).strict();

const profileSchema = z.object({
  stages: z.array(z.object({
    kind: z.enum(['parallel', 'fallback', 'augmentation']),
    invocations: z.array(invocationSchema).min(1).max(64),
  }).strict()).min(1).max(32),
}).strict();

const configSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  home: z.string().trim().min(1).optional(),
  jobs_root: z.string().trim().min(1).optional(),
  retention_hours: z.number().positive().max(24 * 3650),
  log_level: z.enum(['error', 'warn', 'info', 'debug']),
  provider_instances: z.record(z.string().min(1), providerInstanceSchema),
  credential_slots: z.record(z.string().min(1), credentialSlotSchema),
  profiles: z.record(z.string().min(1), profileSchema),
  default_profile_id: z.string().trim().min(1).max(256),
}).strict().superRefine((value, context) => {
  if (value.profiles[value.default_profile_id] === undefined) {
    context.addIssue({ code: 'custom', path: ['default_profile_id'], message: 'default profile is not configured' });
  }
  for (const [instanceId, instance] of Object.entries(value.provider_instances)) {
    if (instance.credential_slot_id !== undefined && value.credential_slots[instance.credential_slot_id] === undefined) {
      context.addIssue({ code: 'custom', path: ['provider_instances', instanceId, 'credential_slot_id'], message: 'credential slot is not configured' });
    } else if (instance.credential_slot_id !== undefined
      && value.credential_slots[instance.credential_slot_id]?.provider_id !== instance.provider_id) {
      context.addIssue({ code: 'custom', path: ['provider_instances', instanceId, 'credential_slot_id'], message: 'credential slot provider does not match the instance provider' });
    }
  }
  for (const [profileId, profile] of Object.entries(value.profiles)) {
    profile.stages.forEach((stage, stageIndex) => stage.invocations.forEach((invocation, invocationIndex) => {
      if (value.provider_instances[invocation.provider_instance_id] === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', profileId, 'stages', stageIndex, 'invocations', invocationIndex, 'provider_instance_id'],
          message: 'provider instance is not configured',
        });
      }
    }));
  }
});

const configPatchSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION).nullable().optional(),
  home: z.string().trim().min(1).nullable().optional(),
  jobs_root: z.string().trim().min(1).nullable().optional(),
  retention_hours: z.number().positive().max(24 * 3650).nullable().optional(),
  log_level: z.enum(['error', 'warn', 'info', 'debug']).nullable().optional(),
  provider_instances: z.record(z.string().min(1), providerInstancePatchSchema.nullable()).nullable().optional(),
  credential_slots: z.record(z.string().min(1), credentialSlotSchema.nullable()).nullable().optional(),
  profiles: z.record(z.string().min(1), profileSchema.nullable()).nullable().optional(),
  default_profile_id: z.string().trim().min(1).max(256).nullable().optional(),
}).strict();

export function parseConfigPatch(value: unknown, source: string): CanonicalConfigPatch {
  const parsed = configPatchSchema.safeParse(value);
  if (!parsed.success) throw configurationError(source, parsed.error.issues);
  return parsed.data as CanonicalConfigPatch;
}

export function parseResolvedConfig(value: unknown): CanonicalConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw configurationError('resolved configuration', parsed.error.issues);
  return parsed.data as CanonicalConfig;
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function configurationError(source: string, issues: readonly z.core.$ZodIssue[]): NbSearchError {
  const details = issues.slice(0, 3).map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
  return new NbSearchError('CONFIGURATION_ERROR', `${source} is invalid: ${details}.`);
}
