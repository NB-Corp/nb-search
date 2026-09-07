# 网页搜索源 (Web Search)

网页搜索类 Lane 专注于返回规范化的网络链接、页面摘要与相关度打分，其输出通道均统一为 `nb-search.results@1`。

## 通用搜索源清单与配置

### 1. Tavily Search (`tavily.search`)
- **操作契约**：`tavily/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_TAVILY_API_KEY`
- **可选配置**：`NB_SEARCH_TAVILY_BASE_URL`（端点补全 `/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 2. Brave Search (`brave.search`)
- **操作契约**：`brave/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_BRAVE_API_KEY`
- **可选配置**：`NB_SEARCH_BRAVE_BASE_URL`（端点补全 `/res/v1/web/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 3. Exa Search (`exa.search`)
- **操作契约**：`exa/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_EXA_API_KEY`
- **可选配置**：`NB_SEARCH_EXA_BASE_URL`（端点补全 `/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 4. Firecrawl Search (`firecrawl.search`)
- **操作契约**：`firecrawl/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_FIRECRAWL_API_KEY`
- **可选配置**：`NB_SEARCH_FIRECRAWL_BASE_URL`（端点补全 `/v2/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 5. SearXNG (`searxng.search`)
- **操作契约**：`searxng/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_SEARXNG_BASE_URL`（无需 Key）
- **端点补全**：`/search`
- **元数据标签**：成本 `free`，延迟 `medium`。

### 6. 智谱搜索 (`zhipu.search`)
- **操作契约**：`zhipu/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_ZHIPU_API_KEY`
- **可选配置**：`NB_SEARCH_ZHIPU_BASE_URL`（端点补全 `/paas/v4/web_search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 7. Parallel Search (`parallel.search`)
- **操作契约**：`parallel/search`；输出 `nb-search.results@1`；支持 sync 与 async。
- **必需配置**：`NB_SEARCH_PARALLEL_API_KEY`
- **端点**：固定调用 `https://api.parallel.ai/v1/search`
- **元数据标签**：成本 `cheap`，延迟 `fast`。

## 使用多源聚合查询

网页搜索类源统一输出 `nb-search.results@1`，支持通过 CLI 进行多源联合查询。在 CLI 中，多源查询必须使用逗号分隔形式（`--lanes lane1,lane2`）或重复参数形式（`--lane lane1 --lane lane2`）：

::: code-group

```bash [逗号分隔形式]
node scripts/nb-search.mjs search "web standard fetch streaming spec" \
  --lanes brave.search,tavily.search
```

```bash [重复参数形式]
node scripts/nb-search.mjs search "web standard fetch streaming spec" \
  --lane brave.search --lane tavily.search
```

:::

聚合执行时，系统会基于规范化 URL 去重，并通过倒数排名融合（RRF）算法计算全局综合位次，保留各源归属的证据组。
