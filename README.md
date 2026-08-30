# nb-search

`nb-search` provides synchronous web search and durable, asynchronous research evidence jobs. It can run as a direct command-line application, a generic stdio MCP server, or an in-process TypeScript runtime.

## Requirements

- Node.js 24.15.0 or newer
- pnpm 10.33.0 when building from source
- At least one configured retrieval route: direct Exa/Tavily, an aggregate gateway, or relay-backed Exa/Tavily

Install the published package:

```sh
npm install --global @nb-corp/nb-search
```

Install dependencies and build:

```sh
pnpm install
pnpm build
```

## Configuration

Configuration is resolved once in this order, from lowest to highest precedence:

1. built-in defaults;
2. the first existing legacy search-layer JSON file;
3. canonical nb-search JSON;
4. environment variables;
5. in-process host configuration;
6. in-process runtime overrides.

Set `NB_SEARCH_CONFIG` to select the canonical JSON file. Without it, nb-search reads `$NB_SEARCH_HOME/config.json` when that file exists. Legacy lookup checks `SEARCH_LAYER_CREDENTIALS`, `~/.openclaw/credentials/search.json`, and then `./credentials/search.json`, stopping at the first existing file. A malformed legacy file is ignored and reported by `capabilities`; malformed canonical, host, or override configuration stops startup with `CONFIGURATION_ERROR`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `NB_SEARCH_EXA_API_KEY` | Exa API key | Falls back to `EXA_API_KEY` |
| `NB_SEARCH_TAVILY_API_KEY` | Tavily API key | Falls back to `TAVILY_API_KEY` |
| `NB_SEARCH_EXA_BASE_URL` | Exa endpoint base | Falls back to `EXA_API_BASE`, then `EXA_API_URL` |
| `NB_SEARCH_TAVILY_BASE_URL` | Tavily endpoint base | Falls back to `TAVILY_API_BASE`, then `TAVILY_API_URL` |
| `NB_SEARCH_EXA_TIMEOUT_MS` | Per-attempt Exa timeout | Resolved instance policy |
| `NB_SEARCH_TAVILY_TIMEOUT_MS` | Per-attempt Tavily timeout | Resolved instance policy |
| `NB_SEARCH_GATEWAY_BASE_URL` | Aggregate gateway base URL | No endpoint; aggregate remains inactive |
| `NB_SEARCH_GATEWAY_TOKEN` | Aggregate or explicit relay downstream token | No token |
| `NB_SEARCH_GATEWAY_AGGREGATE` | Replace compatibility-owned profiles with aggregate retrieval | `false` |
| `NB_SEARCH_GATEWAY_PROFILE` | Downstream aggregate profile name | Derived from intent and selected profile |
| `NB_SEARCH_GATEWAY_TIMEOUT_MS` | Per-attempt aggregate timeout | `40000` |
| `NB_SEARCH_RETRY_MAX_ATTEMPTS` | Provider attempt count | Resolved instance policy |
| `NB_SEARCH_RETRY_BACKOFF_MS` | Initial retry backoff | Resolved instance policy |
| `NB_SEARCH_RETRY_MAX_BACKOFF_MS` | Maximum exponential retry backoff | Resolved instance policy |
| `NB_SEARCH_CONFIG` | Canonical nb-search JSON file | `$NB_SEARCH_HOME/config.json` |
| `NB_SEARCH_HOME` | Trusted local state directory | `~/.nb-search` |
| `NB_SEARCH_JOBS_ROOT` | Durable job directory | `$NB_SEARCH_HOME/jobs` |
| `NB_SEARCH_RETENTION_HOURS` | Age at which terminal jobs become eligible for pruning | `72` |
| `NB_SEARCH_LOG_LEVEL` | `error`, `warn`, `info`, or `debug` logs on stderr | `warn` |

The canonical file can define provider instances, credential slots, and deterministic routing profiles. Built-in retrieval adapters cover Exa, Tavily, and the aggregate search gateway. Credential slots name environment variables; they do not contain API-key values.

```json
{
  "schema_version": "1",
  "provider_instances": {
    "exa.default": {
      "base_url": "https://api.exa.ai/search",
      "timeout_ms": 20000
    }
  },
  "credential_slots": {
    "exa.default": {
      "provider_id": "exa",
      "env": "NB_SEARCH_EXA_API_KEY"
    }
  }
}
```

Provider instances merge by instance ID. Ordinary nested objects merge recursively, arrays replace, each credential slot and profile replaces atomically, and `null` removes a lower-precedence entry. Setting `enabled` to `false` keeps an instance disabled even when its credential is available.

