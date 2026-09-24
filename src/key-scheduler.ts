import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderInstanceConfig } from './config-schema.ts';
import type { SecretBinding } from './config-sources.ts';
import { NbSearchError } from './errors.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from './transport.ts';

export interface KeyUsage {
  provider_instance_id: string;
  provider_id: string;
  key_index: number;
  state: 'ready' | 'cooldown' | 'invalid' | 'exhausted';
  cooldown_until?: string;
  usage?: { scope: 'key' | 'team'; unit: 'credits'; used: number | null; limit: number | null; remaining: number | null; checked_at: string };
  usage_error?: 'unavailable' | 'invalid_response';
}
interface UsageCache { used: number | null; limit: number | null; remaining: number | null; checkedAt: number; error?: 'unavailable' | 'invalid_response' }
interface KeyState { invalid: boolean; cooldownUntil: number; exhausted: boolean; cache?: UsageCache; pending?: Promise<void> }
const DEFAULT_TTL_MS = 600_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES = 2;

/** One scheduler per provider instance; all its query and fetch ports share the same key states. */
export class KeyScheduler implements HttpTransport {
  private readonly keys: readonly string[];
  private readonly states: KeyState[];
  private cursor = 0;
  constructor(readonly instanceId: string, readonly instance: ProviderInstanceConfig, credential: SecretBinding, private readonly transport: HttpTransport, private readonly clock: () => Date = () => new Date()) {
    this.keys = credential.values ?? [credential.value];
    this.states = this.keys.map(() => ({ invalid: false, cooldownUntil: 0, exhausted: false }));
  }
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const original = this.keys[0]!;
    if (!hasCredential(request, original)) return this.transport.send<T>(request);
    const start = this.instance.key_strategy === 'priority' ? 0 : this.cursor++ % this.keys.length;
    let lastResponse: HttpResponse<T> | undefined;
    let lastError: unknown;
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (start + offset) % this.keys.length;
      const state = this.states[index]!;
      if (state.invalid || state.cooldownUntil > this.clock().getTime() || state.exhausted && this.cacheFresh(state)) continue;
      if (state.exhausted && !this.cacheFresh(state)) state.exhausted = false;
      const keyed = withCredential(request, original, this.keys[index]!);
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (request.signal.aborted) throw new NbSearchError('CANCELLED', 'The operation was cancelled.');
        try {
          const response = await this.transport.send<T>(keyed);
          lastError = undefined;
          if (response.status === 401 || response.status === 403) { state.invalid = true; lastResponse = response; break; }
          if (response.status === 429) { state.cooldownUntil = this.clock().getTime() + retryAfter(response.headers, this.clock); lastResponse = response; break; }
          if (response.status === 402) { state.exhausted = true; state.cache = { used: null, limit: null, remaining: null, checkedAt: this.clock().getTime(), error: 'unavailable' }; lastResponse = response; break; }
          if (response.status >= 500 && response.status <= 599) {
            lastResponse = response;
            if (attempt < MAX_RETRIES) { await this.backoff(attempt, request.signal); continue; }
            break;
          }
          return response;
        } catch (error) {
          if (request.signal.aborted) throw error;
          // Only connection failures are retried; parsing, response-size and explicit non-retryable failures are not.
          if (!(error instanceof TypeError || error instanceof NbSearchError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable)) throw error;
          lastResponse = undefined;
          lastError = error;
          if (attempt < MAX_RETRIES) { await this.backoff(attempt, request.signal); continue; }
          break;
        }
      }
    }
    if (lastResponse !== undefined) return lastResponse;
    if (lastError !== undefined) throw lastError;
    const cooldowns = this.states.map((state) => state.cooldownUntil - this.clock().getTime()).filter((ms) => ms > 0);
    if (cooldowns.length > 0) throw new NbSearchError('PROVIDER_RATE_LIMIT', 'All provider keys are cooling down.', true, undefined, { retryAfterMs: Math.min(...cooldowns) });
    throw new NbSearchError('PROVIDER_AUTH', 'No usable provider key remains.');
  }
  private async backoff(attempt: number, signal: AbortSignal): Promise<void> { await delay(100 * 2 ** attempt, undefined, { signal }); }
  private cacheFresh(state: KeyState): boolean { return state.cache !== undefined && this.clock().getTime() - state.cache.checkedAt < (this.instance.balance_ttl_ms ?? DEFAULT_TTL_MS); }
  get supportsUsage(): boolean { return this.instance.provider_id === 'tavily' || this.instance.provider_id === 'firecrawl'; }
  async usage(refresh = false, signal?: AbortSignal): Promise<KeyUsage[]> {
    if (!this.supportsUsage) return [];
    await Promise.all(this.states.map(async (state, index) => {
      if (!refresh && this.cacheFresh(state)) return;
      if (state.pending !== undefined) return state.pending;
      const pending = this.loadUsage(index, signal ?? new AbortController().signal);
      state.pending = pending;
      try { await pending; } finally { state.pending = undefined; }
    }));
    return this.states.map((state, index) => ({ provider_instance_id: this.instanceId, provider_id: this.instance.provider_id, key_index: index + 1,
      state: state.invalid ? 'invalid' : state.cooldownUntil > this.clock().getTime() ? 'cooldown' : state.exhausted && this.cacheFresh(state) ? 'exhausted' : 'ready',
      ...(state.cooldownUntil > this.clock().getTime() ? { cooldown_until: new Date(state.cooldownUntil).toISOString() } : {}),
      ...(state.cache?.error !== undefined ? { usage_error: state.cache.error } : state.cache === undefined ? {} : { usage: { scope: (this.instance.provider_id === 'tavily' ? 'key' : 'team') as 'key' | 'team', unit: 'credits' as const, used: state.cache.used, limit: state.cache.limit, remaining: state.cache.remaining, checked_at: new Date(state.cache.checkedAt).toISOString() } }) }));
  }
  private async loadUsage(index: number, signal: AbortSignal): Promise<void> {
    const state = this.states[index]!;
    const tavily = this.instance.provider_id === 'tavily';
    const origin = this.instance.base_url ?? (tavily ? 'https://api.tavily.com' : 'https://api.firecrawl.dev');
    const url = new URL(tavily ? '/usage' : '/v2/team/credit-usage', origin).toString();
    try {
      const response = await this.transport.send({ url, method: 'GET', headers: { Authorization: `Bearer ${this.keys[index]!}` }, response_type: 'json', max_response_bytes: 64_000, signal });
      if (response.status < 200 || response.status >= 300) { state.cache = { used: null, limit: null, remaining: null, checkedAt: this.clock().getTime(), error: 'unavailable' }; return; }
      const result = usageNumbers(response.body, tavily);
      state.cache = { ...result, checkedAt: this.clock().getTime(), ...(result === undefined ? { error: 'invalid_response' as const } : {}) } as UsageCache;
      // A successful refresh can restore a previously exhausted key, but cannot undo auth quarantine.
      state.exhausted = result?.remaining === 0;
    } catch (error) {
      if (signal.aborted) throw error;
      state.cache = { used: null, limit: null, remaining: null, checkedAt: this.clock().getTime(), error: 'unavailable' };
    }
  }
}
function usageNumbers(body: unknown, tavily: boolean): Pick<UsageCache, 'used' | 'limit' | 'remaining'> | undefined {
  if (!record(body)) return undefined;
  if (tavily) {
    if (!record(body['key']) || !validNumber(body['key']['usage']) || !(body['key']['limit'] === null || validNumber(body['key']['limit']))) return undefined;
    const used = body['key']['usage'] as number; const limit = body['key']['limit'] as number | null;
    return { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
  }
  if (body['success'] !== true || !record(body['data']) || !validNumber(body['data']['remainingCredits'])) return undefined;
  return { used: null, limit: null, remaining: body['data']['remainingCredits'] as number };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function hasCredential(request: HttpRequest, key: string): boolean {
  return Object.entries(request.headers ?? {}).some(([name, value]) => /^(authorization|x-api-key|x-subscription-token)$/i.test(name) && (value === key || value === `Bearer ${key}`)) || record(request.body) && request.body['api_key'] === key;
}
function withCredential(request: HttpRequest, original: string, key: string): HttpRequest {
  return { ...request, headers: Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name, /^(authorization|x-api-key|x-subscription-token)$/i.test(name) && (value === original || value === `Bearer ${original}`) ? value === original ? key : `Bearer ${key}` : value])), ...(record(request.body) && request.body['api_key'] === original ? { body: { ...request.body, api_key: key } } : {}) };
}
function retryAfter(headers: Readonly<Record<string, string>> | undefined, clock: () => Date): number {
  const raw = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (raw === undefined) return DEFAULT_COOLDOWN_MS;
  const seconds = Number(raw); const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - clock().getTime();
  return Number.isFinite(ms) ? Math.max(1_000, Math.min(ms, 3_600_000)) : DEFAULT_COOLDOWN_MS;
}
