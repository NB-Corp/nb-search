# 信息源目录 (Sources Catalog)

`nb-search` 内置支持 15 个搜索源（Search Lanes）与 9 个内容抓取管道（Fetch Pipelines）。这些源依据用途场景、成本结构、延迟特征与输出通道进行分类。

::: tip 维度说明
表格中的相对成本（`free` / `cheap` / `expensive`）和相对延迟（`fast` / `medium` / `slow`）属于运行时配置内严格声明的定性元数据标签，便于上层编排器进行粗粒度选择，并非真实账单计费依据或基准跑分。
:::

## 用途分组与配置选择建议

根据官方内置用途指引（`src/lane-guidance.ts`），能力按业务目标划分为三个主要分组。**这些分组反映的是使用场景与接入路径，而非质量高低的等级排序**：

1. **入门通用检索与原文 (`onboarding`)**：
   - **配置建议**：首次集成时，优先配置一个通用 Results 搜索源（例如 `tavily.search`、`brave.search` 或 `exa.search`）并设置为 `defaults.search_lane`。对于抓取，默认 URL 抓取链直接提供 `direct.fetch` 与 `jina.reader`，无需初始密钥即可验证。
   - **典型源**：`brave.search`、`exa.search`、`tavily.search`、`parallel.search`、`searxng.search`、`zhipu.search`，抓取管道包含 `direct.fetch` 与 `jina.reader`。
2. **按需专题能力 (`specialist`)**：
   - **配置建议**：针对特定类型数据、格式转换或受控环境显式选用，通常通过 `--lane`、`--lanes` 或 `--pipeline` 直接指定，而非作为全网兜底。
   - **典型源**：
     - 代码与工程：`github.repositories`（仓库检索）、`context7.docs`（框架文档上下文）。
     - 深度网页/社交：`firecrawl.search`（带提取内容的搜索）、`grok.x-synthesis`（针对 X 平台的讨论提炼）。
     - 专用抓取：`exa.contents`、`tavily.extract`、`firecrawl.scrape`、`direct.local`（本地免网文件与行内清洗）、`wayback.fetch`（历史快照）、`browser.render`（无头 Chromium 渲染）、`oac.fetch`（模型总结抽取）。
3. **综合与深度研究 (`research`)**：
   - **配置建议**：需要模型进行多步推演、生成综合分析或结构化报告的场景。此类源调用开销与延迟相对较高，必须以单个 Lane 显式发起，不支持放入多源 Results Preset。
   - **典型源**：`exa.synthesis`、`tavily.synthesis`、`grok.synthesis`、`gma.research`、`oac.synthesis`。

::: info 诊断与能力查询
在本地运行 `node scripts/nb-search.mjs --doctor` 可输出包含用途分组指引的配置就绪摘要；调用 `capabilities` 可查看各源实时的端口激活与支持模式。注意下表中列出的“支持模式”适用于默认未注入自定义 `http_transport` 的标准本地运行时；若宿主显式注入了自定义 transport，所有异步模式将被禁用。`readiness` 仅反映本地配置完整度，并非外部上游的在线可用性探测。
:::

## 15 个搜索源 (Search Lanes)

内置 15 个搜索源分布在不同的底层 Provider 与操作中：

