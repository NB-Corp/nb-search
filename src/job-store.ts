import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { NbSearchError, invalidInput } from './errors.ts';
import type {
  ArtifactState, JobRecord, JobState, ResearchArtifact, ResearchRequest, TerminalJobState,
} from './types.ts';
import { SCHEMA_VERSION } from './types.ts';

export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL = new Set<JobState>(['succeeded', 'partial', 'failed', 'timed_out', 'cancelled']);
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'partial', 'failed', 'timed_out', 'cancelling'],
  cancelling: ['cancelled'],
  succeeded: [], partial: [], failed: [], timed_out: [], cancelled: [],
};

export interface CreateJobResult { job: JobRecord; reused: boolean }

export class JobStore {
  constructor(readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const rootStat = await lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw storeError('The jobs root must be a real directory.');
  }

  async createOrReuse(request: ResearchRequest, idempotencyKey?: string): Promise<CreateJobResult> {
    await this.initialize();
    const normalized: ResearchRequest = { ...request, query: request.query.trim() };
    const requestHash = hash(JSON.stringify(normalized));
    const idempotencyHash = idempotencyKey === undefined ? undefined : hash(idempotencyKey);
    return await this.withLock(resolve(this.root, '.idempotency-lock'), async () => {
      if (idempotencyHash !== undefined) {
        for (const job of await this.listRecords()) {
          if (job.idempotency_hash !== idempotencyHash) continue;
          if (job.request_hash !== requestHash) throw new NbSearchError('JOB_CONFLICT', 'The idempotency key is already bound to a different request.');
          return { job, reused: true };
        }
      }
      const jobId = randomUUID();
      const dir = this.jobDir(jobId);
      await mkdir(resolve(dir, 'artifacts'), { recursive: true });
      const now = this.now().toISOString();
      const job: JobRecord = {
        schema_version: SCHEMA_VERSION, job_id: jobId, state: 'queued', phase: 'queued', request: normalized,
        request_hash: requestHash, ...(idempotencyHash === undefined ? {} : { idempotency_hash: idempotencyHash }),
        created_at: now, updated_at: now, progress: { completed_units: 0 },
        artifacts: { summary: 'unavailable', report: 'unavailable', sources: 'unavailable' },
      };
      await this.atomicWrite(resolve(dir, 'job.json'), JSON.stringify(job, null, 2));
      await this.appendEvent(jobId, { type: 'created', state: 'queued', at: now });
      return { job, reused: false };
    });
  }

  async read(jobId: string): Promise<JobRecord> {
    const dir = await this.safeExistingJobDir(jobId);
    let raw: string;
    try { raw = await readFile(resolve(dir, 'job.json'), 'utf8'); }
    catch (error) { throw new NbSearchError('JOB_NOT_FOUND', 'Research job was not found.', false, undefined, { cause: error }); }
    let job: JobRecord;
    try { job = JSON.parse(raw) as JobRecord; } catch (error) { throw storeError('Research job metadata is invalid.', error); }
    if (job.job_id !== jobId || !UUID_V4_PATTERN.test(job.job_id)) throw storeError('Research job identity does not match its directory.');
    return job;
  }

  async transition(jobId: string, next: JobState, patch: Partial<JobRecord> = {}): Promise<JobRecord> {
    return await this.mutate(jobId, (job) => {
      if (!TRANSITIONS[job.state].includes(next)) {
        if (job.state === next) return job;
        throw new NbSearchError('JOB_STORE_ERROR', `Invalid job transition: ${job.state} -> ${next}.`);
      }
      const at = this.now().toISOString();
      const terminal = TERMINAL.has(next);
      return { ...job, ...patch, state: next, updated_at: at, ...(terminal ? { completed_at: at } : {}) };
    });
  }

  async mutate(jobId: string, update: (job: JobRecord) => JobRecord): Promise<JobRecord> {
    const dir = await this.safeExistingJobDir(jobId);
    return await this.withLock(resolve(dir, '.lock'), async () => {
      const current = await this.read(jobId);
      const next = update(structuredClone(current));
      if (next.job_id !== jobId) throw storeError('Job identity is immutable.');
      await this.atomicWrite(resolve(dir, 'job.json'), JSON.stringify(next, null, 2));
      if (current.state !== next.state) await this.appendEvent(jobId, { type: 'state', from: current.state, state: next.state, at: next.updated_at });
      return next;
    });
  }

