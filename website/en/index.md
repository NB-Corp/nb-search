---
layout: home
title: nb-search — Web Search, URL-to-Markdown & Deep Research
description: Unified search and URL reading for AI agents, with zero-key startup, RRF fusion, 32-key failover, and detached research jobs via MCP, Agent Skill, CLI, or SDK.

hero:
  name: nb-search
  text: Search, extract, research.
  tagline: Start keyless. Fuse sources with RRF. Run deep research through one retrieval layer.
  actions:
    - theme: brand
      text: Quick Start
      link: /en/guide/quickstart
    - theme: alt
      text: Sources Catalog
      link: /en/sources/

features:
  - title: Three tools, lean context
    details: MCP ~1.4k tokens. Agent Skill ~110 idle tokens.
  - title: Start without API keys
    details: DuckDuckGo, GitHub, Context7, Defuddle, Jina, Wayback.
  - title: RRF fusion, direct-first fetch
    details: Deduplicated results, source provenance, fewer paid fetches.
  - title: 32-key failover, async jobs
    details: Rotate keys. Run research beyond stdio timeouts.
---

## 30-Second Zero-Key Quick Start

Requires **Node.js >= 24.15**. Install the CLI and try web search, library docs, and URL-to-Markdown extraction:

```bash
npm install -g @nb-corp/nb-search

nb-search search "WebAssembly component model"
nb-search search "react useOptimistic" --lane context7.docs
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

For Claude Code, Codex, Claude Desktop, or Cursor, add this MCP config. Omit `env` when using only zero-key sources:

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

## Why Not Stack Separate Vendor MCPs?

| Capability | 4–5 vendor MCPs | BYOK wrapper (`mcp-omnisearch`) | Keyless scraper (`open-webSearch`) | `@nb-corp/nb-search` |
| --- | --- | --- | --- | --- |
| **Context overhead** | ~15k–35k tokens, 20+ tools | ~4k–8k tokens | ~1k–2k tokens | **~1.4k MCP / ~110 Skill tokens** |
| **Zero-key start** | Keys required | Keys required | Public HTML only | **Six keyless source types + optional BYOK** |
| **Multi-engine fusion** | Manual merging | One engine per call | No API provenance | **URL deduplication + RRF + provenance** |
| **Multi-key failover** | None | One key per source | IP rate limits | **32 keys/provider, `429` cooldown, `402` skip** |
| **URL credit protection** | Paid scraper per fetch | Vendor scrape API | Basic HTML extraction | **Defuddle first + ordered routing + challenge detection** |
| **Research beyond 60s** | stdio timeout | Blocking calls time out | Not supported | **Detached `run` / `get` / `read` / `cancel` jobs** |

## Documentation & AI Index

- **Get started**: [Quick Start](/en/guide/quickstart) · [Configuration & Key Rotation](/en/guide/configuration) · [SDK / CLI / MCP / Skill](/en/guide/integrations)
- **Explore capabilities**: [Sources Catalog](/en/sources/) · [Web & Regional Search](/en/sources/web-search) · [URL Fetch & Routing](/en/guide/fetch) · [Async Jobs](/en/guide/jobs)
- **Reference & machine-readable docs**: [CLI](/en/reference/cli) · [Runtime Contract](/en/reference/runtime) · [Remote Protocol](/en/reference/remote-protocol) · [llms.txt](/llms.txt) · [llms-full.txt](/llms-full.txt)
