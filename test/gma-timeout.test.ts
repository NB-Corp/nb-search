import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { NbSearchError } from '../src/errors.ts';
import type { JsonRequest, JsonTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function gmaEnv(root: string): NodeJS.ProcessEnv {
  return { NB_SEARCH_HOME: root, NB_SEARCH_GROK_API_KEY: 'fake-gma-key', NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: 'https://relay.example/v1' };
}
function hangingTransport(): JsonTransport {
  return { async send<T>(request: JsonRequest) { return await new Promise<never>((_resolve, reject) => { if (request.signal.aborted) { reject(request.signal.reason); return; } request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); }); } };
}
function gmaResponse(answer: string): string {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer, results: [] }) } }] });
}

describe('GMA search timeout and query-array execution', () => {
  it('does not use the ordinary 30-second default for sync GMA, but honors the 600-second deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-gma-timeout-')); roots.push(root); vi.useFakeTimers();
    const app = createRuntimeComposition(gmaEnv(root), { cwd: root, homeDirectory: root, transport: hangingTransport(), config: { execution: { retry_count: 0, max_provider_calls: 1 } } });
    let settled = false;
    const pending = app.runtime.search({ action: 'run', query: 'long GMA brief', lane: 'gma.research' }).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(30_001); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(569_998); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 'timed_out', output: { lane_outcomes: [{ state: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } }] } });
  });

  it('keeps an explicit short request timeout effective for GMA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-gma-short-timeout-')); roots.push(root); vi.useFakeTimers();
    const app = createRuntimeComposition(gmaEnv(root), { cwd: root, homeDirectory: root, transport: hangingTransport(), config: { execution: { retry_count: 0, max_provider_calls: 1 } } });
    const pending = app.runtime.search({ action: 'run', query: 'short GMA brief', lane: 'gma.research', timeout_ms: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ status: 'timed_out', output: { lane_outcomes: [{ state: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } }] } });
  });

  it('captures the same GMA default in async snapshots and preserves explicit config precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-gma-snapshot-')); roots.push(root);
    const app = createRuntimeComposition(gmaEnv(root), { cwd: root, homeDirectory: root, launcher: { async launch() {} }, config: { execution: { retry_count: 0, max_provider_calls: 1 } } });
    const started = await app.runtime.search({ action: 'run', query: 'async GMA brief', lane: 'gma.research', execution: 'async', idempotency_key: 'gma-default' });
    if (started.action !== 'run' || started.execution !== 'async' || started.job === undefined) throw new Error();
    expect((await app.store.readExecutionSnapshot(started.job.job_id)).request.timeout_ms).toBe(600_000);

    const configured = createRuntimeComposition(gmaEnv(root), { cwd: root, homeDirectory: root, launcher: { async launch() {} }, config: { execution: { retry_count: 0, max_provider_calls: 1, search_timeout_ms: 7_000 } } });
    const configuredStart = await configured.runtime.search({ action: 'run', query: 'configured GMA brief', lane: 'gma.research', execution: 'async', idempotency_key: 'gma-configured' });
    if (configuredStart.action !== 'run' || configuredStart.execution !== 'async' || configuredStart.job === undefined) throw new Error();
    expect((await configured.store.readExecutionSnapshot(configuredStart.job.job_id)).request.timeout_ms).toBe(7_000);
  });

  it('tracks numeric timeout sources, including null clearing and source precedence, without counting defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-gma-config-')); roots.push(root);
    const baseline = resolveConfiguration({ env: { NB_SEARCH_HOME: root, NB_SEARCH_LOG_LEVEL: 'info' }, cwd: root, homeDirectory: root });
    expect(baseline.explicit_search_timeout_ms).toBe(false);
    const configured = resolveConfiguration({ env: { NB_SEARCH_HOME: root }, cwd: root, homeDirectory: root, config: { execution: { search_timeout_ms: 12_000 } }, overrides: { execution: { search_timeout_ms: 8_000 } } });
    expect(configured.config.execution.search_timeout_ms).toBe(8_000); expect(configured.explicit_search_timeout_ms).toBe(true);
    const cleared = resolveConfiguration({ env: { NB_SEARCH_HOME: root }, cwd: root, homeDirectory: root, config: { execution: { search_timeout_ms: 12_000 } }, overrides: { execution: { search_timeout_ms: null } } });
    expect(cleared.config.execution.search_timeout_ms).toBe(30_000); expect(cleared.explicit_search_timeout_ms).toBe(false);
  });

  it('runs distinct GMA query-array briefs concurrently and returns typed values in input order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-gma-concurrency-')); roots.push(root);
    let started = 0; let active = 0; let maximumActive = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport: JsonTransport = { async send<T>(request: JsonRequest) {
      const body = request.body as { messages?: Array<{ content?: string }> };
      const content = body.messages?.at(-1)?.content ?? '';
      const query = content.replace(/^<query>/, '').replace(/<\/query>$/, '');
      started += 1; active += 1; maximumActive = Math.max(maximumActive, active); if (started === 2) release(); await gate; active -= 1;
      return { status: 200, headers: {}, body: gmaResponse(query) as T };
    } };
    const app = createRuntimeComposition(gmaEnv(root), { cwd: root, homeDirectory: root, transport, config: { execution: { retry_count: 0, max_provider_calls: 2, max_concurrency: 2 } } });
    const result = await app.runtime.search({ action: 'run', query: ['topic-a', 'topic-b'], lane: 'gma.research' });
    expect(started).toBe(2); expect(maximumActive).toBe(2); expect(result).toMatchObject({ status: 'succeeded', output: { channel: 'typed', lane: 'gma.research' } });
    if (result.action !== 'run' || result.execution !== 'sync' || result.output?.channel !== 'typed' || !Array.isArray(result.output.data)) throw new Error();
    expect(result.output.data.map((item) => (item as { answer?: string }).answer)).toEqual(['topic-a', 'topic-b']);
  });

  it('keeps only successful typed values when one GMA brief fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-gma-partial-')); roots.push(root);
    const transport: JsonTransport = { async send<T>(request: JsonRequest) {
      const body = request.body as { messages?: Array<{ content?: string }> };
      const content = body.messages?.at(-1)?.content ?? '';
      const query = content.replace(/^<query>/, '').replace(/<\/query>$/, '');
      if (query === 'topic-fail') throw new NbSearchError('PROVIDER_UNAVAILABLE', 'fixture failure', false);
      return { status: 200, headers: {}, body: gmaResponse(query) as T };
    } };
    const app = createRuntimeComposition(gmaEnv(root), { cwd: root, homeDirectory: root, transport, config: { execution: { retry_count: 0, max_provider_calls: 2, max_concurrency: 2 } } });
    const result = await app.runtime.search({ action: 'run', query: ['topic-ok', 'topic-fail'], lane: 'gma.research' });
    expect(result).toMatchObject({ status: 'partial', output: { channel: 'typed', lane_outcomes: [{ state: 'failed', result_count: 1, error: { code: 'PROVIDER_UNAVAILABLE' } }] } });
    if (result.action !== 'run' || result.execution !== 'sync' || result.output?.channel !== 'typed' || result.output.data === undefined) throw new Error();
    const values = Array.isArray(result.output.data) ? result.output.data : [result.output.data];
    expect(values.map((item) => (item as { answer?: string }).answer)).toEqual(['topic-ok']);
  });
});
