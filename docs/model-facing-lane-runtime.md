# Model-facing query lane runtime

The package implements configuration schema v4 with three public capabilities: `search`, `fetch`, and `capabilities`. SDK, CLI, and MCP call the same runtime; MCP registers exactly those three tools.

## Query operations

A lane binds one `provider_instance_id` to one `operation_id`. The provider registration is the output-contract source of truth:

- results operations declare `channel: "results"` and `schema_id: "nb-search.results@1"`;
- typed operations declare `channel: "typed"` and their JSON `schema_id`.

Effective execution modes are computed from registration ownership and runtime readiness. Built-in worker-installed query operations may support sync and async. Host registrations are sync-only in this version. Execution never selects another lane.

`search` is a strict `run | get | read | cancel` action union. A run selects one lane, an ordered results-lane list, or a results-only preset. Typed operations require one lane. The one configured search default applies to both sync and async.

One query and one results lane preserve provider order. Each query×lane list canonical-deduplicates before RRF; multiple lists then use fixed RRF, global canonical deduplication, independent evidence groups, and stable plan-position/URL tie-breaking. Aggregate rows without upstream attribution use the `unknown` evidence group and do not add independent corroboration.

Typed operations are treated as schema-bound JSON. The core does not branch on their business purpose. If a sync logical output exceeds `max_inline_bytes`, the run fails with `OUTPUT_TOO_LARGE`; no truncation or implicit async conversion occurs.

## Async query jobs

Async run uses the same normalized request, selection, operation descriptor, provider-attempt budget, retry policy, deadline, and logical output shape as sync. It requires an idempotency key. Matching key/request pairs reuse the job; a key reused for a different normalized request conflicts.

A job publishes exactly one immutable JSON result artifact as a manifest plus bounded binary chunks. The public lifecycle states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. Logical `partial` belongs to the stored query output, not the job lifecycle. Timeout is `failed` with `DEADLINE_EXCEEDED`.

`search.get` reports state and final artifact metadata. `search.read` returns bounded base64 chunks and a cursor bound to artifact SHA and byte offset. Retention is normalized once to integer seconds. A successful artifact's TTL begins at publication; failed and cancelled jobs retain from `completed_at`. A `get` response can precede expiry while a later `read` crosses it, so `read` at or after `artifact.expires_at` returns `JOB_NOT_FOUND`. `search.cancel` records a cancellation request without asserting upstream termination. No public enumeration, selector matrix, checkpoint, or artifact revision exists.

Snapshots and artifact manifests start at contract version 1. A snapshot freezes only the selected operations, fingerprints, normalized request, budget, and credential worker grant required to reconstruct that execution. Heartbeat failure during an active call or retry backoff is classified as `WORKER_LOST`, with no user cancel marker and no extra provider call. Retention pruning runs on start and worker entry. Result-directory publication retries transient Windows `EPERM`, `EACCES`, and `EBUSY` rename failures.

## Fetch

`fetch` accepts one URL and an optional fetch lane. Without `lane`, the configured `fetch_chain` runs serially, preserving configuration order and stopping at the first 2xx document that passes the minimum-content-length and blocked-marker rules. Unavailable lanes are recorded as `skipped`; explicit `lane` bypasses the chain. Terminal failures (`FETCH_BLOCKED`, HTTP 404/410, `FETCH_CONTENT_TYPE_REJECTED`, cancellation, or total deadline) do not fall through. Successful execution returns one document; failure remains in `lane_outcomes` and does not create a placeholder document.

The built-in fetch lanes are `direct.fetch`, `jina.reader`, `tavily.extract`, `exa.contents`, and `firecrawl.scrape`. The built-in chain is `direct.fetch` then `jina.reader`; the latter is also keyless, while Tavily, Exa, and Firecrawl require credentials. `direct.fetch` uses Node HTTP, HTTPS, and DNS APIs. It rejects credentialed and non-HTTP(S) URLs, metadata hosts, non-public address ranges, and mixed/private DNS answers. It connects to a validated address while preserving Host and TLS SNI, validates every redirect, bounds bytes/characters/redirects, accepts text MIME types, and performs deterministic HTML-to-text conversion. Production always connects to the validated public address. The native oracle uses a package-internal test composition seam that is absent from package exports and generated public declarations.

## Capabilities

`capabilities` is a static model-facing catalog. It contains schema/revision, query lanes and presets, fetch lanes and configured chain order, quality-limit values (with blocked markers reported only as a count), effective execution modes, availability issues, public limits, result retention, and cancellation support. It performs no network probe and does not expose provider-instance configuration, credential values, retry internals, heartbeat internals, storage paths, or configuration provenance.
