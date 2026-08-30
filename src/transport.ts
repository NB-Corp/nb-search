import { NbSearchError } from './errors.ts';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  response_type?: 'json' | 'text';
  max_response_bytes?: number;
  signal: AbortSignal;
}
export interface HttpResponse<T = unknown> { status: number; body: T; headers?: Readonly<Record<string, string>> }
export interface HttpTransport { send<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> }
export type JsonRequest = HttpRequest;
export type JsonResponse<T = unknown> = HttpResponse<T>;
export type JsonTransport = HttpTransport;

export class ResponseLimitError extends Error {
  readonly kind = 'response-limit' as const;
  readonly retryable = false as const;
  constructor(readonly maximum: number) {
    super('Provider response exceeded the configured limit.');
    this.name = 'ResponseLimitError';
  }
}

export class FetchJsonTransport implements HttpTransport {
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'GET' || request.body === undefined ? {} : {
          body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider connection failed.', true, undefined, { cause: error });
    }
    const headers = Object.fromEntries(response.headers.entries());
    if (response.status < 200 || response.status >= 300) {
      if (request.max_response_bytes !== undefined) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, body: '' as T, headers };
      }
    }
    const text = request.max_response_bytes === undefined
      ? await response.text()
      : await readBoundedText(response, request.max_response_bytes);
    if (request.response_type === 'text') return { status: response.status, body: text as T, headers };
    if (text.length === 0) return { status: response.status, body: {} as T, headers };
    try {
      return { status: response.status, body: JSON.parse(text) as T, headers };
    } catch (error) {
      if (response.status < 200 || response.status >= 300) return { status: response.status, body: {} as T, headers };
      throw new NbSearchError('PROVIDER_UNAVAILABLE', `Provider returned invalid JSON (HTTP ${String(response.status)}).`, true, undefined, { cause: error });
    }
  }
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseLimitError(maximum);
    }
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseLimitError(maximum);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
