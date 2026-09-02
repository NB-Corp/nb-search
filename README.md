# nb-search

`@nb-corp/nb-search` is a deterministic query-lane runtime with three public capabilities: `search`, `fetch`, and `capabilities`.

The caller selects lanes. The runtime does not inspect a query to choose an engine, replace an unavailable lane, or run an unselected fallback. Selecting `execution: "async"` changes delivery only; it does not change the lane or query plan.

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

Configuration uses schema v3 and resolves in this order:

1. built-in structure;
2. `$NB_SEARCH_HOME/config.json`, or `NB_SEARCH_CONFIG`;
3. canonical `NB_SEARCH_*` environment values;
4. in-process `config`;
5. in-process `overrides`.

```json
{
  "schema_version": "3",
  "defaults": {
    "search_lane": "exa.search",
    "fetch_lane": "direct.fetch"
  },
  "presets": {
    "cross-check": {
      "lanes": ["exa.search", "tavily.search"]
    }
  }
}
```

Built-in lane IDs are `exa.search`, `exa.synthesis`, `tavily.search`, `tavily.synthesis`, `grok.search`, `gma.research`, `gateway.search`, and `direct.fetch`. A default is optional; a call without a selector fails when its default is absent.

Canonical provider environment values include `NB_SEARCH_EXA_API_KEY`, `NB_SEARCH_TAVILY_API_KEY`, `NB_SEARCH_GROK_API_KEY`, `NB_SEARCH_GROK_BASE_URL`, `NB_SEARCH_GATEWAY_TOKEN`, `NB_SEARCH_GATEWAY_BASE_URL`, `NB_SEARCH_GROK_MULTI_AGENT_API_KEY`, and `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL`. Runtime paths and retention use `NB_SEARCH_HOME`, `NB_SEARCH_CONFIG`, `NB_SEARCH_JOBS_ROOT`, `NB_SEARCH_RETENTION_HOURS`, and `NB_SEARCH_LOG_LEVEL`.

A lane binds `provider_instance_id` to `operation_id`. Its registration declares either a results output or a typed JSON output with a `schema_id`. Presets contain results lanes only; typed operations use one lane.

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
  url: 'https://example.com/spec',
  lane: 'direct.fetch'
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

`fetch` accepts one HTTP(S) URL and one lane. `direct.fetch` uses Node built-ins and performs no browser or JavaScript rendering. It:

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
      }
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
nb-search fetch "https://example.com" --lane direct.fetch
nb-search capabilities
```

CLI results are JSON on stdout. The stdio MCP server exposes exactly three tools: `search`, `fetch`, and `capabilities`. MCP and SDK require an explicit `search.action`; the CLI shorthand normalizes an unqualified search query to `action: "run"`.

See `SKILL.md` for the model-use protocol and `docs/model-facing-lane-runtime.md` for the implementation contract summary.
