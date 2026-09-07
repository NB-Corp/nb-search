# nb-search HTTP protocol v1

Status: v1 client contract, implemented by the package's remote client and exercised by test-only loopback fixtures. This document specifies a client/service boundary, not a deployed service. The existing local runtime is not a multi-tenant server.

## Version and endpoints

The API base is an absolute service URL ending in a directory path, for example `https://search.example/api/`. Append `v1/search`, `v1/fetch`, or `v1/capabilities` to that base. An origin-only base is normalized to `/`; a non-root base is normalized to one trailing slash. Never infer a different origin, protocol, or API prefix.

All three endpoints accept POST, UTF-8 JSON, with these headers:

```http
Authorization: Bearer <service-access-key>
Content-Type: application/json
Accept: application/json
X-NB-Search-Protocol: 1
X-Request-Id: <request-id>
```

HTTP protocol `1` is independent of result `schema_version: "3.0"` and canonical configuration schema `4`. No protocol negotiation, downgrade, request replay, or automatic retry occurs in the client.

`search` accepts the strict action union exported as `searchInputSchema`: `run`, `get`, `read`, `cancel`. `fetch` accepts `fetchActionInputSchema`, restricted in v1 to `source.kind: "url"` for `run`. `capabilities` accepts exactly `{}` (it has no action discriminator). Client-side convenience `{url: ...}` is normalized before transmission; it is not a wire request form. Execution omission means `sync`. Async run requires `idempotency_key`; sync rejects it. The bounds in `src/contracts.ts` apply on both sides.

Examples (fake public data, no real keys):

```json
{"action":"run","query":"Node.js release notes","lane":"exa.search"}
```

```json
{"action":"run","source":{"kind":"url","url":"https://example.com/"},"execution":"async","idempotency_key":"fetch-example-1"}
```

```json
{"action":"get","job_id":"00000000-0000-4000-8000-000000000000"}
```

## Transport security and limits

- HTTPS is required. An explicit `allow_loopback_http: true` client setting allows HTTP only for literal `127.0.0.1`, `[::1]`, or `localhost`. It is a development exception, not a general insecure-HTTP switch; no DNS lookup is used to expand that allowlist.
- Reject service URLs containing userinfo, query, or fragment, and reject a missing/blank access key or a key containing whitespace/control characters. Keys are passed separately to the SDK factory, never via query strings or CLI argv. A service access key is not an upstream provider credential.
- Fetch uses `redirect: 'manual'`; every 3xx is an error. No key is sent to the redirect target, including same-origin redirects. Browser-cookie authentication is not part of this protocol.
- Default request limit is 1 MiB after UTF-8 encoding; default response limit is 8 MiB of decoded response-body bytes. These are client options with positive integer validation. Check Content-Length when usable, but also bound streaming reads, including chunked and decompressed responses. Cancel the response stream on overflow, invalid headers, or abort. Error bodies use the same response bound.
- Default per-HTTP-call deadline is 120,000 ms, configurable from 100 through 3,600,000 ms. This is not the provider's input `timeout_ms` or the job lifetime. Compose it with `OperationContext.signal`; abort during headers or body stops the client operation. No cancellation reason or network exception text is exposed verbatim.
- Requests are schema-validated before network IO. In particular, remote inline text, bytes, and file input fail locally before any request, even if a service advertises those input kinds. No upload or local fallback is inferred.
- Services must separately enforce request/body/time/cost limits and SSRF-safe URL acquisition on every redirect and DNS resolution. Client endpoint checks are not service-side fetch egress enforcement.

## Response and error mapping

Every conforming response includes `X-NB-Search-Protocol: 1`, `X-Request-Id` equal to the accepted request ID, and `Content-Type: application/json` (optional charset allowed). The client generates a UUID when `OperationContext.requestId` is absent. Supplied IDs must match `[A-Za-z0-9._:-]{1,128}`; invalid IDs fail before IO. IDs contain no user query, URL, secret, or personal data. A server may generate an ID for invalid/missing inbound IDs, but valid SDK requests require exact response correlation. Missing, malformed, or mismatched metadata is a protocol error, not a successful result.

HTTP **200**, including queued async receipts, carries the existing method's envelope directly, without a transport wrapper. Business `failed`, `partial`, `empty`, `timed_out`, or `cancelled` results are still HTTP 200 and resolve normally. A failed async admission that the runtime represents as an envelope is also HTTP 200. SDK consumers must inspect business status/state.

All other HTTP statuses reject the client promise. HTTP 201/202/204 do not stand in for a run receipt. Non-200 JSON has this service error shape:

```json
{"error":{"code":"RATE_LIMITED","message":"Request rate limit exceeded.","retryable":true}}
```

Optional `error.retry_after_ms` is a nonnegative safe integer. Arbitrary `data`, stack traces, provider credentials, upstream URLs, or upstream response bodies are forbidden. The client uses its own fixed public message and status-derived code rather than trusting a server-supplied message. It does not attach raw body, headers, URL, key, or network `cause` to public errors.

| HTTP status | Service error code | Meaning / client retryable metadata |
| --- | --- | --- |
| 400 | INVALID_REQUEST | Invalid request schema, false |
| 401 | UNAUTHENTICATED | Missing/invalid service key, false |
| 403 | FORBIDDEN | Authenticated identity lacks permission, false |
| 404 | NOT_FOUND | Unknown endpoint, unknown/expired/unowned job, false |
| 409 | CONFLICT | Idempotency key reused with different normalized request, false |
| 413 | REQUEST_TOO_LARGE | Inbound body limit, false |
| 415 | UNSUPPORTED_MEDIA_TYPE | Expected JSON, false |
| 426 | PROTOCOL_UNSUPPORTED | Unsupported HTTP protocol version, false |
| 429 | RATE_LIMITED | Service admission/quota throttling, true |
| 500 | INTERNAL | Service fault, true |
| 502/503/504 | UNAVAILABLE | Service unavailable, true |

An unmapped non-200 status is `HTTP_ERROR`. A mapped error requires the matching wire code and retryability; a malformed JSON error or inconsistent error code is `PROTOCOL_ERROR`, retaining only the safe numeric HTTP status. Gateways which cannot provide the protocol headers likewise cause `PROTOCOL_ERROR`; they must not be misreported as business results.

`Retry-After` on 429/503 accepts nonnegative integer seconds or an HTTP date; expose normalized milliseconds (past dates become zero). If both header and body delay exist, use the larger. Reject invalid or overflowing delay values as protocol errors. This is advisory metadata, **never permission to automatically retry a paid request**. Retryability describes the failure, not idempotency or user authorization.

The SDK exports a distinct `NbSearchRemoteError`, not a fabricated search/fetch envelope. Its public fields are `code`, fixed `message`, `retryable`, `request_id`, optional `status`, and optional `retry_after_ms`. Local codes are `INVALID_INPUT`, `CONFIGURATION_ERROR`, `PROTOCOL_ERROR`, `RESPONSE_TOO_LARGE`, `REQUEST_TOO_LARGE`, `TRANSPORT_ERROR`, `DEADLINE_EXCEEDED`, and `CANCELLED`, plus the service/status codes above. Local validation/configuration errors are nonretryable; transport/deadline failures may be retryable but are never retried. Keep this taxonomy separate from provider-level `PublicErrorCode` so service authentication does not become `PROVIDER_AUTH`.

## Response schema validation

`src/remote-protocol.ts` will validate unknown JSON before returning any exported runtime type. Reuse current input schemas; build response schemas against `src/types.ts`, not type assertions. Check:

1. Exact result schema version; action and effective execution match the request. Fetch envelopes require `mode: "fetch"`; search envelopes reject a fetch mode. Get/read/cancel `job_id` matches the request.
2. Required union fields, enum values, safe nonnegative sizes/durations, job UUIDs, timestamps, selections, hints, error objects, lane outcomes, result/provenance rows, and fetch document metadata. A queued run must have a valid receipt; a failed async admission must have an error. Failed sync runs may instead carry failed logical output/lane outcomes, as the existing runtime does; do not impose an error field that its contract makes optional. Successful search sync must have the declared logical output; whenever output is present its status agrees with the enclosing status.
3. Job receipt/get/read/cancel shapes match the current runtime's state model. A job can have state `succeeded` while its stored logical output is `partial` or `empty`; do not substitute job state for logical status.
4. Artifact metadata uses `application/json`, a 64-hex SHA-256, safe nonnegative byte length, and a valid expiry timestamp. Chunks have integer index/offset/length and canonical base64. Structural validation precedes full integrity validation during CLI result consumption.
5. Capabilities validate the full generic catalog and its declared limits. Typed search output accepts bounded JSON under a nonempty `schema_id`; clients do not assume every future typed lane is GMA. Unknown additive response object properties may pass through, but cannot replace required known fields. Unknown discriminators or result schema versions fail closed.

The service must redact its successful catalogs and envelopes too: do not expose raw endpoint configuration, option values, secret values, or environment-variable names. The client can redact its own service key in error paths; it cannot discover and scrub arbitrary secrets a misconfigured service places in successful business data.

