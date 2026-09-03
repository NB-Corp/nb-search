import { NbSearchError } from '../errors.ts';
import { redactText } from '../redaction.ts';
import { RELAY_RESPONSE_MAX_BYTES } from '../relay-parser.ts';
import { ResponseLimitError, type JsonTransport } from '../transport.ts';
import type { CredentialSlotId, ProviderInstanceId, QueryExecutionRequest } from '../types.ts';
import { normalizeUrl } from '../url.ts';
import { validateGrokModel } from '../providers.ts';

export const DEFAULT_GROK_RESPONSES_URL = 'https://api.x.ai/v1/responses';
export const DEFAULT_GROK_MODEL = 'grok-4.1-fast';
export type GrokResponsesTool = 'web_search' | 'x_search';
export interface GrokSynthesisSource { url: string }
export interface GrokSynthesisResult { answer: string; sources: readonly GrokSynthesisSource[] }
export interface GrokResponsesProviderOptions {
  apiKey: string;
  transport: JsonTransport;
  model: string;
  tool: GrokResponsesTool;
  baseUrl?: string;
  providerInstanceId?: ProviderInstanceId;
  credentialSlotId?: CredentialSlotId;
  clock?: () => Date;
}

export class GrokResponsesProvider {
  readonly name = 'grok' as const;
  readonly provider_id = 'grok' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  private readonly authorization: string;

  constructor(private readonly options: GrokResponsesProviderOptions) {
    validateGrokModel(options.model);
    this.provider_instance_id = options.providerInstanceId ?? 'grok.default';
    this.credential_slot_id = options.credentialSlotId;
    this.endpoint = resolveGrokResponsesUrl(options.baseUrl ?? DEFAULT_GROK_RESPONSES_URL);
    this.authorization = `Bearer ${options.apiKey}`;
    this.redactions = [options.apiKey, ...(options.baseUrl === undefined ? [] : [options.baseUrl]), this.endpoint, this.authorization];
  }

  async synthesize(request: QueryExecutionRequest): Promise<GrokSynthesisResult> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint,
        method: 'POST',
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: {
          model: this.options.model,
          input: request.query,
          stream: false,
          store: false,
          tools: [{ type: this.options.tool }],
        },
        response_type: 'json',
        max_response_bytes: RELAY_RESPONSE_MAX_BYTES,
        signal: request.signal,
      });
      if (request.signal.aborted) throw request.signal.reason;
      assertGrokResponsesStatus(response.status, response.headers, this.options.clock);
      return parseGrokResponses(response.body);
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof ResponseLimitError) throw malformedGrokResponsesError(error);
      if (error instanceof NbSearchError) throw safeGrokResponsesError(error, this.redactions);
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'grok provider connection failed.', true, this.name, { cause: error });
    }
  }
}

export function resolveGrokResponsesUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidGrokResponsesUrl(); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username !== ''
    || url.password !== '' || url.search !== '' || url.hash !== '' || value !== value.trim() || value.length > 2048) {
    throw invalidGrokResponsesUrl();
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/responses')) url.pathname = path.endsWith('/v1') ? `${path}/responses` : `${path}/v1/responses`;
  else url.pathname = path;
  return url.toString();
}

export function parseGrokResponses(value: unknown): GrokSynthesisResult {
  if (!isRecord(value) || !Array.isArray(value['output'])) throw malformedGrokResponsesError();
  const answerParts: string[] = [];
  const sources: GrokSynthesisSource[] = [];
  const seen = new Set<string>();
  for (const output of value['output']) {
    if (!isRecord(output)) throw malformedGrokResponsesError();
    const content = output['content'];
    if (content === undefined || content === null) continue;
    if (!Array.isArray(content)) throw malformedGrokResponsesError();
    for (const item of content) {
      if (!isRecord(item)) throw malformedGrokResponsesError();
      if (item['type'] !== 'output_text') continue;
      if (typeof item['text'] !== 'string') throw malformedGrokResponsesError();
      const text = item['text'].trim();
      if (text !== '') answerParts.push(text);
      const annotations = item['annotations'];
      if (annotations === undefined || annotations === null) continue;
      if (!Array.isArray(annotations)) throw malformedGrokResponsesError();
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation['type'] !== 'url_citation' || typeof annotation['url'] !== 'string') continue;
        const url = normalizeUrl(annotation['url']);
        if (url === undefined || seen.has(url)) continue;
        seen.add(url);
        sources.push({ url });
      }
    }
  }
  if (answerParts.length === 0) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'grok returned no output text.', false, 'grok');
  return { answer: answerParts.join('\n\n'), sources };
}

function assertGrokResponsesStatus(status: number, headers?: Readonly<Record<string, string>>, clock: () => Date = () => new Date()): void {
  if (status >= 200 && status < 300) return;
  const options = { data: { status } };
  if (status === 401 || status === 403) throw new NbSearchError('PROVIDER_AUTH', 'grok authentication failed.', false, 'grok', options);
  if (status === 429) {
    throw new NbSearchError('PROVIDER_RATE_LIMIT', 'grok rate limit was reached.', true, 'grok', {
      ...options,
      retryAfterMs: parseRetryAfter(headerValue(headers, 'retry-after'), clock),
    });
  }
  throw new NbSearchError('PROVIDER_UNAVAILABLE', `grok request failed (HTTP ${String(status)}).`, status === 408 || status === 425 || status >= 500, 'grok', options);
}

function safeGrokResponsesError(error: NbSearchError, redactions: readonly string[]): NbSearchError {
  return new NbSearchError(error.code, redactText(error.message, redactions), error.retryable, 'grok', {
    cause: error,
    retryAfterMs: error.retryAfterMs,
    data: error.data,
  });
}
function malformedGrokResponsesError(cause?: unknown): NbSearchError { return new NbSearchError('PROVIDER_UNAVAILABLE', 'grok returned malformed Responses content.', false, 'grok', { cause }) }
function invalidGrokResponsesUrl(): NbSearchError { return new NbSearchError('CONFIGURATION_ERROR', 'Grok Responses base URL is invalid.') }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function parseRetryAfter(value: string | undefined, clock: () => Date): number | undefined { if (value === undefined) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000); const at = Date.parse(value); return Number.isFinite(at) ? Math.max(0, at - clock().getTime()) : undefined }
function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined { if (headers === undefined) return undefined; return headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] }
