import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { GrokMultiAgentProvider } from '../src/providers.ts';
import { parseRelayChatContent, parseRelayMessagesContent, RELAY_CONTENT_MAX_BYTES } from '../src/relay-parser.ts';
import { FetchJsonTransport } from '../src/transport.ts';

const value = JSON.stringify({ answer: '证据 🌍 café', results: [] });
const event = (data: unknown, name?: string) => `${name ? `event: ${name}\r\n` : ''}data: ${JSON.stringify(data)}\r\n\r\n`;
function stream(mode: 'messages' | 'chat_completions', ending = 'normal', text = value) {
  if (mode === 'chat_completions') return ': heartbeat\r\n\r\n' + event({ choices: [{ index: 0, delta: { reasoning_content: 'hidden', tool_calls: [] } }] }) + event({ choices: [{ index: 0, delta: { content: text.slice(0, 12) } }] }) + event({ choices: [{ index: 0, delta: { content: text.slice(12) } }] }) + (ending === 'cut' ? '' : ending === 'error' ? event({ error: { message: 'private upstream secret' } }, 'error') : event({ choices: [{ index: 0, delta: {}, finish_reason: ending === 'normal' ? 'stop' : 'length' }] }) + 'data: [DONE]\r\n\r\n');
  return event({ type: 'message_start', message: { content: [] } }, 'message_start') + event({ type: 'ping' }, 'ping') + event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } }) + event({ type: 'content_block_stop', index: 0 }) + event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, 12) } }) + event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(12) } }) + event({ type: 'content_block_stop', index: 1 }) + (ending === 'cut' ? '' : ending === 'error' ? event({ type: 'error', error: { message: 'private upstream secret' } }, 'error') : event({ type: 'message_delta', delta: { stop_reason: ending === 'normal' ? 'end_turn' : 'max_tokens' } }) + event({ type: 'message_stop' }));
}
const parsers = { messages: parseRelayMessagesContent, chat_completions: parseRelayChatContent };
async function listen(server: Server) { await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const a = server.address(); if (!a || typeof a === 'string') throw Error('listener'); return `http://127.0.0.1:${a.port}`; }
function request(signal = new AbortController().signal) { return { capability: 'multi-agent-research' as const, query: 'brief', brief: 'brief', limit: 3, request_time_utc: '2026-01-01T00:00:00Z', signal }; }