  async claim(jobId: string, ownerToken: string): Promise<JobRecord> {
    const at = this.now().toISOString();
    return await this.transition(jobId, 'running', { phase: 'collecting', started_at: at, lease: { owner_token: ownerToken, heartbeat_at: at } });
  }

  async heartbeat(jobId: string, ownerToken: string): Promise<JobRecord> {
    return await this.mutate(jobId, (job) => {
      if (job.state !== 'running' && job.state !== 'cancelling') throw storeError('Only active jobs may heartbeat.');
      if (job.lease?.owner_token !== ownerToken) throw storeError('Worker lease ownership does not match.');
      const at = this.now().toISOString();
      return { ...job, updated_at: at, lease: { owner_token: ownerToken, heartbeat_at: at } };
    });
  }

  async requestCancel(jobId: string): Promise<{ job: JobRecord; accepted: boolean }> {
    const dir = await this.safeExistingJobDir(jobId);
    return await this.withLock(resolve(dir, '.lock'), async () => {
      const current = await this.read(jobId);
      if (TERMINAL.has(current.state)) return { job: current, accepted: false };
      if (current.state === 'cancelling') return { job: current, accepted: true };

      const at = this.now().toISOString();
      const nextState: JobState = current.state === 'queued' ? 'cancelled' : 'cancelling';
      const next: JobRecord = {
        ...current,
        state: nextState,
        phase: nextState,
        updated_at: at,
        cancel_requested_at: at,
        ...(TERMINAL.has(nextState) ? { completed_at: at } : {}),
      };
      await this.atomicWrite(resolve(dir, 'cancel.json'), JSON.stringify({ requested_at: at }));
      await this.atomicWrite(resolve(dir, 'job.json'), JSON.stringify(next, null, 2));
      await this.appendEvent(jobId, { type: 'state', from: current.state, state: nextState, at });
      return { job: next, accepted: true };
    });
  }

  async cancelRequested(jobId: string): Promise<boolean> {
    await this.safeExistingJobDir(jobId);
    try { await access(resolve(this.jobDir(jobId), 'cancel.json'), constants.F_OK); return true; } catch { return false; }
  }

  async writeArtifacts(
    jobId: string,
    state: Exclude<ArtifactState, 'unavailable'>,
    artifacts: { summary: unknown; report: string; sources: readonly unknown[] },
    checkpoint?: { phase: string; progress: JobRecord['progress'] },
  ): Promise<JobRecord> {
    const dir = await this.safeArtifactDir(jobId);
    await this.atomicWrite(resolve(dir, 'summary.json'), JSON.stringify(artifacts.summary, null, 2));
    await this.atomicWrite(resolve(dir, 'report.md'), artifacts.report);
    await this.atomicWrite(resolve(dir, 'sources.jsonl'), artifacts.sources.map((item) => JSON.stringify(item)).join('\n') + (artifacts.sources.length > 0 ? '\n' : ''));
    return await this.mutate(jobId, (job) => ({
      ...job,
      ...(checkpoint === undefined ? {} : checkpoint),
      updated_at: this.now().toISOString(),
      artifacts: { summary: state, report: state, sources: state },
    }));
  }

