---
lang: en-US
title: nb-search — Unified Web Search, URL-to-Markdown & Research for AI Agents
description: Unified web search, URL-to-Markdown extraction, RRF multi-source fusion, 32-key failover, and async deep research via 3-tool MCP (~1.4k tokens), Agent Skill (~110 idle tokens), CLI, and TypeScript SDK.
sidebar: false
outline: [2, 3]
---

# nb-search

**Unified web search, URL-to-Markdown extraction, RRF multi-source fusion, and async deep research (`@nb-corp/nb-search`)—shipped as a TypeScript SDK, CLI, 3-tool MCP server, and Agent Skill.**

Stacking separate MCP servers for Exa, Tavily, Firecrawl, Context7, and Playwright consumes **15k–35k context tokens** before your first prompt, duplicates API keys across editors, and fails on single-key `429` limits or 60-second `stdio` timeouts. `@nb-corp/nb-search` consolidates your entire retrieval layer into **one 3-tool MCP server (~1.4k tokens)** or **one Agent Skill (~110 idle tokens)**, backed by the same local TypeScript runtime or your self-hosted [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud) gateway.

- **Context economy**: Expose only `search`, `fetch`, and `capabilities` (~1.4k MCP schema tokens) or mount `skills/nb-search` (~110 idle tokens).
- **Zero-key start + BYOK**: Run keyless DuckDuckGo web search, GitHub repo discovery, Context7 library docs, Defuddle URL extraction, Jina Reader, and Wayback snapshots out of the box—then add BYOK keys as needed.
- **RRF multi-source fusion**: Query multiple search engines in parallel, canonicalize URLs, deduplicate hits, and rank with Reciprocal Rank Fusion and per-source provenance.
- **32-key rotation & failover**: Pass comma-separated key pools per provider with automatic `429` `Retry-After` cooldowns, `402` exhaustion skipping, and `401`/`403` quarantine.
- **Direct-first URL credit protection**: Static HTML, GitHub raw/API responses, npm metadata, and PyPI JSON resolve locally via Defuddle (`direct.fetch`) first—catching Cloudflare/challenge walls explicitly instead of wasting paid scrape credits.
- **Detached async jobs (>60s safe)**: Run 10–15 minute deep research (`tavily.research`, `gma.research`), site crawls (`tavily.crawl`), and Playwright renders (`browser.render`) via `run`/`get`/`read`/`cancel` without hitting MCP `stdio` timeouts.

---

## Zero-Key Quick Start (CLI)

Requires **Node.js >= 24.15**. Install from npm and run three zero-key commands immediately:

```bash
npm install -g @nb-corp/nb-search

nb-search search "WebAssembly component model"
nb-search search "react useOptimistic" --lane context7.docs
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

Sample `3.0` JSON envelope returned on `stdout`:

```json
{
  "schema_version": "3.0",
  "action": "run",
  "execution": "sync",
  "status": "succeeded",
  "documents": [
    {
      "url": "https://nodejs.org/en/about/releases/",
      "source_lane": "direct.fetch",
      "content": "# Node.js Releases\n..."
    }
  ]
}
```

Public DuckDuckGo HTML challenges or rate limits fail explicitly rather than returning fake empty results, and errors never silently switch to paid providers. Add provider keys to unlock multi-engine RRF fusion and detached async research:

```bash
export NB_SEARCH_EXA_API_KEY="YOUR_API_KEY"
export NB_SEARCH_TAVILY_API_KEY="YOUR_API_KEY"

