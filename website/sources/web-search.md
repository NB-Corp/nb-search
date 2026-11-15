# 网页搜索源 (Web Search)

网页搜索类 Lane 专注于返回规范化的网络链接、页面摘要与相关度排序，标准结果通道统一输出 `nb-search.results@1`（知乎直达综合 `zhihu.synthesis` 输出 `nb-search.synthesis@1`）。

## 免密默认搜索源

### DuckDuckGo (`duckduckgo.search`)
- **操作契约**：`duckduckgo/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **默认行为**：`0.5.0` 及以上版本的内置默认搜索源（`defaults.search_lane = "duckduckgo.search"`），无需注册账号、配置 API Key 或手动传 `--lane` 即可直接检索通用网页。
- **错误与限流边界**：公共 HTML 搜索端点可能触发人机验证（CAPTCHA）或 `429` 频控（保留 `Retry-After` 元数据）。运行时会将验证页和不可识别页面作为明确错误返回，绝不伪装为空结果（`empty`），也绝不静默切换到付费搜索源。
- **元数据标签**：成本 `free`，延迟 `medium`。

## BYOK 通用与区域搜索源

### 1. Tavily Search (`tavily.search`)
- **操作契约**：`tavily/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_TAVILY_API_KEY`（支持逗号分隔最多 32 把密钥轮转，本地 SDK 支持 `keyUsage()` 查询周期用量）
- **可选配置**：`NB_SEARCH_TAVILY_BASE_URL`（保留 URL 前缀并补全 `/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。
- **同源高级通道**：同一实例还提供 `tavily.synthesis`（`nb-search.synthesis@1`）、`tavily.crawl`（`nb-search.crawl@1`，默认限时 180s）与 `tavily.research`（`nb-search.research@1`，默认限时 900s）。

### 2. Exa Search (`exa.search`)
- **操作契约**：`exa/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_EXA_API_KEY`
- **可选配置**：`NB_SEARCH_EXA_BASE_URL`（端点补全 `/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 3. Brave Search (`brave.search`)
- **操作契约**：`brave/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_BRAVE_API_KEY`
- **可选配置**：`NB_SEARCH_BRAVE_BASE_URL`（端点补全 `/res/v1/web/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 4. Firecrawl Search (`firecrawl.search`)
- **操作契约**：`firecrawl/search`；输出 `nb-search.results@1`（结果附带页面正文摘录）；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_FIRECRAWL_API_KEY`（本地 SDK 支持 `keyUsage()` 查看团队剩余积分）
- **可选配置**：`NB_SEARCH_FIRECRAWL_BASE_URL`（保留 URL 前缀并补全 `/v2/search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 5. SearXNG (`searxng.search`)
- **操作契约**：`searxng/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_SEARXNG_BASE_URL`（自建或私有聚合实例，无需 API Key，端点补全 `/search`）
- **元数据标签**：成本 `free`，延迟 `medium`。

### 6. 智谱搜索 (`zhipu.search`)
- **操作契约**：`zhipu/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_ZHIPU_API_KEY`
- **可选配置**：`NB_SEARCH_ZHIPU_BASE_URL`（端点补全 `/paas/v4/web_search`）
- **元数据标签**：成本 `cheap`，延迟 `fast`。

### 7. Parallel Search (`parallel.search`)
- **操作契约**：`parallel/search`；输出 `nb-search.results@1`；支持 `sync` 与 `async`。
- **必需配置**：`NB_SEARCH_PARALLEL_API_KEY`
- **端点**：固定调用 `https://api.parallel.ai/v1/search`
- **元数据标签**：成本 `cheap`，延迟 `fast`。

## 显式启用知乎来源 (Opt-in Zhihu) {#zhihu}

内置 `zhihu` 适配器（`provider_id: "zhihu"`）采用显式启用设计，默认不会向内置配置注入 `provider_instance`、`credential_slot` 或 `lane`。使用时需在 Schema v4 `config.json` 中同时声明三者（下方 `latency` 与 `cost` 为编排元数据标签，并非请求配额上限）：

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

设置环境变量 `NB_SEARCH_ZHIHU_API_KEY="YOUR_API_KEY"` 后，显式选择对应通道执行：

```bash
nb-search search "人工智能架构演进" --lane zhihu.search
nb-search search "人工智能架构演进" --lane zhihu.global
nb-search search "比较近期端侧模型推理框架的工程取舍" --lane zhihu.synthesis
```

### 操作契约与路径参数

- **`zhihu.search`**：调用 `GET /api/v1/content/zhihu_search`，输出 `nb-search.results@1`。查询词去除首尾空白后长度须为 **2–100 字符**，请求条数自动钳制在 **1–10**；摘要前缀保留内容类型、作者、权威度等级、赞同数与评论数标签。
- **`zhihu.global`**：调用 `GET /api/v1/content/global_search`，输出 `nb-search.results@1`，请求条数钳制在 **1–20**。`options.search_db` 默认为 `"all"`，可选 `"realtime"` 或 `"static"`。
- **`zhihu.synthesis`**：调用 `POST /v1/chat/completions`，输出单通道 `typed` 结构 `nb-search.synthesis@1`（不可与 `results` 通道混入 `--lanes`）。`options.zhida_model` 默认为 `"zhida-fast-1p5"`，也支持 `"zhida-thinking-1p5"`、`"zhida-agent"` 或自定义非空模型名。
- **URL 前缀与路径覆盖**：三者均支持 `sync` 与 `async`。`base_url` 默认值为 `https://developer.zhihu.com`，按 URL 前缀语义拼接 `search_path`、`global_search_path`、`synthesis_path` 与 `quota_path`（不会丢弃反向代理路径前缀，例如 `https://relay.example.test/zhihu`）。

### 免费配额门禁 (`allow_paid`) 与 `keyUsage()` 计量

- **默认阻断超额计费（`allow_paid: false`）**：派发请求前，运行时会通过 `GET /api/v1/quota` 核验免费额度；当免费额度耗尽或无法完成核验时直接拒绝请求（Fail-closed）。同一运行时内指向相同配额端点与凭据的实例共享预留账本；若请求途中异常中断且结果未决，预留扣减会一直保留至观测到上游 `TotalUsed` 推进或北京时间（`Asia/Shanghai`，`UTC+8`）`00:00` 每日配额重置。仅当剩余请求数大于 32 时才缓存配额快照（最长 60 秒）。只有明确允许钱包扣费时，才应显式设置 `"allow_paid": true`。
- **本地 SDK `keyUsage()` 指标**：`runtime.keyUsage()` 同样读取 `GET /api/v1/quota`，在 `KeyUsage.usage.meters` 中返回按 API 拆分的请求计数器；兼容 credits 摘要优先取 `zhihu_search`（缺省时取首个 meter），仅当 `zhihu_search` 与 `global_search` 剩余额度同时归零时才将该密钥标记为 `exhausted`。

## 多源 RRF 聚合查询

所有 `nb-search.results@1` 网页搜索源（含已启用的 `zhihu.search` 与 `zhihu.global`）均可通过逗号分隔 `--lanes`、重复 `--lane` 或配置 `presets` 并行检索：

::: code-group

```bash [逗号分隔形式]
nb-search search "web standard fetch streaming spec" \
  --lanes exa.search,tavily.search,brave.search
```

```bash [重复参数形式]
nb-search search "web standard fetch streaming spec" \
  --lane exa.search --lane tavily.search
```

:::

聚合执行时，运行时自动对 URL 做规范化去重，并通过倒数排名融合（RRF）算法计算全局综合位次，完整保留各源归属的 `evidence_groups` 与 `provenance`。