describe.each(['messages', 'chat_completions'] as const)('GMA streamed %s', (mode) => {
  it('aggregates only text and requires successful protocol completion', () => {
    expect(parsers[mode](stream(mode), {}, 'gma')).toBe(value);
    for (const ending of ['cut', 'error', 'incomplete']) expect(() => parsers[mode](stream(mode, ending), {}, 'gma')).toThrow(/malformed/);
    expect(() => parsers[mode](stream(mode) + event({ error: { message: 'secret' } }, 'error'), {}, 'gma')).toThrow(/malformed/);
    expect(() => parsers[mode](stream(mode).slice(0, -2), {}, 'gma')).toThrow(/malformed/);
    expect(() => parsers[mode](stream(mode, 'cut') + 'data: {broken}\n\n' + stream(mode), {}, 'gma')).toThrow(/malformed/);
    const json = mode === 'messages' ? { content: [{ type: 'text', text: value }], stop_reason: 'max_tokens' } : { choices: [{ message: { content: value }, finish_reason: 'length' }] };
    expect(() => parsers[mode](JSON.stringify(json), {}, 'gma')).toThrow(/malformed/);
    expect(() => parsers[mode](stream(mode, 'normal', 'x'.repeat(RELAY_CONTENT_MAX_BYTES + 1)), {}, 'gma')).toThrow(/limit/);
  });
  it.each(['normal', 'error', 'cut', 'disconnect', 'abort'] as const)('reads actual byte-split HTTP SSE: %s', async (ending) => {
    let count = 0; let sent: unknown; let accept: string | undefined; const controller = new AbortController();
    const server = createServer(async (req, res) => {
      count++; accept = req.headers.accept; const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); sent = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(stream(mode, ending === 'disconnect' || ending === 'abort' ? 'cut' : ending));
      const split = bytes.indexOf(Buffer.from('🌍')) + 1;
      res.write(bytes.subarray(0, split)); await sleep(5); res.write(bytes.subarray(split));
      if (ending === 'abort') { controller.abort(new Error('caller abort')); return; }
      if (ending === 'disconnect') { await sleep(5); res.destroy(); return; }
      res.end();
    });
    const baseUrl = await listen(server);
    try {
      const provider = new GrokMultiAgentProvider({ baseUrl, apiKey: 'fake-test-key', model: 'grok-test', reasoningEffort: 'low', apiMode: mode, transport: new FetchJsonTransport() });
      const pending = provider.research(request(controller.signal));
      if (ending === 'normal') await expect(pending).resolves.toMatchObject({ answer: '证据 🌍 café', api_mode: mode });
      else { const error: unknown = await pending.catch((e: unknown) => e); expect(error).toBeInstanceOf(Error); expect(JSON.stringify(error)).not.toContain('private upstream secret'); }
      expect(count).toBe(1); expect(sent).toMatchObject({ stream: true }); expect(accept).toBe('text/event-stream');
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it('bounds actual chunked HTTP response bytes, including non-content heartbeat bytes', async () => {
    const server = createServer(async (req, res) => {
      for await (const _ of req) {}
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n'); await sleep(5); res.end(':'.repeat(256));
    });
    const baseUrl = await listen(server);
    try {
      await expect(new FetchJsonTransport().send({ url: baseUrl, method: 'POST', response_type: 'text', max_response_bytes: 128, redirect: 'manual', signal: new AbortController().signal })).rejects.toMatchObject({ name: 'ResponseLimitError', retryable: false, maximum: 128 });
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it('marks HTTP 524 retryable without another dispatch', async () => {
    let count = 0;
    const provider = new GrokMultiAgentProvider({ baseUrl: 'https://relay.example', apiKey: 'fake', model: 'grok-test', reasoningEffort: 'low', apiMode: mode, transport: { async send<T>() { count++; return { status: 524, body: '' as T }; } } });
    await expect(provider.research(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true }); expect(count).toBe(1);
  });
});

it('handles multiline SSE data and text arrays without exposing non-text chat blocks', () => {
  const body = 'data: {"choices":\n' + `data: ${JSON.stringify([{ index: 0, delta: { content: [{ type: 'thinking', text: 'hidden' }, { type: 'text', text: value.slice(0, 10) }, { type: 'text', text: value.slice(10) }, { type: 'tool_use', text: 'hidden' }] } }])}}\n\n`
    + event({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] }) + event({ choices: [], usage: { total_tokens: 1 } }) + 'data: [DONE]\n\n';
  expect(parseRelayChatContent(body, {}, 'gma')).toBe(value);
  expect(() => parseRelayChatContent(stream('chat_completions', 'cut') + 'data: [DONE]\n\n', {}, 'gma')).toThrow(/malformed/);
});

it('ignores messages tool JSON and fails closed on unclosed blocks or tool-use stops', () => {
  const extra = event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', input: {} } })
    + event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"answer":"hidden"}' } })
    + event({ type: 'content_block_stop', index: 2 });
  const normal = stream('messages').replace(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), extra + event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
  expect(parseRelayMessagesContent(normal, {}, 'gma')).toBe(value);
  expect(() => parseRelayMessagesContent(normal.replace(event({ type: 'content_block_stop', index: 2 }), ''), {}, 'gma')).toThrow(/malformed/);
  expect(() => parseRelayMessagesContent(normal.replace('"end_turn"', '"tool_use"'), {}, 'gma')).toThrow(/malformed/);
});
