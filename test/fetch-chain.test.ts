import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import type { CanonicalConfigPatch } from '../src/config-schema.ts';
import { NbSearchError } from '../src/errors.ts';
import type { ProviderRegistration } from '../src/provider-registry.ts';
import type { FetchProviderResult, PublicErrorCode } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('fetch serial lane chain', () => {
  it('runs lanes in order and short-circuits after the first qualified document', async () => {
    const calls = { a: 0, b: 0, c: 0 }; const app = await runtime(['a.fetch', 'b.fetch', 'c.fetch'], {
      a: async (url) => { calls.a += 1; return document(url, 'a'.repeat(600)); },
      b: async (url) => { calls.b += 1; return document(url, 'b'.repeat(600)); },
      c: async (url) => { calls.c += 1; return document(url, 'c'.repeat(600)); },
    });
    const value = await app.runtime.fetch({ url: 'https://example.com' });
    expect(value).toMatchObject({ status: 'succeeded', documents: [{ source_lane: 'a.fetch' }], lane_outcomes: [{ lane: 'a.fetch', state: 'succeeded' }] });
    expect(calls).toEqual({ a: 1, b: 0, c: 0 });
  });

  it('preserves duplicate lane entries as configured', async () => { let calls = 0; const app = await runtime(['a.fetch', 'a.fetch'], { a: async (url) => { calls += 1; if (calls === 1) throw httpError(403); return document(url, 'a'.repeat(600)); } }); const value = await app.runtime.fetch({ url: 'https://example.com' }); expect(value.status).toBe('succeeded'); expect(value.lane_outcomes.map((item) => item.lane)).toEqual(['a.fetch', 'a.fetch']); expect(calls).toBe(2); });

  it('falls back after a classified failure and preserves outcome order', async () => {
    const calls = { a: 0, b: 0, c: 0 }; const app = await runtime(['a.fetch', 'b.fetch', 'c.fetch'], {
      a: async () => { calls.a += 1; throw httpError(403); },
      b: async (url) => { calls.b += 1; return document(url, 'b'.repeat(600)); },
      c: async (url) => { calls.c += 1; return document(url, 'c'.repeat(600)); },
    });
    const value = await app.runtime.fetch({ url: 'https://example.com' });
    expect(value.documents[0]?.source_lane).toBe('b.fetch'); expect(value.lane_outcomes.map((item) => item.lane)).toEqual(['a.fetch', 'b.fetch']); expect(calls).toEqual({ a: 1, b: 1, c: 0 });
  });

  it.each([403, 429, 500, 418])('falls back after HTTP %s', async (status) => {
    let second = 0; const app = await runtime(['a.fetch', 'b.fetch'], { a: async () => { throw httpError(status); }, b: async (url) => { second += 1; return document(url, 'b'.repeat(600)); } });
    const value = await app.runtime.fetch({ url: 'https://example.com' }); expect(value.status).toBe('succeeded'); expect(second).toBe(1);
  });

  it.each([[404, 'FETCH_HTTP_ERROR'], [410, 'FETCH_HTTP_ERROR'], [0, 'FETCH_BLOCKED'], [0, 'FETCH_CONTENT_TYPE_REJECTED']] as const)('terminates after %s %s', async (status, code) => {
    let second = 0; const app = await runtime(['a.fetch', 'b.fetch'], { a: async () => { if (code === 'FETCH_HTTP_ERROR') throw httpError(status); throw new NbSearchError(code, code); }, b: async (url) => { second += 1; return document(url, 'b'.repeat(600)); } });
    const value = await app.runtime.fetch({ url: 'https://example.com' }); expect(value.status).toBe('failed'); expect(value.lane_outcomes).toHaveLength(1); expect(second).toBe(0);
  });

  it('falls back after a transport error and records all outcomes when every lane fails', async () => {
    const app = await runtime(['a.fetch', 'b.fetch', 'c.fetch'], { a: async () => { throw new Error('transport'); }, b: async () => { throw httpError(500); }, c: async () => { throw new NbSearchError('QUALITY_GATE_FAILED', 'quality'); } });
    const value = await app.runtime.fetch({ url: 'https://example.com' }); expect(value.status).toBe('failed'); expect(value.lane_outcomes.map((item) => item.lane)).toEqual(['a.fetch', 'b.fetch', 'c.fetch']);
  });

  it('applies both quality rules case-insensitively and supports disabling each rule', async () => {
    const short = await runtime(['a.fetch', 'b.fetch'], { a: async (url) => document(url, 'short'), b: async (url) => document(url, 'b'.repeat(20)) }, { quality: { min_content_chars: 10, blocked_markers: [] } });
    const shortValue = await short.runtime.fetch({ url: 'https://example.com' }); expect(shortValue.documents[0]?.source_lane).toBe('b.fetch'); expect(shortValue.lane_outcomes[0]?.error?.code).toBe('QUALITY_GATE_FAILED');
    const marker = await runtime(['a.fetch', 'b.fetch'], { a: async (url) => document(url, 'Please Enable JavaScript now'), b: async (url) => document(url, 'usable content') }, { quality: { min_content_chars: 0, blocked_markers: ['please enable javascript'] } });
    const markerValue = await marker.runtime.fetch({ url: 'https://example.com' }); expect(markerValue.documents[0]?.source_lane).toBe('b.fetch'); expect(markerValue.lane_outcomes[0]?.error?.code).toBe('QUALITY_GATE_FAILED');
    const disabledLength = await runtime(['a.fetch'], { a: async (url) => document(url, '') }, { quality: { min_content_chars: 0, blocked_markers: [] } }); expect((await disabledLength.runtime.fetch({ url: 'https://example.com' })).status).toBe('succeeded');
    const disabledMarkers = await runtime(['a.fetch'], { a: async (url) => document(url, 'JUST A MOMENT') }, { quality: { min_content_chars: 0, blocked_markers: [] } }); expect((await disabledMarkers.runtime.fetch({ url: 'https://example.com' })).status).toBe('succeeded');
  });

  it('records unavailable lanes as skipped without consuming calls', async () => {
    let calls = 0; const app = await runtime(['a.fetch', 'b.fetch'], { a: async () => { calls += 1; throw new Error(); }, b: async (url) => { calls += 1; return document(url, 'b'.repeat(600)); } }, { disabled: ['a'] });
    const value = await app.runtime.fetch({ url: 'https://example.com' }); expect(value.lane_outcomes).toMatchObject([{ lane: 'a.fetch', state: 'skipped', error: { code: 'LANE_NOT_CONFIGURED' } }, { lane: 'b.fetch', state: 'succeeded' }]); expect(calls).toBe(1);
    const none = await runtime(['a.fetch', 'b.fetch'], {}, { disabled: ['a', 'b'] }); const failed = await none.runtime.fetch({ url: 'https://example.com' }); expect(failed.status).toBe('failed'); expect(failed.lane_outcomes.every((item) => item.state === 'skipped')).toBe(true); expect(failed.hints.some((item) => item.code === 'FETCH_CHAIN_UNAVAILABLE')).toBe(true);
  });

  it('uses an explicit lane without touching the configured chain', async () => {
    const calls = { a: 0, b: 0, c: 0 }; const app = await runtime(['a.fetch', 'b.fetch'], { a: async (url) => { calls.a += 1; return document(url, 'a'); }, b: async (url) => { calls.b += 1; return document(url, 'b'); }, c: async (url) => { calls.c += 1; return document(url, 'c'); } }, { quality: { min_content_chars: 0, blocked_markers: [] } });
    const value = await app.runtime.fetch({ url: 'https://example.com', lane: 'c.fetch' }); expect(value.documents[0]?.source_lane).toBe('c.fetch'); expect(value.selection).toEqual({ source: 'lane', lane: 'c.fetch' }); expect(calls).toEqual({ a: 0, b: 0, c: 1 });
  });

  it('shares provider-call budget and deadline across the chain', async () => {
    let a = 0; let b = 0; const budget = await runtime(['a.fetch', 'b.fetch'], { a: async () => { a += 1; throw new NbSearchError('PROVIDER_UNAVAILABLE', 'retry', true); }, b: async (url) => { b += 1; return document(url, 'b'); } }, { max_provider_calls: 1, retry_count: 1, quality: { min_content_chars: 0, blocked_markers: [] } });
    const budgetValue = await budget.runtime.fetch({ url: 'https://example.com' }); expect(budgetValue.status).toBe('failed'); expect(a).toBe(1); expect(b).toBe(0); expect(budgetValue.hints.some((item) => item.code === 'BUDGET_EXCEEDED')).toBe(true);
    const deadline = await runtime(['a.fetch', 'b.fetch'], { a: async (_url, signal) => await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), b: async (url) => { b += 1; return document(url, 'b'); } }, { quality: { min_content_chars: 0, blocked_markers: [] } });
    const deadlineValue = await deadline.runtime.fetch({ url: 'https://example.com', timeout_ms: 100 }); expect(deadlineValue.status).toBe('timed_out'); expect(deadlineValue.lane_outcomes).toMatchObject([{ lane: 'a.fetch', state: 'timeout' }]); expect(b).toBe(0);
  });
});

