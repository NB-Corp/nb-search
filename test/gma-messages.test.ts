import { describe, expect, it } from 'vitest';
import { GrokMultiAgentProvider, resolveGmaUrl } from '../src/providers.ts';
import { parseRelayMessagesContent, RELAY_CONTENT_MAX_BYTES, RELAY_RESPONSE_MAX_BYTES } from '../src/relay-parser.ts';
import { NbSearchError } from '../src/errors.ts';
import type { JsonTransport, HttpRequest as TransportRequest } from '../src/transport.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import { mapLegacy } from '../src/search-layer-import.ts';

const key = 'fake-gma-private-key';
const value = { answer: '证据 🌍 café', results: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Evidence' }], claims: [{ text: 'Evidence statement', confidence: 'high', evidence_strength: 'direct', evidence_urls: ['https://example.com/source'] }] };
const envelope = (data: unknown = value) => { const text = JSON.stringify(data); const split = Math.floor(text.length / 2); return JSON.stringify({ content: [{ type: 'thinking', text: '{"answer":"must not surface"}' }, { type: 'text', text: text.slice(0, split) }, { type: 'tool_use', text: 'must not surface', input: { query: 'hidden' } }, { type: 'text', text: text.slice(split) }] }); };
function request(signal = new AbortController().signal) { return { capability: 'multi-agent-research' as const, query: 'brief', brief: 'brief', limit: 5, request_time_utc: '2026-01-01T00:00:00.000Z', signal }; }
function fixture(body = envelope(), status = 200, headers: Record<string, string> = {}) {
  const calls: TransportRequest[] = [];
  const transport = { async send(input: TransportRequest) { calls.push(input); return { status, headers, body }; } } as JsonTransport;
  const provider = new GrokMultiAgentProvider({ apiKey: key, baseUrl: 'https://relay.example/v1/messages', model: 'grok-4.20-multi-agent-xhigh', reasoningEffort: 'xhigh', apiMode: 'messages', transport });
  return { provider, calls };
}

describe('explicit GMA relay messages mode', () => {
  it('sends the observed relay contract once and preserves the typed research projection', async () => {
    const f = fixture(); const result = await f.provider.research(request());
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ url: 'https://relay.example/v1/messages', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, response_type: 'text', max_response_bytes: RELAY_RESPONSE_MAX_BYTES, body: { system: expect.any(String), messages: [{ role: 'user', content: '<query>brief</query>' }], model: 'grok-4.20-multi-agent-xhigh', max_tokens: 4096, temperature: 0.1, stream: false, reasoning: { effort: 'xhigh' } } });
    expect(result).toMatchObject({ answer: value.answer, api_mode: 'messages', completeness: 'complete', expected_agent_count: 16, backend_trace_observable: false, semantic_verification: false }); expect(result.trace.claims).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('must not surface');
  });
  it('keeps omitted api_mode on the existing chat path and projection', async () => {
    let sent: TransportRequest | undefined; const transport = { async send(input: TransportRequest) { sent = input; return { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }) }; } } as JsonTransport;
    const provider = new GrokMultiAgentProvider({ apiKey: key, baseUrl: 'https://relay.example/v1', model: 'grok-4.20-multi-agent-xhigh', reasoningEffort: 'low', transport });
    expect(await provider.research(request())).toMatchObject({ api_mode: 'chat_completions', expected_agent_count: 4, answer: value.answer }); expect(sent?.url).toBe('https://relay.example/v1/chat/completions'); expect(sent?.headers).not.toHaveProperty('x-api-key'); expect(sent?.body).not.toHaveProperty('system');
  });
  it('accepts only bases or matching suffixes, never switches wire protocol', () => {
    expect(resolveGmaUrl('https://relay.example/v1/', 'messages')).toBe('https://relay.example/v1/messages'); expect(resolveGmaUrl('https://relay.example/v1/messages/', 'messages')).toBe('https://relay.example/v1/messages');
    for (const [url, mode] of [['https://relay.example/v1/chat/completions', 'messages'], ['https://relay.example/v1/messages', 'chat_completions'], ['https://relay.example/v1/responses', 'messages']] as const) expect(() => resolveGmaUrl(url, mode)).toThrow(/conflicts/);
    expect(() => resolveGmaUrl('https://relay.example', 'unknown' as never)).toThrow(/api_mode/);
    const registration = builtInProviderRegistrations().find((r) => r.descriptor.provider_id === 'grok-multi-agent')!; expect(registration.descriptor).toMatchObject({ adapter_version: '2', option_keys: ['model', 'reasoning_effort', 'api_mode'] }); expect(() => registration.validate!('gma', { provider_id: 'grok-multi-agent', enabled: true, options: { model: 'grok-test', reasoning_effort: 'low', api_mode: 'unknown' } })).toThrow();
    for (const invalid of [null, '', 'anthropic']) expect(() => registration.validate!('gma', { provider_id: 'grok-multi-agent', enabled: true, options: { model: 'grok-test', reasoning_effort: 'low', api_mode: invalid } })).toThrow(/api_mode/);
    const current = new ProviderRegistry(builtInProviderRegistrations()).operationFingerprint('grok-multi-agent', 'research'); const old = new ProviderRegistry([{ ...registration, descriptor: { ...registration.descriptor, adapter_version: '1' } }]).operationFingerprint('grok-multi-agent', 'research'); expect(current).not.toBe(old);
  });
  it.each(['', '{broken', '{"content":[]}', '{"content":[{"type":"text","text":42}]}', '{"content":[{"type":"thinking","thinking":"hidden"}]}'])('rejects empty/malformed messages JSON without retries (%s)', async (body) => { const f = fixture(body); await expect(f.provider.research(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' }); expect(f.calls).toHaveLength(1); });
  it('enforces response/content limits and rejects SSE instead of guessing a stream contract', () => {
    expect(() => parseRelayMessagesContent('x'.repeat(RELAY_RESPONSE_MAX_BYTES + 1), {}, 'gma')).toThrow(/limit/);
    expect(() => parseRelayMessagesContent(JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(RELAY_CONTENT_MAX_BYTES + 1) }] }), {}, 'gma')).toThrow(/limit/);
    expect(() => parseRelayMessagesContent(envelope(), { 'content-type': 'text/event-stream' }, 'gma')).toThrow(/malformed/);
  });
  it.each([[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT']] as const)('maps HTTP %s with safe errors and single dispatch', async (status, code) => { const f = fixture(`raw ${key}`, status, { 'retry-after': '1' }); const error = await f.provider.research(request()).catch((e: unknown) => e); expect(error).toMatchObject({ code }); expect(JSON.stringify(error)).not.toContain(key); expect(f.calls).toHaveLength(1); });
  it('excludes echoed secrets from semantic output and honors caller abort without another dispatch', async () => {
    const f = fixture(envelope({ ...value, answer: `echo ${key}` })); const result = await f.provider.research(request()); expect(result.answer).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(key); expect(result.trace.omissions.sensitive_semantic_items).toBeGreaterThan(0);
    const controller = new AbortController(); let count = 0; const transport = { async send() { count++; controller.abort(new NbSearchError('CANCELLED', 'Cancelled.')); return { status: 200, body: envelope(), headers: {} }; } } as JsonTransport;
    const provider = new GrokMultiAgentProvider({ apiKey: key, baseUrl: 'https://relay.example', model: 'grok-test', reasoningEffort: 'low', apiMode: 'messages', transport }); await expect(provider.research(request(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' }); expect(count).toBe(1);
  });
  it('reports normalized modes and precise blocked reasons without inventing legacy key/URL env support', () => {
    for (const mode of ['messages', 'anthropic', 'anthropic_messages']) { const mapped = mapLegacy({ grokMultiAgent: { apiKey: key, apiUrl: 'https://relay.example/v1/messages', apiMode: mode } }, {}); expect(mapped.providers.find((r) => r.provider === 'grok-multi-agent')).toMatchObject({ normalized_protocol: 'messages', status: 'compatible_unverified' }); expect(mapped.patch.provider_instances?.['grok-multi-agent.default']?.options?.['api_mode']).toBe('messages'); }
    for (const [mode, url, reason] of [['mystery', 'https://relay.example/v1', 'API_MODE_UNKNOWN'], ['messages', undefined, 'ENDPOINT_MISSING'], ['messages', 'https://relay.example/v1/chat/completions', 'ENDPOINT_PROTOCOL_CONFLICT'], ['chat', 'https://relay.example/v1/messages', 'ENDPOINT_PROTOCOL_CONFLICT']] as const) { const mapped = mapLegacy({ grokMultiAgent: { apiKey: key, apiMode: mode, apiUrl: url } }, {}); expect(mapped.providers.find((r) => r.provider === 'grok-multi-agent')).toMatchObject({ status: 'disabled_incompatible', reason }); expect(JSON.stringify(mapped.providers)).not.toMatch(/fake-gma|relay\.example/); }
    for (const invalid of [null, 123, '']) expect(mapLegacy({ grokMultiAgent: { apiKey: key, apiUrl: 'https://relay.example/v1', apiMode: invalid } }, {}).providers.find((r) => r.provider === 'grok-multi-agent')).toMatchObject({ normalized_protocol: 'unknown', reason: 'API_MODE_UNKNOWN', status: 'disabled_incompatible' });
    const mapped = mapLegacy({ grok: { apiKey: 'file-grok', apiUrl: 'https://file.example/v1' }, grokMultiAgent: { apiKey: 'own-gma', apiMode: 'messages' } }, { GROK_API_KEY: 'env-grok', GROK_API_URL: 'https://env.example/v1', GROK_MULTI_AGENT_API_KEY: 'unsupported-key', GROK_MULTI_AGENT_API_URL: 'https://unsupported.example/' });
    expect(mapped.secrets.values['NB_SEARCH_GROK_MULTI_AGENT_API_KEY']).toBe('own-gma'); expect(mapped.patch.provider_instances?.['grok-multi-agent.default']?.base_url).toBe('https://env.example/v1');
  });
});
