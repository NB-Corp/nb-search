import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { NbSearchError } from './errors.ts';
import { htmlToText, isPublicAddress, parsePublicUrl } from './fetch-security.ts';
import { ResponseLimitError } from './transport.ts';
import type { FetchProvider, FetchProviderRequest, FetchProviderResult, FetchWarning } from './types.ts';

export interface BrowserRenderOutput {
  status: number;
  final_url: string;
  html: string;
  content_type: string;
  content_disposition?: string;
  byte_length: number;
  truncated: boolean;
}

export interface BrowserRenderIo {
  readonly available: boolean;
  resolve(hostname: string): Promise<readonly string[]>;
  render(input: {
    url: URL;
    signal: AbortSignal;
    max_response_bytes: number;
    max_redirects: number;
    validate_request(url: string): Promise<URL>;
    validate_redirect(url: string): Promise<URL>;
  }): Promise<BrowserRenderOutput>;
}

export class BrowserRenderProvider implements FetchProvider {
  readonly name = 'browser-render';
  constructor(private readonly io: BrowserRenderIo = playwrightBrowserRenderIo) {}

  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      if (request.source.kind !== 'url') throw new NbSearchError('FETCH_PIPELINE_UNSUPPORTED', 'The browser render pipeline accepts URL input only.');
      const original = parsePublicUrl(request.source.url);
      await this.validateTarget(original);
      request.signal.throwIfAborted();
      let redirects = 0;
      const validateRequest = async (value: string): Promise<URL> => { const url = parsePublicUrl(value); await this.validateTarget(url); return url; };
      const rendered = await this.io.render({
        url: original,
        signal: request.signal,
        max_response_bytes: request.max_response_bytes,
        max_redirects: request.max_redirects,
        validate_request: validateRequest,
        validate_redirect: async (value) => {
          redirects += 1;
          if (redirects > request.max_redirects) throw new NbSearchError('FETCH_HTTP_ERROR', 'The redirect limit was reached.', false, this.name, { data: { status: 302, max_redirects: request.max_redirects } });
          return await validateRequest(value);
        },
      });
      if (rendered.status < 200 || rendered.status >= 300) throw httpError(rendered.status, this.name);
      const finalUrl = parsePublicUrl(rendered.final_url);
      if (finalUrl.toString() !== original.toString() && redirects === 0) await this.validateTarget(finalUrl);
      const contentType = mediaType(rendered.content_type);
      if (contentType === undefined || !BROWSER_TEXT_TYPES.has(contentType) || rendered.content_disposition?.toLowerCase().includes('attachment') === true) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The rendered response content type is not allowed.', false, this.name);
      const projected = htmlToText(rendered.html);
      const truncatedChars = projected.content.length > request.max_content_chars;
      const content = truncatedChars ? projected.content.slice(0, request.max_content_chars) : projected.content;
      const warnings: FetchWarning[] = [];
      if (rendered.truncated) warnings.push({ code: 'FETCH_BYTES_LIMIT', message: 'The response byte limit was reached.', data: { max_response_bytes: request.max_response_bytes } });
      if (truncatedChars) warnings.push({ code: 'FETCH_CONTENT_CHARS_LIMIT', message: 'The content character limit was reached.', data: { max_content_chars: request.max_content_chars } });
      return {
        url: request.source.url,
        final_url: finalUrl.toString(),
        ...(projected.title === undefined ? {} : { title: projected.title }),
        content,
        content_type: contentType,
        media_type: contentType,
        representation: request.representation,
        format: 'text',
        byte_length: rendered.byte_length,
        truncated: rendered.truncated || truncatedChars,
        warnings,
      };
    } catch (error) {
      if (error instanceof NbSearchError || request.signal.aborted) throw error;
      if (error instanceof ResponseLimitError) throw new NbSearchError('FETCH_BYTES_LIMIT', 'Browser render exceeded the configured byte limit.', false, this.name, { cause: error, data: { max_response_bytes: error.maximum } });
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Browser render failed.', true, this.name, { cause: error });
    }
  }

  private async validateTarget(url: URL): Promise<void> {
    const addresses = await this.io.resolve(url.hostname);
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new NbSearchError('FETCH_BLOCKED', 'Target resolved to a non-public address.', false, this.name);
  }
}

