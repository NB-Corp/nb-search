import { describe, expect, it, vi } from 'vitest';

import { SearchService } from '../src/core.ts';
import { NbSearchError } from '../src/errors.ts';
import type { SearchPlan } from '../src/planner.ts';
import type { ProviderPorts } from '../src/provider-registry.ts';
import type { ProviderSearchRequest, ProviderResult, SearchProvider } from '../src/types.ts';

describe('SearchService', () => {
  it('normalizes and deduplicates URLs in deterministic provider order', async () => {
    const exa = provider('exa', async () => [{
      title: '  Primary   result ',
      url: 'HTTPS://Example.com:443/docs/?utm_source=x&b=2&a=1#part',
      snippet: ' first   snippet ',
      published_at: '2026-08-01',
    }]);
    const tavily = provider('tavily', async () => [{
      title: 'Duplicate', url: 'https://example.com/docs?a=1&b=2', snippet: 'other',
    }, { title: 'Second', url: 'https://second.test/', snippet: 'second' }]);

    const response = await new SearchService({
      providers: [exa, tavily], requestId: () => 'request-1', now: clock(),
    }).search({ query: ' query ' });

    expect(response).toMatchObject({
      request_id: 'request-1', mode: 'search', state: 'succeeded', query: 'query',
    });
    expect(response.results.map((item) => item.url)).toEqual([
      'https://example.com/docs?a=1&b=2', 'https://second.test/',
    ]);
    expect(response.results[0]).toMatchObject({
      title: 'Primary result', snippet: 'first snippet', providers: ['exa', 'tavily'],
    });
    expect(response.results[0]?.provenance.map((item) => [item.provider, item.rank])).toEqual([
      ['exa', 0], ['tavily', 0],
    ]);
    expect(response.attempts.map((attempt) => attempt.result_count)).toEqual([1, 2]);
  });

  it('preserves useful results and typed attempts when another provider degrades', async () => {
    let failedCalls = 0;
    const success = provider('exa', async () => [{ title: 'Good', url: 'https://good.test' }]);
    const failure = provider('tavily', async () => {
      failedCalls += 1;
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'provider failed with api_key=hidden-token', true, 'tavily');
    }, ['hidden-token']);

    const response = await new SearchService({
      providers: [success, failure], sleep: async () => undefined,
    }).search({ query: 'q' });

    expect(response.state).toBe('partial');
    expect(response.results).toHaveLength(1);
    expect(failedCalls).toBe(2);
    expect(response.attempts.filter((attempt) => attempt.provider === 'tavily')).toHaveLength(2);
    expect(response.attempts.at(-1)).toMatchObject({
      provider: 'tavily', attempt: 2, state: 'failed', error: { code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(JSON.stringify(response)).not.toContain('hidden-token');
  });

  it('distinguishes empty, failed, and explicit cancellation', async () => {
    const empty = await new SearchService({ providers: [provider('exa', async () => [])] }).search({ query: 'q' });
    expect(empty.state).toBe('empty');
    expect(empty.attempts[0]?.state).toBe('empty');

    const missing = await new SearchService({ providers: [] }).search({ query: 'q' });
    expect(missing).toMatchObject({ state: 'failed', error: { code: 'CONFIGURATION_ERROR' } });

    const controller = new AbortController();
    const waiting = provider('exa', async ({ signal }) => await untilAborted(signal));
    const pending = new SearchService({ providers: [waiting] }).search({ query: 'q', signal: controller.signal });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
  });

  it('maps caller cancellation during retry backoff without hiding provider history', async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    let backoffStarted!: () => void;
    const enteredBackoff = new Promise<void>((resolve) => { backoffStarted = resolve; });
    const service = new SearchService({
      providers: [provider('exa', async () => {
        providerCalls += 1;
        throw new NbSearchError('PROVIDER_UNAVAILABLE', 'temporary provider failure', true, 'exa');
      })],
      sleep: async (_ms, signal) => {
        backoffStarted();
        await untilAborted(signal);
      },
    });

    const pending = service.search({ query: 'q', signal: controller.signal });
    await enteredBackoff;
    controller.abort(new Error('caller stopped'));
    const response = await pending;

    expect(response).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
    expect(response.attempts).toEqual([
      expect.objectContaining({ attempt: 1, state: 'failed', error: { code: 'PROVIDER_UNAVAILABLE', message: 'temporary provider failure', retryable: true, provider: 'exa' } }),
    ]);
    expect(providerCalls).toBe(1);
  });

  it('maps deadline exhaustion during retry backoff to the deadline diagnostic', async () => {
    vi.useFakeTimers();
    try {
      let providerCalls = 0;
      let backoffStarted!: () => void;
      const enteredBackoff = new Promise<void>((resolve) => { backoffStarted = resolve; });
      const service = new SearchService({
        providers: [provider('exa', async () => {
          providerCalls += 1;
          throw new NbSearchError('PROVIDER_UNAVAILABLE', 'temporary provider failure', true, 'exa');
        })],
        sleep: async (_ms, signal) => {
          backoffStarted();
          await untilAborted(signal);
        },
      });
      const pending = service.search({ query: 'q', timeout_ms: 1000 });
      await enteredBackoff;
      await vi.advanceTimersByTimeAsync(1000);
      const response = await pending;

      expect(response).toMatchObject({ state: 'timed_out', error: { code: 'DEADLINE_EXCEEDED' } });
      expect(response.attempts[0]).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_UNAVAILABLE' } });
      expect(providerCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a successful answer as partial output when the outer deadline yields no URL results', async () => {
    vi.useFakeTimers();
    try {
      const plan: SearchPlan = {
        plan_version: '1', profile_id: 'default', plan_fingerprint: 'answer-deadline',
        stages: [{ stage_id: 'stage-1', kind: 'parallel', invocations: [{
          invocation_id: 'retrieval', provider_id: 'exa', provider_instance_id: 'exa.default', capability: 'retrieval',
          role: 'primary', trigger: 'always', timeout_ms: 5_000, retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 },
        }, {
          invocation_id: 'answer', provider_id: 'tavily', provider_instance_id: 'tavily.default', capability: 'answer',
          role: 'answer', trigger: 'routing:answer-intent', timeout_ms: 5_000, retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 },
          failure_policy: 'affects-state', execution_scope: 'once-per-job',
        }] }],
      };
      const ports = new Map<string, ProviderPorts>([
        ['exa.default', { retrieval: provider('exa', async ({ signal }) => await untilAborted(signal)) }],
        ['tavily.default', { answer: {
          name: 'tavily', provider_id: 'tavily', provider_instance_id: 'tavily.default',
          async answer() { return { capability: 'answer', text: 'useful answer', supporting_results: [] }; },
        } }],
      ]);
      const pending = new SearchService({ providers: [], plan, portsByInstance: ports }).search({
        query: 'q', profile: 'default', intent: 'factual', timeout_ms: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;

      expect(response).toMatchObject({
        state: 'partial', results: [], error: { code: 'DEADLINE_EXCEEDED' },
        augmentations: [{ capability: 'answer', state: 'succeeded', result: { delivery: 'inline', value: { text: 'useful answer' } } }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('compacts oversized snippets and omits low-ranked results within 32 KiB', async () => {
    const huge = 'x'.repeat(20_000);
    const results = Array.from({ length: 20 }, (_, index) => ({
      title: `Result ${String(index)}`, url: `https://example.test/${String(index)}`, snippet: huge,
    }));
    const response = await new SearchService({ providers: [provider('exa', async () => results)] })
      .search({ query: 'q', max_results: 20 });

    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(response.compaction.applied).toBe(true);
    expect(response.compaction.snippets_shortened + response.compaction.results_omitted).toBeGreaterThan(0);
  });
});

function provider(
  name: 'exa' | 'tavily',
  search: (request: ProviderSearchRequest) => Promise<readonly ProviderResult[]>,
  redactions?: readonly string[],
): SearchProvider {
  return { name, search, ...(redactions === undefined ? {} : { redactions }) };
}

async function untilAborted(signal: AbortSignal): Promise<never> {
  return await new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}
