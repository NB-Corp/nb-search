---
name: nb-search
description: "Deterministic search-lane and fetch-pipeline runtime for AI models. Use for explicit search lanes, typed or async jobs, and safe conversion of URLs, inline content, or scoped files into model-readable documents."
---

# nb-search

`nb-search` is a deterministic lane runtime with exactly three public capabilities: `search`, `fetch`, `capabilities`.

For `search`, the caller selects lanes explicitly; the runtime never inspects a query to pick an engine, replace an unavailable lane, or run an unselected fallback. For `fetch`, omitting `pipeline` matches the configured chain by input kind and representation, while an explicit `pipeline` bypasses it. Execution mode changes delivery only, not the selected plan.

## Workflow

1. Determine whether the request is a query (search), a source conversion (fetch), or a capability check (capabilities).
2. Choose the search lane or fetch pipeline explicitly, or omit the selector to use the configured default chain.
3. For async search or fetch, supply a stable `idempotency_key` and reuse it for retries.
4. Validate output shape before reporting: results use ranked `results`, typed uses `schema_id` + `data`, fetch uses `documents`.

## `search`

`search` uses a discriminated action union. SDK/MCP require an explicit `action`; the CLI shorthand normalizes an unqualified query to `run`.

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

- Use the `run | get | read | cancel` action union. `run.source` is `url | inline_text | inline_bytes | file`; `representation` defaults to `markdown`.
- Without `pipeline`, pipelines run serially from the matching `capabilities.fetch.chains` entry; an explicit `pipeline` invokes only that pipeline.
- File and inline sources may enter only `egress: none` pipelines. File paths are relative to a capability-advertised scope id.
- HTTP 403/429/5xx, transport failures, and quality-gate failures may fall through. `FETCH_BLOCKED`, HTTP 404/410, and `FETCH_CONTENT_TYPE_REJECTED` terminate the chain.
- `direct.fetch` provides bounded text extraction and deterministic HTML→text; it is not browser rendering or high-fidelity layout reconstruction.
- Successful documents report `representation` and source `media_type`; attempts and skips remain in `lane_outcomes`.
- Async fetch requires `idempotency_key` and uses fetch `get/read/cancel` for job management.

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
