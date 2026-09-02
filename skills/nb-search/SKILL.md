---
name: nb-search
description: "Deterministic query/fetch lane runtime for AI models. Use when the user needs explicit search lanes, typed synthesis or research output, async query jobs with idempotency, safe single-URL fetch with SSRF protection, or static capability inspection via the nb-search CLI/SDK/MCP."
---

# nb-search

`nb-search` is a deterministic lane runtime with exactly three public capabilities: `search`, `fetch`, `capabilities`.

For `search`, the caller selects lanes explicitly; the runtime never inspects a query to pick an engine, replace an unavailable lane, or run an unselected fallback. For `fetch`, omitting `lane` runs the configured serial chain, while an explicit `lane` bypasses it. Search execution mode changes delivery only, not lane or plan.

## Workflow

1. Determine whether the request is a query (search), a URL read (fetch), or a capability check (capabilities).
2. Choose the lane explicitly, or omit the selector to use the configured default.
3. For async search, supply a stable `idempotency_key` and reuse it for retries.
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

- Pass exactly one `url` and optionally one `lane`. No URL arrays, lane arrays, or presets.
- Without `lane`, lanes run serially in `capabilities.fetch.chain` order; an explicit `lane` invokes only that lane.
- HTTP 403/429/5xx, transport failures, and quality-gate failures may fall through. `FETCH_BLOCKED`, HTTP 404/410, and `FETCH_CONTENT_TYPE_REJECTED` terminate the chain.
- `direct.fetch` provides bounded text extraction and deterministic HTML→text; it is not browser rendering or high-fidelity layout reconstruction.
- Successful content lives in `documents`; attempts and skipped lanes live in `lane_outcomes`, with failures also represented in `hints`. There is no failed-document placeholder.
- The production SDK has no DNS/request replacement or connect-address remap seams. Production fetch connects only to a validated public IP.

## `capabilities`

- Returns a static catalog of query/fetch lanes, output schemas, effective execution modes, availability, presets, and runtime limits.
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
nb-search fetch "https://example.com" --lane direct.fetch
nb-search capabilities
```

CLI output is JSON on stdout. The stdio MCP server exposes exactly three tools: `search`, `fetch`, `capabilities`.