  async readArtifact(jobId: string, artifact: ResearchArtifact): Promise<{ state: ArtifactState; items: unknown[] }> {
    const job = await this.read(jobId);
    const state = job.artifacts[artifact];
    if (state === 'unavailable') return { state, items: [] };
    const artifactDir = await this.safeArtifactDir(jobId);
    const path = resolve(artifactDir, artifact === 'summary' ? 'summary.json' : artifact === 'report' ? 'report.md' : 'sources.jsonl');
    const raw = await readFile(path, 'utf8');
    if (artifact === 'summary') return { state, items: [JSON.parse(raw) as unknown] };
    if (artifact === 'report') return { state, items: chunkText(raw, 4000) };
    return { state, items: raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown) };
  }

  async reconcileStale(jobId: string, staleAfterMs = 30_000): Promise<JobRecord> {
    const job = await this.read(jobId);
    if (job.state !== 'running' && job.state !== 'cancelling') return job;
    const heartbeat = Date.parse(job.lease?.heartbeat_at ?? job.updated_at);
    if (this.now().getTime() - heartbeat <= staleAfterMs) return job;
    if (await this.cancelRequested(jobId)) {
      if (job.state === 'running') await this.transition(jobId, 'cancelling', { phase: 'cancelling' });
      return await this.transition(jobId, 'cancelled', { phase: 'cancelled', error: undefined });
    }
    return await this.transition(jobId, 'failed', {
      phase: 'failed', error: new NbSearchError('WORKER_LOST', 'The research worker lease expired.', true).toPublic(), lease: undefined,
    });
  }

  async listRecords(states?: readonly JobState[]): Promise<JobRecord[]> {
    await this.initialize();
    const wanted = states === undefined ? undefined : new Set(states);
    const records: JobRecord[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_V4_PATTERN.test(entry.name)) continue;
      try {
        const dirStat = await lstat(resolve(this.root, entry.name));
        if (dirStat.isSymbolicLink()) continue;
        const job = await this.read(entry.name);
        if (wanted === undefined || wanted.has(job.state)) records.push(job);
      } catch { /* Retain but do not expose malformed or foreign directories. */ }
    }
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.job_id.localeCompare(b.job_id));
  }

  async prune(retentionMs: number): Promise<number> {
    let removed = 0;
    for (const job of await this.listRecords()) {
      if (!TERMINAL.has(job.state)) continue;
      const completed = Date.parse(job.completed_at ?? job.updated_at);
      if (this.now().getTime() - completed < retentionMs) continue;
      const dir = await this.safeExistingJobDir(job.job_id);
      const metadata = await this.read(job.job_id);
      if (metadata.job_id !== basename(dir) || !TERMINAL.has(metadata.state)) continue;
      const dirStat = await lstat(dir);
      if (dirStat.isSymbolicLink()) continue;
      await rm(dir, { recursive: true, force: false });
      removed += 1;
    }
    return removed;
  }

  private jobDir(jobId: string): string {
    if (!UUID_V4_PATTERN.test(jobId)) throw invalidInput('job_id must be a lowercase UUID v4.');
    const candidate = resolve(this.root, jobId);
    const rel = relative(resolve(this.root), candidate);
    if (rel.startsWith(`..${sep}`) || rel === '..' || rel === '' || rel.includes(sep)) throw invalidInput('job_id resolves outside the jobs root.');
    return candidate;
  }

  private async safeExistingJobDir(jobId: string): Promise<string> {
    await this.initialize();
    const dir = this.jobDir(jobId);
    let info;
    try { info = await lstat(dir); } catch (error) { throw new NbSearchError('JOB_NOT_FOUND', 'Research job was not found.', false, undefined, { cause: error }); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new NbSearchError('JOB_NOT_FOUND', 'Research job was not found.');
    return dir;
  }

  private async safeArtifactDir(jobId: string): Promise<string> {
    const jobDir = await this.safeExistingJobDir(jobId);
    const artifactDir = resolve(jobDir, 'artifacts');
    let info;
    try { info = await lstat(artifactDir); }
    catch (error) { throw storeError('Research artifact directory is missing.', error); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw storeError('Research artifact directory must be a real directory.');
    const rel = relative(jobDir, artifactDir);
    if (rel !== 'artifacts') throw storeError('Research artifact path resolves outside the job directory.');
    return artifactDir;
  }

  private async atomicWrite(path: string, value: string): Promise<void> {
    const token = randomBytes(8).toString('hex');
    const temporary = resolve(dirname(path), `.${basename(path)}.${token}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    let renamed = false;
    let renameError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rename(temporary, path); renamed = true; break; }
      catch (error) {
        renameError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) break;
        await delay(10 * (attempt + 1));
      }
    }
    if (!renamed) { await rm(temporary, { force: true }); throw storeError('Atomic job-store write failed.', renameError); }
    try { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Directory fsync is not available on every platform. */ }
  }

  private async appendEvent(jobId: string, event: unknown): Promise<void> {
    const path = resolve(this.jobDir(jobId), 'events.ndjson');
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    const handle = await open(path, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  }

  private async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const token = randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await mkdir(path); await this.atomicWrite(resolve(path, 'owner'), token); break; }
      catch (error) {
        if (attempt === 99) throw storeError('Timed out waiting for the job-store lock.', error);
        await delay(10);
      }
    }
    try { return await operation(); }
    finally {
      try { if ((await readFile(resolve(path, 'owner'), 'utf8')) === token) await rm(path, { recursive: true, force: true }); } catch { /* A mismatched lock is left intact. */ }
    }
  }
}

export function isTerminalState(state: JobState): state is TerminalJobState { return TERMINAL.has(state) }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function chunkText(value: string, size: number): string[] { const chunks: string[] = []; for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size)); return chunks }
function storeError(message: string, cause?: unknown): NbSearchError { return new NbSearchError('JOB_STORE_ERROR', message, false, undefined, cause === undefined ? undefined : { cause }) }
