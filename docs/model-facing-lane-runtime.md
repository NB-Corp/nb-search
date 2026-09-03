# Model-facing query lane runtime

The package implements configuration schema v4 with three public capabilities: `search`, `fetch`, and `capabilities`. SDK, CLI, and MCP call the same runtime; MCP registers exactly those three tools.

## Query operations

A lane binds one `provider_instance_id` to one `operation_id`. The provider registration is the output-contract source of truth:

- results operations declare `channel: "results"` and `schema_id: "nb-search.results@1"`;
- typed operations declare `channel: "typed"` and their JSON `schema_id`.

Effective execution modes are computed from registration ownership and runtime readiness. Built-in worker-installed query operations may support sync and async. Host registrations are sync-only in this version. Execution never selects another lane.

`search` is a strict `run | get | read | cancel` action union. A run selects one lane, an ordered results-lane list, or a results-only preset. Typed operations require one lane. The built-in configuration has no search default; when a host configures `defaults.search_lane`, that lane applies to both sync and async.

One query and one results lane preserve provider order. Each query×lane list canonical-deduplicates before RRF; multiple lists then use fixed RRF, global canonical deduplication, independent evidence groups, and stable plan-position/URL tie-breaking.

Typed operations are treated as schema-bound JSON. The core does not branch on their business purpose. `grok.synthesis` and `grok.x-synthesis` use the Grok Responses API; `gma.research` remains the separate multi-agent Chat Completions integration. If a sync logical output exceeds `max_inline_bytes`, the run fails with `OUTPUT_TOO_LARGE`; no truncation or implicit async conversion occurs.

## Async jobs

Async run uses the same normalized request, selection, operation descriptor, provider-attempt budget, retry policy, deadline, and logical output shape as sync. It requires an idempotency key. Matching key/request pairs reuse the job; a key reused for a different normalized request conflicts.

A job publishes exactly one immutable JSON result artifact as a manifest plus bounded binary chunks. The public lifecycle states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. Logical `partial` belongs to the stored query output, not the job lifecycle. Timeout is `failed` with `DEADLINE_EXCEEDED`.

`search.get/read/cancel` and `fetch.get/read/cancel` use the same job store while enforcing their public namespaces. Reads return bounded base64 chunks and a cursor bound to artifact SHA and byte offset. Retention is normalized once to integer seconds. A successful artifact's TTL begins at publication; failed and cancelled jobs retain from `completed_at`. No public enumeration, selector matrix, checkpoint, or artifact revision exists.

Snapshots and artifact manifests start at contract version 1. A snapshot freezes only the selected operations, fingerprints, normalized request, budget, and credential worker grant required to reconstruct that execution. Heartbeat failure during an active call or retry backoff is classified as `WORKER_LOST`, with no user cancel marker and no extra provider call. Retention pruning runs on start and worker entry. Result-directory publication retries transient Windows `EPERM`, `EACCES`, and `EBUSY` rename failures.

## Fetch

`fetch` is a strict `run | get | read | cancel` action union. A run accepts a discriminated `url | inline_text | inline_bytes | file` source and requests `markdown` (default) or `text`. Without an explicit pipeline, `fetch_chain` is matched by input kind and representation and runs serially until one document passes quality gates. An explicit pipeline bypasses the chain. Unsupported representation or execution fails preflight rather than degrading or switching execution mode.

Each pipeline descriptor reports input kinds, media types, representations, execution modes, egress, and typed stages. File and inline sources may enter only `egress: "none"` pipelines. Scoped files use relative paths, lexical and realpath containment, read-only access, source byte limits, and extension/content MIME checks; capabilities expose scope IDs but not roots, and file input remains disabled until a scope is configured. Inline HTML is parsed without script execution or secondary resource fetches. The built-in URL pipelines are `direct.fetch`, `jina.reader`, `tavily.extract`, `exa.contents`, `firecrawl.scrape`, `wayback.fetch`, `browser.render`, and `oac.fetch`; `direct.local` handles inline and scoped-file sources. The default URL chain remains `direct.fetch` then `jina.reader`; the latter three URL pipelines require explicit selection. `direct.local` advertises sync and async execution, `browser.render` is async-only, and the other built-in URL pipelines are sync-only. `browser.render` declares `egress: "url"` because Chromium connects to the target URL and bounded subresources. URL SSRF, redirect, byte/character limits, fallback classification, and `lane_outcomes` behavior remain unchanged. Documents add `representation` and `media_type` while retaining `source_lane`.

## Capabilities

`capabilities` is a static model-facing catalog. Its fetch section reports default representation, enabled input kinds, scope IDs, expanded chains, pipeline descriptors, availability, latency, cost, and public limits. It performs no network probe and does not expose provider-instance configuration, credentials, file-scope roots, retry or heartbeat internals, storage paths, or configuration provenance.
