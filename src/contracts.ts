import { z } from 'zod';
import { FRESHNESS_VALUES } from './types.ts';

export const freshnessSchema = z.enum(FRESHNESS_VALUES);
const selectorShape = { lane: z.string().trim().min(1).max(256).optional(), lanes: z.array(z.string().trim().min(1).max(256)).min(1).optional(), preset: z.string().trim().min(1).max(256).optional() };
const runSchema = z.object({ action: z.literal('run'), query: z.union([z.string().trim().min(1).max(4000), z.array(z.string().trim().min(1).max(4000)).min(1).max(64)]), ...selectorShape, execution: z.enum(['sync', 'async']).optional(), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), freshness: freshnessSchema.optional(), max_results: z.number().int().min(1).max(100).optional(), timeout_ms: z.number().int().min(100).max(3_600_000).optional() }).strict().superRefine((value, context) => { if ([value.lane, value.lanes, value.preset].filter((item) => item !== undefined).length > 1) context.addIssue({ code: 'custom', message: 'lane, lanes, and preset are mutually exclusive' }); const execution = value.execution ?? 'sync'; if (execution === 'async' && value.idempotency_key === undefined) context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'async execution requires idempotency_key' }); if (execution === 'sync' && value.idempotency_key !== undefined) context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'sync execution does not accept idempotency_key' }); });
const getSchema = z.object({ action: z.literal('get'), job_id: z.string().uuid() }).strict();
const readSchema = z.object({ action: z.literal('read'), job_id: z.string().uuid(), cursor: z.string().min(1).max(2048).optional(), page_size: z.number().int().min(1).max(100).optional() }).strict();
const cancelSchema = z.object({ action: z.literal('cancel'), job_id: z.string().uuid() }).strict();
export const searchInputSchema = z.discriminatedUnion('action', [runSchema, getSchema, readSchema, cancelSchema]);

const httpUrl = z.string().url().max(4096).refine((value) => { const protocol = new URL(value).protocol; return protocol === 'http:' || protocol === 'https:'; }, 'URL must use http or https');
const fetchSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: httpUrl }).strict(),
  z.object({ kind: z.literal('inline_text'), content: z.string(), media_type: z.enum(['text/html', 'text/plain', 'text/markdown']), base_url: httpUrl.optional() }).strict(),
  z.object({ kind: z.literal('inline_bytes'), content_base64: z.string().min(1).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), media_type: z.string().trim().min(1).max(256), filename: z.string().trim().min(1).max(1024).optional() }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().trim().min(1).max(4096), scope: z.string().trim().min(1).max(256) }).strict(),
]);
const fetchRunShape = { source: fetchSourceSchema, pipeline: z.string().trim().min(1).max(256).optional(), representation: z.enum(['markdown', 'text']).optional(), execution: z.enum(['sync', 'async']).optional(), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), timeout_ms: z.number().int().min(100).max(120_000).optional(), max_content_chars: z.number().int().min(1).max(10_000_000).optional() };
const fetchRunSchema = z.object({ action: z.literal('run'), ...fetchRunShape }).strict().superRefine(validateFetchExecution);
const fetchGetSchema = z.object({ action: z.literal('get'), job_id: z.string().uuid() }).strict();
const fetchReadSchema = z.object({ action: z.literal('read'), job_id: z.string().uuid(), cursor: z.string().min(1).max(2048).optional(), page_size: z.number().int().min(1).max(100).optional() }).strict();
const fetchCancelSchema = z.object({ action: z.literal('cancel'), job_id: z.string().uuid() }).strict();
export const fetchActionInputSchema = z.discriminatedUnion('action', [fetchRunSchema, fetchGetSchema, fetchReadSchema, fetchCancelSchema]);
const legacyFetchSchema = z.object({ url: httpUrl, pipeline: z.string().trim().min(1).max(256).optional(), representation: z.enum(['markdown', 'text']).optional(), execution: z.enum(['sync', 'async']).optional(), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), timeout_ms: z.number().int().min(100).max(120_000).optional(), max_content_chars: z.number().int().min(1).max(10_000_000).optional() }).strict().superRefine(validateFetchExecution).transform(({ url, ...value }) => ({ action: 'run' as const, source: { kind: 'url' as const, url }, ...value }));
export const fetchInputSchema = z.union([fetchActionInputSchema, legacyFetchSchema]);
export const capabilitiesInputSchema = z.object({}).strict();
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchRunInput = z.infer<typeof runSchema>;
export type SearchGetInput = z.infer<typeof getSchema>;
export type SearchReadInput = z.infer<typeof readSchema>;
export type SearchCancelInput = z.infer<typeof cancelSchema>;
export type FetchInput = z.input<typeof fetchInputSchema>;
export type FetchParsedInput = z.output<typeof fetchInputSchema>;
export type FetchRunInput = z.infer<typeof fetchRunSchema>;
export type FetchGetInput = z.infer<typeof fetchGetSchema>;
export type FetchReadInput = z.infer<typeof fetchReadSchema>;
export type FetchCancelInput = z.infer<typeof fetchCancelSchema>;
export type CapabilitiesInput = z.infer<typeof capabilitiesInputSchema>;
export interface OperationContext { requestId?: string; signal?: AbortSignal }
function validateFetchExecution(value: { execution?: 'sync' | 'async'; idempotency_key?: string }, context: z.RefinementCtx): void { const execution = value.execution ?? 'sync'; if (execution === 'async' && value.idempotency_key === undefined) context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'async execution requires idempotency_key' }); if (execution === 'sync' && value.idempotency_key !== undefined) context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'sync execution does not accept idempotency_key' }); }
