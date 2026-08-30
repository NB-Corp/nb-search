import { NbSearchError } from './errors.ts';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  response_type?: 'json' | 'text';
  signal: AbortSignal;
}
export interface HttpResponse<T = unknown> { status: number; body: T; headers?: Readonly<Record<string, string>> }
export interface HttpTransport { send<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> }
export type JsonRequest = HttpRequest;
export type JsonResponse<T = unknown> = HttpResponse<T>;
export type JsonTransport = HttpTransport;

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
    const text = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
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
