import { describe, expect, it } from 'vitest';
import {
  capabilityEnvelopeSchema,
  fetchEnvelopeSchema,
  fetchRunSyncEnvelopeSchema,
  searchEnvelopeSchema,
  searchLogicalOutputSchema,
} from '../src/response-schemas.ts';

const jobId = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-01-01T00:00:00.000Z';
const artifact = {
  media_type: 'application/json',
  byte_length: 5,
  sha256: 'a'.repeat(64),
  expires_at: timestamp,
};

const laneOutcome = {
  lane: 'demo.search',
  ok: true,
  state: 'succeeded',
  duration_ms: 3,
  result_count: 1,
  warnings: [],
};

const searchOutput = {
  channel: 'results',
  schema_id: 'nb-search.results@1',
  status: 'succeeded',
  lanes: ['demo.search'],
  results: [{
    title: 'Example',
    url: 'https://example.com/article',
    snippet: 'A useful result.',
    evidence_groups: ['demo'],
    provenance: [{
      lane: 'demo.search',
      provider_instance_id: 'demo.default',
      query_index: 0,
      rank: 0,
      original_url: 'https://example.com/article',
      evidence_groups: ['demo'],
      upstream: [{ provider: 'demo-provider' }],
    }],
  }],
  lane_outcomes: [laneOutcome],
  merge_summary: {
    input_rows: 1,
    canonical_dedup: 0,
    independent_evidence_groups: 1,
    result_count: 1,
  },
  hints: [],
  additive: { retained: true },
};

const capability = {
  schema_version: '3.0',
  revision: 'revision-1',
  providers: {
    descriptors: [{
      provider_id: 'demo-provider',
      adapter_version: '1.0.0',
      query_operations: [{
        operation_id: 'search',
        output: { channel: 'results', schema_id: 'nb-search.results@1' },
        built_in_async: false,
      }],
      fetch_operations: [{
        operation_id: 'fetch',
        schema_id: 'nb-search.fetch@1',
        input_kinds: ['url'],
        media_types: ['text/html'],
        representations: ['markdown'],
        execution_modes: ['sync', 'async'],
        egress: 'url',
        stages: [{ id: 'acquire', role: 'acquire' }],
      }],
      activation: { credential: 'none', endpoint: 'none' },
      option_keys: [],
    }],
    instances: [{
      id: 'demo.default',
      provider_id: 'demo-provider',
      enabled: true,
      availability: 'ready',
      issues: [],
      credential: { requirement: 'none', configured: false },
      endpoint: { requirement: 'none', configured: true },
    }],
  },
  search: {
    default_lane: 'demo.search',
    lanes: [{
      id: 'demo.search',
      output: { channel: 'results', schema_id: 'nb-search.results@1' },
      execution_modes: ['sync'],
      availability: 'ready',
      issues: [],
      latency: 'fast',
      cost: 'free',
    }],
    presets: [{
      name: 'default',
      lanes: ['demo.search'],
      execution_modes: ['sync'],
      availability: 'ready',
      issues: [],
    }],
    limits: { max_queries: 4, max_results: 10, max_timeout_ms: 1000, max_inline_bytes: 1024 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [{ kind: 'url', enabled: true, max_bytes: 1024, media_types: ['text/html'] }],
    chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['demo.fetch'] }],
    pipelines: [{
      id: 'demo.fetch',
      input_kinds: ['url'],
      media_types: ['text/html'],
      representations: ['markdown'],
      execution_modes: ['sync', 'async'],
      egress: 'url',
      stages: [{ id: 'acquire', role: 'acquire' }],
      availability: 'ready',
      issues: [],
      latency: 'medium',
      cost: 'cheap',
    }],
    limits: {
      max_source_bytes: 1024,
      max_response_bytes: 2048,
      max_content_chars: 5000,
      max_redirects: 3,
      max_timeout_ms: 1000,
      max_inline_bytes: 1024,
    },
  },
  jobs: { result_ttl_seconds: 3600, cancel_supported: true },
};

