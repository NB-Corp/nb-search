import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createNbSearchRuntime } from '../src/index.ts';
import { FetchJsonTransport, ResponseLimitError } from '../src/transport.ts';

async function listen(server: Server): Promise<string> { await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback listener.'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }

describe('local authenticated GMA redirect policy', () => {
  it.each([
    ['messages', 302], ['messages', 307], ['chat_completions', 302], ['chat_completions', 307],
  ] as const)('%s rejects cross-origin %s before forwarding credentials/body, even with runtime retries enabled', async (mode, status) => {
    const root = mkdtempSync(resolve('.test-gma-redirect-')); const key = 'fake-redirect-only-key';
    let firstRequests = 0; let secondRequests = 0; let authenticated = false; let hadPostBody = false; let firstStreamClosed = false;
    const second = createServer(async (req, res) => { secondRequests++; for await (const _ of req) {} res.setHeader('content-type', 'application/json'); res.end('{}'); });
    const target = await listen(second);
    const suffix = mode === 'messages' ? '/messages' : '/chat/completions';
    const first = createServer(async (req, res) => {
      firstRequests++; let bytes = 0; for await (const chunk of req) bytes += chunk.length;
      authenticated = req.headers.authorization === `Bearer ${key}` && (mode === 'messages' ? req.headers['x-api-key'] === key : req.headers['x-api-key'] === undefined);
      hadPostBody = req.method === 'POST' && bytes > 0;
      res.on('close', () => { firstStreamClosed = true; });
      res.writeHead(status, { location: `${target}${suffix}`, 'content-type': 'text/plain' });
      res.flushHeaders(); res.write(`Do not expose this redirect body: ${key}`);
      // Deliberately never finish: manual rejection must cancel, not consume this body or wait for it.
    });
    const origin = await listen(first);
    try {
      const runtime = createNbSearchRuntime({ env: { NB_SEARCH_HOME: root, NB_SEARCH_GROK_API_KEY: key, NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: origin }, config: { provider_instances: { 'grok.default': { enabled: false }, 'grok-multi-agent.default': { options: { api_mode: mode } } }, execution: { retry_count: 2 } } });
      const result = await runtime.search({ action: 'run', query: 'fake local fixture brief', lane: 'gma.research', timeout_ms: 2000 });
      expect(result).toMatchObject({ action: 'run', execution: 'sync', status: 'failed', output: { lane_outcomes: [{ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider redirect was rejected.', retryable: false } }] } });
      expect(JSON.stringify(result)).not.toContain(key); expect(JSON.stringify(result)).not.toContain(target); expect(JSON.stringify(result)).not.toContain('Do not expose');
      for (let i = 0; !firstStreamClosed && i < 100; i++) await sleep(10);
      expect(authenticated).toBe(true); expect(hadPostBody).toBe(true); expect(firstStreamClosed).toBe(true);
      expect(firstRequests).toBe(1); expect(secondRequests).toBe(0);
    } finally { await close(first); await close(second); rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves default transport follow behavior and bounds manual non-redirect response bodies', async () => {
    let destinationRequests = 0;
    const target = createServer((req, res) => { destinationRequests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
    const destination = await listen(target);
    const origin = createServer((req, res) => { if (req.url === '/large') { res.setHeader('content-length', '64'); res.end('x'.repeat(64)); } else { res.writeHead(302, { location: destination }); res.end(); } });
    const base = await listen(origin); const transport = new FetchJsonTransport();
    try {
      await expect(transport.send({ url: base, method: 'GET', signal: new AbortController().signal, max_response_bytes: 128 })).resolves.toMatchObject({ status: 200, body: { ok: true } });
      expect(destinationRequests).toBe(1);
      await expect(transport.send({ url: `${base}/large`, method: 'GET', redirect: 'manual', response_type: 'text', max_response_bytes: 16, signal: new AbortController().signal })).rejects.toBeInstanceOf(ResponseLimitError);
      expect(destinationRequests).toBe(1);
    } finally { await close(origin); await close(target); }
  });
});
