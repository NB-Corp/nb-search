import { z } from 'zod';
import { NbSearchError } from '../errors.ts';
import { KeyScheduler } from '../key-scheduler.ts';
import { validateSearchPath } from '../providers.ts';
import { ResponseLimitError, type HttpRequest, type JsonTransport } from '../transport.ts';
import type { ProviderResult, ProviderSearchRequest, QueryExecutionRequest, SupportingUrl } from '../types.ts';
import { normalizeUrl } from '../url.ts';
import { DEFAULT_ZHIHU_BASE_URL, ZhihuQuotaTransport, resolveZhihuEndpoints, zhihuHeaders, type ZhihuOptions } from './zhihu-quota.ts';

export { DEFAULT_ZHIHU_BASE_URL } from './zhihu-quota.ts';
export type { ZhihuOptions } from './zhihu-quota.ts';
const itemSchema = z.object({
  Title: z.string().optional(), Url: z.string(), ContentText: z.string().optional(),
  ContentType: z.string().optional(), AuthorName: z.string().optional(), AuthorityLevel: z.union([z.string(), z.number()]).optional(),
  VoteUpCount: z.number().optional(), CommentCount: z.number().optional(),
  EditTime: z.number().nullish(), CreatedTime: z.number().nullish(),
}).passthrough();
const resultsSchema = z.object({ Items: z.array(itemSchema) });
const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }).passthrough() })).min(1) }).passthrough();
export interface ZhihuProviderOptions {
  apiKey: string;
  transport: JsonTransport;
  baseUrl?: string;
  clock?: () => Date;
  options?: ZhihuOptions;
}
export function validateZhihuOptions(options: Readonly<Record<string, unknown>>, baseUrl = DEFAULT_ZHIHU_BASE_URL): void {
  const keys = ['allow_paid', 'search_db', 'zhida_model', 'search_path', 'global_search_path', 'synthesis_path', 'quota_path'];
  if (Object.keys(options).some((key) => !keys.includes(key))
    || options['allow_paid'] !== undefined && typeof options['allow_paid'] !== 'boolean'
    || options['search_db'] !== undefined && !['all', 'realtime', 'static'].includes(options['search_db'] as string)
    || options['zhida_model'] !== undefined && (typeof options['zhida_model'] !== 'string' || options['zhida_model'].trim() === '')) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Zhihu provider options are invalid.');
  }
  for (const key of ['search_path', 'global_search_path', 'synthesis_path', 'quota_path']) {
    const value = options[key];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new NbSearchError('CONFIGURATION_ERROR', 'Zhihu endpoint path must be a string.');
      validateSearchPath(value);
    }
  }
  resolveZhihuEndpoints(baseUrl, options as ZhihuOptions);
}
export class ZhihuProvider {
  readonly name = 'zhihu' as const;
  readonly redactions: readonly string[];
  private readonly transport: JsonTransport;
  private readonly authorization: string;
  private readonly endpoints: Record<'search' | 'global' | 'synthesis', string>;
  private readonly settings: ZhihuOptions;
  private readonly clock: () => Date;
  constructor(options: ZhihuProviderOptions) {
    this.settings = options.options ?? {};
    const baseUrl = options.baseUrl ?? DEFAULT_ZHIHU_BASE_URL;
    validateZhihuOptions({ ...this.settings }, baseUrl);
    this.clock = options.clock ?? (() => new Date());
    this.authorization = `Bearer ${options.apiKey}`;
    this.redactions = [options.apiKey, this.authorization];
    this.endpoints = resolveZhihuEndpoints(baseUrl, this.settings);
    // The scheduler guards after selecting a key; standalone adapters guard their own transport.
    this.transport = options.transport instanceof KeyScheduler && options.transport.instance.provider_id === 'zhihu'
      ? options.transport : new ZhihuQuotaTransport(options.transport, baseUrl, this.settings, this.clock);
  }
  search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> { return this.results('search', request); }
  global(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> { return this.results('global', request); }
  private async results(operation: 'search' | 'global', request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    const query = request.query.trim();
    if (query.length < 2 || query.length > 100) throw new NbSearchError('INVALID_INPUT', 'Zhihu search query must contain 2 to 100 characters.', false, this.name);
    const limit = Math.min(operation === 'search' ? 10 : 20, Math.max(1, Math.trunc(request.limit)));
    const url = new URL(this.endpoints[operation]); url.searchParams.set('Query', query); url.searchParams.set('Count', String(limit));
    if (operation === 'global') url.searchParams.set('SearchDB', this.settings.search_db ?? 'all');
    const body = await this.send({ url: url.toString(), method: 'GET', signal: request.signal });
    const parsed = resultsSchema.safeParse(record(body) && body['Code'] === 0 ? body['Data'] : undefined);
    if (!parsed.success) throw malformed();
    const results: ProviderResult[] = [];
    for (const item of parsed.data.Items) {
      const resultUrl = normalizeUrl(item.Url.trim()); if (resultUrl === undefined) continue;
      const tags = [clean(item.ContentType), clean(item.AuthorName), item.AuthorityLevel === undefined ? '' : `authority:${String(item.AuthorityLevel)}`, item.VoteUpCount === undefined ? '' : `votes:${String(item.VoteUpCount)}`, item.CommentCount === undefined ? '' : `comments:${String(item.CommentCount)}`].filter(Boolean);
      const snippet = `${tags.length === 0 ? '' : `[${tags.join(' · ')}] `}${clean(item.ContentText)}`.trim();
      const seconds = item.EditTime ?? item.CreatedTime;
      const date = seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0 ? undefined : new Date(seconds * 1000);
      const publishedAt = date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
      results.push({ title: clean(item.Title), url: resultUrl, ...(snippet === '' ? {} : { snippet }), ...(publishedAt === undefined ? {} : { published_at: publishedAt }) });
      if (results.length >= limit) break;
    }
    return results;
  }
  async synthesize(request: QueryExecutionRequest): Promise<{ text: string; supporting_urls: SupportingUrl[]; citation_status: { claim_linked_citations: false; evidence_map_available: false; semantic_verification: false } }> {
    const body = await this.send({ url: this.endpoints.synthesis, method: 'POST', body: { model: this.settings.zhida_model ?? 'zhida-fast-1p5', messages: [{ role: 'user', content: request.query }], stream: false }, signal: request.signal });
    const parsed = completionSchema.safeParse(body); if (!parsed.success) throw malformed();
    const message = parsed.data.choices[0]!.message;
    const supporting: SupportingUrl[] = []; const seen = new Set<string>();
    for (const source of [parsed.data['citations'], parsed.data['search_results'], message['citations'], message['search_results']]) {
      if (!Array.isArray(source)) continue;
      for (const item of source) {
        const candidate = typeof item === 'string' ? item : record(item) ? item['url'] : undefined;
        const url = typeof candidate === 'string' ? normalizeUrl(candidate) : undefined;
        if (url === undefined || seen.has(url)) continue;
        seen.add(url); const title = record(item) ? clean(item['title']) : '';
        supporting.push({ url, ...(title === '' ? {} : { title }), source: 'provider-grounding' });
      }
    }
    return { text: message.content.trim(), supporting_urls: supporting, citation_status: { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false } };
  }
  private async send(request: HttpRequest): Promise<unknown> {
    try {
      const response = await this.transport.send({ ...request, headers: { ...zhihuHeaders(this.authorization, this.clock()), ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, response_type: 'json', max_response_bytes: 2 * 1024 * 1024, redirect: 'manual' });
      if (response.status === 401 || response.status === 403) throw new NbSearchError('PROVIDER_AUTH', 'zhihu authentication failed.', false, this.name);
      if (response.status === 429) throw new NbSearchError('PROVIDER_RATE_LIMIT', 'zhihu rate limit was reached.', true, this.name);
      if (response.status < 200 || response.status >= 300) throw new NbSearchError('PROVIDER_UNAVAILABLE', `zhihu request failed (HTTP ${String(response.status)}).`, response.status >= 500, this.name);
      assertZhihuEnvelope(response.body);
      return response.body;
    } catch (error) {
      if (request.signal.aborted || error instanceof NbSearchError) throw error;
      if (error instanceof ResponseLimitError) throw malformed();
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'zhihu provider connection failed.', true, this.name, { cause: error });
    }
  }
}
function assertZhihuEnvelope(body: unknown): void {
  if (!record(body) || body['Code'] === undefined || body['Code'] === 0) return;
  const code = body['Code'];
  if (code === 20001) throw new NbSearchError('PROVIDER_AUTH', 'zhihu authentication failed.', false, 'zhihu');
  if (code === 30001 || code === 40003 || code === 30002) throw new NbSearchError('PROVIDER_RATE_LIMIT', 'zhihu quota or rate limit was reached.', code !== 30002, 'zhihu');
  if (code === 10001) throw new NbSearchError('INVALID_INPUT', 'zhihu rejected the input.', false, 'zhihu');
  throw new NbSearchError('PROVIDER_UNAVAILABLE', 'zhihu request was rejected by the upstream service.', code === 90001, 'zhihu');
}
function malformed(): NbSearchError { return new NbSearchError('PROVIDER_UNAVAILABLE', 'zhihu returned malformed content.', false, 'zhihu'); }
function clean(value: unknown): string { return typeof value === 'string' ? value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim() : ''; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
