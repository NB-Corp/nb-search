import { NbSearchError } from './errors.ts';

export interface JsonRequest {
  url: string; method: 'POST'; headers: Readonly<Record<string, string>>; body: unknown; signal: AbortSignal;
}
export interface JsonResponse<T = unknown> { status: number; body: T }
export interface JsonTransport { send<T = unknown>(request: JsonRequest): Promise<JsonResponse<T>> }

export class FetchJsonTransport implements JsonTransport {
  async send<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method, headers: request.headers, body: JSON.stringify(request.body), signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Provider connection failed.', true, undefined, { cause: error });
    }
    const text = await response.text();
    if (text.length === 0) return { status: response.status, body: {} as T };
    try {
      return { status: response.status, body: JSON.parse(text) as T };
    } catch (error) {
      throw new NbSearchError('PROVIDER_UNAVAILABLE', `Provider returned invalid JSON (HTTP ${String(response.status)}).`, true, undefined, { cause: error });
    }
  }
}
