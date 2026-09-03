import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
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

interface ResolvedBrowserTarget { url: URL; address: string }
export interface BrowserRenderIo {
  readonly available: boolean;
  resolve(hostname: string): Promise<readonly string[]>;
  render(input: {
    url: URL;
    signal: AbortSignal;
    max_response_bytes: number;
    max_redirects: number;
    resolve_target(url: string): Promise<ResolvedBrowserTarget>;
    validate_redirect(url: string): Promise<URL>;
    record_redirect(status: number): void;
  }): Promise<BrowserRenderOutput>;
}

export class BrowserRenderProvider implements FetchProvider {
  readonly name = 'browser-render';
  constructor(private readonly io: BrowserRenderIo = playwrightBrowserRenderIo) {}

  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      if (request.source.kind !== 'url') throw new NbSearchError('FETCH_PIPELINE_UNSUPPORTED', 'The browser render pipeline accepts URL input only.');
      const resolveTarget = async (value: string): Promise<ResolvedBrowserTarget> => {
        const url = parsePublicUrl(value, this.name);
        const addresses = await this.io.resolve(url.hostname);
        if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new NbSearchError('FETCH_BLOCKED', 'Target resolved to a non-public address.', false, this.name);
        return { url, address: addresses[0]! };
      };
      const original = (await resolveTarget(request.source.url)).url;
      request.signal.throwIfAborted();
      let redirects = 0;
      const rendered = await this.io.render({
        url: original,
        signal: request.signal,
        max_response_bytes: request.max_response_bytes,
        max_redirects: request.max_redirects,
        resolve_target: resolveTarget,
        validate_redirect: async (value) => {
          redirects += 1;
          if (redirects > request.max_redirects) throw redirectLimitError(302, request.max_redirects, this.name);
          return (await resolveTarget(value)).url;
        },
        record_redirect: (status) => {
          redirects += 1;
          if (redirects > request.max_redirects) throw redirectLimitError(status, request.max_redirects, this.name);
        },
      });
      if (rendered.status < 200 || rendered.status >= 300) throw httpError(rendered.status, this.name);
      const finalUrl = parsePublicUrl(rendered.final_url, this.name);
      const contentType = mediaType(rendered.content_type);
      if (contentType === undefined || !BROWSER_TEXT_TYPES.has(contentType) || isAttachment(rendered.content_disposition)) throw rejectedContent(this.name);
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
}

export interface TestOnlyPlaywrightBrowserRenderIoOptions {
  resolve(hostname: string): Promise<readonly string[]>;
  test_connect_address(url: URL, validatedAddress: string): string;
}
export function createTestOnlyPlaywrightBrowserRenderIo(options: TestOnlyPlaywrightBrowserRenderIoOptions): BrowserRenderIo {
  return createPlaywrightBrowserRenderIo(options.resolve, options.test_connect_address);
}

const require = createRequire(import.meta.url);
const playwrightInstalled = (() => { try { const loaded = require('playwright') as { chromium: { executablePath(): string } }; return existsSync(loaded.chromium.executablePath()); } catch { return false; } })();
export const playwrightBrowserRenderIo = createPlaywrightBrowserRenderIo(
  async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address),
  (_url, validatedAddress) => validatedAddress,
);

function createPlaywrightBrowserRenderIo(resolve: BrowserRenderIo['resolve'], connectAddress: (url: URL, validatedAddress: string) => string): BrowserRenderIo {
  return { available: playwrightInstalled, resolve, async render(input) { return await renderWithPlaywright(input, connectAddress); } };
}

