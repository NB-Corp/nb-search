import { z } from 'zod';

import { FRESHNESS_VALUES, SEARCH_INTENTS, SEARCH_PROFILE_IDS } from './types.ts';

export const searchProfileSchema = z.enum(SEARCH_PROFILE_IDS);
export const searchIntentSchema = z.enum(SEARCH_INTENTS);
export const freshnessSchema = z.enum(FRESHNESS_VALUES);

const routingInputShape = {
  profile: searchProfileSchema.optional(),
  intent: searchIntentSchema.optional(),
  freshness: freshnessSchema.optional(),
};

export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  max_results: z.number().int().min(1).max(20).optional(),
  timeout_ms: z.number().int().min(1000).max(120_000).optional(),
  ...routingInputShape,
}).strict();

export const researchStartInputSchema = z.object({
  query: z.string().trim().min(1).max(8000),
  max_sources: z.number().int().min(5).max(100).optional(),
  max_duration_ms: z.number().int().min(60_000).max(3_600_000).optional(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  ...routingInputShape,
}).strict();

export const researchStatusInputSchema = z.object({ job_id: z.string().uuid() }).strict();

export const researchReadInputSchema = researchStatusInputSchema.extend({
  artifact: z.enum(['summary', 'report', 'sources', 'capabilities', 'multi_agent_research']).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  page_size: z.number().int().min(1).max(100).optional(),
}).strict();

export const jobStateSchema = z.enum([
  'queued', 'running', 'cancelling', 'succeeded', 'partial', 'failed', 'timed_out', 'cancelled',
]);

export const researchListInputSchema = z.object({
  states: z.array(jobStateSchema).max(8).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const researchCancelInputSchema = researchStatusInputSchema;
export const capabilitiesInputSchema = z.object({}).strict();

export type SearchInput = z.infer<typeof searchInputSchema>;
export type ResearchStartInput = z.infer<typeof researchStartInputSchema>;
export type ResearchStatusInput = z.infer<typeof researchStatusInputSchema>;
export type ResearchReadInput = z.infer<typeof researchReadInputSchema>;
export type ResearchListInput = z.infer<typeof researchListInputSchema>;
export type ResearchCancelInput = z.infer<typeof researchCancelInputSchema>;
export type CapabilitiesInput = z.infer<typeof capabilitiesInputSchema>;

export interface OperationContext {
  requestId?: string;
  signal?: AbortSignal;
}
