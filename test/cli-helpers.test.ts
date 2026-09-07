import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { readAll, waitForJob, outputExit } from '../src/cli-job-reader.ts';
import type { NbSearchRuntime } from '../src/runtime.ts';
import type { SearchEnvelope, SearchReadEnvelope } from '../src/types.ts';
const output = { channel: 'typed' as const, lane: 'test', schema_id: 'test@1', status: 'succeeded' as const, data: { answer: '证据 🌍 café' }, lane_outcomes: [], hints: [] };
const sync = { schema_version: '3.0' as const, action: 'run' as const, execution: 'sync' as const, status: 'succeeded' as const, output, hints: [] };
function runtime(result: SearchEnvelope = sync): NbSearchRuntime { return { search: vi.fn(async () => result), fetch: vi.fn(), capabilities: vi.fn() }; }
function io(input?: string | Uint8Array) { const stdout = { value: '', write(value: string) { this.value += value; } }; const stderr = { value: '', write(value: string) { this.value += value; } }; return { stdout, stderr, stdin: (async function* () { if (input !== undefined) yield input; })() }; }
function pages(): SearchReadEnvelope[] { const bytes = Buffer.from(JSON.stringify(output)); const artifact = { media_type: 'application/json' as const, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expires_at: new Date(Date.now() + 60000).toISOString() }; const id = randomUUID(); const split = bytes.indexOf(Buffer.from('🌍')) + 1; return [bytes.subarray(0, split), bytes.subarray(split)].map((chunk, index) => ({ schema_version: '3.0', action: 'read', job_id: id, state: 'succeeded', artifact, chunks: [{ index, offset: index ? split : 0, byte_length: chunk.length, data_base64: chunk.toString('base64') }], ...(index ? {} : { next_cursor: 'second' }) })); }

describe('CLI complete JSON and artifact helpers', () => {
  it('preserves Unicode, quotes, option-like queries and literal help data', async () => {
    for (const args of [['search', '--', '--help'], ['search', '--query=--leading-dashes']]) { const rt = runtime(); expect(await runCli(args, io(), () => rt)).toBe(0); expect(rt.search).toHaveBeenCalledWith(expect.objectContaining({ query: args.at(-1) === '--help' ? '--help' : '--leading-dashes' })); }
    const rt = runtime(); const query = '中文 "quoted" 🌍'; expect(await runCli(['search', '--stdin'], io(JSON.stringify({ action: 'run', query })), () => rt)).toBe(0); expect(rt.search).toHaveBeenCalledWith({ action: 'run', query });
  });
  it('rejects mixed stdin/options, malformed UTF8, noninteger values and unknown sensitive arguments before construction', async () => {
    for (const [args, input] of [[['search', '--stdin', '--lane', 'x'], '{}'], [['search', '--stdin'], Buffer.from([0xff])], [['search', 'query', '--max-results', '1e1'], ''], [['search', '--secret=fake-secret'], ''], [['search', '--stdin'], '{}{}']] as const) { const make = vi.fn(() => runtime()); const capture = io(input); expect(await runCli(args, capture, make)).toBe(2); expect(make).not.toHaveBeenCalled(); expect(capture.stderr.value).not.toContain('fake-secret'); }
  });
  it('defaults omitted follow-up profiles to the local runtime', async () => {
    const id = randomUUID(); const pending = { schema_version: '3.0' as const, action: 'get' as const, job_id: id, state: 'queued' as const, cancel_requested: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as SearchEnvelope;
    const rt = runtime(pending); const make = vi.fn(() => rt); expect(await runCli(['search', '--stdin'], io(JSON.stringify({ action: 'get', job_id: id })), make)).toBe(7); expect(make).toHaveBeenCalledTimes(1); expect(rt.search).toHaveBeenCalledWith({ action: 'get', job_id: id });
    expect(await runCli(['search', 'get', id], io(), () => rt)).toBe(7); expect(rt.search).toHaveBeenCalledTimes(2);
  });
  it('validates complete pages and reconstructs Unicode even across a codepoint boundary', async () => { const all = pages(); const rt = runtime(); rt.search = vi.fn().mockResolvedValueOnce(all[0]).mockResolvedValueOnce(all[1]); expect(await readAll(rt, 'search', all[0]!.job_id)).toEqual(output); expect(rt.search).toHaveBeenLastCalledWith({ action: 'read', job_id: all[0]!.job_id, cursor: 'second' }, { signal: undefined }); });
  it.each(['hash', 'offset', 'base64', 'length', 'cursor', 'utf8', 'json', 'oversize'])('rejects corrupt complete artifact: %s', async (caseName) => {
    const all = pages(); const first = all[0]!; const second = all[1]!;
    if (caseName === 'hash') { first.artifact!.sha256 = '0'.repeat(64); second.artifact!.sha256 = first.artifact!.sha256; }
    if (caseName === 'offset') second.chunks[0]!.offset++;
    if (caseName === 'base64') first.chunks[0]!.data_base64 = '!!!!';
    if (caseName === 'length') second.artifact!.byte_length++;
    if (caseName === 'cursor') second.next_cursor = 'second';
    if (caseName === 'oversize') first.artifact!.byte_length = 65 * 1024 * 1024;
    if (caseName === 'utf8' || caseName === 'json') { const bytes = caseName === 'utf8' ? Buffer.from([255]) : Buffer.from('not json'); first.artifact = { ...first.artifact!, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; first.chunks = [{ index: 0, offset: 0, byte_length: bytes.length, data_base64: bytes.toString('base64') }]; delete first.next_cursor; }
    const rt = runtime(); rt.search = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second); await expect(readAll(rt, 'search', first.job_id)).rejects.toMatchObject({ code: 'JOB_STORE_ERROR' });
  });
  it('wait budget exhaustion is not cancellation and observes poll hints', async () => { const id = randomUUID(); const initial: SearchEnvelope = { schema_version: '3.0', action: 'run', execution: 'async', status: 'queued', job: { job_id: id, state: 'queued', created_at: new Date().toISOString() }, poll_after_ms: 10000, hints: [] }; const rt = runtime(); const result = await waitForJob(rt, 'search', initial, Date.now() + 10, new AbortController().signal); expect(result).toMatchObject({ cli_schema_version: '1', status: 'timed_out', cancel_requested_by_cli: false }); expect(rt.search).not.toHaveBeenCalled(); expect(outputExit(result)).toBe(5); });
  it('defines distinct logical/pending exits and cancel acknowledgement', () => { for (const [status, exit] of [['succeeded', 0], ['failed', 2], ['partial', 3], ['empty', 4], ['timed_out', 5], ['cancelled', 6], ['queued', 7]] as const) expect(outputExit({ status })).toBe(exit); expect(outputExit({ action: 'cancel', state: 'running', cancel_requested: true })).toBe(0); });
});
