# Web & Regional Search

Web-search lanes focus on returning normalized web links, page summaries, and relevance ranking. The standard Results channel is `nb-search.results@1`; direct Zhihu synthesis through `zhihu.synthesis` returns `nb-search.synthesis@1`.

## Keyless default search source

### DuckDuckGo (`duckduckgo.search`)
- **Operation contract**: `duckduckgo/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Default behavior**: In version `0.5.0` and later, this is the built-in default search source (`defaults.search_lane = "duckduckgo.search"`). You can search the general web without registering an account, configuring an API key, or passing `--lane` manually.
- **Errors and rate limits**: Public HTML search endpoints may trigger a CAPTCHA or `429` rate limiting (the `Retry-After` metadata is retained). The runtime returns challenge pages and unrecognized pages as explicit errors, never disguises them as empty results (`empty`), and never silently switches to a paid search source.
- **Metadata labels**: Cost `free`; latency `medium`.

## BYOK general and regional search sources

### 1. Tavily Search (`tavily.search`)
- **Operation contract**: `tavily/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_TAVILY_API_KEY` (supports comma-separated rotation of up to 32 keys; the local SDK exposes `keyUsage()` for periodic usage inspection)
- **Optional configuration**: `NB_SEARCH_TAVILY_BASE_URL` (retains the URL prefix and appends `/search`)
- **Metadata labels**: Cost `cheap`; latency `fast`.
- **Advanced lanes from the same source**: The same instance also provides `tavily.synthesis` (`nb-search.synthesis@1`), `tavily.crawl` (`nb-search.crawl@1`, default timeout 180s), and `tavily.research` (`nb-search.research@1`, default timeout 900s).

### 2. Exa Search (`exa.search`)
- **Operation contract**: `exa/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_EXA_API_KEY`
- **Optional configuration**: `NB_SEARCH_EXA_BASE_URL` (appends `/search` to the endpoint)
- **Metadata labels**: Cost `cheap`; latency `fast`.

### 3. Brave Search (`brave.search`)
- **Operation contract**: `brave/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_BRAVE_API_KEY`
- **Optional configuration**: `NB_SEARCH_BRAVE_BASE_URL` (appends `/res/v1/web/search` to the endpoint)
- **Metadata labels**: Cost `cheap`; latency `fast`.

### 4. Firecrawl Search (`firecrawl.search`)
- **Operation contract**: `firecrawl/search`; outputs `nb-search.results@1` with page-content excerpts; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_FIRECRAWL_API_KEY` (the local SDK exposes `keyUsage()` to inspect remaining team credits)
- **Optional configuration**: `NB_SEARCH_FIRECRAWL_BASE_URL` (retains the URL prefix and appends `/v2/search`)
- **Metadata labels**: Cost `cheap`; latency `fast`.

### 5. SearXNG (`searxng.search`)
- **Operation contract**: `searxng/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_SEARXNG_BASE_URL` (self-hosted or private aggregated instance; no API key; appends `/search` to the endpoint)
- **Metadata labels**: Cost `free`; latency `medium`.

### 6. Zhipu Search (`zhipu.search`)
- **Operation contract**: `zhipu/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_ZHIPU_API_KEY`
- **Optional configuration**: `NB_SEARCH_ZHIPU_BASE_URL` (appends `/paas/v4/web_search` to the endpoint)
- **Metadata labels**: Cost `cheap`; latency `fast`.

### 7. Parallel Search (`parallel.search`)
- **Operation contract**: `parallel/search`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Required configuration**: `NB_SEARCH_PARALLEL_API_KEY`
- **Endpoint**: Always calls `https://api.parallel.ai/v1/search`
- **Metadata labels**: Cost `cheap`; latency `fast`.

## Opt-in Zhihu source {#zhihu}

The built-in `zhihu` adapter (`provider_id: "zhihu"`) is opt-in. The default configuration does not inject a `provider_instance`, `credential_slot`, or `lane`. To use it, declare all three in a Schema v4 `config.json` (the `latency` and `cost` values below are orchestration metadata labels, not request quota limits):