| Lane 标识 | Provider / 操作 | 输出通道与 Schema | 支持模式 (就绪时) | 必需凭据与端点配置 | 相对成本 / 延迟 | 特征与端点约定 |
|---|---|---|---|---|---|---|
| `brave.search` | `brave/search` | Results (`nb-search.results@1`) | sync, async | 必需 `NB_SEARCH_BRAVE_API_KEY`；Base URL 可选 | cheap / fast | 独立网页搜索索引，端点补全 `/res/v1/web/search` |
| `exa.search` | `exa/search` | Results (`nb-search.results@1`) | sync, async | 必需 `NB_SEARCH_EXA_API_KEY`；Base URL 可选 | cheap / fast | 神经搜索，端点补全 `/search` |
| `exa.synthesis` | `exa/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | 必需 `NB_SEARCH_EXA_API_KEY`；Base URL 可选 | expensive / medium | 提炼型搜索，返回综合段落与引用 |
| `tavily.search` | `tavily/search` | Results (`nb-search.results@1`) | sync, async | 必需 `NB_SEARCH_TAVILY_API_KEY`；Base URL 可选 | cheap / fast | 面向 Agent 优化的搜索，端点补全 `/search` |
| `tavily.synthesis` | `tavily/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | 必需 `NB_SEARCH_TAVILY_API_KEY`；Base URL 可选 | cheap / medium | 返回带直接答案回答的提炼型结果 |
| `firecrawl.search` | `firecrawl/search` | Results (`nb-search.results@1`) | sync, async | 必需 `NB_SEARCH_FIRECRAWL_API_KEY`；Base URL 可选 | cheap / fast | 搜索接口，端点补全 `/v2/search` |
| `searxng.search` | `searxng/search` | Results (`nb-search.results@1`) | sync, async | 无需 Key；必需 `NB_SEARCH_SEARXNG_BASE_URL` | free / medium | 自建或私有聚合搜索实例，端点补全 `/search` |
| `zhipu.search` | `zhipu/search` | Results (`nb-search.results@1`) | sync, async | 必需 `NB_SEARCH_ZHIPU_API_KEY`；Base URL 可选 | cheap / fast | 智谱 Web Search，端点补全 `/paas/v4/web_search` |
| `parallel.search` | `parallel/search` | Results (`nb-search.results@1`) | sync, async | 必需 `NB_SEARCH_PARALLEL_API_KEY` | cheap / fast | 固定端点 `https://api.parallel.ai/v1/search` |
| `github.repositories` | `github/repositories` | Results (`nb-search.results@1`) | sync, async | `NB_SEARCH_GITHUB_TOKEN` 可选 | free / fast | GitHub 官方仓库搜索；无 Token 易受匿名频控限制 |
| `context7.docs` | `context7/docs` | Typed (`nb-search.docs-context@1`) | sync, async | `NB_SEARCH_CONTEXT7_API_KEY` 可选 | cheap / medium | 框架与代码库文档上下文提取，无 Key 时按公用模式调用 |
| `grok.synthesis` | `grok/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | 必需 `NB_SEARCH_GROK_API_KEY`；Base/Model 可选 | expensive / slow | 基于 xAI Grok Responses API，启用 `web_search` 工具 |
| `grok.x-synthesis` | `grok/x-synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | 必需 `NB_SEARCH_GROK_API_KEY`；Base/Model 可选 | expensive / slow | 基于 xAI Grok Responses API，启用 `x_search` 工具 |
| `gma.research` | `grok-multi-agent/research` | Typed (`nb-search.multi-agent-research@1`) | sync, async | 必需 `NB_SEARCH_GROK_API_KEY` + `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL` | expensive / slow | 深度多代理推演，支持 chat_completions 与 messages 模式 |
| `oac.synthesis` | `openai-compatible/synthesis` | Typed (`nb-search.synthesis@1`) | sync, async | 必需 `NB_SEARCH_OAC_API_KEY` + `NB_SEARCH_OAC_BASE_URL` + `NB_SEARCH_OAC_MODEL` | expensive / slow | 基于 OpenAI 兼容 Chat Completions 的结构化综合回答 |

## 9 个抓取管道 (Fetch Pipelines)

| Pipeline 标识 | Provider / 操作 | 适用输入与输出 | 支持模式 (就绪时) | 凭据与依赖要求 | 相对成本 / 延迟 | 默认抓取链位置与说明 |
|---|---|---|---|---|---|---|
| `direct.fetch` | `direct-http/fetch` | URL -> `nb-search.fetch@1` | sync | 无需凭据，直接 HTTP 请求 | free / fast | **默认 URL 抓取链第 1 位**；直接抓取，无外部依赖 |
| `jina.reader` | `jina-reader/reader` | URL -> `nb-search.fetch@1` | sync | `NB_SEARCH_JINA_API_KEY` 可选 | free / medium | **默认 URL 抓取链第 2 位**；正文提取与 Markdown 转换 |
| `direct.local` | `direct-http/local` | inline / file -> `nb-search.fetch@1` | sync, async | 无需凭据；file 需配置 `file_scopes` | free / fast | **默认 inline/file 抓取链唯一项**；不出网 (`egress: none`) |
| `exa.contents` | `exa/contents` | URL -> `nb-search.fetch@1` | sync | 必需 `NB_SEARCH_EXA_API_KEY` | cheap / fast | 需显式指定或自定义 chain；调用 Exa 内容提取端点 `/contents` |
| `tavily.extract` | `tavily/extract` | URL -> `nb-search.fetch@1` | sync | 必需 `NB_SEARCH_TAVILY_API_KEY` | cheap / fast | 需显式指定或自定义 chain；调用 Tavily 页面提取端点 `/extract` |
| `firecrawl.scrape` | `firecrawl/scrape` | URL -> `nb-search.fetch@1` | sync | 必需 `NB_SEARCH_FIRECRAWL_API_KEY` | cheap / medium | 需显式指定或自定义 chain；调用 Firecrawl 抓取端点 `/v2/scrape` |
| `wayback.fetch` | `wayback/fetch` | URL -> `nb-search.fetch@1` | sync | 无需凭据；自动查询 Wayback 归档快照 | free / medium | 需显式指定或自定义 chain；适用于页面已下线或需要历史快照的场景 |
| `browser.render` | `browser-render/render` | URL -> `nb-search.fetch@1` | async | 依赖 Playwright + Chromium；仅支持异步 | free / slow | 需显式指定或自定义 chain；通过浏览器内核渲染客户端 JavaScript 页面 |
| `oac.fetch` | `openai-compatible/fetch` | URL -> `nb-search.fetch@1` | sync | 必需 OAC Key + Base URL + Model | expensive / slow | 需显式指定或自定义 chain；使用兼容模型对页面内容进行归纳提取 |