async function renderWithPlaywright(input: Parameters<BrowserRenderIo['render']>[0], connectAddress: (url: URL, validatedAddress: string) => string): Promise<BrowserRenderOutput> {
  input.signal.throwIfAborted();
  const proxy = await startPinnedProxy(input, connectAddress);
  const moduleName = 'playwright';
  let browser: PlaywrightBrowser | undefined;
  try {
    const playwright = await import(moduleName) as unknown as PlaywrightModule;
    browser = await playwright.chromium.launch({ headless: true, proxy: { server: proxy.url }, args: ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-quic', '--proxy-bypass-list=<-loopback>', '--renderer-process-limit=1', '--js-flags=--max-old-space-size=256'] });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    let primaryPage: PlaywrightPage | undefined;
    let routeError: unknown;
    let navigationError: NbSearchError | undefined;
    const failNavigation = (error: NbSearchError, page: PlaywrightPage): void => { navigationError ??= error; void page.close(); };

    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        const resourceType = request.resourceType();
        if (['image', 'media', 'font', 'eventsource', 'manifest'].includes(resourceType)) { await route.abort('blockedbyclient'); return; }
        const requestUrl = request.url();
        const protocol = new URL(requestUrl).protocol;
        if (protocol === 'http:' || protocol === 'https:') {
          let frame: PlaywrightFrame;
          try { frame = request.frame(); } catch { await route.abort('blockedbyclient'); return; }
          if (request.isNavigationRequest() && primaryPage !== undefined && frame.page() !== primaryPage) { await route.abort('blockedbyclient'); return; }
          await input.resolve_target(requestUrl);
        } else if (protocol !== 'data:' && protocol !== 'blob:') { await route.abort('blockedbyclient'); return; }
        await route.continue();
      } catch (error) { routeError ??= error; await route.abort('blockedbyclient'); }
    });
    await context.routeWebSocket('**/*', async (socket) => { await socket.close(); });
    context.on('page', (opened) => {
      opened.on('download', () => failNavigation(rejectedContent('browser-render'), opened));
      if (primaryPage === undefined) primaryPage = opened;
      else void opened.close();
    });
    context.on('response', (response) => {
      const page = primaryPage; const request = response.request(); const status = response.status(); let frame: PlaywrightFrame;
      try { frame = request.frame(); } catch { return; }
      if (page === undefined || frame !== page.mainFrame() || !request.isNavigationRequest() || status >= 300 && status < 400) return;
      const headers = response.headers(); const contentType = mediaType(headers['content-type']);
      if (isAttachment(headers['content-disposition']) || contentType !== undefined && !BROWSER_TEXT_TYPES.has(contentType)) failNavigation(rejectedContent('browser-render'), page);
    });

    const page = await context.newPage();
    primaryPage ??= page;
    const session = await context.newCDPSession(page);
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });
    session.on('Fetch.requestPaused', (event) => {
      const status = event.responseStatusCode;
      if (status !== undefined && status >= 300 && status < 400) {
        try { input.record_redirect(status); }
        catch (error) { navigationError ??= error as NbSearchError; void session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); void page.close(); return; }
      }
      void session.send('Fetch.continueResponse', { requestId: event.requestId });
    });
    input.signal.throwIfAborted();
    const abort = (): void => { void page.close(); };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      let response: PlaywrightResponse | null;
      try { response = await page.goto(input.url.toString(), { waitUntil: 'domcontentloaded', timeout: 0 }); }
      catch (error) { throw navigationError ?? proxy.failure() ?? routeError ?? error; }
      throwRenderFailure(navigationError, proxy.failure(), routeError);
      if (response === null) throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Browser navigation did not return a document response.', false, 'browser-render');
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
      throwRenderFailure(navigationError, proxy.failure(), routeError);
      const headers = response.headers(); const contentType = headers['content-type'] ?? '';
      if (isAttachment(headers['content-disposition']) || mediaType(contentType) === undefined || !BROWSER_TEXT_TYPES.has(mediaType(contentType)!)) throw rejectedContent('browser-render');
      const html = await page.content();
      const encoded = Buffer.from(html, 'utf8');
      const truncated = encoded.byteLength > input.max_response_bytes;
      const bounded = truncated ? encoded.subarray(0, input.max_response_bytes).toString('utf8') : html;
      return { status: response.status(), final_url: page.url(), html: bounded, content_type: contentType, ...(headers['content-disposition'] === undefined ? {} : { content_disposition: headers['content-disposition'] }), byte_length: encoded.byteLength, truncated };
    } finally { input.signal.removeEventListener('abort', abort); }
  } finally {
    await browser?.close().catch(() => undefined);
    await proxy.close();
  }
}