```json
{
  "schema_version": "4",
  "provider_instances": {
    "zhihu.manual": {
      "provider_id": "zhihu",
      "enabled": true,
      "credential_slot_id": "zhihu.manual",
      "base_url": "https://developer.zhihu.com",
      "options": {
        "allow_paid": false,
        "search_db": "all",
        "zhida_model": "zhida-fast-1p5",
        "search_path": "/api/v1/content/zhihu_search",
        "global_search_path": "/api/v1/content/global_search",
        "synthesis_path": "/v1/chat/completions",
        "quota_path": "/api/v1/quota"
      }
    }
  },
  "credential_slots": {
    "zhihu.manual": {
      "provider_id": "zhihu",
      "env": "NB_SEARCH_ZHIHU_API_KEY"
    }
  },
  "lanes": {
    "zhihu.search": {
      "provider_instance_id": "zhihu.manual",
      "operation_id": "search",
      "latency": "fast",
      "cost": "cheap"
    },
    "zhihu.global": {
      "provider_instance_id": "zhihu.manual",
      "operation_id": "global",
      "latency": "fast",
      "cost": "cheap"
    },
    "zhihu.synthesis": {
      "provider_instance_id": "zhihu.manual",
      "operation_id": "synthesis",
      "latency": "medium",
      "cost": "cheap"
    }
  }
}
```

Set `NB_SEARCH_ZHIHU_API_KEY="YOUR_API_KEY"`, then select the required lane explicitly:

```bash
nb-search search "人工智能架构演进" --lane zhihu.search
nb-search search "人工智能架构演进" --lane zhihu.global
nb-search search "比较近期端侧模型推理框架的工程取舍" --lane zhihu.synthesis
```

### Operation contracts and path parameters

- **`zhihu.search`**: Calls `GET /api/v1/content/zhihu_search` and outputs `nb-search.results@1`. After trimming leading and trailing whitespace, the query must be **2–100 characters** long. The requested count is clamped to **1–10**. The summary prefix retains labels for content type, author, authority level, upvotes, and comments.
- **`zhihu.global`**: Calls `GET /api/v1/content/global_search` and outputs `nb-search.results@1`; the requested count is clamped to **1–20**. `options.search_db` defaults to `"all"` and also accepts `"realtime"` or `"static"`.
- **`zhihu.synthesis`**: Calls `POST /v1/chat/completions` and outputs a single `typed` channel with schema `nb-search.synthesis@1`; it cannot be mixed with the `results` channel in `--lanes`. `options.zhida_model` defaults to `"zhida-fast-1p5"` and also accepts `"zhida-thinking-1p5"`, `"zhida-agent"`, or any other non-empty custom model name.
- **URL prefix and path overrides**: All three lanes support `sync` and `async`. `base_url` defaults to `https://developer.zhihu.com`; endpoint paths are joined according to URL-prefix semantics for `search_path`, `global_search_path`, `synthesis_path`, and `quota_path`. Reverse-proxy prefixes are preserved, such as `https://relay.example.test/zhihu`.

### Free-quota gate (`allow_paid`) and `keyUsage()` metrics

- **Block over-quota billing by default (`allow_paid: false`)**: Before dispatching a request, the runtime verifies free quota through `GET /api/v1/quota`. If free quota is exhausted or verification cannot complete, it rejects the request directly (fail-closed). Instances that point to the same quota endpoint and credentials share a reservation ledger within one runtime. If a request is interrupted and its result is undecided, the reservation remains until upstream `TotalUsed` advances or the daily quota resets at `00:00` Beijing time (`Asia/Shanghai`, `UTC+8`). A quota snapshot is cached for at most 60 seconds only when more than 32 requests remain. Set `"allow_paid": true` explicitly only when wallet billing is intentionally allowed.
- **Local SDK `keyUsage()` metric**: `runtime.keyUsage()` also reads `GET /api/v1/quota` and returns per-API request counters in `KeyUsage.usage.meters`. For the compatible credits summary, it prefers `zhihu_search` and falls back to the first meter when absent. The key is marked `exhausted` only when both `zhihu_search` and `global_search` have zero remaining quota.

## Multi-source RRF queries

All web-search sources that output `nb-search.results@1`, including enabled `zhihu.search` and `zhihu.global`, can run in parallel through comma-separated `--lanes`, repeated `--lane` options, or configured presets:

::: code-group

```bash [Comma-separated form]
nb-search search "web standard fetch streaming spec" \
  --lanes exa.search,tavily.search,brave.search
```

```bash [Repeated-option form]
nb-search search "web standard fetch streaming spec" \
  --lane exa.search --lane tavily.search
```

:::

During aggregation, the runtime canonicalizes and deduplicates URLs, then calculates global rankings with Reciprocal Rank Fusion (RRF), while retaining each source's `evidence_groups` and `provenance`.
