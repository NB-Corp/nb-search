import type { ProviderInstanceConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import type { SecretBinding } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import {
  ExaProvider, GrokProvider, SearchGatewayProvider, TavilyProvider, validateGrokBaseUrl, validateGrokModel,
  validateProviderBaseUrl, validateSearchPath,
} from './providers.ts';
import type { HttpTransport } from './transport.ts';
import type { ProviderCapability, ProviderId, SearchProvider } from './types.ts';

export const REGISTRY_SCHEMA_VERSION = '1' as const;

export interface ProviderDescriptor {
  provider_id: ProviderId;
  adapter_version: string;
  capabilities: readonly ProviderCapability[];
  activation: { kind: 'credential' | 'explicit'; required: boolean; endpoint?: 'required' };
  operations: ReadonlyArray<{ capability: ProviderCapability; method: 'GET' | 'POST'; response_type: 'json' | 'text'; path: string }>;
  auth: { kind: 'api-key-header' | 'api-key-body' | 'bearer-header' | 'none'; name?: string };
  option_keys: readonly string[];
  option_schema: Readonly<Record<string, unknown>>;
}

export interface ProviderFactoryContext {
  instance_id: string;
  instance: ProviderInstanceConfig;
  credential?: SecretBinding;
  transports: { http: HttpTransport };
  logger?: { write(level: 'error' | 'warn' | 'info' | 'debug', event: string, fields?: Readonly<Record<string, unknown>>): void };
  clock: () => Date;
}

export interface ProviderCapabilityRequest { query: string; signal: AbortSignal }
export interface ProviderAnswerResult { text: string; metadata?: Readonly<Record<string, unknown>> }
export interface AnswerProvider { answer(request: ProviderCapabilityRequest): Promise<ProviderAnswerResult> }
export interface ResearchLightProvider { researchLight(request: ProviderCapabilityRequest): Promise<unknown> }
export interface MultiAgentResearchProvider { research(request: ProviderCapabilityRequest): Promise<unknown> }

export interface ProviderPorts {
  retrieval?: SearchProvider;
  answer?: AnswerProvider;
  research_light?: ResearchLightProvider;
  multi_agent_research?: MultiAgentResearchProvider;
}

export interface ProviderRegistration {
  descriptor: ProviderDescriptor;
  validate?(instanceId: string, instance: ProviderInstanceConfig): void;
  create(context: ProviderFactoryContext): ProviderPorts;
}

export class ProviderRegistry {
  private readonly registrations = new Map<ProviderId, ProviderRegistration>();

  constructor(registrations: readonly ProviderRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: ProviderRegistration): void {
    const id = registration.descriptor.provider_id;
    if (this.registrations.has(id)) throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${id} is registered more than once.`);
    this.registrations.set(id, registration);
  }

  descriptor(providerId: ProviderId): ProviderDescriptor | undefined {
    return this.registrations.get(providerId)?.descriptor;
  }

  requireDescriptor(providerId: ProviderId): ProviderDescriptor {
    const descriptor = this.descriptor(providerId);
    if (descriptor === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${providerId} is not registered.`);
    return descriptor;
  }

  validate(instanceId: string, instance: ProviderInstanceConfig): void {
    const registration = this.registrations.get(instance.provider_id);
    if (registration === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${instance.provider_id} is not registered.`);
    registration.validate?.(instanceId, instance);
  }

  descriptors(): readonly ProviderDescriptor[] {
    return [...this.registrations.values()].map((item) => item.descriptor)
      .sort((left, right) => left.provider_id.localeCompare(right.provider_id));
  }

  create(instanceId: string, instance: ProviderInstanceConfig, context: Omit<ProviderFactoryContext, 'instance_id' | 'instance'>): ProviderPorts {
    const registration = this.registrations.get(instance.provider_id);
    if (registration === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${instance.provider_id} is not registered.`);
    registration.validate?.(instanceId, instance);
    return registration.create({ ...context, instance_id: instanceId, instance });
  }

  fingerprintFor(providerIds: readonly ProviderId[]): string {
    const descriptors = [...new Set(providerIds)].sort().map((id) => this.requireDescriptor(id));
    return stableFingerprint({ schema_version: REGISTRY_SCHEMA_VERSION, descriptors });
  }

  revisionFor(providerIds: readonly ProviderId[]): string {
    return `registry-${REGISTRY_SCHEMA_VERSION}-${this.fingerprintFor(providerIds).slice(0, 16)}`;
  }

  fingerprint(): string {
    return stableFingerprint({ schema_version: REGISTRY_SCHEMA_VERSION, descriptors: this.descriptors() });
  }

  revision(): string { return `registry-${REGISTRY_SCHEMA_VERSION}-${this.fingerprint().slice(0, 16)}`; }
}

export function builtInProviderRegistrations(): readonly ProviderRegistration[] {
  return [exaRegistration, grokRegistration, searchGatewayRegistration, tavilyRegistration];
}

const exaRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'exa', adapter_version: 'l2', capabilities: ['retrieval'],
    activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-header', name: 'x-api-key' }, option_keys: ['search_path'],
    option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
  },
  validate: validateRelayInstance,
  create(context) {
    const credential = requireCredential(context);
    return {
      retrieval: new ExaProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(typeof context.instance.options['search_path'] === 'string' ? { searchPath: context.instance.options['search_path'] } : {}),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
    };
  },
};

const tavilyRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'tavily', adapter_version: 'l2', capabilities: ['retrieval'],
    activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-body', name: 'api_key' }, option_keys: ['search_path'],
    option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
  },
  validate: validateRelayInstance,
  create(context) {
    const credential = requireCredential(context);
    return {
      retrieval: new TavilyProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(typeof context.instance.options['search_path'] === 'string' ? { searchPath: context.instance.options['search_path'] } : {}),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
    };
  },
};

const grokRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'grok', adapter_version: 'l3', capabilities: ['retrieval'],
    activation: { kind: 'credential', required: true, endpoint: 'required' },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'text', path: '/chat/completions' }],
    auth: { kind: 'bearer-header', name: 'Authorization' }, option_keys: ['model'],
    option_schema: {
      type: 'object',
      properties: { model: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' } },
      additionalProperties: false,
    },
  },
  validate: validateGrokInstance,
  create(context) {
    const credential = requireCredential(context);
    if (context.instance.base_url === undefined || typeof context.instance.options['model'] !== 'string') {
      throw new NbSearchError('CONFIGURATION_ERROR', `Provider instance ${context.instance_id} is incomplete.`);
    }
    return {
      retrieval: new GrokProvider({
        apiKey: credential.value,
        baseUrl: context.instance.base_url,
        model: context.instance.options['model'],
        transport: context.transports.http,
        providerInstanceId: context.instance_id,
        credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
    };
  },
};

const searchGatewayRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'search-gateway', adapter_version: 'l2', capabilities: ['retrieval'],
    activation: { kind: 'credential', required: true, endpoint: 'required' },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/v1/aggregate/search' }],
    auth: { kind: 'bearer-header', name: 'Authorization' }, option_keys: ['downstream_profile'],
    option_schema: {
      type: 'object', properties: { downstream_profile: { type: 'string', minLength: 1, maxLength: 256 } },
      additionalProperties: false,
    },
  },
  validate: validateGatewayInstance,
  create(context) {
    const credential = requireCredential(context);
    return {
      retrieval: new SearchGatewayProvider({
        apiKey: credential.value,
        transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(typeof context.instance.options['downstream_profile'] === 'string'
          ? { downstreamProfile: context.instance.options['downstream_profile'] } : {}),
        providerInstanceId: context.instance_id,
        credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
    };
  },
};

function validateRelayInstance(instanceId: string, instance: ProviderInstanceConfig): void {
  validateKnownOptions(instanceId, instance, ['search_path']);
  if (instance.base_url !== undefined) validateProviderBaseUrl(instance.base_url);
  const path = instance.options['search_path'];
  if (path !== undefined) {
    if (typeof path !== 'string') throw invalidOption(instanceId);
    validateSearchPath(path);
  }
}

function validateGatewayInstance(instanceId: string, instance: ProviderInstanceConfig): void {
  validateKnownOptions(instanceId, instance, ['downstream_profile']);
  if (instance.base_url !== undefined) validateProviderBaseUrl(instance.base_url);
  const profile = instance.options['downstream_profile'];
  if (profile !== undefined && (typeof profile !== 'string' || profile.trim() === '' || profile !== profile.trim() || profile.length > 256)) {
    throw invalidOption(instanceId);
  }
}

function validateGrokInstance(instanceId: string, instance: ProviderInstanceConfig): void {
  validateKnownOptions(instanceId, instance, ['model']);
  if (instance.base_url !== undefined) validateGrokBaseUrl(instance.base_url);
  validateGrokModel(instance.options['model']);
}

function validateKnownOptions(instanceId: string, instance: ProviderInstanceConfig, keys: readonly string[]): void {
  if (Object.keys(instance.options).some((key) => !keys.includes(key))) throw invalidOption(instanceId);
}

function invalidOption(instanceId: string): NbSearchError {
  return new NbSearchError('CONFIGURATION_ERROR', `Provider instance ${instanceId} has invalid options.`);
}

function requireCredential(context: ProviderFactoryContext): SecretBinding {
  if (context.credential === undefined) {
    throw new NbSearchError('CONFIGURATION_ERROR', `Credential grant is missing for provider instance ${context.instance_id}.`);
  }
  if (context.instance.credential_slot_id !== context.credential.credential_slot_id) {
    throw new NbSearchError('CONFIGURATION_ERROR', `Credential slot does not match provider instance ${context.instance_id}.`);
  }
  if (context.instance.provider_id !== context.credential.provider_id) {
    throw new NbSearchError('CONFIGURATION_ERROR', `Credential provider does not match provider instance ${context.instance_id}.`);
  }
  return context.credential;
}