interface PinnedProxy { url: string; failure(): unknown; close(): Promise<void> }
async function startPinnedProxy(input: Parameters<BrowserRenderIo['render']>[0], connectAddress: (url: URL, validatedAddress: string) => string): Promise<PinnedProxy> {
  const sockets = new Set<Duplex>(); let failure: unknown; let responseBytes = 0; let server: Server;
  const fail = (error: unknown): void => { failure ??= error; for (const socket of sockets) socket.destroy(error instanceof Error ? error : undefined); if (server.listening) server.close(); };
  const count = (chunk: Buffer): boolean => { responseBytes += chunk.byteLength; if (responseBytes <= input.max_response_bytes) return true; fail(new ResponseLimitError(input.max_response_bytes)); return false; };
  server = createServer((request, response) => { void proxyHttpRequest(request, response, input, connectAddress, sockets, count, fail); });
  server.on('connect', (request, client, head) => { void proxyConnect(request.url ?? '', client, head, input, connectAddress, sockets, count, fail); });
  server.on('connection', (socket) => trackSocket(sockets, socket));
  const abort = (): void => fail(input.signal.reason);
  input.signal.addEventListener('abort', abort, { once: true });
  try { await listenLoopback(server); }
  catch (error) { input.signal.removeEventListener('abort', abort); throw error; }
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Browser proxy did not bind a TCP port.');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    failure: () => failure,
    async close() {
      input.signal.removeEventListener('abort', abort);
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function proxyHttpRequest(request: import('node:http').IncomingMessage, response: ServerResponse, input: Parameters<BrowserRenderIo['render']>[0], connectAddress: (url: URL, validatedAddress: string) => string, sockets: Set<Duplex>, count: (chunk: Buffer) => boolean, fail: (error: unknown) => void): Promise<void> {
  try {
    const target = await input.resolve_target(request.url ?? '');
    const headers = proxyHeaders(request.headers, target.url.host);
    const options: RequestOptions = { protocol: target.url.protocol, host: connectAddress(target.url, target.address), port: target.url.port === '' ? undefined : Number(target.url.port), method: request.method, path: `${target.url.pathname}${target.url.search}`, headers, ...(target.url.protocol === 'https:' ? { servername: target.url.hostname } : {}) };
    const upstream = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(options, (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      response.writeHead(status, upstreamResponse.headers);
      upstreamResponse.on('data', (chunk: Buffer) => { if (count(chunk)) response.write(chunk); else upstreamResponse.destroy(); });
      upstreamResponse.once('end', () => response.end());
      upstreamResponse.once('error', (error) => response.destroy(error));
    });
    upstream.once('socket', (socket) => trackSocket(sockets, socket));
    upstream.once('error', (error) => response.destroy(error));
    request.pipe(upstream);
  } catch (error) { fail(error); if (!response.headersSent) response.writeHead(502); response.end(); }
}

async function proxyConnect(authority: string, client: Duplex, head: Buffer, input: Parameters<BrowserRenderIo['render']>[0], connectAddress: (url: URL, validatedAddress: string) => string, sockets: Set<Duplex>, count: (chunk: Buffer) => boolean, fail: (error: unknown) => void): Promise<void> {
  let upstream: Socket | undefined;
  try {
    const target = await input.resolve_target(`https://${authority}/`);
    upstream = netConnect({ host: connectAddress(target.url, target.address), port: target.url.port === '' ? 443 : Number(target.url.port) });
    trackSocket(sockets, upstream);
    await new Promise<void>((resolve, reject) => { upstream!.once('connect', resolve); upstream!.once('error', reject); });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.byteLength > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => { if (count(chunk)) client.write(chunk); else { upstream?.destroy(); client.destroy(); } });
    upstream.once('end', () => client.end());
    upstream.once('error', (error) => client.destroy(error));
    client.once('error', (error) => upstream?.destroy(error));
  } catch (error) { fail(error); upstream?.destroy(); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
}

function proxyHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders { const forwarded: IncomingHttpHeaders = { ...headers, host }; delete forwarded['proxy-connection']; delete forwarded['connection']; return forwarded; }
function trackSocket(sockets: Set<Duplex>, socket: Duplex): void { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
async function listenLoopback(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => { const error = (value: Error): void => reject(value); server.once('error', error); server.listen(0, '127.0.0.1', () => { server.removeListener('error', error); resolve(); }); }); }
function throwRenderFailure(...errors: readonly unknown[]): void { const error = errors.find((value) => value !== undefined); if (error !== undefined) throw error; }

interface PlaywrightModule { chromium: { launch(options: { headless: boolean; proxy: { server: string }; args: string[] }): Promise<PlaywrightBrowser> } }
interface PlaywrightBrowser { newContext(options: { acceptDownloads: boolean; serviceWorkers: 'block' }): Promise<PlaywrightContext>; close(): Promise<void> }
interface PlaywrightContext {
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
  routeWebSocket(pattern: string, handler: (socket: PlaywrightWebSocketRoute) => Promise<void>): Promise<void>;
  on(event: 'page', handler: (page: PlaywrightPage) => void): void;
  on(event: 'response', handler: (response: PlaywrightResponse) => void): void;
  newPage(): Promise<PlaywrightPage>;
  newCDPSession(page: PlaywrightPage): Promise<PlaywrightCdpSession>;
}
interface PlaywrightPage { goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<PlaywrightResponse | null>; waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>; content(): Promise<string>; url(): string; mainFrame(): PlaywrightFrame; close(): Promise<void>; on(event: 'download', handler: () => void): void }
interface PlaywrightFrame { page(): PlaywrightPage }
interface PlaywrightResponse { status(): number; headers(): Record<string, string>; request(): PlaywrightRequest }
interface PlaywrightRoute { request(): PlaywrightRequest; abort(code: string): Promise<void>; continue(): Promise<void> }
interface PlaywrightRequest { resourceType(): string; isNavigationRequest(): boolean; frame(): PlaywrightFrame; url(): string }
interface PlaywrightWebSocketRoute { close(): Promise<void> }
interface PlaywrightCdpSession { send(method: string, params?: unknown): Promise<unknown>; on(event: string, handler: (value: { requestId: string; responseStatusCode?: number }) => void): void }

const BROWSER_TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
function mediaType(value: string | undefined): string | undefined { const item = value?.split(';')[0]?.trim().toLowerCase(); return item === '' ? undefined : item; }
function isAttachment(value: string | undefined): boolean { return value?.toLowerCase().includes('attachment') === true; }
function rejectedContent(provider: string): NbSearchError { return new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The rendered response content type is not allowed.', false, provider); }
function redirectLimitError(status: number, maxRedirects: number, provider: string): NbSearchError { return new NbSearchError('FETCH_HTTP_ERROR', 'The redirect limit was reached.', false, provider, { data: { status, max_redirects: maxRedirects } }); }
function httpError(status: number, provider: string): NbSearchError { return new NbSearchError('FETCH_HTTP_ERROR', `${provider} fetch failed with status ${String(status)}.`, status === 429 || status >= 500, provider, { data: { status } }); }
