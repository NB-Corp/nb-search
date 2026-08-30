import type { ProviderInstanceConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import type { SecretBinding } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import {
  ExaProvider, ExaResearchLightProvider, GrokMultiAgentProvider, GrokProvider, SearchGatewayProvider, TavilyAnswerProvider, TavilyProvider,
  validateGmaEffort, validateGrokBaseUrl, validateGrokModel,
  validateProviderBaseUrl, validateSearchPath,
} from './providers.ts';
import type { HttpTransport } from './transport.ts';
import type { AnswerProvider, MultiAgentResearchProvider, ProviderCapability, ProviderId, ResearchLightProvider, SearchProvider } from './types.ts';
export type { AnswerProvider, MultiAgentResearchProvider, ResearchLightProvider, ProviderCapabilityRequest } from './types.ts';
export type ProviderAnswerResult = import('./types.ts').ProviderAnswerCapabilityResult;

export const REGISTRY_SCHEMA_VERSION = '2' as const;

export interface ProviderDescriptor {
  provider_id: ProviderId;
  adapter_version: string;
  capability_versions?: Readonly<Partial<Record<ProviderCapability, string>>>;
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
  return [exaRegistration, grokMultiAgentRegistration, grokRegistration, searchGatewayRegistration, tavilyRegistration];
}

const exaRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'exa', adapter_version: 'l4', capabilities: ['retrieval', 'research-light'],
    capability_versions: { retrieval: 'l2', 'research-light': 'l4' },
    activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }, { capability: 'research-light', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-header', name: 'x-api-key' }, option_keys: ['search_path', 'research_light_path'],
    option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 }, research_light_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
  },
  validate: validateRelayInstance,
  create(context) {
    const credential = requireCredential(context);
    const searchPath = typeof context.instance.options['search_path'] === 'string' ? context.instance.options['search_path'] : undefined;
    const researchPath = typeof context.instance.options['research_light_path'] === 'string' ? context.instance.options['research_light_path'] : undefined;
    return {
      retrieval: new ExaProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(searchPath === undefined ? {} : { searchPath }),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
      ...(searchPath !== undefined && researchPath === undefined ? {} : { research_light: new ExaResearchLightProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(researchPath === undefined ? {} : { operationPath: researchPath }),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id, clock: context.clock,
      }) }),
    };
  },
};

const tavilyRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'tavily', adapter_version: 'l4', capabilities: ['retrieval', 'answer'],
    capability_versions: { retrieval: 'l2', answer: 'l4' },
    activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }, { capability: 'answer', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-body', name: 'api_key' }, option_keys: ['search_path', 'answer_path'],
    option_schema: { type: 'object', properties: { search_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 }, answer_path: { type: 'string', format: 'nb-search-operation-path', maxLength: 512 } }, additionalProperties: false },
  },
  validate: validateRelayInstance,
  create(context) {
    const credential = requireCredential(context);
    const searchPath = typeof context.instance.options['search_path'] === 'string' ? context.instance.options['search_path'] : undefined;
    const answerPath = typeof context.instance.options['answer_path'] === 'string' ? context.instance.options['answer_path'] : undefined;
    return {
      retrieval: new TavilyProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(searchPath === undefined ? {} : { searchPath }),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
      ...(searchPath !== undefined && answerPath === undefined ? {} : { answer: new TavilyAnswerProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        ...(answerPath === undefined ? {} : { operationPath: answerPath }),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id, clock: context.clock,
      }) }),
    };
  },
};

const grokRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'grok', adapter_version: 'l3', capabilities: ['retrieval'],
    capability_versions: { retrieval: 'l3' },
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

const grokMultiAgentRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'grok-multi-agent', adapter_version: 'l5', capabilities: ['multi-agent-research'],
    capability_versions: { 'multi-agent-research': 'l5' },
    activation: { kind: 'credential', required: true, endpoint: 'required' },
    operations: [{ capability: 'multi-agent-research', method: 'POST', response_type: 'text', path: '/chat/completions' }],
    auth: { kind: 'bearer-header', name: 'Authorization' }, option_keys: ['model', 'reasoning_effort', 'replace_grok'],
    option_schema: {
      type: 'object',
      properties: {
        model: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' },
        reasoning_effort: { enum: ['low', 'medium', 'high', 'xhigh'] },
        replace_grok: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  validate: validateGmaInstance,
  create(context) {
    const credential = requireCredential(context);
    if (context.instance.base_url === undefined || typeof context.instance.options['model'] !== 'string') {
      throw new NbSearchError('CONFIGURATION_ERROR', `Provider instance ${context.instance_id} is incomplete.`);
    }
    validateGmaEffort(context.instance.options['reasoning_effort']);
    return { multi_agent_research: new GrokMultiAgentProvider({
      apiKey: credential.value, baseUrl: context.instance.base_url, model: context.instance.options['model'],
      reasoningEffort: context.instance.options['reasoning_effort'], transport: context.transports.http,
      providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id, clock: context.clock,
    }) };
  },
};

const searchGatewayRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'search-gateway', adapter_version: 'l2', capabilities: ['retrieval'],
    capability_versions: { retrieval: 'l2' },
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
  const keys = instance.provider_id === 'exa' ? ['search_path', 'research_light_path'] : ['search_path', 'answer_path'];
  validateKnownOptions(instanceId, instance, keys);
  if (instance.base_url !== undefined) validateProviderBaseUrl(instance.base_url);
  for (const path of keys.map((key) => instance.options[key]).filter((value) => value !== undefined)) {
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

function validateGmaInstance(instanceId: string, instance: ProviderInstanceConfig): void {
  validateKnownOptions(instanceId, instance, ['model', 'reasoning_effort', 'replace_grok']);
  if (instance.base_url !== undefined) validateGrokBaseUrl(instance.base_url);
  validateGrokModel(instance.options['model']);
  validateGmaEffort(instance.options['reasoning_effort']);
  if (typeof instance.options['replace_grok'] !== 'boolean') throw invalidOption(instanceId);
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
