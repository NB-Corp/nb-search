# 搜索能力 (Search)

`nb-search` 的搜索接口支持通用网页链接检索、结构化知识库查询以及基于大模型的专用提炼分析。

## 架构区分：Envelope 与 Output Schema

执行搜索时，返回的最外层信封（Envelope）具有统一的规范版本：
- 全局信封版本：`schema_version: "3.0"`
- 核心载荷字段：`output`（或失败时的 `error`）

根据操作特性，`output` 内部划分为两种通道：

1. **Results 通道** (`channel: "results"`)：
   - 输出载荷遵循 `schema_id: "nb-search.results@1"`。
   - 包含标准化的条目数组 `results`：包含标题、规范化 URL、摘要、证据组（`evidence_groups`）与来源追溯（`provenance`）。
   - 支持单 Lane 查询、多 Lane 聚合，或仅包含 Results 操作的预设（`preset`）。
   - 示例源：`tavily.search`、`brave.search`、`exa.search`、`github.repositories`。

2. **Typed 通道** (`channel: "typed"`)：
   - 输出载荷遵循具体声明的 Typed Schema，例如 `nb-search.docs-context@1`、`nb-search.synthesis@1` 或 `nb-search.multi-agent-research@1`。
   - 专门返回结构化研究报告或知识文档上下文。
   - **约束**：Typed 操作**只能**针对单个 Lane 发起，不支持多 Lane 聚合，也不能配置在多源 Results Preset 中。
   - 示例源：`context7.docs`、`exa.synthesis`、`grok.synthesis`、`gma.research`、`oac.synthesis`。

## 单源查询与多源聚合

### 单源查询

当执行单 query × 单 results lane 查询时，系统完整保留该源返回条目在规范化去重后的相对先后顺序（单源时 `rrf_score` 不输出，不保留上游原始浮点 score）：

```bash
node scripts/nb-search.mjs search "fastify vs express" --lane brave.search
```

若在同一请求中针对单 lane 传入多个 query（例如通过 stdin 传入 query 数组），系统会按 query 分别生成独立的候选列表并进行合并。

### 多源聚合与去重 (RRF)

在 CLI 中，多源查询可以通过逗号分隔的 `--lanes` 或重复传入 `--lane` 指定（两形式与 `--preset` 互斥）：

::: code-group

```bash [CLI 逗号分隔]
node scripts/nb-search.mjs search "postgresql replication" --lanes brave.search,tavily.search
```

```bash [CLI 重复参数]
node scripts/nb-search.mjs search "postgresql replication" --lane brave.search --lane tavily.search
```

```json [标准输入 JSON]
{
  "action": "run",
  "query": "postgresql replication",
  "lanes": ["brave.search", "tavily.search"],
  "execution": "sync"
}
```

:::

多源执行时，系统按以下规则确定性合并：
1. **URL 规范化去重**：清除等价跟踪参数与后缀。
2. **倒数排名融合 (RRF)**：根据每个源中的相对排位计算全局综合分。
3. **证据组聚类 (Evidence Groups)**：保留不同源所捕获的独立证据片段。
4. **确定性仲裁**：在分数并列时执行确定的备用排序，确保相同输入产生稳定输出。

## 同步与异步执行

- **同步执行 (`execution: "sync"`)**：等待搜索完成并在响应中返回数据。若载荷超过 `execution.max_inline_bytes`（默认 16 MiB），系统返回 `OUTPUT_TOO_LARGE` 错误，绝不进行隐式截断或静默切换到异步。
- **异步执行 (`execution: "async"`)**：立即返回作业回执。异步调用必须提供 `idempotency_key` 保证幂等性。关于作业轮询与完整产物重构，参见[异步任务指南](/guide/jobs)。
