---
name: nb-search
description: "Deterministic search-lane and fetch-pipeline runtime for AI models. Use for explicit search lanes, typed or async jobs, and safe conversion of URLs, inline content, or scoped files into model-readable documents."
---

# nb-search

`nb-search` is a deterministic lane runtime with exactly three public capabilities: `search`, `fetch`, `capabilities`.

For `search`, the caller selects lanes explicitly; the runtime never inspects a query to pick an engine, replace an unavailable lane, or run an unselected fallback. For `fetch`, omitting `pipeline` matches the configured chain by input kind and representation, while an explicit `pipeline` bypasses it. Execution mode changes delivery only, not the selected plan.

## Workflow

1. Determine whether the request is a query (search), a source conversion (fetch), or a capability check (capabilities).
2. Choose a search lane explicitly or use a host-configured default lane; for fetch, choose a pipeline explicitly or omit it to use the matching configured chain.
3. For a search lane or fetch pipeline that supports async, supply a stable `idempotency_key` and reuse it for retries.
4. Validate output shape before reporting: results use ranked `results`, typed uses `schema_id` + `data`, fetch uses `documents`.

## `search`

`search` uses a discriminated action union. SDK/MCP require an explicit `action`; the CLI shorthand normalizes an unqualified query to `run`. The built-in configuration has no `defaults.search_lane`; omitting `lane`, `lanes`, and `preset` works only when the host configured a default, otherwise it returns `DEFAULT_NOT_CONFIGURED`.

### Built-in lanes

| Lane | Output |
| --- | --- |
| `brave.search` | results |
| `context7.docs` | typed (`nb-search.docs-context@1`) |
| `exa.search` | results |
| `exa.synthesis` | typed (`nb-search.synthesis@1`) |
| `firecrawl.search` | results |
| `github.repositories` | results |
| `gma.research` | typed (`nb-search.multi-agent-research@1`) |
| `grok.synthesis` | typed (`nb-search.synthesis@1`) |
| `grok.x-synthesis` | typed (`nb-search.synthesis@1`) |
| `oac.synthesis` | typed (`nb-search.synthesis@1`) |
| `parallel.search` | results |
| `searxng.search` | results |
| `tavily.search` | results |
| `tavily.synthesis` | typed (`nb-search.synthesis@1`) |
| `zhipu.search` | results |

### `action: "run"`

- `query` is a string or an ordered string array.
- Results operations accept one `lane`, ordered `lanes`, or a results-only `preset`.
- Typed operations accept exactly one `lane`; do not place typed lanes in `lanes` or `preset`.
- `execution` defaults to `sync`. `async` requires `idempotency_key`; `sync` forbids it.
- A reused idempotency key with the same normalized request returns the same job. The same key with a different request conflicts.
- One query × one results lane preserves provider order. Multiple query/lane lists use per-list canonical dedup, RRF, independent evidence groups, and stable tie-breaking.
- Typed output returns `{ channel: "typed", lane, schema_id, data }`. Oversized sync output returns `OUTPUT_TOO_LARGE`; it is not truncated and does not become async.

### `action: "get"`

- Pass `job_id` to read async job state.
- Terminal success returns the one immutable result artifact's metadata (`ArtifactRef`).

### `action: "read"`

- Pass `job_id`, optional `cursor` and `page_size`.
- Continue reading until `next_cursor` is absent; concatenate base64 chunks in order and decode as UTF-8 JSON.
- The cursor is bound to the artifact SHA and byte offset; never reuse across jobs.

### `action: "cancel"`

- Pass `job_id` to record a cancellation request.
- The response means the request was recorded; it does not claim the upstream stopped or avoided billing.

## `fetch`

The built-in pipelines are `direct.fetch`, `direct.local`, `jina.reader`, `exa.contents`, `tavily.extract`, `firecrawl.scrape`, `wayback.fetch`, `browser.render`, and `oac.fetch`. The default URL chain remains `direct.fetch` → `jina.reader`; `inline_text`, `inline_bytes`, and `file` default to `direct.local`; the three new pipelines require explicit selection.

### `action: "run"`

- `source` is `{ kind: "url", url }`, `{ kind: "inline_text", content, media_type, base_url? }`, `{ kind: "inline_bytes", content_base64, media_type, filename? }`, or `{ kind: "file", scope, path }`.
- `representation` is `markdown` (default) or `text`.
- Without `pipeline`, pipelines run serially from the `capabilities.fetch.chains` entry matching input kind and representation. An explicit `pipeline` invokes only that pipeline and must support the source, representation, and execution mode.
- File and inline sources may enter only `egress: none` pipelines. File paths use a capability-advertised scope id and a path relative to that scope; file input is unavailable until a scope is configured.
- Built-in `direct.local` supports sync and async, `browser.render` is async-only, and the other built-in fetch pipelines are sync-only; use `capabilities.fetch.pipelines[].execution_modes` as the authority.
- HTTP failures other than 404/410, provider/auth/rate-limit and transport failures, byte-limit failures, and quality-gate failures may fall through. `FETCH_BLOCKED`, HTTP 404/410, `FETCH_CONTENT_TYPE_REJECTED`, cancellation, deadline, and budget exhaustion terminate the chain.
- `direct.fetch` provides bounded text extraction and deterministic HTML→text; it is not browser rendering or high-fidelity layout reconstruction.
- Successful documents report `representation` and source `media_type`; attempts and skips remain in `lane_outcomes`.
- Async fetch requires a stable `idempotency_key`; sync forbids that field.

### `action: "get" | "read" | "cancel"`

- `get` passes `job_id` to read fetch job state and successful artifact metadata.
- `read` passes `job_id`, optional `cursor` and `page_size`, and follows `next_cursor` to read the complete JSON artifact.
- `cancel` passes `job_id` to record a cancellation request without claiming that the upstream stopped or avoided billing.

## `capabilities`

- Returns a static catalog of query lanes, fetch pipeline descriptors, chains, inputs, execution modes, availability, and runtime limits.
- It performs no network probe. Do not use it to auto-select lanes.

## Forbidden patterns

- Do not read hidden history/session as a mandatory first step.
- Do not expect runtime query expansion, cost/latency/health-based auto-selection, or lane replacement.
- Do not present fetch content as semantically verified citation.
- Do not enumerate jobs, pass artifact selectors, checkpoints, or revisions.
- Do not mix typed lanes with `lanes` or preset.

## CLI quick reference

```sh
nb-search search "query" --lane exa.search
nb-search search run "facet one" --query "facet two" --preset cross-check
nb-search search run "brief" --lane gma.research --execution async --idempotency-key run-1
nb-search search get <job_id>
nb-search search read <job_id> --page-size 8
nb-search search cancel <job_id>
nb-search fetch "https://example.com" --pipeline direct.fetch --representation markdown
nb-search fetch get <job_id>
nb-search fetch read <job_id> --page-size 8
nb-search fetch cancel <job_id>
nb-search capabilities
```

CLI output is JSON on stdout. The stdio MCP server exposes exactly three tools: `search`, `fetch`, `capabilities`.
