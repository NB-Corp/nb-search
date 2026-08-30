import type { ProviderInstanceConfig } from './config-schema.ts';
import { stableFingerprint } from './config-schema.ts';
import type { SecretBinding } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import { ExaProvider, TavilyProvider } from './providers.ts';
import type { HttpTransport } from './transport.ts';
import type { ProviderCapability, ProviderId, SearchProvider } from './types.ts';

export const REGISTRY_SCHEMA_VERSION = '1' as const;

export interface ProviderDescriptor {
  provider_id: ProviderId;
  adapter_version: string;
  capabilities: readonly ProviderCapability[];
  activation: { kind: 'credential' | 'explicit'; required: boolean };
  operations: ReadonlyArray<{ capability: ProviderCapability; method: 'GET' | 'POST'; response_type: 'json' | 'text'; path: string }>;
  auth: { kind: 'api-key-header' | 'api-key-body' | 'none'; name?: string };
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

  descriptors(): readonly ProviderDescriptor[] {
    return [...this.registrations.values()].map((item) => item.descriptor)
      .sort((left, right) => left.provider_id.localeCompare(right.provider_id));
  }

  create(instanceId: string, instance: ProviderInstanceConfig, context: Omit<ProviderFactoryContext, 'instance_id' | 'instance'>): ProviderPorts {
    const registration = this.registrations.get(instance.provider_id);
    if (registration === undefined) throw new NbSearchError('CONFIGURATION_ERROR', `Provider ${instance.provider_id} is not registered.`);
    return registration.create({ ...context, instance_id: instanceId, instance });
  }

  fingerprint(): string {
    return stableFingerprint({ schema_version: REGISTRY_SCHEMA_VERSION, descriptors: this.descriptors() });
  }

  revision(): string { return `registry-${REGISTRY_SCHEMA_VERSION}-${this.fingerprint().slice(0, 16)}`; }
}

export function builtInProviderRegistrations(): readonly ProviderRegistration[] {
  return [exaRegistration, tavilyRegistration];
}

const exaRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'exa', adapter_version: 'm1', capabilities: ['retrieval'],
    activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-header', name: 'x-api-key' }, option_keys: [],
    option_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  create(context) {
    const credential = requireCredential(context);
    return {
      retrieval: new ExaProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
    };
  },
};

const tavilyRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'tavily', adapter_version: 'm1', capabilities: ['retrieval'],
    activation: { kind: 'credential', required: true },
    operations: [{ capability: 'retrieval', method: 'POST', response_type: 'json', path: '/search' }],
    auth: { kind: 'api-key-body', name: 'api_key' }, option_keys: [],
    option_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  create(context) {
    const credential = requireCredential(context);
    return {
      retrieval: new TavilyProvider({
        apiKey: credential.value, transport: context.transports.http,
        ...(context.instance.base_url === undefined ? {} : { baseUrl: context.instance.base_url }),
        providerInstanceId: context.instance_id, credentialSlotId: credential.credential_slot_id,
        clock: context.clock,
      }),
    };
  },
};

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
