import { resolve } from 'node:path';

import type { CanonicalConfigPatch } from './config-schema.ts';
import {
  resolveConfiguration, type ConfigurationDiagnostic, type ResolvedConfiguration,
} from './config-sources.ts';
import {
  builtInProviderRegistrations, ProviderRegistry, type ProviderRegistration,
} from './provider-registry.ts';
import { NbSearchError } from './errors.ts';
import { FetchJsonTransport, type JsonTransport } from './transport.ts';
import type { SearchProvider } from './types.ts';

export interface AppConfiguration {
  home: string;
  jobs_root: string;
  retention_hours: number;
  log_level: 'error' | 'warn' | 'info' | 'debug';
  providers: SearchProvider[];
  providers_by_instance: ReadonlyMap<string, SearchProvider>;
  provider_configured: Record<'exa' | 'tavily', boolean>;
  provider_readiness: Readonly<Record<string, boolean>>;
  resolved: ResolvedConfiguration;
  registry: ProviderRegistry;
  diagnostics: readonly ConfigurationDiagnostic[];
}

export interface LoadConfigurationOptions {
  config?: CanonicalConfigPatch;
  overrides?: CanonicalConfigPatch;
  provider_registrations?: readonly ProviderRegistration[];
  cwd?: string;
  homeDirectory?: string;
  now?: () => Date;
}

export function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  transport: JsonTransport = new FetchJsonTransport(),
  options: LoadConfigurationOptions = {},
): AppConfiguration {
  const resolved = resolveConfiguration({
    env,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  });
  const registry = new ProviderRegistry([
    ...builtInProviderRegistrations(),
    ...(options.provider_registrations ?? []),
  ]);
  const providers: SearchProvider[] = [];
  const providersByInstance = new Map<string, SearchProvider>();
  const readiness: Record<string, boolean> = {};
  for (const [instanceId, instance] of Object.entries(resolved.config.provider_instances).sort(([left], [right]) => left.localeCompare(right))) {
    const descriptor = registry.descriptor(instance.provider_id);
    if (instance.enabled && descriptor === undefined) {
      throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${instance.provider_id} is not registered for instance ${instanceId}.`);
    }
    if (descriptor !== undefined) registry.validate(instanceId, instance);
    const credential = instance.credential_slot_id === undefined ? undefined : resolved.secret_bindings.get(instance.credential_slot_id);
    const ready = instance.enabled && descriptor !== undefined
      && (!descriptor.activation.required || credential !== undefined)
      && (descriptor.activation.endpoint !== 'required' || instance.base_url !== undefined);
    readiness[instanceId] = ready;
    if (!ready) continue;
    const ports = registry.create(instanceId, instance, {
      ...(credential === undefined ? {} : { credential }),
      transports: { http: transport },
      clock: options.now ?? (() => new Date()),
    });
    if (ports.retrieval !== undefined) {
      providers.push(ports.retrieval);
      providersByInstance.set(instanceId, ports.retrieval);
    }
  }
  const configured = (providerId: 'exa' | 'tavily'): boolean => Object.entries(resolved.config.provider_instances)
    .some(([instanceId, instance]) => instance.provider_id === providerId && readiness[instanceId] === true);
  return {
    home: resolve(resolved.config.home ?? '.'),
    jobs_root: resolve(resolved.config.jobs_root ?? resolve(resolved.config.home ?? '.', 'jobs')),
    retention_hours: resolved.config.retention_hours,
    log_level: resolved.config.log_level,
    providers,
    providers_by_instance: providersByInstance,
    provider_configured: { exa: configured('exa'), tavily: configured('tavily') },
    provider_readiness: readiness,
    resolved,
    registry,
    diagnostics: resolved.diagnostics,
  };
}
