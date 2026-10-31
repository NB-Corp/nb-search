# Model-facing query lane runtime

The package implements configuration schema v4 with three public capabilities: `search`, `fetch`, and `capabilities`. SDK, local CLI, and MCP call the same runtime; MCP registers exactly those three tools. The explicit remote client implements the same method interface over HTTP protocol 1, with strict response validation and URL-only fetch. Its identity/job authorization and wire-content idempotency requirements are in `remote-protocol.md`; they are not implemented by the local store described here. CLI profiles, private credential loading from environment or protected files, coordinated migration, and complete artifact consumption are described in `cli.md`.

## Trusted host HTTP transport

`createNbSearchRuntime({ http_transport })` accepts an in-process object implementing the root-exported `HttpTransport.send<T>(HttpRequest): Promise<HttpResponse<T>>` contract. `HttpRequest`, `HttpResponse`, `HttpTransport` and `ResponseLimitError` are available from the package root. Adapters using `ProviderFactoryContext.transports.http` receive that exact object; it must enforce its own bounds, redirect policy and AbortSignal handling. This is not JSON/config/env input, a global proxy, or interception of every SDK network path: direct HTTP, wayback's direct acquisition, browser and custom provider IO may use independent paths. A cloud host must restrict enabled operations to its audited coverage rather than infer universal SSRF protection.

Explicit public injection disables **all detached async run admissions on that runtime instance**, before selection/fetch preflight or job creation, returning `LANE_EXECUTION_UNSUPPORTED`. The transport object is not serialized or silently replaced in a child process. Effective `search.lanes`, presets and `fetch.pipelines` omit async; async-only browser pipelines have no effective modes and are unavailable, never relabeled sync. Provider descriptors retain static adapter support information and are not an instance execution guarantee. Sync operations, including non-egress inline/scoped-file fetch, and existing local get/read/cancel semantics remain unchanged. Omitting the option preserves the default runtime's async behavior. Internal worker/test transport injection is not subject to this public-instance policy. The SDK supplies no new cloud admission/job-store implementation through this option.

## Captured configuration and hosted workers

Hosts that admit configuration themselves can call `resolveCapturedConfiguration({ home, canonicalPath, canonical }, { env, config, overrides })` instead of making the SDK reread a file. `canonical` is the admitted local patch (`{}` when no local document is used); `config` is the host patch. The resolver applies standard defaults, environment settings and patches once and returns `ResolvedConfiguration`, including effective config, revision/fingerprint, timeout provenance and in-process secret bindings. Treat that object as private host state, not a client response.

After importing host-managed credential values into a captured environment, `bindCapturedConfiguration(resolved, env)` refreshes credential grants without merging configuration again. `createCapturedNbSearchRuntime(resolved, { env, launcher })` composes that exact effective configuration without disk reads, default resurrection or a second host patch. Standard `defaultConfiguration(home)` is also public; hosts should reuse it rather than copy default tables. Browser consumers can import input/routing schemas, types, built-in rule metadata and pure `selectFetchRoute` from `@nb-corp/nb-search/contracts`; that entry has no Node IO or worker startup.

`launcher: WorkerLauncher` is a trusted in-process hook with `launch(jobId, jobsRoot): Promise<void>`. Use it when a host executable must own detached worker startup. The public `runWorker(jobId, env?, jobsRoot?, onReady?)` runs the standard worker lifecycle; importing the function does not auto-run a worker. Both ordinary and captured runtime constructors preserve hosted async execution and the normal job snapshot/file admission checks.

## Offline provider operation inspection for hosts

The root helper `resolveProviderOperation(providerId, operationId, instance: ProviderInstanceConfig): ResolvedProviderOperation` resolves **Exa (search/synthesis/contents), GMA (research), and script (search)** without credentials, network requests, provider construction or script imports. It returns `{ provider, operation, kind, instance, endpoints }`: registry-owned provider/operation descriptors (including adapter version and schema), `kind: 'search' | 'fetch'`, an effective instance, and the adapter's request URLs. It validates options using the registration, uses the same URL resolvers as execution, and shares GMA default resolution with its factory. Unknown operations and providers outside this narrow resolver's coverage throw rather than return guessed endpoint information. Existing `builtInProviderRegistrations()` remains the catalog source; do not duplicate descriptors in a cloud catalog.

GMA defaults are materialized in `instance.options`; script resolves the module to an absolute path (relative input uses caller cwd) and preserves JSON `params`. Returned options are `Readonly<Record<string, unknown>>`, not string-only. No credentials are looked up, and these host-facing instance values are not automatically safe for tenant-facing display. Script has `endpoints: []` because arbitrary trusted module IO cannot be enumerated—not because scripts cannot access the network. Hosts own HTTPS/DNS/allowlist and module-deployment policy. Pass the returned instance to the SDK rather than rebuilding provider URLs or writing a second runner. Registry activation and operation descriptors are not a promise of runtime readiness or available credentials.