Set `NB_SEARCH_GATEWAY_AGGREGATE=true`, `NB_SEARCH_GATEWAY_BASE_URL`, and `NB_SEARCH_GATEWAY_TOKEN` to move compatibility-owned `default`, `fast`, and `deep` profiles to one `search-gateway.aggregate` invocation. If the flag is enabled while the endpoint or token is missing, direct compatibility routes remain selected and `capabilities` reports `GATEWAY_AGGREGATE_INCOMPLETE`.

Once active, an aggregate error, timeout, cancellation, or empty response stays on the aggregate route; it does not fall back to direct Exa or Tavily.

Exa and Tavily can also use a vendor-compatible relay. Define explicit provider instances with `options.search_path` and provider-bound credential slots. Exa keeps `x-api-key` authentication, Tavily keeps body `api_key`, and both slots may name the same downstream token environment variable.

```json
{
  "provider_instances": {
    "exa.gateway": {
      "provider_id": "exa",
      "enabled": true,
      "credential_slot_id": "exa.gateway",
      "base_url": "https://gateway.example",
      "timeout_ms": 40000,
      "retry": { "max_attempts": 2, "backoff_ms": 100, "max_backoff_ms": 2000 },
      "options": { "search_path": "/exa/search" }
    }
  },
  "credential_slots": {
    "exa.gateway": { "provider_id": "exa", "env": "NB_SEARCH_GATEWAY_TOKEN" }
  }
}
```

`search_path` must be an absolute operation path without query text, fragments, traversal segments, empty segments, backslashes, or a trailing slash. Unknown instance options stop configuration before a request is sent.

Legacy Exa and Tavily entries accept a key string or an object with `apiKey`. Provider objects accept `apiUrl`, `baseUrl`, or `apiBase`. Top-level `exaApiUrl|exaApiBase|exaBaseUrl` and `tavilyApiUrl|tavilyApiBase|tavilyBaseUrl` aliases override nested endpoints in that order. A legacy `searchGateway` object maps its base, token, aggregate flag, and downstream profile to `search-gateway.aggregate`; `token` wins over `apiKey`, and `baseUrl` wins over `apiUrl` and `apiBase`. A legacy `searchLayer` object maps `requestTimeoutSeconds`, provider timeouts, and `retry.maxAttempts|backoffMs` into instance policies. Numeric strings remain accepted for compatibility. Invalid optional legacy file values produce a safe diagnostic and use inherited values. Invalid `NB_SEARCH_*`, canonical, host, and runtime values stop configuration.

Legacy gateway aliases remain available: `SEARCH_GATEWAY_BASE_URL`, `SEARCH_GATEWAY_TOKEN`, `SEARCH_GATEWAY_AGGREGATE`, `SEARCH_GATEWAY_PROFILE`, and `SEARCH_LAYER_SEARCH_GATEWAY_TIMEOUT_SECONDS`. Direct-provider timeout aliases remain `SEARCH_LAYER_REQUEST_TIMEOUT_SECONDS`, `SEARCH_LAYER_EXA_TIMEOUT_SECONDS`, and `SEARCH_LAYER_TAVILY_TIMEOUT_SECONDS`. Provider attempts use the smaller applicable provider/request budget. The synchronous request timeout and research deadline remain the outer bound for every attempt and retry sleep.

Queries, keys, configured endpoints, response bodies, and absolute artifact paths are omitted from logs. `capabilities` reports provider instances, profile readiness, and safe configuration diagnostics without making a network request.

## CLI

Run a one-step search or use the explicit command:

```sh
nb-search "query"
nb-search search "query" --max-results 8 --timeout-ms 20000
nb-search search "query" --profile fast --intent status --freshness pd
```

Search accepts 1–20 results and a 1,000–45,000 ms total budget. A provider failure preserves useful results from other providers and marks the result `partial`.

Routing fields are optional. With the aggregate cutover inactive, `default` and `deep` run configured Exa and Tavily retrieval in parallel, while `fast` uses direct fallback order. With the cutover active, each compatibility profile contains one aggregate invocation.

Supported intents are `factual`, `status`, `comparison`, `tutorial`, `exploratory`, `news`, and `resource`. `status` and `news` select Exa fast search; `exploratory` with `deep` selects Exa deep search. Freshness values `pd`, `pw`, `pm`, and `py` apply 1, 7, 30, or 365 days to Exa and Tavily requests. Tavily retrieval always sends `include_answer:false`.