const require = createRequire(import.meta.url);
const playwrightInstalled = (() => { try { const loaded = require('playwright') as { chromium: { executablePath(): string } }; return existsSync(loaded.chromium.executablePath()); } catch { return false; } })();

export const playwrightBrowserRenderIo: BrowserRenderIo = {
  available: playwrightInstalled,
  async resolve(hostname) { return (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address); },
  async render(input) {
    input.signal.throwIfAborted();
    const moduleName = 'playwright';
    const playwright = await import(moduleName) as unknown as PlaywrightModule;
    const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256'] });
    try {
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
      const page = await context.newPage();
    let current = input.url.toString();
    let receivedBytes = 0;
    let overflow: ResponseLimitError | undefined;
    let routeError: unknown;
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    session.on('Network.dataReceived', (event) => {
      receivedBytes += event.encodedDataLength;
      if (receivedBytes > input.max_response_bytes && overflow === undefined) {
        overflow = new ResponseLimitError(input.max_response_bytes);
        void page.close();
      }
    });
    await page.route('**/*', async (route) => {
      try {
        const request = route.request();
        const resourceType = request.resourceType();
        if (['image', 'media', 'font', 'websocket', 'eventsource', 'manifest'].includes(resourceType)) { await route.abort('blockedbyclient'); return; }
        const requestUrl = request.url();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          if (requestUrl !== current) { const validated = await input.validate_redirect(requestUrl); current = validated.toString(); }
        } else {
          const protocol = new URL(requestUrl).protocol;
          if (protocol === 'http:' || protocol === 'https:') await input.validate_request(requestUrl);
          else if (protocol !== 'data:' && protocol !== 'blob:') { await route.abort('blockedbyclient'); return; }
        }
        await route.continue();
      } catch (error) { routeError = error; await route.abort('blockedbyclient'); }
    });
    input.signal.throwIfAborted();
    const abort = (): void => { void page.close(); };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      let response: PlaywrightResponse | null;
      try { response = await page.goto(input.url.toString(), { waitUntil: 'domcontentloaded', timeout: 0 }); }
      catch (error) { if (overflow !== undefined) throw overflow; if (routeError !== undefined) throw routeError; throw error; }
      if (overflow !== undefined) throw overflow;
      if (routeError !== undefined) throw routeError;
      if (response === null) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Browser navigation did not return a document response.', false, 'browser-render');
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
      if (overflow !== undefined) throw overflow;
      if (routeError !== undefined) throw routeError;
      const html = await page.content();
      const encoded = Buffer.from(html, 'utf8');
      const truncated = encoded.byteLength > input.max_response_bytes;
      const bounded = truncated ? encoded.subarray(0, input.max_response_bytes).toString('utf8') : html;
      const headers = response.headers(); const contentDisposition = headers['content-disposition'];
      return { status: response.status(), final_url: page.url(), html: bounded, content_type: headers['content-type'] ?? '', ...(contentDisposition === undefined ? {} : { content_disposition: contentDisposition }), byte_length: encoded.byteLength, truncated };
      } finally {
        input.signal.removeEventListener('abort', abort);
      }
    } finally { await browser.close(); }
  },
};

interface PlaywrightModule {
  chromium: { launch(options: { headless: boolean; args: string[] }): Promise<PlaywrightBrowser> };
}
interface PlaywrightBrowser {
  newContext(options: { acceptDownloads: boolean; serviceWorkers: 'block' }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  newCDPSession(page: PlaywrightPage): Promise<{ send(method: string): Promise<void>; on(event: string, handler: (value: { encodedDataLength: number }) => void): void }>;
}
interface PlaywrightPage {
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<PlaywrightResponse | null>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
  mainFrame(): unknown;
  close(): Promise<void>;
}
interface PlaywrightResponse { status(): number; headers(): Record<string, string> }
interface PlaywrightRoute { request(): PlaywrightRequest; abort(code: string): Promise<void>; continue(): Promise<void> }
interface PlaywrightRequest { resourceType(): string; isNavigationRequest(): boolean; frame(): unknown; url(): string }

const BROWSER_TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
function mediaType(value: string): string | undefined { const item = value.split(';')[0]?.trim().toLowerCase(); return item === '' ? undefined : item; }
function httpError(status: number, provider: string): NbSearchError {
  return new NbSearchError('FETCH_HTTP_ERROR', `${provider} fetch failed with status ${String(status)}.`, status === 429 || status >= 500, provider, { data: { status } });
}