describe('response schemas', () => {
  it('accepts runtime-like search, fetch, and typed outputs while retaining additive fields', () => {
    const search = searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'run',
      execution: 'sync',
      status: 'succeeded',
      output: searchOutput,
      hints: [],
      extra: 'allowed',
    });
    expect(search.success).toBe(true);
    if (search.success) expect(search.data['extra']).toBe('allowed');

    const fetch = fetchRunSyncEnvelopeSchema.safeParse({
      schema_version: '3.0',
      mode: 'fetch',
      action: 'run',
      execution: 'sync',
      selection: { source: 'default' },
      status: 'succeeded',
      lane_outcomes: [{ ...laneOutcome, lane: 'demo.fetch', result_count: 1 }],
      documents: [{
        url: 'https://example.com/article',
        final_url: 'https://example.com/article',
        title: 'Example',
        content: '# Example',
        content_type: 'text/html',
        media_type: 'text/html',
        representation: 'markdown',
        format: 'text',
        byte_length: 9,
        truncated: false,
        warnings: [],
        source_lane: 'demo.fetch',
        extra_document_field: { retained: true },
      }],
      hints: [],
    });
    expect(fetch.success).toBe(true);
    if (fetch.success) expect(fetch.data.documents[0]?.['extra_document_field']).toEqual({ retained: true });

    const typed = searchLogicalOutputSchema.safeParse({
      channel: 'typed',
      lane: 'demo.typed',
      schema_id: 'future.schema@1',
      status: 'partial',
      data: { nested: [{ answer: 42, nullable: null }] },
      lane_outcomes: [{ ...laneOutcome, lane: 'demo.typed', state: 'empty', ok: false, result_count: 0 }],
      hints: [],
    });
    expect(typed.success).toBe(true);
  });

  it('accepts the full capability catalog and rejects malformed nested catalog values', () => {
    expect(capabilityEnvelopeSchema.safeParse(capability).success).toBe(true);

    const malformed = structuredClone(capability) as typeof capability;
    malformed.fetch.pipelines[0]!.stages[0]!.role = 'not-a-stage' as never;
    expect(capabilityEnvelopeSchema.safeParse(malformed).success).toBe(false);
  });

  it('validates artifact metadata, UUID/timestamps, and canonical chunk lengths', () => {
    const get = searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'get',
      job_id: jobId,
      state: 'succeeded',
      cancel_requested: false,
      created_at: timestamp,
      updated_at: timestamp,
      artifact,
    });
    expect(get.success).toBe(true);

    const read = searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'read',
      job_id: jobId,
      state: 'succeeded',
      artifact,
      chunks: [{ index: 0, offset: 0, byte_length: 5, data_base64: 'aGVsbG8=' }],
    });
    expect(read.success).toBe(true);

    const badChunk = {
      schema_version: '3.0',
      action: 'read',
      job_id: 'not-a-uuid',
      state: 'succeeded',
      chunks: [{ index: 0, offset: 0, byte_length: 4, data_base64: 'aGVsbG8=' }],
    };
    expect(searchEnvelopeSchema.safeParse(badChunk).success).toBe(false);

    const badArtifact = {
      schema_version: '3.0',
      action: 'get',
      job_id: jobId,
      state: 'succeeded',
      cancel_requested: false,
      created_at: 'not-a-timestamp',
      updated_at: timestamp,
      artifact: { ...artifact, sha256: 'not-a-sha' },
    };
    expect(searchEnvelopeSchema.safeParse(badArtifact).success).toBe(false);
  });

  it('enforces sync output agreement and async admission requirements', () => {
    expect(searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'run',
      execution: 'sync',
      status: 'succeeded',
      hints: [],
    }).success).toBe(false);

    expect(searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'run',
      execution: 'sync',
      status: 'failed',
      hints: [],
    }).success).toBe(true);

    expect(searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'run',
      execution: 'async',
      status: 'queued',
      hints: [],
    }).success).toBe(false);

    expect(searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'run',
      execution: 'async',
      status: 'failed',
      reused: true,
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'failed', retryable: true },
      hints: [],
    }).success).toBe(false);

    expect(searchEnvelopeSchema.safeParse({
      schema_version: '3.0',
      action: 'run',
      execution: 'async',
      status: 'failed',
      reused: true,
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'failed', retryable: true },
      job: { job_id: jobId, state: 'failed', created_at: timestamp },
      hints: [],
    }).success).toBe(true);
  });

  it('keeps search and fetch discriminators separate', () => {
    const fetchRun = {
      schema_version: '3.0',
      mode: 'fetch',
      action: 'run',
      execution: 'sync',
      selection: { source: 'default' },
      status: 'empty',
      lane_outcomes: [],
      documents: [],
      hints: [],
    };
    expect(fetchEnvelopeSchema.safeParse(fetchRun).success).toBe(true);
    expect(searchEnvelopeSchema.safeParse({ ...fetchRun, mode: 'fetch' }).success).toBe(false);
    expect(searchEnvelopeSchema.safeParse({ ...searchOutput, action: 'run', execution: 'sync', status: 'succeeded', hints: [], mode: 'fetch' }).success).toBe(false);
  });
});
