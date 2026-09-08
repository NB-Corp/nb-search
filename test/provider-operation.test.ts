import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveProviderOperation, builtInProviderRegistrations, ProviderRegistry, type HttpRequest, type HttpTransport, type ProviderInstanceConfig } from '../src/index.ts';

const registry = () => new ProviderRegistry(builtInProviderRegistrations());
const request = { query: 'fixture', limit: 2, request_time_utc: '2026-01-01T00:00:00Z', signal: new AbortController().signal };
function instance(provider_id: string, base_url?: string, options: Record<string, unknown> = {}): ProviderInstanceConfig { return { provider_id, enabled: true, credential_slot_id: 'fixture', ...(base_url === undefined ? {} : { base_url }), options }; }
function factory(input: ProviderInstanceConfig) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = { async send<T>(r: HttpRequest) { calls.push(r); return { status: 200, body: (input.provider_id === 'grok-multi-agent' ? JSON.stringify(input.options['api_mode'] === 'messages' ? { content: [{ type: 'text', text: '{"answer":"fixture"}' }] } : { choices: [{ message: { content: '{"answer":"fixture"}' } }] }) : { results: [{ title: 'Fixture', url: 'https://example.com/', text: 'Fixture text' }], output: { content: 'fixture' } }) as T }; } };
  return { calls, ports: registry().create('fixture', input, { credential: { provider_id: input.provider_id, credential_slot_id: 'fixture', value: 'fake-only', worker_grant: { kind: 'environment', name: 'FAKE_KEY' } }, transports: { http: transport }, clock: () => new Date() }) };
}

describe('offline provider operation resolution', () => {
  it.each([
    ['search', undefined, {}], ['search', 'https://relay.example/v1/', { search_path: '/custom' }],
    ['synthesis', 'https://relay.example/v1', { synthesis_path: '/deep' }], ['contents', undefined, {}], ['contents', 'https://relay.example/v1/contents', {}],
  ] as const)('resolves Exa %s to the factory actual request target', async (operation, base, options) => {
    const input = instance('exa', base, options); const info = resolveProviderOperation('exa', operation, input);
    expect(info.provider).toEqual(registry().requireDescriptor('exa'));
    expect(info.operation).toEqual(operation === 'contents' ? registry().fetchOperation('exa', operation) : registry().operation('exa', operation));
    const f = factory(info.instance);
    if (operation === 'contents') await f.ports.fetch['contents']!.fetch({ source: { kind: 'url', url: 'https://example.com/' }, representation: 'text', signal: request.signal, max_source_bytes: 10000, max_response_bytes: 10000, max_content_chars: 1000, max_redirects: 0, file_scopes: [] });
    else await f.ports.query[operation]!.execute(request);
    expect(f.calls).toHaveLength(1); expect(info.endpoints).toEqual([f.calls[0]!.url]);
  });
  it.each(['chat_completions', 'messages'] as const)('shares GMA %s defaults and target with the unnormalized factory input', async (mode) => {
    const input = instance('grok-multi-agent', 'https://relay.example/v1/', { api_mode: mode });
    const info = resolveProviderOperation('grok-multi-agent', 'research', input);
    expect(input.options).toEqual({ api_mode: mode });
    expect(info.instance.options).toEqual({ model: 'grok-4.20-multi-agent-xhigh', reasoning_effort: 'xhigh', api_mode: mode });
    const f = factory(input); await f.ports.query['research']!.execute(request);
    expect(info.endpoints).toEqual([f.calls[0]!.url]); expect(f.calls[0]!.body).toMatchObject({ model: info.instance.options['model'], reasoning: { effort: info.instance.options['reasoning_effort'] }, stream: true });
    expect(info.provider.adapter_version).toBe('2');
    expect(info.operation).toEqual(registry().operation('grok-multi-agent', 'research'));
  });
  it('does no network, resolves default api_mode and accepts plain HTTP for host policy to decide', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No network'));
    try {
      const info = resolveProviderOperation('grok-multi-agent', 'research', instance('grok-multi-agent', 'http://relay.example/v1'));
      expect(info.instance.options['api_mode']).toBe('chat_completions'); expect(info.endpoints).toEqual(['http://relay.example/v1/chat/completions']); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('returns script JSON params and no endpoints without importing the module', () => {
    mkdirSync(resolve('.release-check'), { recursive: true }); const root = mkdtempSync(resolve('.release-check/host-script-'));
    try {
      const marker = resolve(root, 'loaded'); const module = resolve(root, 'script.mjs');
      writeFileSync(module, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'bad'); export const search=()=>[];`);
      const input = instance('script', undefined, { module, params: { nested: { items: [1, true, 'x'] } } });
      const info = resolveProviderOperation('script', 'search', input);
      expect(info.endpoints).toEqual([]); expect(info.instance.options).toEqual(input.options); expect(existsSync(marker)).toBe(false);
      expect(info.kind).toBe('search'); expect(info.operation).toMatchObject({ built_in_async: true, output: { channel: 'results' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects invalid protocols/options/identities and unsupported resolution rather than guessing targets', () => {
    for (const base of ['ftp://relay.example', 'https://user:pass@relay.example', 'https://relay.example/v1?secret=bad']) {
      expect(() => resolveProviderOperation('exa', 'search', instance('exa', base))).toThrow();
      expect(() => resolveProviderOperation('grok-multi-agent', 'research', instance('grok-multi-agent', base))).toThrow();
    }
    for (const options of [{ api_mode: 'invalid' }, { api_mode: null }, { model: '' }, { reasoning_effort: 'bad' }, { unknown: true }]) expect(() => resolveProviderOperation('grok-multi-agent', 'research', instance('grok-multi-agent', 'https://relay.example', options))).toThrow();
    expect(() => resolveProviderOperation('grok-multi-agent', 'research', instance('grok-multi-agent'))).toThrow(/base URL/);
    expect(() => resolveProviderOperation('grok-multi-agent', 'research', instance('grok-multi-agent', 'https://relay.example/messages', { api_mode: 'chat_completions' }))).toThrow(/conflicts/);
    expect(() => resolveProviderOperation('exa', 'missing', instance('exa'))).toThrow(/not registered/);
    expect(() => resolveProviderOperation('unknown', 'search', instance('unknown'))).toThrow(/not registered/);
    expect(() => resolveProviderOperation('exa', 'search', instance('script'))).toThrow(/identity/);
    expect(() => resolveProviderOperation('tavily', 'search', instance('tavily'))).toThrow(/not supported/);
  });
});
