import { NbSearchError } from '../errors.ts';
import type { KeyUsageMeter } from '../key-scheduler.ts';
import { resolveOperationUrl } from '../providers.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../transport.ts';

export const DEFAULT_ZHIHU_BASE_URL = 'https://developer.zhihu.com';
export const ZHIHU_PATHS = { search: '/api/v1/content/zhihu_search', global: '/api/v1/content/global_search', synthesis: '/v1/chat/completions', quota: '/api/v1/quota' } as const;
export interface ZhihuOptions {
  allow_paid?: boolean;
  search_db?: 'all' | 'realtime' | 'static';
  zhida_model?: string;
  search_path?: string;
  global_search_path?: string;
  synthesis_path?: string;
  quota_path?: string;
}
export function resolveZhihuEndpoints(baseUrl: string, options: ZhihuOptions): Record<keyof typeof ZHIHU_PATHS, string> {
  const endpoints = {
    search: resolveOperationUrl(baseUrl, options.search_path ?? ZHIHU_PATHS.search),
    global: resolveOperationUrl(baseUrl, options.global_search_path ?? ZHIHU_PATHS.global),
    synthesis: resolveOperationUrl(baseUrl, options.synthesis_path ?? ZHIHU_PATHS.synthesis),
    quota: resolveOperationUrl(baseUrl, options.quota_path ?? ZHIHU_PATHS.quota),
  };
  if (new Set(Object.values(endpoints)).size !== 4) throw new NbSearchError('CONFIGURATION_ERROR', 'Zhihu operation paths must resolve to distinct endpoints.');
  return endpoints;
}
export function zhihuResetAt(now: Date): string {
  const day = Math.floor((now.getTime() + 28_800_000) / 86_400_000);
  return new Date((day + 1) * 86_400_000 - 28_800_000).toISOString();
}
export function zhihuHeaders(authorization: string, now: Date): Record<string, string> {
  return { Authorization: authorization, 'X-Request-Timestamp': String(Math.floor(now.getTime() / 1000)), Accept: 'application/json' };
}
export function zhihuQuotaMeters(body: unknown, now: Date): KeyUsageMeter[] | undefined {
  if (!record(body) || body['Code'] !== 0) return undefined;
  const data = body['Data'];
  const rows = Array.isArray(data) ? data : record(data) ? data['Items'] : undefined;
  if (!Array.isArray(rows)) return undefined;
  const meters: KeyUsageMeter[] = [];
  for (const row of rows) {
    if (!record(row)) return undefined;
    const id = row['APIID'] ?? row['api_id']; const label = row['APIName'] ?? row['api_name'];
    const used = row['TotalUsed'] ?? row['total_used'] ?? null;
    const limit = row['TotalQuota'] ?? row['total_quota'] ?? null;
    const remaining = row['RemainingQuota'] ?? row['remaining_quota'] ?? null;
    if (typeof id !== 'string' || id.trim() === '' || !(used === null || validNumber(used)) || !(limit === null || validNumber(limit)) || !(remaining === null || validNumber(remaining))) return undefined;
    meters.push({ id, ...(typeof label === 'string' && label.trim() !== '' ? { label } : {}), unit: 'requests', used, limit, remaining, reset_at: zhihuResetAt(now), reset_timezone: 'Asia/Shanghai' });
  }
  return meters.length === 0 ? undefined : meters;
}
interface QuotaState { resetAt: string; remaining: number; checkedAt: number; inFlight: number; exhausted: boolean; pending?: Promise<void> }

/** Below key rotation, so every retry reserves quota against the credential actually sent. */
export class ZhihuQuotaTransport implements HttpTransport {
  private readonly states = new Map<string, QuotaState>();
  private readonly endpoints: ReadonlyMap<string, string>;
  private readonly quotaUrl: string;
  constructor(private readonly transport: HttpTransport, baseUrl: string = DEFAULT_ZHIHU_BASE_URL, private readonly options: ZhihuOptions = {}, private readonly clock: () => Date = () => new Date()) {
    const endpoints = resolveZhihuEndpoints(baseUrl, options);
    this.endpoints = new Map([[endpoints.search, 'zhihu_search'], [endpoints.global, 'global_search'], [endpoints.synthesis, 'zhida_openai']]);
    this.quotaUrl = endpoints.quota;
  }
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const endpoint = new URL(request.url); endpoint.search = '';
    const apiId = this.endpoints.get(endpoint.toString());
    const authorization = request.headers?.['Authorization'] ?? '';
    const state = apiId === undefined || this.options.allow_paid === true ? undefined : await this.reserve(apiId, authorization, request.signal);
    try {
      const response = await this.transport.send<T>({ ...request, headers: { ...request.headers, ...zhihuHeaders(authorization, this.clock()) } });
      if (state !== undefined && record(response.body) && response.body['Code'] === 30002) { state.remaining = 0; state.exhausted = true; }
      return response;
    } finally { if (state !== undefined) state.inFlight -= 1; }
  }
  private async reserve(apiId: string, authorization: string, signal: AbortSignal): Promise<QuotaState> {
    const now = this.clock(); const resetAt = zhihuResetAt(now); const key = `${authorization}\0${apiId}`;
    let state = this.states.get(key);
    if (state === undefined || state.resetAt !== resetAt) {
      state = { resetAt, remaining: 0, checkedAt: 0, inFlight: 0, exhausted: false };
      this.states.set(key, state);
    }
    if (state.exhausted) throw quotaUnavailable();
    if (state.pending !== undefined) await state.pending;
    else if (state.remaining <= 32 || now.getTime() - state.checkedAt >= 60_000) {
      const pending = this.checkQuota(state, apiId, authorization, signal);
      state.pending = pending;
      try { await pending; } finally { state.pending = undefined; }
    }
    // A precheck straddling midnight must not authorize the new day's request.
    if (state.resetAt !== zhihuResetAt(this.clock())) return this.reserve(apiId, authorization, signal);
    if (state.exhausted || state.remaining <= 0) throw quotaUnavailable();
    state.remaining -= 1; state.inFlight += 1;
    return state;
  }
  private async checkQuota(state: QuotaState, apiId: string, authorization: string, signal: AbortSignal): Promise<void> {
    const url = new URL(this.quotaUrl); url.searchParams.set('APIIDs', apiId);
    const outstanding = state.inFlight;
    try {
      const response = await this.transport.send({ url: url.toString(), method: 'GET', headers: zhihuHeaders(authorization, this.clock()), response_type: 'json', max_response_bytes: 64_000, redirect: 'manual', signal });
      const remaining = response.status >= 200 && response.status < 300 ? zhihuQuotaMeters(response.body, this.clock())?.find((meter) => meter.id === apiId)?.remaining : undefined;
      if (remaining === undefined || remaining === null) throw quotaUnavailable();
      state.remaining = Math.max(0, remaining - outstanding); state.checkedAt = this.clock().getTime();
    } catch (error) { if (signal.aborted) throw error; throw quotaUnavailable(); }
  }
}
function quotaUnavailable(): NbSearchError { return new NbSearchError('PROVIDER_RATE_LIMIT', 'zhihu daily free quota is exhausted or unverified.', false, 'zhihu'); }
function validNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
