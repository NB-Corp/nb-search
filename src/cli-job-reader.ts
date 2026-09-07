import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { NbSearchRuntime } from './runtime.ts';
import type { ArtifactRef, FetchEnvelope, SearchEnvelope } from './types.ts';
import { fetchEnvelopeSchema, fetchRunSyncEnvelopeSchema, searchEnvelopeSchema, searchLogicalOutputSchema } from './response-schemas.ts';
import { NbSearchError } from './errors.ts';

const integrity = () => new NbSearchError('JOB_STORE_ERROR', 'The complete result failed integrity validation.');
export async function readAll(runtime: NbSearchRuntime, kind: 'search' | 'fetch', jobId: string, signal?: AbortSignal): Promise<unknown> {
  const buffers: Buffer[] = []; const cursors = new Set<string>(); let cursor: string | undefined; let artifact: ArtifactRef | undefined; let offset = 0; let index = 0;
  for (let page = 0; page < 10000; page++) {
    const result = await runtime[kind]({ action: 'read', job_id: jobId, ...(cursor ? { cursor } : {}) }, { signal });
    const parsed = (kind === 'search' ? searchEnvelopeSchema : fetchEnvelopeSchema).safeParse(result);
    if (!parsed.success || parsed.data.action !== 'read' || parsed.data.job_id !== jobId) throw integrity();
    const value = parsed.data;
    if (!value.artifact) { if (page === 0 && value.state !== 'succeeded') return result; throw integrity(); }
    if (value.state !== 'succeeded' || value.artifact.byte_length > 64 * 1024 * 1024 || value.artifact.byte_length < 1 || Date.parse(value.artifact.expires_at) <= Date.now()) throw integrity();
    if (artifact && JSON.stringify(artifact) !== JSON.stringify(value.artifact)) throw integrity(); artifact = value.artifact;
    if (!value.chunks.length) throw integrity();
    for (const chunk of value.chunks) { const bytes = Buffer.from(chunk.data_base64, 'base64'); if (chunk.index !== index++ || chunk.offset !== offset || bytes.length !== chunk.byte_length || bytes.toString('base64') !== chunk.data_base64 || !bytes.length) throw integrity(); offset += bytes.length; if (offset > artifact.byte_length) throw integrity(); buffers.push(bytes); }
    if (!value.next_cursor) {
      if (offset !== artifact.byte_length) throw integrity(); const bytes = Buffer.concat(buffers, offset); if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw integrity();
      try { const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); return (kind === 'search' ? searchLogicalOutputSchema : fetchRunSyncEnvelopeSchema).parse(data); } catch { throw integrity(); }
    }
    if (cursors.has(value.next_cursor)) throw integrity(); cursors.add(value.next_cursor); cursor = value.next_cursor;
  }
  throw integrity();
}
export async function waitForJob(runtime: NbSearchRuntime, kind: 'search' | 'fetch', initial: SearchEnvelope | FetchEnvelope, deadline: number, signal: AbortSignal): Promise<unknown> {
  let last = initial; const id = 'job_id' in initial ? initial.job_id : 'job' in initial ? initial.job?.job_id : undefined;
  if (!id) return initial;
  const timedOut = () => ({ cli_schema_version: '1', status: 'timed_out', job_id: id, last, cancel_requested_by_cli: false });
  try {
    for (;;) {
      if (Date.now() >= deadline || signal.aborted) return timedOut();
      const state = 'state' in last ? last.state : 'job' in last ? last.job?.state : undefined;
      if (state === 'failed' || state === 'cancelled') return last;
      if (state === 'succeeded') return await readAll(runtime, kind, id, signal);
      const pause = Math.max(100, 'poll_after_ms' in last && typeof last.poll_after_ms === 'number' ? last.poll_after_ms : 1000);
      if (Date.now() + pause >= deadline) { await sleep(Math.max(0, deadline - Date.now()), undefined, { signal }).catch(() => {}); return timedOut(); }
      await sleep(pause, undefined, { signal }); last = await runtime[kind]({ action: 'get', job_id: id }, { signal });
    }
  } catch (error) { if (signal.aborted || Date.now() >= deadline) return timedOut(); throw error; }
}
export function outputExit(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const item = value as { action?: string; cancel_requested?: boolean; status?: string; state?: string; job?: { state: string } };
  if (item.action === 'cancel') return 0;
  const state = item.status === 'queued' && item.job ? item.job.state : item.status ?? item.state;
  return ({ partial: 3, empty: 4, failed: 2, timed_out: 5, cancelled: 6, queued: 7, running: 7 } as Record<string, number>)[state ?? ''] ?? 0;
}
