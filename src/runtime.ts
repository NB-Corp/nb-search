import type {
  CapabilitiesInput, OperationContext, ResearchCancelInput, ResearchListInput, ResearchReadInput,
  ResearchStartInput, ResearchStatusInput, SearchInput,
} from './contracts.ts';
import {
  capabilitiesInputSchema, researchCancelInputSchema, researchListInputSchema, researchReadInputSchema,
  researchStartInputSchema, researchStatusInputSchema, searchInputSchema,
} from './contracts.ts';
import type { SearchService } from './core.ts';
import { NbSearchError } from './errors.ts';
import type { ResearchService } from './research.ts';
import type {
  CapabilityEnvelope, JobStatusEnvelope, ResearchCancelEnvelope, ResearchListEnvelope, ResearchReadEnvelope,
  ResearchStartEnvelope, SearchEnvelope,
} from './types.ts';
import { SCHEMA_VERSION } from './types.ts';

export interface NbSearchRuntime {
  search(input: SearchInput, context?: OperationContext): Promise<SearchEnvelope>;
  researchStart(input: ResearchStartInput, context?: OperationContext): Promise<ResearchStartEnvelope>;
  researchStatus(input: ResearchStatusInput, context?: OperationContext): Promise<JobStatusEnvelope>;
  researchRead(input: ResearchReadInput, context?: OperationContext): Promise<ResearchReadEnvelope>;
  researchList(input: ResearchListInput, context?: OperationContext): Promise<ResearchListEnvelope>;
  researchCancel(input: ResearchCancelInput, context?: OperationContext): Promise<ResearchCancelEnvelope>;
  capabilities(input?: CapabilitiesInput, context?: OperationContext): Promise<CapabilityEnvelope>;
}

interface RuntimeDependencies {
  search: SearchService;
  research: ResearchService;
  requestId: () => string;
  providerConfigured: Readonly<Record<'exa' | 'tavily', boolean> & Partial<Record<'grok', boolean>>>;
  retentionHours: number;
  providerInstances?: CapabilityEnvelope['providers']['instances'];
  profiles?: CapabilityEnvelope['profiles'];
  capabilityRoutes?: CapabilityEnvelope['capability_routes'];
  configurationDiagnostics?: NonNullable<CapabilityEnvelope['diagnostics']['configuration']>;
}

export class NbSearchRuntimeImpl implements NbSearchRuntime {
  constructor(private readonly dependencies: RuntimeDependencies) {}

  async search(input: SearchInput, context: OperationContext = {}): Promise<SearchEnvelope> {
    const parsed = searchInputSchema.parse(input);
    assertActive(context.signal);
    return await this.dependencies.search.search({ ...parsed, signal: context.signal }, context.requestId);
  }

  async researchStart(input: ResearchStartInput, context: OperationContext = {}): Promise<ResearchStartEnvelope> {
    const parsed = researchStartInputSchema.parse(input);
    assertActive(context.signal);
    return await this.dependencies.research.start(parsed, context);
  }

  async researchStatus(input: ResearchStatusInput, context: OperationContext = {}): Promise<JobStatusEnvelope> {
    const parsed = researchStatusInputSchema.parse(input);
    assertActive(context.signal);
    return await this.dependencies.research.status(parsed.job_id, context.requestId);
  }

  async researchRead(input: ResearchReadInput, context: OperationContext = {}): Promise<ResearchReadEnvelope> {
    const parsed = researchReadInputSchema.parse(input);
    assertActive(context.signal);
    return await this.dependencies.research.read(parsed, context.requestId);
  }

  async researchList(input: ResearchListInput, context: OperationContext = {}): Promise<ResearchListEnvelope> {
    const parsed = researchListInputSchema.parse(input);
    assertActive(context.signal);
    return await this.dependencies.research.list(parsed, context.requestId);
  }

  async researchCancel(input: ResearchCancelInput, context: OperationContext = {}): Promise<ResearchCancelEnvelope> {
    const parsed = researchCancelInputSchema.parse(input);
    assertActive(context.signal);
    return await this.dependencies.research.cancel(parsed.job_id, context.requestId);
  }

  async capabilities(input: CapabilitiesInput = {}, context: OperationContext = {}): Promise<CapabilityEnvelope> {
    capabilitiesInputSchema.parse(input);
    assertActive(context.signal);
    return {
      schema_version: SCHEMA_VERSION,
      request_id: context.requestId ?? this.dependencies.requestId(),
      mode: 'capabilities',
      version: '0.1.0',
      search: { max_results: 20, default_timeout_ms: 20_000, max_timeout_ms: 120_000 },
      research: {
        max_sources: 100,
        max_duration_ms: 3_600_000,
        detached_worker: true,
        guaranteed_process_survival: false,
        artifacts: ['summary', 'report', 'sources', 'capabilities'],
        capability_once_per_job: true,
      },
      providers: {
        exa: { configured: this.dependencies.providerConfigured.exa },
        tavily: { configured: this.dependencies.providerConfigured.tavily },
        grok: { configured: this.dependencies.providerConfigured.grok === true },
        ...(this.dependencies.providerInstances === undefined ? {} : { instances: this.dependencies.providerInstances }),
      },
      ...(this.dependencies.profiles === undefined ? {} : { profiles: this.dependencies.profiles }),
      ...(this.dependencies.capabilityRoutes === undefined ? {} : { capability_routes: this.dependencies.capabilityRoutes }),
      persistence: {
        durable_jobs: true,
        cancellation_markers: true,
        retention_hours: this.dependencies.retentionHours,
        stale_after_ms: 30_000,
      },
      transport: { mcp: 'stdio', cli_direct_service: true },
      diagnostics: {
        network_probe_performed: false,
        ...(this.dependencies.configurationDiagnostics === undefined ? {} : {
          configuration: this.dependencies.configurationDiagnostics,
        }),
      },
    };
  }
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new NbSearchError('CANCELLED', 'The operation was cancelled.');
}