Aggregate upstream attempts and source attribution are returned as bounded nested evidence; outer retry, state, ordering, health, and deduplication remain controlled by nb-search.

Start and manage research jobs:

```sh
nb-search research start "query" --max-sources 30 --max-duration-ms 900000 --idempotency-key my-run --profile deep --intent exploratory --freshness pm
nb-search research status <job_id>
nb-search research read <job_id> --artifact report --page-size 10
nb-search research list --states queued,running --limit 20
nb-search research cancel <job_id>
nb-search capabilities
```

`research start` returns a receipt without waiting for completion. Jobs use lowercase UUID v4 identifiers and live under `$NB_SEARCH_HOME/jobs` unless `NB_SEARCH_JOBS_ROOT` changes that location. New jobs save an `execution.json` snapshot beside `job.json`; detached workers replay its profile, intent, freshness, plan, provider instances, invocation policies, and safe credential-grant identities. API-key bytes are excluded from the snapshot.

Reusing an idempotency key requires the same normalized request and complete execution snapshot fingerprint. Route, grant identity, plan, policy, or selected provider descriptor drift returns `JOB_CONFLICT`; changing only secret bytes under the same grant identity does not change the snapshot fingerprint.

Research output is a bounded deterministic evidence report. It does not claim autonomous synthesis or semantic verification. `research read` labels artifacts as `checkpoint`, `final`, or `unavailable`; callers should not treat a checkpoint as a completed report.

Research collection uses successive search operations of at most 20 results and 45 seconds each, with deterministic evidence-focus suffixes after the first batch to broaden source discovery. The runner checkpoints after every operation, deduplicates sources across operations, and stops when it reaches `max_sources`, exhausts `max_duration_ms`, or observes durable cancellation. This lets a job collect up to 100 sources without changing the synchronous search limits.

## Generic MCP

Start the JSON-RPC-only stdio server:

```sh
nb-search-mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "nb-search": {
      "command": "node",
      "args": ["/absolute/path/to/nb-search/dist/mcp.mjs"],
      "env": {
        "NB_SEARCH_HOME": "/absolute/path/to/nb-search-state",
        "NB_SEARCH_EXA_API_KEY": "${EXA_API_KEY}"
      }
    }
  }
}
```

The server exposes `search`, `research_start`, `research_status`, `research_read`, `research_list`, `research_cancel`, and `capabilities`. MCP results contain the same envelope in JSON text and `structuredContent`. Logs use stderr; stdout is reserved for JSON-RPC.

## In-Process Runtime

```ts
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = createNbSearchRuntime({
  env: process.env,
  config: {
    provider_instances: {
      'exa.default': { timeout_ms: 15000 },
    },
  },
  overrides: {},
});
const result = await runtime.search(
  { query: 'query', max_results: 8 },
  { requestId: 'host-request-id', signal: abortSignal },
);
```

The package exports `NbSearchRuntime`, `OperationContext`, `createNbSearchRuntime`, canonical configuration types, static provider-registration types, planner/snapshot contracts, all seven strict input schemas, and their native envelope types. `provider_registrations` accepts explicit code registrations; configuration files are data-only and never load provider modules. The runtime has no host-framework dependency.

## Job Lifecycle And Recovery

Job transitions are `queued → running/cancelled/failed`, `running → succeeded/partial/failed/timed_out/cancelling`, and `cancelling → cancelled`. Terminal states do not reopen. Cancellation writes a durable marker that a worker observes even if the original caller disconnects.

Workers heartbeat every five seconds. Status and read operations reconcile an active job whose lease is older than 30 seconds to `WORKER_LOST`, or to `cancelled` when a cancellation marker exists. Retry a failed job with a new idempotency key after correcting provider or local filesystem configuration.

Jobs use local-user ownership through `NB_SEARCH_HOME`. Active work is not guaranteed to survive application shutdown or machine restart. There is no daemon, remote namespace, or multi-user authorization layer in version 0.1.0.

## Output Limits

- synchronous search envelope: 32 KiB
- status, list, and capabilities envelopes: 16 KiB
- each research artifact page: 24 KiB

Search compaction shortens snippets, bounds nested upstream messages and lists with explicit omission counts, and then omits the lowest-ranked results. Research-page compaction preserves typed outer attempts and source provenance, including bounded upstream attribution, before lower-priority metadata. It reports truncated item and omitted-byte counts in `compaction`. A `next_cursor` continues from the next complete artifact item.
