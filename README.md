# nb-search

`@nb-corp/nb-search` is a deterministic query-lane runtime with three public capabilities: `search`, `fetch`, and `capabilities`.

For full documentation, tutorials, and configuration guides, visit the [documentation site](https://nb-corp.github.io/nb-search/) (or browse the source documentation locally starting at [`website/guide/quickstart.md`](website/guide/quickstart.md)).

For `search`, the caller selects lanes and the runtime does not inspect a query to choose an engine, replace an unavailable lane, or run an unselected fallback. Selecting `execution: "async"` changes delivery only; it does not change the lane or query plan. For `fetch`, the caller supplies a URL, inline text, inline bytes, or a scoped file; omitting `pipeline` runs the matching configured chain, while an explicit `pipeline` bypasses it.

## Requirements

- Node.js 24.15.0 or newer
- pnpm 10.33.0 when building from source

### TypeScript Consumer Compatibility

Validated consumer builds use TypeScript with `skipLibCheck: true`. Compiling against packaged type definitions under TypeScript 6.0.2 with full declaration re-checking (`skipLibCheck: false`) produces variance diagnostics (TS2636) within bundled internal Zod type declarations. Enabling `skipLibCheck: true` skips third-party declaration checking without disabling strict type checking in your own application code. Projects requiring strict full dependency declaration checking should evaluate this compatibility constraint before adoption.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm smoke
```

## Configuration

Configuration uses schema v4 and resolves in this order:

1. built-in structure;
2. `$NB_SEARCH_HOME/config.json`, or `NB_SEARCH_CONFIG`;
3. canonical `NB_SEARCH_*` environment values;
4. in-process `config`;
5. in-process `overrides`.

```json
{
  "schema_version": "4",
  "defaults": {
    "fetch_chain": [
      { "input_kind": "url", "pipelines": ["direct.fetch", "jina.reader"] },
      { "input_kind": "inline_text", "pipelines": ["direct.local"] },
      { "input_kind": "inline_bytes", "pipelines": ["direct.local"] },
      { "input_kind": "file", "pipelines": ["direct.local"] }
    ]
  },
  "presets": {
    "cross-check": {
      "lanes": ["exa.search", "tavily.search"]
    }
  }
}
```

The built-in configuration has no default search lane. A search call without `lane`, `lanes`, or `preset` therefore fails with `DEFAULT_NOT_CONFIGURED` unless the host configures `defaults.search_lane`. A lane binds `provider_instance_id` to `operation_id`; results lanes can be combined in `lanes` and presets, while typed lanes require a single `lane`.

### Built-in search lanes

| Lane | Output | Credential and required configuration |
| --- | --- | --- |
| `brave.search` | results | `NB_SEARCH_BRAVE_API_KEY` |
| `context7.docs` | typed (`nb-search.docs-context@1`) | Optional `NB_SEARCH_CONTEXT7_API_KEY`; keyless by default |
| `exa.search` | results | `NB_SEARCH_EXA_API_KEY` |
| `exa.synthesis` | typed (`nb-search.synthesis@1`) | `NB_SEARCH_EXA_API_KEY` |
| `firecrawl.search` | results | `NB_SEARCH_FIRECRAWL_API_KEY` |
| `github.repositories` | results | Optional `NB_SEARCH_GITHUB_TOKEN`; keyless with unauthenticated rate limits |
| `gma.research` | typed (`nb-search.multi-agent-research@1`) | `NB_SEARCH_GROK_API_KEY`; requires `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL` |
| `grok.synthesis` | typed (`nb-search.synthesis@1`) | `NB_SEARCH_GROK_API_KEY` |
| `grok.x-synthesis` | typed (`nb-search.synthesis@1`) | `NB_SEARCH_GROK_API_KEY` |
| `oac.synthesis` | typed (`nb-search.synthesis@1`) | `NB_SEARCH_OAC_API_KEY`; requires `NB_SEARCH_OAC_BASE_URL` and `NB_SEARCH_OAC_MODEL` |
| `parallel.search` | results | `NB_SEARCH_PARALLEL_API_KEY` |
| `searxng.search` | results | Keyless; requires `NB_SEARCH_SEARXNG_BASE_URL` |
| `tavily.search` | results | `NB_SEARCH_TAVILY_API_KEY` |
| `tavily.synthesis` | typed (`nb-search.synthesis@1`) | `NB_SEARCH_TAVILY_API_KEY` |
| `zhipu.search` | results | `NB_SEARCH_ZHIPU_API_KEY` |

All built-in search operations advertise both sync and async execution on default runtime instances when configured and available (custom `http_transport` injection restricts an instance to sync).

### Built-in fetch pipelines

| Pipeline | Input | Execution | Egress | Credential |
| --- | --- | --- | --- | --- |
| `direct.fetch` | URL | sync | `url` | None; keyless |
| `direct.local` | inline text, inline bytes, scoped file | sync, async | `none` | None; keyless |
| `jina.reader` | URL | sync | `url` | Optional `NB_SEARCH_JINA_API_KEY`; keyless by default |
| `exa.contents` | URL | sync | `url` | `NB_SEARCH_EXA_API_KEY` |
| `tavily.extract` | URL | sync | `url` | `NB_SEARCH_TAVILY_API_KEY` |
| `firecrawl.scrape` | URL | sync | `url` | `NB_SEARCH_FIRECRAWL_API_KEY` |
| `wayback.fetch` | URL | sync | `url` | None; keyless |
| `browser.render` | URL | async | `url` | None; optional Playwright/Chromium installation |
| `oac.fetch` | URL | sync | `url` | `NB_SEARCH_OAC_API_KEY`; requires `NB_SEARCH_OAC_BASE_URL` and `NB_SEARCH_OAC_MODEL` |

The built-in URL chain is `direct.fetch` then `jina.reader`; inline and scoped-file sources use `direct.local`. `wayback.fetch`, `browser.render`, and `oac.fetch` require explicit pipeline selection and are not in the default chain. Both `markdown` and `text` representations are supported. Scoped-file input is disabled until the host configures at least one read-only file scope. See `.env.example` for the complete canonical environment-variable set.

## SDK

```ts
import {
  createNbSearchRuntime,
  parseConfigPatch,
  type CanonicalConfigPatch
} from '@nb-corp/nb-search';

const savedConfig = parseConfigPatch(hostSettings.nbSearch, 'host settings');
const sessionOverrides: CanonicalConfigPatch = {
  defaults: { search_lane: 'exa.search' }
};

const runtime = createNbSearchRuntime({
  env: process.env,
  config: savedConfig,
  overrides: sessionOverrides
});

const results = await runtime.search({
  action: 'run',
  query: 'Node.js ESM resolution',
  execution: 'sync'
});

const typed = await runtime.search({
  action: 'run',
  query: 'Summarize the differences',
  lane: 'tavily.synthesis'
});

const started = await runtime.search({
  action: 'run',
  query: 'Investigate the migration',
  lane: 'gma.research',
  execution: 'async',
  idempotency_key: 'migration-1'
});

const page = await runtime.fetch({
  action: 'run',
  source: { kind: 'url', url: 'https://example.com/spec' },
  representation: 'markdown'
});

const catalog = await runtime.capabilities();
```

`config` is the host's validated saved patch and `overrides` is the higher-precedence runtime patch. `capabilities()` returns registered provider descriptors, configured provider-instance readiness, search-lane and fetch-pipeline descriptors, configured defaults, limits, and credential readiness.

Provider-instance availability is runtime readiness, not a substitute for operation selection:

- `availability: "ready"` means activation succeeded and at least one declared operation has a realized runtime port.
- `PROVIDER_PORTS_PARTIAL` is a non-fatal diagnostic: the provider instance remains ready, but the host must inspect `search.lanes` and `fetch.pipelines` before enabling a specific operation.
- `availability: "unavailable"` means provider activation failed or none of its declared operations has a realized runtime port.

Capabilities expose provider and instance identifiers, activation requirements, slot identifiers, readiness, and issue codes. They do not expose raw base URLs, provider option values, credential environment-variable names, secret values, file-scope roots, or storage paths. `CapabilityIssueCode` provides the current known issue-code literals while retaining support for future provider-defined codes.

`search` is an action union:

- `run` executes a query operation. Execution defaults to `sync`; `async` requires `idempotency_key`, while sync forbids that key.
- `get` reads job state and final artifact metadata.
- `read` reads bounded chunks from the one immutable JSON result artifact.
- `cancel` records a cancellation request; it does not claim that an upstream request stopped or avoided billing.

Results operations support one lane, ordered `lanes`, or a results-only `preset`. One query and one results lane preserve provider order. Multiple query/lane lists use per-list canonical deduplication, RRF, independent evidence groups, and stable tie-breaking. Typed operations require one lane and return schema-bound JSON. Oversized sync output returns `OUTPUT_TOO_LARGE`; it is not truncated or changed to async.

Operational failures use stable `PublicErrorCode` values in run envelopes and lane outcomes. No configured search default returns a failed envelope with `DEFAULT_NOT_CONFIGURED`; an unavailable fetch default returns `FETCH_CHAIN_UNAVAILABLE`. Successful work from some selected search lanes produces `partial`. Host cancellation produces `cancelled` with `CANCELLED`, and the execution budget produces `timed_out` with `DEADLINE_EXCEEDED`.

An async job publishes one immutable logical-output artifact. Its normalized integer-second TTL begins when the successful artifact is published. A `get` response may cross the expiry boundary before a later `read`; `read` at or after `artifact.expires_at` returns `JOB_NOT_FOUND`. There is no public job enumeration, artifact selector, checkpoint, or artifact revision.

## Fetch safety

`fetch` is a strict `run | get | read | cancel` action union. `run.source` is one of `{ kind: "url", url }`, `{ kind: "inline_text", content, media_type, base_url? }`, `{ kind: "inline_bytes", content_base64, media_type, filename? }`, or `{ kind: "file", scope, path }`; `representation` is `markdown` (default) or `text`. Without `pipeline`, the runtime matches `defaults.fetch_chain` by input kind and representation and tries its pipelines serially. An explicit `pipeline` bypasses the chain and must support the requested source, representation, and execution mode. Execution defaults to sync; async requires `idempotency_key` and applies to built-in `direct.local` and async-only `browser.render`, as reported by `capabilities.fetch.pipelines[].execution_modes`. Fetch `get`, `read`, and `cancel` use the resulting `job_id` and the same immutable-artifact protocol as search jobs.

File and inline sources can use only `egress: "none"` pipelines. File paths remain within configured read-only scopes, including lexical and realpath checks against symlink escape; capabilities expose scope IDs, not host roots. Chain fallback continues after non-404/410 HTTP failures, provider/auth/rate-limit or transport failures, byte-limit failures, and quality-gate failures; it stops for `FETCH_BLOCKED`, HTTP 404/410, `FETCH_CONTENT_TYPE_REJECTED`, cancellation, deadline, or budget exhaustion. `direct.fetch` uses Node built-ins and performs no browser or JavaScript rendering. It:

- rejects credentialed URLs and non-public targets, including loopback, private, link-local, metadata, multicast, reserved, unspecified, CGNAT, and IPv4-mapped IPv6 addresses;
- connects to a validated resolved address while preserving the original HTTP Host and TLS SNI;
- validates every redirect hop;
- bounds redirects, response bytes, and content characters;
- accepts a text MIME allowlist;
- converts HTML to deterministic visible text.

Production `direct.fetch` connects only to the public address that passed validation. Test-only DNS/request seams are internal and are not package exports.

## Host registrations

Configuration does not load code. A host may register query or fetch operations through `provider_registrations`. Custom query operations are sync-only in this version, even if their descriptor requests built-in async execution.

```ts
import { createNbSearchRuntime, type ProviderRegistration } from '@nb-corp/nb-search';

const registration: ProviderRegistration = {
  descriptor: {
    provider_id: 'host-query',
    adapter_version: 'host-1',
    query_operations: [{
      operation_id: 'lookup',
      output: { channel: 'results', schema_id: 'nb-search.results@1' },
      built_in_async: false
    }],
    fetch_operations: [],
    activation: { credential: 'none', endpoint: 'none' },
    option_keys: []
  },
  create() {
    return {
      query: {
        lookup: {
          name: 'host-query',
          async execute(request) {
            return {
              channel: 'results',
              value: { results: await hostLookup(request.query, request.signal) }
            };
          }
        }
      },
      fetch: {}
    };
  }
};

const runtime = createNbSearchRuntime({ provider_registrations: [registration] });
```

### Trusted host HTTP transport

In-process hosts can supply an audited `http_transport` object implementing `HttpTransport.send` (`HttpRequest`, `HttpResponse`, `HttpTransport`, and `ResponseLimitError` are exported from the package root). The injected transport handles provider adapter HTTP calls (such as Exa or Grok Multi-Agent) through its own boundaries, redirect rules, and byte limits. Direct HTTP, wayback acquisition, browser render, and custom provider IO may use independent paths. Public transport injection disables detached async execution on that instance (omitting effective async modes and rejecting async run requests with `LANE_EXECUTION_UNSUPPORTED`), while sync operations and local get/read/cancel semantics remain intact. See `docs/model-facing-lane-runtime.md` for the contract specification.

## Remote SDK

```ts
import { createNbSearchRemoteClient, NbSearchRemoteError } from '@nb-corp/nb-search';

const remote = createNbSearchRemoteClient({
  base_url: 'https://your-search-service.example/',
  access_key: process.env.NB_SEARCH_SERVICE_TOKEN!
});
const catalog = await remote.capabilities();
const result = await remote.search({ action: 'run', query: 'public research', lane: 'exa.search' });
```

This is a callable HTTP client, not a hosted service. HTTP protocol 1 is independent of result schema 3.0. The client validates input/output, bounds streaming responses, honors AbortSignal/deadlines, rejects redirects, and never automatically retries or falls back to local execution. HTTP 200 business failures resolve as envelopes; authentication/rate-limit/transport/protocol failures reject with `NbSearchRemoteError`. Remote v1 fetch accepts URLs only, rejecting local file/inline input before IO. Service-side identity, job ACL, billing, and deployment remain service responsibilities; see `docs/remote-protocol.md`.

## CLI and MCP

From a built checkout or package, no global installation or PATH command is required:

```sh
node scripts/nb-search.mjs --version
node scripts/nb-search.mjs capabilities
node scripts/nb-search.mjs search "query" --lane exa.search
node scripts/nb-search.mjs search "brief" --lane gma.research --execution async --idempotency-key run-1 --wait 240000
node scripts/nb-search.mjs search get <job_id>
node scripts/nb-search.mjs search read <job_id> --all
node scripts/nb-search.mjs search read <job_id> --page-size 8
node scripts/nb-search.mjs search cancel <job_id>
node scripts/nb-search.mjs fetch "https://example.com" --pipeline direct.fetch --representation markdown
```

An installed `nb-search` bin accepts the same arguments. In an npm consumer project, use `node node_modules/@nb-corp/nb-search/scripts/nb-search.mjs` or `npx nb-search`; in a source checkout, use `node scripts/nb-search.mjs`. The official skill mounts the entire package root via `node "<skill_dir>/scripts/nb-search.mjs"`; root and nested skill entrypoints ship with the package and require the built package structure. Global `--profile NAME` precedes the business command; omitted profile is local. Full `--stdin` JSON supports Unicode/option-like queries and local inline/file fetch. Local follow-up job actions default to local; remote actions require an explicit profile. `read --all` verifies and decodes the entire artifact to JSON; raw read keeps its original page envelope. Waiting is bounded and never cancels a job.

CLI results are JSON on stdout; diagnostics use stderr. Exit codes are **0 succeeded, 2 failed, 3 partial, 4 empty, 5 timeout, 6 cancelled, 7 pending**. Cancel acknowledgement returns 0 without claiming completed cancellation. These replace the old CLI behavior that often returned 0 for empty, partial, or unfinished work.

CLI-only protected secret files populate a private env copy for runtime and worker; existing process env entries win, including empty values. The SDK/MCP do not implicitly load these files. Migration is explicit, offline, conflict-preserving, and does not modify the legacy source:

```sh
node scripts/nb-search.mjs --import-search-layer --dry-run
node scripts/nb-search.mjs --import-search-layer --apply
node scripts/nb-search.mjs --doctor
```

Apply is a separate operator choice after inspecting dry-run. Old Grok Chat Completions does not prove Responses compatibility and stays disabled. GMA explicitly supports chat_completions or messages relay mode through provider options.api_mode; valid known modes are compatible-but-unverified, while unknown modes and endpoint suffix conflicts remain disabled. This adds no automatic protocol switching or generic native Anthropic guarantee. GMA adapter version 2 requires existing version-1 in-flight jobs to finish before upgrade. A partial migration is not full legacy parity or live provider verification.

Ordinary local readers do not take a persistent global lock: concurrent reads, searches, and fetches proceed without blocking one another. Readers capture a consistent configuration and credential snapshot, while writers take a coordinated transaction marker during publication. An interrupted or failed write leaves the configuration safely blocked until a valid pair is restored. Detailed profiles, stdin, limits, migration/ACL recovery, and output examples are in `docs/cli.md`.

The stdio MCP server still exposes exactly `search`, `fetch`, and `capabilities`. MCP requires explicit action fields; CLI shorthands normalize an unqualified query/URL to run. The SDK also accepts `{ url }` as the narrow fetch-run convenience form. See `SKILL.md` for the model-use protocol and `docs/model-facing-lane-runtime.md` for the local runtime contract.
