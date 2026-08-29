import { createRuntimeComposition } from './app.ts';
import type { NbSearchRuntime } from './runtime.ts';

export {
  capabilitiesInputSchema,
  researchCancelInputSchema,
  researchListInputSchema,
  researchReadInputSchema,
  researchStartInputSchema,
  researchStatusInputSchema,
  searchInputSchema,
} from './contracts.ts';
export type {
  CapabilitiesInput,
  OperationContext,
  ResearchCancelInput,
  ResearchListInput,
  ResearchReadInput,
  ResearchStartInput,
  ResearchStatusInput,
  SearchInput,
} from './contracts.ts';
export type { NbSearchRuntime } from './runtime.ts';
export type {
  ArtifactState,
  AttemptState,
  CapabilityEnvelope,
  ErrorEnvelope,
  JobArtifacts,
  JobProgress,
  JobReceipt,
  JobState,
  JobStatusEnvelope,
  ProviderName,
  PublicError,
  PublicErrorCode,
  ResearchArtifact,
  ResearchCancelEnvelope,
  ResearchListEnvelope,
  ResearchListItem,
  ResearchReadEnvelope,
  ResearchStartEnvelope,
  ResultProvenance,
  SearchAttempt,
  SearchEnvelope,
  SearchResult,
  SearchState,
  TerminalJobState,
} from './types.ts';

export interface CreateNbSearchRuntimeOptions {
  /** Environment-shaped configuration supplied by the embedding composition root. */
  env?: NodeJS.ProcessEnv;
}

export function createNbSearchRuntime(options: CreateNbSearchRuntimeOptions = {}): NbSearchRuntime {
  return createRuntimeComposition(options.env).runtime;
}
