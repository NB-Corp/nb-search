import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeComposition } from '../src/app.ts';
import { compileSearchPlan } from '../src/planner.ts';
import { builtInProviderRegistrations, ProviderRegistry } from '../src/provider-registry.ts';
import { resolveConfiguration } from '../src/config-sources.ts';
import { ResearchRunner, ResearchService } from '../src/research.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/transport.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))); });

describe('L4 answer and research-light capabilities', () => {
  it('declares advanced ports without creating provider or credential identities and gates relay paths', () => {
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    expect(registry.requireDescriptor('exa')).toMatchObject({ adapter_version: 'l4', capabilities: ['retrieval', 'research-light'], capability_versions: { retrieval: 'l2', 'research-light': 'l4' } });
    expect(registry.requireDescriptor('tavily')).toMatchObject({ adapter_version: 'l4', capabilities: ['retrieval', 'answer'], capability_versions: { retrieval: 'l2', answer: 'l4' } });
    const direct = composition(new RoutingTransport()).config;
    expect([...direct.ports_by_instance.keys()]).toContain('exa.default');
    expect(direct.ports_by_instance.get('exa.default')).toHaveProperty('research_light');
    expect(direct.ports_by_instance.get('tavily.default')).toHaveProperty('answer');

    const relay = composition(new RoutingTransport(), {
      provider_instances: {
        'exa.default': { base_url: 'https://relay.test', options: { search_path: '/exa/search' } },
        'tavily.default': { base_url: 'https://relay.test', options: { search_path: '/tavily/search' } },
      },
    }).config;
    expect(relay.ports_by_instance.get('exa.default')?.research_light).toBeUndefined();
    expect(relay.ports_by_instance.get('tavily.default')?.answer).toBeUndefined();
  });

  it('specializes the complete public profile and intent routing matrix before execution', () => {
    const resolved = resolveConfiguration({ env: { NB_SEARCH_EXA_API_KEY: 'exa', NB_SEARCH_TAVILY_API_KEY: 'tavily' }, config: { provider_instances: { 'grok.default': { enabled: false } } } });
    const registry = new ProviderRegistry(builtInProviderRegistrations());
    const readiness = { 'exa.default': true, 'tavily.default': true, 'grok.default': false, 'search-gateway.aggregate': false };
    const caps = { 'exa.default': { retrieval: true, 'research-light': true }, 'tavily.default': { retrieval: true, answer: true } } as const;
    const selected = (profile: 'default' | 'fast' | 'deep', intent?: import('../src/types.ts').SearchIntent) => compileSearchPlan({ config: resolved.config, registry, readiness, capability_readiness: caps, routing: { profile, ...(intent === undefined ? {} : { intent }) } });
    expect(selected('default', 'factual').stages[0]?.invocations.map((item) => `${item.provider_instance_id}:${item.capability}`)).toEqual(['exa.default:retrieval', 'tavily.default:answer']);
    expect(selected('deep', 'status').stages.map((stage) => stage.invocations.map((item) => item.capability))).toEqual([['retrieval', 'retrieval'], ['research-light']]);
    expect(selected('fast', 'factual').stages.flatMap((stage) => stage.invocations).every((item) => item.capability === 'retrieval')).toBe(true);
    expect(selected('default').stages.flatMap((stage) => stage.invocations).every((item) => item.capability === 'retrieval')).toBe(true);
  });

  it('resolves research-light timeout precedence and diagnoses only optional legacy aliases', () => {
    const alias = resolveConfiguration({ env: { SEARCH_LAYER_EXA_RESEARCH_LIGHT_TIMEOUT_SECONDS: '12' } });
    expect(alias.config.provider_instances['exa.default']?.capability_policies?.['research-light']?.timeout_ms).toBe(12_000);
    const primary = resolveConfiguration({ env: { SEARCH_LAYER_EXA_RESEARCH_LIGHT_TIMEOUT_SECONDS: '12', NB_SEARCH_EXA_RESEARCH_LIGHT_TIMEOUT_MS: '13000' } });
    expect(primary.config.provider_instances['exa.default']?.capability_policies?.['research-light']?.timeout_ms).toBe(13_000);
    const malformed = resolveConfiguration({ env: { SEARCH_LAYER_EXA_RESEARCH_LIGHT_TIMEOUT_SECONDS: 'invalid' } });
    expect(malformed.config.provider_instances['exa.default']?.capability_policies?.['research-light']?.timeout_ms).toBe(60_000);
    expect(malformed.diagnostics).toContainEqual(expect.objectContaining({ code: 'LEGACY_INVALID' }));
    expect(() => resolveConfiguration({ env: { NB_SEARCH_EXA_RESEARCH_LIGHT_TIMEOUT_MS: 'invalid' } })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });

  it('runs one Tavily advanced answer request, merges only genuine rows, and reports citation limits', async () => {
    const transport = new RoutingTransport();
    const runtime = composition(transport).runtime;
    const result = await runtime.search({ query: 'what is q', profile: 'default', intent: 'factual', freshness: 'pm', max_results: 8 });
    expect(transport.requests).toHaveLength(2);
    const tavily = transport.requests.find((request) => isRecord(request.body) && request.body['include_answer'] === 'advanced');
    expect(tavily).toMatchObject({ method: 'POST', url: 'https://api.tavily.com/search', headers: { 'Content-Type': 'application/json' }, body: { api_key: 'tavily-secret', query: 'what is q', max_results: 8, include_answer: 'advanced', days: 30 } });
    expect(transport.requests.some((request) => isRecord(request.body) && request.body['include_answer'] === false)).toBe(false);
    expect(result.results.map((item) => item.url)).toEqual(['https://exa.test/', 'https://answer-source.test/']);
    expect(result.augmentations).toEqual([expect.objectContaining({ capability: 'answer', state: 'succeeded', result: { delivery: 'inline', value: expect.objectContaining({ text: 'bounded answer', citation_status: { claim_linked_citations: false, evidence_map_available: false, semantic_verification: false } }) } })]);
    expect(result.attempts.find((attempt) => attempt.capability === 'answer')).toMatchObject({ state: 'succeeded', result_count: 1 });
    expect(JSON.stringify(result.results)).not.toContain('bounded answer');
    const failedAnswer = await composition(new RoutingTransport(false, true)).runtime.search({ query: 'what is q', profile: 'default', intent: 'factual' });
    expect(failedAnswer.state).toBe('partial');
    expect(failedAnswer.augmentations?.[0]).toMatchObject({ capability: 'answer', state: 'failed' });
  });

  it('starts research-light after retrieval and keeps its failure report-only', async () => {
    const transport = new RoutingTransport();
    const result = await composition(transport).runtime.search({ query: 'compare q', profile: 'deep', intent: 'comparison' });
    expect(transport.kinds).toEqual(expect.arrayContaining(['exa-retrieval', 'tavily-retrieval', 'research-light']));
    expect(transport.kinds.at(-1)).toBe('research-light');
    expect(result.state).toBe('succeeded');
    expect(result.augmentations?.[0]).toMatchObject({ capability: 'research-light', state: 'succeeded', failure_policy: 'report-only', result: { delivery: 'inline', value: { synthesis: 'research synthesis', resolved_type: 'deep', citation_status: { semantic_verification: false } } } });
    expect(result.attempts.find((attempt) => attempt.capability === 'research-light')).toMatchObject({ state: 'succeeded', result_count: 1 });

    const failed = new RoutingTransport(true);
    const degraded = await composition(failed).runtime.search({ query: 'compare q', profile: 'deep', intent: 'comparison' });
    expect(degraded.state).toBe('succeeded');
    expect(degraded.augmentations?.[0]).toMatchObject({ capability: 'research-light', state: 'failed' });
  });

  it('keeps aggregate retrieval separate from the sole Tavily answer lane', async () => {
    const home = join(tmpdir(), `nb-search-l4-gateway-${String(Math.random()).slice(2)}`); roots.push(home);
    const transport = new RoutingTransport();
    const composed = createRuntimeComposition({
      NB_SEARCH_HOME: home, NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret',
      NB_SEARCH_GATEWAY_BASE_URL: 'https://gateway.test', NB_SEARCH_GATEWAY_TOKEN: 'gateway-secret', NB_SEARCH_GATEWAY_AGGREGATE: 'true',
    }, { transport, launcher: { async launch() {} }, config: { provider_instances: { 'grok.default': { enabled: false } } } });
    const result = await composed.runtime.search({ query: 'gateway answer', profile: 'default', intent: 'factual' });
    expect(transport.kinds).toEqual(['gateway-retrieval', 'answer']);
    const gateway = transport.requests.find((request) => request.url.includes('/v1/aggregate/search'));
    expect(gateway?.body).toMatchObject({ profile: 'deep', intent: 'factual' });
    expect(result.results.some((item) => item.url === 'https://gateway.test/source')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('gateway answer must be ignored');
  });

  it('exposes four revision-bound artifacts and safe capability readiness without a network probe', async () => {
    const transport = new RoutingTransport();
    const compositionValue = composition(transport);
    const capabilities = await compositionValue.runtime.capabilities();
    expect(transport.requests).toHaveLength(0);
    expect(capabilities.search).toEqual({ max_results: 20, default_timeout_ms: 20_000, max_timeout_ms: 120_000 });
    expect(capabilities.research.artifacts).toEqual(['summary', 'report', 'sources', 'capabilities']);
    expect(capabilities.capability_routes).toHaveLength(2);
    expect(JSON.stringify(capabilities)).not.toMatch(/tavily-secret|exa-secret|api\.tavily\.com|api\.exa\.ai/);
  });

  it('executes selected capability once per claimed research job and persists a revision-bound artifact', async () => {
    const transport = new RoutingTransport();
    const composed = composition(transport);
    const { job } = await composed.store.createOrReuse({ query: 'compare evidence', max_sources: 25, max_duration_ms: 120_000, profile: 'deep', intent: 'comparison' });
    const finished = await new ResearchRunner(composed.store, composed.search, undefined, monotonicClock()).run(job.job_id);
    expect(finished.state).toBe('succeeded');
    expect(transport.kinds.filter((kind) => kind === 'research-light')).toHaveLength(1);
    expect(finished.artifact_revision).toBeGreaterThan(0);
    const artifact = await composed.store.readArtifact(job.job_id, 'capabilities');
    expect(artifact).toMatchObject({ state: 'final', revision: finished.artifact_revision, items: [expect.objectContaining({ capability: 'research-light', state: 'succeeded' })] });
  });

  it('binds research-read cursors to the published artifact revision', async () => {
    const composed = composition(new RoutingTransport());
    const { job } = await composed.store.createOrReuse({ query: 'q', max_sources: 5, max_duration_ms: 60_000 });
    await composed.store.writeArtifacts(job.job_id, 'checkpoint', { summary: {}, report: '', sources: [{ url: 'https://one.test' }, { url: 'https://two.test' }], capabilities: [] });
    const service = new ResearchService(composed.store, { async launch() {} }, () => 'request-id');
    const page = await service.read({ job_id: job.job_id, artifact: 'sources', page_size: 1 });
    expect(page).toMatchObject({ artifact_revision: 1, next_cursor: expect.any(String) });
    await composed.store.writeArtifacts(job.job_id, 'final', { summary: {}, report: '', sources: [{ url: 'https://one.test' }, { url: 'https://two.test' }], capabilities: [] });
    await expect(service.read({ job_id: job.job_id, artifact: 'sources', cursor: page.next_cursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('normalizes old flat artifact metadata in memory without rewriting it', async () => {
    const composed = composition(new RoutingTransport());
    const { job } = await composed.store.createOrReuse({ query: 'old', max_sources: 5, max_duration_ms: 60_000 });
    const jobPath = join(composed.store.root, job.job_id, 'job.json');
    const metadata = JSON.parse(await readFile(jobPath, 'utf8')) as Record<string, unknown>;
    delete metadata['artifact_revision'];
    const artifacts = metadata['artifacts'] as Record<string, unknown>; delete artifacts['capabilities']; artifacts['summary'] = 'final';
    await writeFile(jobPath, JSON.stringify(metadata, null, 2));
    await writeFile(join(composed.store.root, job.job_id, 'artifacts', 'summary.json'), JSON.stringify({ old: true }));
    const before = await readFile(jobPath, 'utf8');
    expect(await composed.store.read(job.job_id)).toMatchObject({ artifact_revision: 0, artifacts: { capabilities: 'unavailable' } });
    expect(await composed.store.readArtifact(job.job_id, 'capabilities')).toEqual({ state: 'unavailable', revision: 0, items: [] });
    expect(await readFile(jobPath, 'utf8')).toBe(before);
  });
});

class RoutingTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly kinds: string[] = [];
  constructor(private readonly failResearch = false, private readonly failAnswer = false) {}
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const body = isRecord(request.body) ? request.body : {};
    if (request.url.includes('/v1/aggregate/search')) {
      this.kinds.push('gateway-retrieval');
      return { status: 200, body: { answer: 'gateway answer must be ignored', results: [{ title: 'Gateway', url: 'https://gateway.test/source', snippet: 'evidence' }] } as T };
    }
    if (body['include_answer'] === 'advanced') {
      this.kinds.push('answer');
      if (this.failAnswer) return { status: 500, body: {} as T };
      return { status: 200, body: { answer: 'bounded answer', results: [{ title: 'Answer source', url: 'https://answer-source.test', content: 'support' }] } as T };
    }
    if (body['type'] === 'deep' && isRecord(body['contents']) && isRecord(body['contents']['highlights']) && body['contents']['highlights']['maxCharacters'] === 800) {
      this.kinds.push('research-light');
      if (this.failResearch) return { status: 500, body: {} as T };
      return { status: 200, body: { resolvedSearchType: 'deep', output: { content: 'research synthesis', grounding: [{ citations: [{ url: 'https://ground.test', title: 'Ground' }] }] } } as T };
    }
    if (request.headers?.['x-api-key'] !== undefined) {
      this.kinds.push('exa-retrieval');
      return { status: 200, body: { results: [{ title: 'Exa', url: 'https://exa.test', highlights: ['evidence'] }] } as T };
    }
    this.kinds.push('tavily-retrieval');
    return { status: 200, body: { results: [{ title: 'Tavily', url: 'https://tavily.test', content: 'evidence' }] } as T };
  }
}

function composition(transport: HttpTransport, config: import('../src/config-schema.ts').CanonicalConfigPatch = {}) {
  const home = join(tmpdir(), `nb-search-l4-${String(Math.random()).slice(2)}`); roots.push(home);
  return createRuntimeComposition({ NB_SEARCH_HOME: home, NB_SEARCH_EXA_API_KEY: 'exa-secret', NB_SEARCH_TAVILY_API_KEY: 'tavily-secret' }, {
    transport, launcher: { async launch() {} }, now: () => new Date('2026-08-30T00:00:00.000Z'),
    config: { ...config, provider_instances: { 'grok.default': { enabled: false }, ...config.provider_instances } },
  });
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function monotonicClock(): () => number { let value = 0; return () => { value += 10; return value; }; }
