# Grok, Multi-Agent, and Model Sources

For tasks that need more than a list of links—such as having a large model combine live retrieval with a structured report—`nb-search` provides dedicated typed search sources.

## Grok synthesis sources (`grok.synthesis` / `grok.x-synthesis`)

These two sources are built on xAI's **Grok Responses API** and output through `nb-search.synthesis@1`.
- Metadata labels: cost `expensive`; latency `slow`.
- `grok.synthesis`: enables the `web_search` tool for multi-step synthesis and reasoning over public information across the web.
- `grok.x-synthesis`: enables the `x_search` tool to search and summarize current discussions and context on X.

### Configuration requirements

- Required environment variable: `NB_SEARCH_GROK_API_KEY`
- Optional environment variables: `NB_SEARCH_GROK_BASE_URL` (the system resolves it and appends `/v1/responses`), `NB_SEARCH_GROK_MODEL`

::: warning Different from Chat Completions
The Grok Responses API has a separate endpoint and request format (using the `input` field and dedicated tool declarations), so it is not interchangeable with the traditional `/chat/completions` endpoint. The system never implicitly falls back from Grok Responses to the legacy chat interface.
:::

## GMA deep multi-agent research (`gma.research`)

`gma.research` is designed for research tasks that require multi-step reasoning and outputs through `nb-search.multi-agent-research@1`.
- Metadata labels: cost `expensive`; latency `slow`.

### Protocol modes and endpoint conventions

GMA selects its communication protocol through `options.api_mode` and supports two modes:
1. `chat_completions` (default): appends `/chat/completions` to the Base URL.
2. `messages`: appends `/messages` to the Base URL and follows a specific relay contract (POST `/messages`, a top-level `system` field, `x-api-key` and `anthropic-version` request headers, and `reasoning: { effort }` in the JSON request body).

Provider requests in both GMA modes use `stream: true`, so the gateway must support SSE. This streaming is part of the provider request contract; `execution: sync|async` still describes the local job lifecycle, and the two concepts are independent. The `public SDK` and CLI still return complete typed JSON and do not expose a token stream to users.

Configuration example:

```json
{
  "schema_version": "4",
  "provider_instances": {
    "grok-multi-agent.default": {
      "provider_id": "grok-multi-agent",
      "enabled": true,
      "base_url": "https://relay.example.test/v1",
      "options": {
        "api_mode": "messages",
        "reasoning_effort": "high"
      }
    }
  }
}
```

::: danger Do not mix endpoint suffixes or follow redirects
The Base URL suffix must match the selected mode exactly. For example, when the mode is `messages`, the Base URL must not already include `/chat/completions` or `/responses`, and vice versa. If an endpoint conflict is detected, the instance is marked unavailable and fails directly. In addition, both GMA modes reject HTTP 3xx redirects to prevent credential disclosure.
:::

### Required configuration

- `NB_SEARCH_GROK_API_KEY`: GMA reuses this credential slot by default.
- `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL`: the service entry point for the agent cluster.

### Parallel topics and execution deadlines

GMA calls run under the host's existing authorization and budget. Independent research topics can be processed in parallel in one `query` array or submitted as separate asynchronous jobs:

1. **Submit multiple topics**:
   - **Multiple queries in one job**: Provide several complete briefs in the `query` array of one request. The queries share that job's timeout, cancellation, and retry state.
   - **Independent async jobs**: Submit separate asynchronous tasks when each topic needs exact tracking, cancellation, or independent retry. Give each task its own stable `idempotency_key`. When a typed batch result is `partial`, it does not include an index mapping to the original `query` array, so topics cannot be associated by array position alone.
2. **Execution timeout mechanism**:
   - Timeout precedence is request-level `timeout_ms` > explicit `execution.search_timeout_ms` > the default. When neither of the first two is provided, `grok-multi-agent/research` uses 600000 ms (10 minutes) by default; ordinary search remains 30000 ms.
   - CLI `--wait` is only the local client's waiting budget. It does not change the server or provider execution deadline.
   - The local default maximum concurrency per job is 8 (`max_concurrency: 8`), and the planned call budget is capped at 64. Cloud execution applies corresponding bounded limits per job and tenant.

```json
{
  "action": "run",
  "query": [
    "Analyze cold-start optimization approaches for WebAssembly in server-side runtimes and compare mainstream approaches",
    "Survey the current state and typical challenges of eBPF-based cloud-native network observability in 2026"
  ],
  "lane": "gma.research",
  "execution": "async",
  "idempotency_key": "gma-research-batch-2026-09-08",
  "timeout_ms": 600000
}
```

## OpenAI-compatible synthesis source (`oac.synthesis`)

Use this source to connect any self-hosted model service or gateway that follows the OpenAI Chat Completions specification. It outputs through `nb-search.synthesis@1`.
- Metadata labels: cost `expensive`; latency `slow`.

### Configuration requirements

- Required environment variables:
  - `NB_SEARCH_OAC_API_KEY`: access key.
  - `NB_SEARCH_OAC_BASE_URL`: service endpoint (the system appends `/chat/completions`).
  - `NB_SEARCH_OAC_MODEL`: model name.
- Optional JSON configuration: `options.fallback_models` (a list of fallback models).

Configuration example:

```json
{
  "schema_version": "4",
  "provider_instances": {
    "openai-compatible.default": {
      "provider_id": "openai-compatible",
      "enabled": true,
      "base_url": "https://llm.example.test/v1",
      "options": {
        "model": "qwen-max",
        "fallback_models": ["qwen-plus"]
      }
    }
  }
}
```

::: tip Compatibility note
OAC provides a standard HTTP JSON adapter, but the exact response structure depends on how well the upstream model follows the prompt and JSON Schema. The runtime itself does not guarantee the semantic accuracy of a self-hosted upstream model.
:::