## Jobs, authorization, retries, and retention

- A service authenticates every operation, including capabilities. Its catalog contains only lanes, pipelines, presets, and limits authorized for the current principal; execution reauthorizes, even after a cached catalog said ready. Remote v1 catalog input declarations must not enable file/inline input.
- Every get/read/cancel requires tenant/principal ownership and capability-kind checks. Unknown, expired, wrong-kind, and unowned IDs produce indistinguishable 404 errors. An opaque UUID is not authorization. Never mount the current local job store as a shared unauthenticated job API.
- Authentication/resource authorization and eligibility for **new paid execution** are separate checks. Exhausted execution quota or balance must not block get/read/cancel for an existing still-authorized job, nor matching idempotent receipt recovery which dispatches no new work. Revoked identity/resource access remains denied; ordinary abuse-protection rate limits may still apply independently of paid execution quota. These are service obligations, not features of the local store.
- Async idempotency namespace is `(tenant ID, stable authenticated principal ID, capability kind, idempotency_key)`, not a bearer-token hash. Token rotation preserving the same principal preserves the namespace. Matching requests reuse the same admitted job as specified below; differing requests in that namespace yield 409.
- Artifact and job retention are advertised via capabilities and artifact expiry. Expired artifacts are not regenerated by `read`. No cross-service job discovery or automatic replay is available.
- SDK calls on one client instance remain on that connection. Local CLI follow-up actions default to the local connection, while remote actions explicitly select their profile, and known job bindings must match before IO. Neither local jobs nor jobs from another service are silently queried elsewhere.
- `cancel` is an explicit cooperative request; `cancel_requested: true` does not guarantee all upstream work stopped, nor a refund. A get/read deadline, CLI wait timeout, or client abort never implicitly calls cancel. Sync requests also may have executed upstream after a transport failure; the client never retries them automatically. Zero client retries does not disable separately configured provider/service execution retries.

### Async idempotency normalization

This is a **remote service rule**, intentionally not the local SDK's snapshot-based job fingerprint. It does not change local SDK semantics. The client sends schema-parsed wire requests and does not resolve service configuration or compute provider plans.

For an async run, parse the strict v1 input schema first (including its trimming), then construct comparison JSON as follows:

1. Remove `idempotency_key`; it is the namespace key, not a content field. Retain `action: "run"` and `execution: "async"`.
2. For search, normalize `query` to an ordered array even when supplied as a string. Preserve array order and duplicates, including selector arrays. Do not equate `lane`, `lanes`, and `preset` or resolve their contents from the catalog.
3. For fetch, normalize an omitted `representation` to `"markdown"`. The URL string is the schema-parsed wire value; do not infer redirect destinations, URL canonical equivalences, or server defaults. Non-URL sources never reach admission in v1.
4. Apart from that explicit fetch representation default, keep omitted optional fields absent. In particular, do not fill in `max_results`, `timeout_ms`, `max_content_chars`, pipeline, lane, or preset using deployment defaults. An omitted field and an explicit value differ even if that value happens to equal today's default.
5. Recursively sort object keys lexicographically, preserve array order, and serialize compact JSON using JSON string/number escaping semantics. Equality is equality of these canonical UTF-8 bytes (a collision-resistant hash may index them, but a hash collision must not alias unequal content). Whitespace in the original JSON formatting is irrelevant; no Unicode normalization beyond input-schema trimming is applied.

The comparison excludes configuration revisions, resolved defaults, selected lane expansions, provider options, deployment versions, and execution snapshot fingerprints. The first atomic admission binds the normalized content and key to one job and freezes its first execution plan. A matching request after defaults/deployment changes still identifies that job: reauthorize access to the originally admitted resources, then project its current state without new provider dispatch. Do not rerun selection against new defaults to decide content equality. If access to an original resource was revoked, deny recovery rather than disclose it or substitute another resource.

### Admission, replay projection, and expiry

Atomically persist key/content/job/first-plan association before any worker/provider dispatch. Concurrent matching admissions converge on one job. Validation or admission rejection **before this commit** creates no association; a corrected/retried request may later be admitted. Once committed, worker startup failure, timeout, execution failure, or cancellation does not release the association. If commit/dispatch outcome is uncertain, reconcile the durable admission state; never clear the key and dispatch again merely because a response was lost.

Replay is a projection of the **same admission and current job state**, not a byte-for-byte replay of an old instantaneous envelope:

- queued/running/succeeded/cancelled jobs return the run-async receipt shape, `status: "queued"`, `reused: true`, the same `job_id`/`created_at`, and `job.state` set to its actual current state. The outer queued status denotes an async receipt, not a claim that terminal work is queued again. Poll hints are needed only while work is queued/running.
- An admitted failed job returns the run-async failed envelope with its public error, `reused: true`, and the same receipt with `job.state: "failed"`. The optional `job` field is required for this remote admitted-failure projection so callers can distinguish it from a rejection with no admission and address get/read. No rerun occurs.
- A pre-admission business rejection may use a run-async failed envelope without a job; it has no durable key association. Consumers must not infer admission from HTTP 200 alone.

An association never expires while its job is active, even if the initial advertised TTL elapses. After terminal transition it remains for at least the service's advertised terminal job/result retention duration; that duration applies to failed/cancelled jobs even when they have no artifact. It must not expire earlier than any advertised retained artifact/job expiry. Replays do not shorten retention. After this documented retention has expired the same key **may admit a new job and execute again**; clients must not rely on indefinite deduplication or blindly resubmit an old key. Unknown/expired get/read/cancel returns 404, not regeneration. Services must document their retention policy; this SDK does not implement the backing admission database.

### Normative vectors

Within the same tenant/principal and capability, use key `k1`. `S(q, extra)` below means `{"action":"run","execution":"async","idempotency_key":"k1","query":q,...extra}`; `F(extra)` means a fetch run with those three action/execution/key fields and `source:{"kind":"url","url":"https://example.com/"}`. All examples are schema-valid unless explicitly labeled rejection.

| A then B | Normalized comparison / required outcome |
| --- | --- |
| `S(" q ", {})` then `S(["q"], {})` | Equal: `{"action":"run","execution":"async","query":["q"]}`; same admitted job |
| `S(["a","b"], {})` then `S(["b","a"], {})` | Different ordered queries; 409 |
| `S("q", {})` then `S("q", {max_results:10})` | Different: omission is not explicit 10; 409 even when default is 10 |
| `S("q", {})` then `S("q", {timeout_ms:30000})` | Different: omission is not explicit timeout; 409 |
| `S("q", {lane:" exa.search "})` then `S("q", {lane:"exa.search"})` | Equal after schema trim |
| `S("q", {lane:"exa.search"})` then `S("q", {lanes:["exa.search"]})` | Different selector forms; 409 |
| `S("q", {preset:"p"})` then `S("q", {lanes:["exa.search"]})` | Different even if today's preset p has exactly that lane; 409 |
| `F({})` then `F({representation:"markdown"})` | Equal: `{"action":"run","execution":"async","representation":"markdown","source":{"kind":"url","url":"https://example.com/"}}` |
| `F({})` then `F({representation:"text"})` | Different; 409 |
| Same omitted-selector wire request, default lane/budget/deployment changes between A and B | Equal; return same job and frozen first plan, no new dispatch; deny if access revoked |
| Matching B while A's job is queued/running/succeeded/cancelled | Same job receipt, current state, reused true; no rerun |
| Matching B after admitted worker failure | Failed envelope with same failed job receipt and reused true; no rerun |
| Invalid schema or rejected admission before durable commit, then valid retry | No previous association; may admit once (subject to current authorization/quota) |
| Matching B after advertised TTL while job is still active | Same association; never a new job |
| Matching B after terminal transition but before terminal retention expires | Same association, including failed/cancelled; no rerun |
| Matching B after documented terminal association retention expires | May admit a new job; old get/read/cancel remains 404 |
| Same content/key in different capability or different tenant/principal | Different namespace, independently authorized admission |

These vectors constrain services and reusable conformance fixtures. A fixture test of projection/normalization is not proof of a production database's atomicity or authorization enforcement.

## Conformance boundary

The repository includes an explicitly test-only loopback HTTP fixture server (`test/fixtures/remote-http.ts`), client conformance checks (`test/remote-client.test.ts`), and real CLI subprocess HTTP checks (`test/cli-remote-integration.test.ts`). These fixtures are repository test resources, not a production server or npm runtime entrypoint. Tests must cover all three methods, sync and async receipts, get/read/cancel, correlation and version headers, request validation before IO, URL-only fetch, 401/403/404/409/429, both Retry-After forms, redirects (a second listener must receive zero requests), streamed oversize bodies, malformed UTF-8/JSON/envelopes, mismatched action/job IDs, caller abort and deadlines. CLI integration must really pass through HTTP, not inject a fake SDK object alone.

These tests prove a client can call the specified HTTP boundary. They do not prove production identity, job ACL, provider compatibility, quota enforcement, billing, deployment, or any live paid call. Cloud implementers own those requirements; this package does not supply a production HTTP server.
