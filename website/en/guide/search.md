# Search Capabilities (Search)

The `nb-search` search interface supports general web-link discovery, structured knowledge-base queries, and specialized LLM-based synthesis and analysis.

## Architectural distinction: Envelope and Output Schema

When a search runs, the outermost response envelope uses one common specification version:

- Global envelope version: `schema_version: "3.0"`
- Core payload field: `output` (or `error` on failure)

Depending on the operation, `output` uses one of two channels:

1. **Results channel** (`channel: "results"`):
   - The payload follows `schema_id: "nb-search.results@1"`.
   - It contains a standardized `results` array with titles, canonical URLs, summaries, evidence groups (`evidence_groups`), and provenance (`provenance`).
   - It supports a single-Lane query, multi-Lane aggregation, or a preset that contains only Results operations.
   - Example sources: `tavily.search`, `brave.search`, `exa.search`, `github.repositories`.

2. **Typed channel** (`channel: "typed"`):
   - The payload follows the declared Typed Schema, such as `nb-search.docs-context@1`, `nb-search.synthesis@1`, or `nb-search.multi-agent-research@1`.
   - It is intended for structured research reports or knowledge-document context.
   - **Constraint**: Typed operations can target **only one Lane** at a time. They do not support multi-Lane aggregation and cannot be configured in a multi-source Results Preset.
   - Example sources: `context7.docs`, `exa.synthesis`, `grok.synthesis`, `gma.research`, `oac.synthesis`.

## Single-source queries and multi-source aggregation

### Single-source query

For a single-query × single-results-Lane query, the system preserves the relative order of the source's entries after canonicalization and deduplication (for a single source, `rrf_score` is not emitted and the original upstream floating-point score is not retained):

```bash
node scripts/nb-search.mjs search "fastify vs express" --lane brave.search
```

If one request sends multiple queries to the same Lane (for example, a query array sent through stdin), the system creates a separate candidate list for each query and merges them.

### Multi-source aggregation and deduplication (RRF)

In the CLI, specify a multi-source query with comma-separated `--lanes` or by passing `--lane` repeatedly. Both forms are mutually exclusive with `--preset`:

::: code-group

```bash [CLI comma-separated]
node scripts/nb-search.mjs search "postgresql replication" --lanes brave.search,tavily.search
```

```bash [CLI repeated flag]
node scripts/nb-search.mjs search "postgresql replication" --lane brave.search --lane tavily.search
```

```json [Standard input JSON]
{
  "action": "run",
  "query": "postgresql replication",
  "lanes": ["brave.search", "tavily.search"],
  "execution": "sync"
}
```

:::

During multi-source execution, the system merges results deterministically:

1. **URL canonicalization and deduplication**: Remove equivalent tracking parameters and suffixes.
2. **Reciprocal Rank Fusion (RRF)**: Calculate a global combined score from each source's relative rank.
3. **Evidence-group clustering**: Preserve independent evidence fragments captured by different sources.
4. **Deterministic arbitration**: Apply a deterministic fallback ordering for tied scores so identical inputs produce stable output.

## Synchronous and asynchronous execution

- **Synchronous execution (`execution: "sync"`)**: Waits for the search to finish and returns data in the response. If the payload exceeds `execution.max_inline_bytes` (16 MiB by default), the system returns `OUTPUT_TOO_LARGE`; it never truncates implicitly or silently switches to asynchronous execution.
- **Asynchronous execution (`execution: "async"`)**: Returns a job receipt immediately. Asynchronous calls must provide an `idempotency_key` for idempotency. See the [Async Jobs Guide](/en/guide/jobs) for job polling and reconstruction of complete artifacts.