```ts
import { resolveProviderOperation } from '@nb-corp/nb-search';
const resolved = resolveProviderOperation('grok-multi-agent', 'research', {
  provider_id: 'grok-multi-agent', enabled: true,
  base_url: 'https://relay.example/v1', options: { api_mode: 'messages' }
});
// Apply host endpoint policy to resolved.endpoints.
// Bind a selected credential slot and execute resolved.instance using the SDK.
```

## Query operations

A lane binds one `provider_instance_id` to one `operation_id`. The provider registration is the output-contract source of truth:

- results operations declare `channel: "results"` and `schema_id: "nb-search.results@1"`;
- typed operations declare `channel: "typed"` and their JSON `schema_id`.

Effective execution modes are computed from registration ownership and runtime readiness. Built-in worker-installed query operations may support sync and async. Host registrations are sync-only in this version. Execution never selects another lane.

`search` is a strict `run | get | read | cancel` action union. A run selects one lane, an ordered results-lane list, or a results-only preset. Typed operations require one lane. The built-in search default is the keyless general-web `duckduckgo.search` lane; a configured `defaults.search_lane` applies to both sync and async. No registration, API key or browser download is needed. Public HTML challenges, rate limits and unrecognized pages are errors, never successful empty results; explicit defaults, removals and lane selections remain authoritative without provider fallback. Tavily's credentialed typed `crawl` and `research` lanes use the official crawl and POST-then-GET research-task protocols, with default query deadlines of 180 seconds and 900 seconds respectively unless the request or configuration supplies a timeout.

One query and one results lane preserve provider order. Each query×lane list canonical-deduplicates before RRF; multiple lists then use fixed RRF, global canonical deduplication, independent evidence groups, and stable plan-position/URL tie-breaking.

Typed operations are treated as schema-bound JSON. The core does not branch on their business purpose. `grok.synthesis` and `grok.x-synthesis` use the Grok Responses API; `gma.research` remains the separate multi-agent relay integration, with explicit provider `options.api_mode` selecting `chat_completions` (omitted default) or `messages`. Both modes use the same typed research projection; its data.api_mode records the actual protocol. Messages accepts bounded non-streaming text blocks only, not thinking/tool data. Its reasoning.effort and dual authentication headers are the observed relay contract, not a promise of universal native Anthropic compatibility. GMA adapter version 2 changes operation fingerprints: finish version-1 in-flight jobs before upgrading; old snapshots are not silently rebuilt under a different adapter. If a sync logical output exceeds `max_inline_bytes`, the run fails with `OUTPUT_TOO_LARGE`; no truncation or implicit async conversion occurs.

## Async jobs

Async run uses the same normalized request, selection, operation descriptor, provider-attempt budget, retry policy, deadline, and logical output shape as sync. It requires an idempotency key. Matching key/request pairs reuse the job; a key reused for a different normalized request conflicts.

A job publishes exactly one immutable JSON result artifact as a manifest plus bounded binary chunks. The public lifecycle states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. Logical `partial` belongs to the stored query output, not the job lifecycle. Timeout is `failed` with `DEADLINE_EXCEEDED`.

`search.get/read/cancel` and `fetch.get/read/cancel` use the same job store while enforcing their public namespaces. Reads return bounded base64 chunks and a cursor bound to artifact SHA and byte offset. Retention is normalized once to integer seconds. A successful artifact's TTL begins at publication; failed and cancelled jobs retain from `completed_at`. No public enumeration, selector matrix, checkpoint, or artifact revision exists.

Snapshots and artifact manifests start at contract version 1. A snapshot freezes only the selected operations, fingerprints, normalized request, budget, and credential worker grant required to reconstruct that execution. Heartbeat failure during an active call or retry backoff is classified as `WORKER_LOST`, with no user cancel marker and no extra provider call. Retention pruning runs on start and worker entry. Result-directory publication retries transient Windows `EPERM`, `EACCES`, and `EBUSY` rename failures.

## Fetch

`fetch` is a strict `run | get | read | cancel` action union. A run accepts a discriminated `url | inline_text | inline_bytes | file` source and requests `markdown` (default) or `text`. URL selection is **explicit pipeline → first matching enabled user rule → enabled built-in rule → input/representation fetch chain**. Only the selected ordered list is tried. Unsupported representation or execution fails preflight rather than degrading, matching another rule, or changing execution mode. Inline and file inputs do not use URL routing.

`fetch.routing` defaults to enabled, with the built-in `kiki-common-direct@1` package enabled. Its four rules cover known text files on `raw.githubusercontent.com`, specific GitHub repository JSON endpoints on `api.github.com`, npm metadata, and PyPI JSON. They select only `direct.fetch`: failure does not add Jina, Tavily, or another paid fallback. GitHub webpages, unrelated GitHub APIs, binary raw files, package tarballs, and PyPI project HTML do not match these built-ins. The package and full rules are returned in `capabilities.fetch.routing`.

