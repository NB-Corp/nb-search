import { z } from 'zod';
import { FRESHNESS_VALUES } from './types.ts';

export const freshnessSchema = z.enum(FRESHNESS_VALUES);
const selectorShape = { lane: z.string().trim().min(1).max(256).optional(), lanes: z.array(z.string().trim().min(1).max(256)).min(1).optional(), preset: z.string().trim().min(1).max(256).optional() };
const runSchema = z.object({ action: z.literal('run'), query: z.union([z.string().trim().min(1).max(4000), z.array(z.string().trim().min(1).max(4000)).min(1).max(64)]), ...selectorShape, execution: z.enum(['sync', 'async']).optional(), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), freshness: freshnessSchema.optional(), max_results: z.number().int().min(1).max(100).optional(), timeout_ms: z.number().int().min(100).max(3_600_000).optional() }).strict().superRefine((value, context) => { if ([value.lane, value.lanes, value.preset].filter((item) => item !== undefined).length > 1) context.addIssue({ code: 'custom', message: 'lane, lanes, and preset are mutually exclusive' }); const execution = value.execution ?? 'sync'; if (execution === 'async' && value.idempotency_key === undefined) context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'async execution requires idempotency_key' }); if (execution === 'sync' && value.idempotency_key !== undefined) context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'sync execution does not accept idempotency_key' }); });
const getSchema = z.object({ action: z.literal('get'), job_id: z.string().uuid() }).strict();
const readSchema = z.object({ action: z.literal('read'), job_id: z.string().uuid(), cursor: z.string().min(1).max(2048).optional(), page_size: z.number().int().min(1).max(100).optional() }).strict();
const cancelSchema = z.object({ action: z.literal('cancel'), job_id: z.string().uuid() }).strict();
export const searchInputSchema = z.discriminatedUnion('action', [runSchema, getSchema, readSchema, cancelSchema]);
export const fetchInputSchema = z.object({ url: z.string().url().max(4096), lane: z.string().trim().min(1).max(256).optional(), timeout_ms: z.number().int().min(100).max(120_000).optional(), max_content_chars: z.number().int().min(1).max(10_000_000).optional() }).strict();
export const capabilitiesInputSchema = z.object({}).strict();
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchRunInput = z.infer<typeof runSchema>;
export type SearchGetInput = z.infer<typeof getSchema>;
export type SearchReadInput = z.infer<typeof readSchema>;
export type SearchCancelInput = z.infer<typeof cancelSchema>;
export type FetchInput = z.infer<typeof fetchInputSchema>;
export type CapabilitiesInput = z.infer<typeof capabilitiesInputSchema>;
export interface OperationContext { requestId?: string; signal?: AbortSignal }
