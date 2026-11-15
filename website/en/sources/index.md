# Sources Catalog

`nb-search` ships with 18 search lanes and 9 fetch pipelines. Use the standalone [nb-extract](https://github.com/NB-Corp/nb-extract) tool for local document conversion and Markdown/resource saving. These sources are grouped by use case, cost structure, latency characteristics, and output channel.

::: tip About the dimensions
The relative cost (`free` / `cheap` / `expensive`) and relative latency (`fast` / `medium` / `slow`) in the tables are qualitative metadata labels declared strictly by the runtime configuration. They help an upper-layer orchestrator make coarse-grained choices; they are not actual billing data or benchmark scores.
:::

## Use-case groups and configuration guidance

The official built-in usage guidance (`src/lane-guidance.ts`) divides capabilities into three main groups. **These groups describe use cases and integration paths, not a quality ranking**:

1. **Onboarding: general discovery and reading (`onboarding`)**:
   - **Configuration guidance**: In `0.5.0` and later, the default is the keyless `duckduckgo.search` lane for general web search. Public HTML pages may trigger challenges or rate limits; the tool reports those errors as they are instead of pretending the result set is empty. Repository search and documentation context can be selected explicitly with `github.repositories` and `context7.docs`. You can also configure `tavily.search`, `brave.search`, `exa.search`, and other sources and set one as `defaults.search_lane`; an explicit default or selection takes precedence, and a failure does not silently switch sources. Fetching uses the built-in ordered URL routing package `kiki-common-direct@1` (known GitHub Raw/API, npm, and PyPI metadata use `direct.fetch` only). Other public URLs try `direct.fetch` (Defuddle) first and then the keyless `jina.reader` if that fails.
   - **Typical sources**: `duckduckgo.search`, `brave.search`, `exa.search`, `tavily.search`, `parallel.search`, `searxng.search`, and `zhipu.search`; fetch pipelines include `direct.fetch` and `jina.reader`.
2. **Specialist capabilities (`specialist`)**:
   - **Configuration guidance**: Select these explicitly for particular data types, page extraction, or controlled environments. Usually specify them directly with `--lane`, `--lanes`, or `--pipeline` rather than using them as a fallback for the entire web.
   - **Typical sources**:
     - Code and engineering: `github.repositories` (repository search), `context7.docs` (framework documentation context).
     - Deep web/social search: `firecrawl.search` (search with extracted content), `grok.x-synthesis` (synthesis of discussions on X).
     - Dedicated fetchers: `exa.contents`, `tavily.extract`, `firecrawl.scrape`, `direct.local` (compatible local files and inline content without network egress), `wayback.fetch` (historical snapshots), `browser.render` (headless Chromium rendering), and `oac.fetch` (model-based extraction and summarization).
3. **Synthesis and deep research (`research`)**:
   - **Configuration guidance**: Use these when a model must perform multi-step reasoning, produce a synthesis, or generate a structured report. They have comparatively higher cost and latency and must be invoked as a single explicit lane; they cannot be placed in a multi-source Results preset.
   - **Typical sources**: `exa.synthesis`, `tavily.synthesis`, `grok.synthesis`, `gma.research`, and `oac.synthesis`.

::: info Diagnostics and capability inspection
Run `node scripts/nb-search.mjs --doctor` locally to print a readiness summary with the use-case groups. Call `capabilities` to inspect each source's live port activation and supported modes. The "supported modes" listed below apply to the standard local runtime when no custom `http_transport` is injected; an explicitly injected custom transport disables all async modes. `readiness` reflects local configuration completeness only, not whether an external upstream is online.
:::

## 18 search lanes

The 18 built-in search lanes use different underlying providers and operations:

| Lane ID | Provider / operation | Output channel and schema | Supported modes (when ready) | Required credentials and endpoint configuration | Relative cost / latency | Characteristics and endpoint conventions |
|---|---|---|---|---|---|---|
| `brave.search` | `brave/search` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_BRAVE_API_KEY` required; Base URL optional | cheap / fast | Independent web search index; appends `/res/v1/web/search` to the endpoint |
| `exa.search` | `exa/search` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_EXA_API_KEY` required; Base URL optional | cheap / fast | Neural search; appends `/search` to the endpoint |
| `exa.synthesis` | `exa/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | `NB_SEARCH_EXA_API_KEY` required; Base URL optional | expensive / medium | Synthesis-oriented search that returns paragraphs and citations |
| `tavily.search` | `tavily/search` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_TAVILY_API_KEY` required; Base URL optional | cheap / fast | Agent-optimized search; appends `/search` to the endpoint |
| `tavily.synthesis` | `tavily/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | `NB_SEARCH_TAVILY_API_KEY` required; Base URL optional | cheap / medium | Synthesis-oriented results with a direct answer |
| `tavily.crawl` | `tavily/crawl` | Typed (`nb-search.crawl@1`) | sync, async | `NB_SEARCH_TAVILY_API_KEY` required; Base URL optional | cheap / slow | Official Crawl POST; returns a bounded Markdown document set |
| `tavily.research` | `tavily/research` | Typed (`nb-search.research@1`) | sync, async | `NB_SEARCH_TAVILY_API_KEY` required; Base URL optional | expensive / slow | Official Research Task POST/GET polling; returns content and sources |
| `firecrawl.search` | `firecrawl/search` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_FIRECRAWL_API_KEY` required; Base URL optional | cheap / fast | Search endpoint; appends `/v2/search` to the endpoint |
| `searxng.search` | `searxng/search` | Results (`nb-search.results@1`) | sync, async | No key; `NB_SEARCH_SEARXNG_BASE_URL` required | free / medium | Self-hosted or private aggregated search instance; appends `/search` to the endpoint |
| `zhipu.search` | `zhipu/search` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_ZHIPU_API_KEY` required; Base URL optional | cheap / fast | Zhipu Web Search; appends `/paas/v4/web_search` to the endpoint |
| `parallel.search` | `parallel/search` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_PARALLEL_API_KEY` required | cheap / fast | Fixed endpoint: `https://api.parallel.ai/v1/search` |
| `github.repositories` | `github/repositories` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_GITHUB_TOKEN` optional | free / fast | On-demand repository search; anonymous requests are more vulnerable to rate limits |
| `duckduckgo.search` | `duckduckgo/search` | Results (`nb-search.results@1`) | sync, async | No credentials or self-hosted endpoint required | free / medium | **Zero-key default general web search**; public HTML search reports challenges or rate limits directly |
| `context7.docs` | `context7/docs` | Typed (`nb-search.docs-context@1`) | sync, async | `NB_SEARCH_CONTEXT7_API_KEY` optional | cheap / medium | Framework and code-library documentation context extraction; uses public mode without a key |
| `grok.synthesis` | `grok/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | `NB_SEARCH_GROK_API_KEY` required; Base/Model optional | expensive / slow | Based on the xAI Grok Responses API with the `web_search` tool enabled |
| `grok.x-synthesis` | `grok/x-synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | `NB_SEARCH_GROK_API_KEY` required; Base/Model optional | expensive / slow | Based on the xAI Grok Responses API with the `x_search` tool enabled |
| `gma.research` | `grok-multi-agent/research` | Typed (`nb-search.multi-agent-research@1`) | sync, async | `NB_SEARCH_GROK_API_KEY` and `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL` required | expensive / slow | Deep multi-agent reasoning; supports `chat_completions` and `messages` modes |
| `oac.synthesis` | `openai-compatible/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | `NB_SEARCH_OAC_API_KEY`, `NB_SEARCH_OAC_BASE_URL`, and `NB_SEARCH_OAC_MODEL` required | expensive / slow | Structured synthesis through an OpenAI-compatible Chat Completions endpoint |

## 9 fetch pipelines

| Pipeline ID | Provider / operation | Supported input and output | Supported modes (when ready) | Credential and dependency requirements | Relative cost / latency | Default fetch-chain position and description |
|---|---|---|---|---|---|---|
| `direct.fetch` | `direct-http/fetch` | URL -> `nb-search.fetch@1` | sync, async | No credentials; direct HTTP request | free / fast | **First in the default URL fetch chain**; Defuddle extracts static HTML, JSON, and GitHub API text |
| `jina.reader` | `jina-reader/reader` | URL -> `nb-search.fetch@1` | sync | `NB_SEARCH_JINA_API_KEY` optional | free / medium | **Second in the default URL fetch chain**; extracts page text and converts it to Markdown |
| `direct.local` | `direct-http/local` | inline / file -> `nb-search.fetch@1` | sync, async | No credentials; `file_scopes` required for files | free / fast | **Only item in the default inline/file fetch chain**; no network egress (`egress: none`) |
| `exa.contents` | `exa/contents` | URL -> `nb-search.fetch@1` | sync | `NB_SEARCH_EXA_API_KEY` required | cheap / fast | Requires explicit selection or a custom chain; calls Exa's `/contents` extraction endpoint |
| `tavily.extract` | `tavily/extract` | URL -> `nb-search.fetch@1` | sync | `NB_SEARCH_TAVILY_API_KEY` required | cheap / fast | Requires explicit selection or a custom chain; calls Tavily's `/extract` page-extraction endpoint |
| `firecrawl.scrape` | `firecrawl/scrape` | URL -> `nb-search.fetch@1` | sync | `NB_SEARCH_FIRECRAWL_API_KEY` required | cheap / medium | Requires explicit selection or a custom chain; calls Firecrawl's `/v2/scrape` endpoint |
| `wayback.fetch` | `wayback/fetch` | URL -> `nb-search.fetch@1` | sync | No credentials; automatically queries Wayback archive snapshots | free / medium | Requires explicit selection or a custom chain; useful for pages that are offline or require historical snapshots |
| `browser.render` | `browser-render/render` | URL -> `nb-search.fetch@1` | async | Playwright + Chromium required; async only | free / slow | Requires explicit selection or a custom chain; renders client-side JavaScript pages through a browser engine |
| `oac.fetch` | `openai-compatible/fetch` | URL -> `nb-search.fetch@1` | sync | OAC key, Base URL, and Model required | expensive / slow | Requires explicit selection or a custom chain; uses a compatible model to summarize and extract page content |

## Explicit opt-in and custom sources

The built-in adapters below do not create default instances or lanes automatically. Declare them explicitly in `config.json` or host code before enabling them:

- **Built-in Zhihu source (`provider_id: "zhihu"`)**: Supports community Q&A and column search (`zhihu.search`), Chinese web-wide search (`zhihu.global`), and direct synthesis (`zhihu.synthesis`). It includes a free-quota gate through `GET /api/v1/quota` (default `allow_paid: false`) and a local `keyUsage()` metric. See the complete Schema v4 configuration in [Web & Regional Search: opt-in Zhihu](/en/sources/web-search#zhihu).
- **Local script source (`provider_id: "script"`) and SDK custom registration**: Bind trusted local `.js`/`.mjs`/`.ts`/`.mts` modules to standard search lanes that support `sync` and detached `async`, or inject a custom adapter into the host process through `ProviderRegistration`. See [Custom Sources and Script Lanes](/en/sources/custom).
