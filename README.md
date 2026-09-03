# nb-search

`@nb-corp/nb-search` is a deterministic query-lane runtime with three public capabilities: `search`, `fetch`, and `capabilities`.

For `search`, the caller selects lanes and the runtime does not inspect a query to choose an engine, replace an unavailable lane, or run an unselected fallback. Selecting `execution: "async"` changes delivery only; it does not change the lane or query plan. For `fetch`, the caller supplies a URL, inline text, inline bytes, or a scoped file; omitting `pipeline` runs the matching configured chain, while an explicit `pipeline` bypasses it.

## Requirements

- Node.js 24.15.0 or newer
- pnpm 10.33.0 when building from source

```sh
pnpm install
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

All built-in search operations advertise both sync and async execution when configured and available.

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
| `browser.render` | URL | async | `none` | None; optional Playwright/Chromium installation |
| `oac.fetch` | URL | sync | `url` | `NB_SEARCH_OAC_API_KEY`; requires `NB_SEARCH_OAC_BASE_URL` and `NB_SEARCH_OAC_MODEL` |

The built-in URL chain is `direct.fetch` then `jina.reader`; inline and scoped-file sources use `direct.local`. `wayback.fetch`, `browser.render`, and `oac.fetch` require explicit pipeline selection and are not in the default chain. Both `markdown` and `text` representations are supported. Scoped-file input is disabled until the host configures at least one read-only file scope. See `.env.example` for the complete canonical environment-variable set.

## SDK

```ts
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = createNbSearchRuntime({ env: process.env });

const results = await runtime.search({
  action: 'run',
  query: ['Node.js ESM resolution', 'TypeScript bundler resolution'],
  preset: 'cross-check',
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
  pipeline: 'direct.fetch',
  representation: 'markdown'
});

const catalog = await runtime.capabilities();
```

`search` is an action union:

- `run` executes a query operation. Execution defaults to `sync`; `async` requires `idempotency_key`, while sync forbids that key.
- `get` reads job state and final artifact metadata.
- `read` reads bounded chunks from the one immutable JSON result artifact.
- `cancel` records a cancellation request; it does not claim that an upstream request stopped or avoided billing.

Results operations support one lane, ordered `lanes`, or a results-only `preset`. One query and one results lane preserve provider order. Multiple query/lane lists use per-list canonical deduplication, RRF, independent evidence groups, and stable tie-breaking. Typed operations require one lane and return schema-bound JSON. Oversized sync output returns `OUTPUT_TOO_LARGE`; it is not truncated or changed to async.

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

## CLI and MCP

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

CLI results are JSON on stdout. The stdio MCP server exposes exactly three tools: `search`, `fetch`, and `capabilities`. MCP requires explicit `search.action` and `fetch.action`; CLI shorthands normalize an unqualified query or URL to `action: "run"`. The SDK also accepts `{ url }` as the narrow fetch-run convenience form.

See `SKILL.md` for the model-use protocol and `docs/model-facing-lane-runtime.md` for the implementation contract summary.