Configure an exception with an exact HTTP(S) origin, optional `path_globs` and representation, and either a complete ordered `pipelines` list or `use: "default"`. Origins ignore case/default ports/trailing root dots. Paths are case-sensitive, fully anchored and keep percent encoding; `*` does not cross `/`, `**` does. Queries and fragments do not participate in matching, and routing does not rewrite the query sent to the source. A `use: "default"` rule suppresses the built-in match for that URL and restores the configured chain. `enabled: false` turns off routing; `builtin_enabled: false` turns off only built-ins; `disabled_builtin_rules` disables selected built-in IDs.

```json
{
  "fetch": {
    "routing": {
      "rules": [
        {
          "id": "raw-explicit-fallback",
          "match": { "origin": "https://raw.githubusercontent.com", "path_globs": ["/**/*.md"] },
          "action": { "pipelines": ["direct.fetch", "jina.reader"] }
        },
        {
          "id": "npm-use-my-chain",
          "match": { "origin": "https://registry.npmjs.org" },
          "action": { "use": "default" }
        }
      ]
    }
  }
}
```

Direct URL HTML uses Defuddle 0.19.3 with a linkedom DOM and `useAsync: false`; scripts, iframes and extractor secondary downloads are not executed. It extracts Markdown or readable text with links/code rather than returning the page shell. An empty extracted body fails with `QUALITY_GATE_FAILED`; authentication/challenge structures fail with `FETCH_BLOCKED`. Plain source text preserves whitespace, empty plain bodies return `status: "empty"`, and JSON is pretty-printed. GitHub contents/readme file responses decode base64 locally only when the payload is valid UTF-8 readable text within the byte budget. Directory listings stay JSON; missing content, pagination, byte truncation and LFS pointers carry warnings. No `download_url` is followed automatically. Explicit quality rules still apply after extraction; default `min_content_chars: 0` and `blocked_markers: []` do not impose an arbitrary length threshold. Direct 401/404/410 and GitHub API errors terminate the selected list instead of fetching an error page elsewhere.

Each pipeline descriptor reports input kinds, media types, representations, execution modes, egress, and typed stages. File and inline sources may enter only `egress: "none"` pipelines. Scoped files retain relative-path and realpath containment, read-only byte/MIME checks, and optional host-admitted `canonical_target` plus `approved_identity`; `captureFetchFileIdentity` captures the identity for validation at read time. Capabilities expose scope IDs but not roots. The default URL chain remains `direct.fetch` then `jina.reader` for unmatched URLs. `direct.fetch` and `direct.local` support sync and async, `browser.render` is async-only, and other built-in URL pipelines are sync-only. Browser rendering connects to bounded target subresources; static Direct extraction does not. Existing SSRF, DNS pinning, redirects, abort and byte/character limits remain in the acquisition layer.

URL run receipts return `routing` with origin, rule/package identity, selected pipelines, representation and execution. `lane_outcomes` retain actual provider `attempts`, failures and skipped unavailable lanes. Async admission freezes that decision and list once; workers and get/read use the captured plan even if configuration changes. Failed fetch execution can publish a diagnostic artifact with route/attempts and no successful documents. Inspect document warnings before treating projected content as complete.

## Capabilities

`capabilities` is a static model-facing catalog. Its fetch section reports default representation, enabled input kinds, scope IDs, expanded chains, pipeline descriptors, availability, latency, cost, and public limits. It performs no network probe.

Provider-instance `availability` describes realized runtime readiness. `ready` means activation succeeded and at least one operation declared by the provider has a realized runtime port. `PROVIDER_PORTS_PARTIAL` is a non-fatal diagnostic: the instance remains ready, but one or more declared operations are unavailable, so hosts must inspect the matching `search.lanes` and `fetch.pipelines` entries before enabling an operation. `unavailable` means activation failed or none of the provider's declared operations has a realized runtime port. `PROVIDER_PORTS_UNAVAILABLE` identifies the latter case. Operation-specific issues such as `BROWSER_NOT_INSTALLED` remain attached to their lane or pipeline and are also propagated to the provider instance.

The known capability issue-code literals are `PROVIDER_NOT_REGISTERED`, `PROVIDER_DISABLED`, `CREDENTIAL_NOT_CONFIGURED`, `ENDPOINT_NOT_CONFIGURED`, `PROVIDER_PORTS_UNAVAILABLE`, `PROVIDER_PORTS_PARTIAL`, `LANE_NOT_REGISTERED`, `OPERATION_NOT_REGISTERED`, `LANE_NOT_CONFIGURED`, `BROWSER_NOT_INSTALLED`, and `RATE_LIMIT_UNAUTHENTICATED`. The public `CapabilityIssueCode` type retains an extensible string branch for future provider-defined diagnostics.

Capabilities expose provider and instance identifiers, operation descriptors, activation requirements, slot identifiers, readiness, and issue codes. They do not expose raw base URLs, provider option values, credential environment-variable names, secret values, file-scope roots, retry or heartbeat internals, storage paths, or configuration provenance.
