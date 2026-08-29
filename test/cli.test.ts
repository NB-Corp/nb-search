import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli.ts';
import type { NbSearchRuntime } from '../src/runtime.ts';
import type { SearchEnvelope } from '../src/types.ts';

describe('direct CLI', () => {
  it('runs the one-step query alias directly against NbSearchRuntime', async () => {
    const search = vi.fn(async (): Promise<SearchEnvelope> => envelope());
    const runtime = fakeRuntime({ search });
    const io = captureIo();

    const code = await runCli(['query', '--max-results', '2'], io, () => runtime);

    expect(code).toBe(0);
    expect(search).toHaveBeenCalledWith({ query: 'query', max_results: 2 });
    expect(JSON.parse(io.stdout.value)).toMatchObject({ mode: 'search', state: 'succeeded' });
    expect(io.stderr.value).toBe('');
  });

  it('routes every research management command through the runtime without an MCP client', async () => {
    const runtime = fakeRuntime();
    const jobId = crypto.randomUUID();
    const commands = [
      ['research', 'status', jobId],
      ['research', 'read', jobId, '--artifact', 'summary'],
      ['research', 'list', '--states', 'queued,running', '--limit', '2'],
      ['research', 'cancel', jobId],
      ['capabilities'],
    ] as const;
    for (const argv of commands) expect(await runCli(argv, captureIo(), () => runtime)).toBe(0);
    expect(runtime.researchStatus).toHaveBeenCalledWith({ job_id: jobId });
    expect(runtime.researchRead).toHaveBeenCalledWith({ job_id: jobId, artifact: 'summary' });
    expect(runtime.researchList).toHaveBeenCalledWith({ states: ['queued', 'running'], limit: 2 });
    expect(runtime.researchCancel).toHaveBeenCalledWith({ job_id: jobId });
    expect(runtime.capabilities).toHaveBeenCalledWith();
  });

  it('returns typed invalid-input diagnostics and does not construct a runtime for help', async () => {
    const helpIo = captureIo();
    const factory = vi.fn(() => fakeRuntime());
    expect(await runCli(['--help'], helpIo, factory)).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(helpIo.stdout.value).toContain('nb-search research start');

    const badIo = captureIo();
    expect(await runCli(['search', 'q', '--unknown', 'x'], badIo, factory)).toBe(2);
    expect(JSON.parse(badIo.stderr.value)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });
});

function fakeRuntime(overrides: Partial<NbSearchRuntime> = {}): NbSearchRuntime & Record<string, ReturnType<typeof vi.fn>> {
  return {
    search: vi.fn(async () => envelope()),
    researchStart: vi.fn(async () => ({
      schema_version: '1.0', request_id: 'r', mode: 'research_start', reused: false,
      job: { job_id: crypto.randomUUID(), state: 'queued', created_at: '2026-01-01T00:00:00.000Z' }, poll_after_ms: 1000,
    })),
    researchStatus: vi.fn(async (input) => ({
      schema_version: '1.0', request_id: 'r', mode: 'research_status', job_id: input.job_id,
      state: 'queued', phase: 'queued', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      progress: { completed_units: 0 }, artifacts: { summary: 'unavailable', report: 'unavailable', sources: 'unavailable' }, poll_after_ms: 1000,
    })),
    researchRead: vi.fn(async (input) => ({
      schema_version: '1.0', request_id: 'r', mode: 'research_read', job_id: input.job_id,
      job_state: 'queued', artifact: input.artifact ?? 'report', artifact_state: 'unavailable', items: [],
    })),
    researchList: vi.fn(async () => ({ schema_version: '1.0', request_id: 'r', mode: 'research_list', items: [] })),
    researchCancel: vi.fn(async (input) => ({
      schema_version: '1.0', request_id: 'r', mode: 'research_cancel', job_id: input.job_id,
      state: 'cancelled', accepted: true,
    })),
    capabilities: vi.fn(async () => ({
      schema_version: '1.0', request_id: 'r', mode: 'capabilities', version: '0.1.0',
      search: { max_results: 20, max_timeout_ms: 45_000 },
      research: { max_sources: 100, max_duration_ms: 3_600_000, detached_worker: true, guaranteed_process_survival: false },
      providers: { exa: { configured: false }, tavily: { configured: false } },
      persistence: { durable_jobs: true, cancellation_markers: true, retention_hours: 72, stale_after_ms: 30_000 },
      transport: { mcp: 'stdio', cli_direct_service: true }, diagnostics: { network_probe_performed: false },
    })),
    ...overrides,
  } as NbSearchRuntime & Record<string, ReturnType<typeof vi.fn>>;
}

function envelope(): SearchEnvelope {
  return {
    schema_version: '1.0', request_id: 'r', mode: 'search', state: 'succeeded', query: 'query',
    results: [], attempts: [], warnings: [],
    timing: { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:00.001Z', duration_ms: 1, budget_ms: 20_000 },
    compaction: { applied: false, snippets_shortened: 0, results_omitted: 0, max_bytes: 32 * 1024 },
  };
}

function captureIo() {
  const stdout = { value: '', write(value: string) { this.value += value; } };
  const stderr = { value: '', write(value: string) { this.value += value; } };
  return { stdout, stderr };
}
