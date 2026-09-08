import { resolve } from 'node:path';
import type { ProviderInstanceConfig } from './config-schema.ts';
import { NbSearchError } from './errors.ts';
import { resolveExaContentsUrl } from './fetch-providers.ts';
import { builtInProviderRegistrations, type ProviderDescriptor } from './provider-registry.ts';
import { EXA_SEARCH_URL, resolveGmaOptions, resolveGmaUrl, resolveSearchUrl } from './providers.ts';
import type { FetchOperationDescriptor, QueryOperationDescriptor } from './types.ts';

export type ResolvedProviderOperation = {
  provider: ProviderDescriptor;
  /** Effective instance to pass to the SDK factory; no credentials are resolved. */
  instance: ProviderInstanceConfig;
  /** Adapter request targets, not a universal network allowlist for user code. */
  endpoints: readonly string[];
} & ({ kind: 'search'; operation: QueryOperationDescriptor } | { kind: 'fetch'; operation: FetchOperationDescriptor });

/**
 * Offline host inspection for Exa, GMA and script operations. Uses adapter URL
 * resolvers and registration validation, never creates providers or imports scripts.
 * Script relative paths follow inline SDK configuration rules (current cwd).
 * Other providers deliberately fail rather than claim incomplete endpoint coverage.
 */
export function resolveProviderOperation(providerId: string, operationId: string, input: ProviderInstanceConfig): ResolvedProviderOperation {
  if (input.provider_id !== providerId) throw new NbSearchError('CONFIGURATION_ERROR', 'Provider operation instance identity does not match.');
  const registration = builtInProviderRegistrations().find((entry) => entry.descriptor.provider_id === providerId);
  const provider = registration?.descriptor;
  const query = provider?.query_operations.find((entry) => entry.operation_id === operationId);
  const fetch = provider?.fetch_operations.find((entry) => entry.operation_id === operationId);
  if (!registration || !provider || (!query && !fetch)) throw new NbSearchError('LANE_NOT_REGISTERED', 'Provider operation is not registered.');
  if (!['exa', 'grok-multi-agent', 'script'].includes(providerId)) throw new NbSearchError('CONFIGURATION_ERROR', 'Offline provider operation resolution is not supported for this provider.');
  // Validate original keys before normalizing defaults (unknown options must not disappear).
  registration.validate?.('host', input);
  let instance = structuredClone(input);
  let endpoints: string[];
  if (providerId === 'grok-multi-agent') {
    const options = resolveGmaOptions(instance.options);
    instance = { ...instance, options };
    if (instance.base_url === undefined) throw new NbSearchError('CONFIGURATION_ERROR', 'GMA operation requires a base URL.');
    endpoints = [resolveGmaUrl(instance.base_url, options.api_mode)];
  } else if (providerId === 'exa') {
    endpoints = [operationId === 'contents' ? resolveExaContentsUrl(instance.base_url)
      : resolveSearchUrl(instance.base_url ?? EXA_SEARCH_URL, instance.options[operationId === 'synthesis' ? 'synthesis_path' : 'search_path'] as string | undefined)];
  } else {
    instance = { ...instance, options: { module: resolve(instance.options['module'] as string), params: instance.options['params'] ?? {} } };
    endpoints = [];
  }
  return { provider: structuredClone(provider), instance, endpoints, ...(query ? { kind: 'search' as const, operation: structuredClone(query) } : { kind: 'fetch' as const, operation: structuredClone(fetch!) }) };
}