nb-search search "PostgreSQL logical replication latency" --lanes exa.search,tavily.search --freshness py
nb-search search "2026 WebAssembly server runtime benchmarks" --lane tavily.research --execution async --idempotency-key wasm-2026
nb-search search get "<job_id>" --wait 240000
nb-search search read "<job_id>" --all
```

---

## MCP Server, Agent Skill & TypeScript SDK

### 1. MCP Server (`Claude Code` / `Codex` / `Claude Desktop` / `Cursor`)

Add `nb-search-mcp` to your `mcpServers` config (`env` is optional when using zero-key sources):

```json
{
  "mcpServers": {
    "nb-search": {
      "command": "npx",
      "args": ["-y", "--package=@nb-corp/nb-search", "nb-search-mcp"],
      "env": {
        "NB_SEARCH_TAVILY_API_KEY": "YOUR_API_KEY",
        "NB_SEARCH_EXA_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### 2. Agent Skill (~110 Idle Tokens)

For CLI-capable coding agents (`Claude Code`, `Codex`, `OpenCode`), install globally and point your skill loader at the packaged `skills/nb-search` directory:

```bash
npm install -g @nb-corp/nb-search
echo "$(npm root -g)/@nb-corp/nb-search/skills/nb-search"
```

### 3. TypeScript SDK

Install `@nb-corp/nb-search` in your project (`skipLibCheck: true` is recommended in `tsconfig.json`):

```typescript
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = createNbSearchRuntime();

const searchResult = await runtime.search({
  action: 'run',
  query: 'SQLite WAL concurrency'
});

const fetchResult = await runtime.fetch({
  action: 'run',
  source: {
    kind: 'url',
    url: 'https://nodejs.org/en/about/releases/'
  },
  pipeline: 'direct.fetch'
});

if (fetchResult.action === 'run' && fetchResult.execution === 'sync' && fetchResult.status === 'succeeded') {
  console.log(fetchResult.documents[0]?.content);
}

if (searchResult.action === 'run' && searchResult.execution === 'sync' && searchResult.status === 'succeeded') {
  console.log(searchResult.output);
}

const catalog = await runtime.capabilities();
const usage = await runtime.keyUsage();
console.log(catalog.schema_version, usage.length);
```

---

## Supported Sources

See the full [Sources Catalog](/sources/) for schemas, cost/latency labels, and endpoint details.

| Category | Providers | Lane / Pipeline IDs | Auth & Notes |
| --- | --- | --- | --- |
| **Zero-Key Out-of-the-Box** | DuckDuckGo (default), GitHub, Context7, Direct Fetch (Defuddle), Jina Reader, Wayback Machine | `duckduckgo.search`, `github.repositories`, `context7.docs`, `direct.fetch`, `jina.reader`, `wayback.fetch` | Keyless (optional token/key raises GitHub, Context7, or Jina rate limits) |
| **BYOK Web & Regional Search** | Exa, Tavily, Brave, Firecrawl, Parallel, Zhipu, SearXNG, [Zhihu (opt-in)](/sources/web-search#zhihu) | `exa.search`, `tavily.search`, `brave.search`, `firecrawl.search`, `parallel.search`, `zhipu.search`, `searxng.search`, `zhihu.search`, `zhihu.global` | Provider API key (`searxng.search` needs `base_url`; Zhihu requires schema-4 opt-in config) |
| **BYOK & Browser URL Reading** | Exa Contents, Tavily Extract, Firecrawl Scrape, OpenAI-Compatible Fetch, Playwright Render, Local File/Inline | `exa.contents`, `tavily.extract`, `firecrawl.scrape`, `oac.fetch`, `browser.render` (async), `direct.local` (no egress) | Provider API key (`browser.render` uses optional peer `playwright >= 1.50.0`) |
| **Synthesis, Crawl, Deep Research & Scripts** | Exa / Tavily / Grok / OAC / opt-in Zhihu Synthesis, Tavily Crawl, Tavily Research, Grok Multi-Agent Research, [Local Script](/sources/custom) | `exa.synthesis`, `tavily.synthesis`, `grok.synthesis`, `grok.x-synthesis`, `oac.synthesis`, `zhihu.synthesis`, `tavily.crawl`, `tavily.research`, `gma.research`, `.js`/`.ts` module | Single-lane typed output or trusted local `.js`/`.ts` results module |

Built-in ordered URL routing (`kiki-common-direct@1`) pins plain-text `raw.githubusercontent.com` files, `api.github.com` repository/README/release JSON, npm package metadata, and PyPI JSON strictly to `direct.fetch`—never appending paid fallbacks unless overridden in `fetch.routing.rules`.

---

## Multi-Key Rotation & Quota Inspection

Supply up to 32 distinct comma-separated keys in any credential variable (`NB_SEARCH_TAVILY_API_KEY="key-one,key-two"`). Scheduling defaults to `round-robin`, or fails over in strict order with `"key_strategy": "priority"`:

```json
{
  "schema_version": "4",
  "provider_instances": {
    "tavily.default": {
      "key_strategy": "priority",
      "balance_ttl_ms": 600000
    }
  }
}
```

Both strategies quarantine `401`/`403` keys for the runtime's lifetime, cool `429` keys using `Retry-After` (or 60s), skip `402` exhausted keys until TTL expiry or manual refresh, and retry `5xx`/network errors twice before rotating. Call `runtime.keyUsage({ provider_instance_id: 'tavily.default', refresh: true })` in the local SDK to inspect redacted key health and remaining quota across Tavily, Firecrawl, and opt-in Zhihu.

---

## Comparison Matrix

| Capability | Stacking 4–5 Vendor MCPs | Multi-Vendor BYOK Wrappers (`mcp-omnisearch`) | Keyless Scrapers (`open-webSearch`) | `@nb-corp/nb-search` |
| --- | --- | --- | --- | --- |
| **Context Overhead** | ~15k–35k tokens across 20+ tools | ~4k–8k tokens across per-vendor tools | ~1k–2k tokens | **~1.4k tokens (3-tool MCP) / ~110 tokens (Skill)** |
| **Zero-Key Start** | No (keys required per server) | No (API keys required upfront) | Yes (public HTML scraping only) | **Yes (DuckDuckGo, GitHub, Context7, Defuddle, Jina, Wayback) + BYOK** |
| **Multi-Engine RRF Fusion** | Manual prompt-level merging | Single provider per call | Multi-engine HTML without API provenance | **URL canonicalization + RRF + per-source provenance** |
| **Multi-Key `429` Failover** | None | Single key per provider | None (IP rate-limited) | **Up to 32 keys/provider, `Retry-After` cooldown & `402` skip** |
| **URL Credit Protection** | Every URL hits paid scraper | Direct vendor scrape call | Basic HTML fetch | **Defuddle Direct-first + ordered URL routing + challenge detection** |
| **>60s Async Research & Render** | Hits 60s MCP `stdio` timeout | Sync call timeouts on long tasks | Not supported | **Detached `run`/`get`/`read`/`cancel` jobs (up to 60 min)** |

---

## FAQ

### MCP server or Agent Skill—which should I choose?
Use the Agent Skill in CLI-capable coding agents (`Claude Code`, `Codex`, `OpenCode`) to keep idle context near ~110 tokens. Use `nb-search-mcp` in desktop or IDE hosts (`Claude Desktop`, `Cursor`) that expect MCP `stdio` tools.

### Does `nb-search` silently fall back to paid APIs when a free source fails?
Never. Search errors on `duckduckgo.search` or explicit lanes fail closed, and Direct-only URL routes (`raw.githubusercontent.com`, `api.github.com`, npm, PyPI) never append paid scrapers unless you configure a custom chain.

### When should I use `nb-extract` or `paper-search-cli` instead?
Use `nb-search` for web discovery, URL reading, RRF fusion, and deep research. Route local PDF/Office/OCR conversion and webpage media export to [nb-extract](https://github.com/NB-Corp/nb-extract), and DOI/arXiv/patent/citation graphs to `paper-search-cli`.

### How can a team share keys without distributing `.env` files?
Deploy [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud) and connect the same CLI (`--profile cloud`) or SDK (`createNbSearchRemoteClient()`) over [HTTP Protocol v1](/reference/remote-protocol).

---

## Reference & LLM Indexes

- **English Reference**: [CLI Reference](/reference/cli) · [Runtime & Host Architecture](/reference/runtime) · [Remote HTTP Protocol v1](/reference/remote-protocol) · [Changelog](/reference/changelog)
- **Full Guides (简体中文)**: [中文首页](/) · [快速开始](/guide/quickstart) · [配置与多密钥轮转](/guide/configuration) · [数据源目录](/sources/)
- **Machine-Readable Docs**: [llms.txt](/llms.txt) · [llms-full.txt](/llms-full.txt) · [GitHub Repository](https://github.com/NB-Corp/nb-search)