type FetchBehavior = (url: string, signal: AbortSignal) => Promise<FetchProviderResult>;
async function runtime(chain: string[], behaviors: Record<string, FetchBehavior> = {}, options: { quality?: { min_content_chars: number; blocked_markers: string[] }; disabled?: string[]; max_provider_calls?: number; retry_count?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-fetch-chain-')); roots.push(root); const ids = [...new Set([...chain.map(prefix), ...Object.keys(behaviors)])]; const registrations = ids.map((id) => registration(id, behaviors[id])); const provider_instances: Record<string, { provider_id: string; enabled: boolean; options: {} }> = {}; const lanes: Record<string, { provider_instance_id: string; operation_id: string; latency: 'fast'; cost: 'free' }> = {};
  for (const id of ids) { provider_instances[`${id}.default`] = { provider_id: id, enabled: !(options.disabled ?? []).includes(id), options: {} }; lanes[`${id}.fetch`] = { provider_instance_id: `${id}.default`, operation_id: 'fetch', latency: 'fast', cost: 'free' }; }
  const config: CanonicalConfigPatch = { home: root, jobs_root: join(root, 'jobs'), provider_instances, lanes, defaults: { fetch_chain: chain }, execution: { retry_count: options.retry_count ?? 0, max_provider_calls: options.max_provider_calls ?? 64, fetch: { quality: options.quality ?? { min_content_chars: 500, blocked_markers: [] } } } };
  return createRuntimeComposition({}, { cwd: root, homeDirectory: root, config, provider_registrations: registrations });
}
function registration(id: string, behavior: FetchBehavior | undefined): ProviderRegistration { return { descriptor: { provider_id: id, adapter_version: 'test-1', query_operations: [], fetch_operation: { operation_id: 'fetch', schema_id: 'nb-search.fetch@1' }, activation: { credential: 'none', endpoint: 'none' }, option_keys: [] }, create: () => ({ query: {}, fetch: { name: id, async fetch(request) { return await (behavior?.(request.url, request.signal) ?? Promise.resolve(document(request.url, 'default'.repeat(100)))); } } }) }; }
function prefix(lane: string): string { return lane.split('.')[0]!; }
function document(url: string, content: string): FetchProviderResult { return { url, final_url: url, content, content_type: 'text/plain', format: 'text', byte_length: Buffer.byteLength(content), truncated: false, warnings: [] }; }
function httpError(status: number): NbSearchError { return new NbSearchError('FETCH_HTTP_ERROR', `HTTP ${String(status)}`, status >= 500, 'test', { data: { status } }); }
