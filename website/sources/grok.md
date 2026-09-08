# Grok、多代理与模型源

对于不仅需要链接列表，而是需要大模型结合实时检索直接产出结构化报告的场景，`nb-search` 提供了专门的 Typed 搜索源。

## Grok 综合源 (`grok.synthesis` / `grok.x-synthesis`)

这两个源基于 xAI 提供的 **Grok Responses API** 构建，输出通道为 `nb-search.synthesis@1`。
- 元数据标签：成本 `expensive`，延迟 `slow`。
- `grok.synthesis`：启用 `web_search` 工具，针对全网公开信息进行多步骤归纳推理。
- `grok.x-synthesis`：启用 `x_search` 工具，专门检索与总结 X 平台上的实时讨论与脉络。

### 配置要求

- 必需环境变量：`NB_SEARCH_GROK_API_KEY`
- 可选环境变量：`NB_SEARCH_GROK_BASE_URL`（系统自动解析并补全 `/v1/responses` 路径）、`NB_SEARCH_GROK_MODEL`

::: warning 与 Chat Completions 的区别
Grok Responses API 是独立的端点与请求格式（使用 `input` 字段与专用 tool 声明），与传统的 `/chat/completions` 不通用。系统禁止向 Grok Responses 隐式 fallback 到旧聊天接口。
:::

## GMA 深度多代理研究 (`gma.research`)

`gma.research` 面向多步骤推演的研究任务，输出通道为 `nb-search.multi-agent-research@1`。
- 元数据标签：成本 `expensive`，延迟 `slow`。

### 协议模式与端点约定

GMA 支持通过配置项 `options.api_mode` 选择通信协议，支持两种模式：
1. `chat_completions`（默认）：向 Base URL 追加 `/chat/completions` 端点。
2. `messages`：向 Base URL 追加 `/messages` 端点，遵循特定的 Relay 转发合同（POST `/messages`，顶层 `system` 字段，附带 `x-api-key` 与 `anthropic-version` 请求头，请求体 JSON 中包含 `reasoning: { effort }`）。

GMA 两种模式的 provider 请求都使用 `stream: true`，网关必须支持 SSE。这里的流式传输是 provider 请求层合同；`execution: sync|async` 仍描述本机任务生命周期，两者不是同一概念。`public SDK` 与 CLI 最终仍返回完整 typed JSON，不向用户提供 token 流。

配置示例：

```json
{
  "schema_version": "4",
  "provider_instances": {
    "grok-multi-agent.default": {
      "provider_id": "grok-multi-agent",
      "enabled": true,
      "base_url": "https://relay.internal/v1",
      "options": {
        "api_mode": "messages",
        "reasoning_effort": "high"
      }
    }
  }
}
```

::: danger 禁止端点冲突与重定向
Base URL 的后缀必须与所选模式严格匹配。例如，若模式为 `messages`，Base URL 不能已经带有 `/chat/completions` 或 `/responses`；反之亦然。一旦检测到端点冲突，该实例会被标记为不可用并直接报错。此外，GMA 两种模式均会直接拒绝 HTTP 3xx 重定向，防止凭据泄露。
:::

### 必需配置

- `NB_SEARCH_GROK_API_KEY`：GMA 默认复用此凭据槽位。
- `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL`：指定代理集群服务入口。

### 多主题并发与执行期限

GMA 的调用按宿主已有授权与预算执行。针对相互独立的研究主题，可在单个 `query` 数组中并行处理，或分别提交异步作业：

1. **多主题提交**：
   - **单 Job 多 Query**：在同一请求的 `query` 数组中提供多个主题的完整 brief；这些 Query 共享该作业的超时、取消和重试状态。
   - **独立 Async Jobs**：若需要逐主题准确追踪、取消或单独重试，分别提交独立的异步任务，每个任务使用独立的稳定 `idempotency_key`。typed 批量结果为 `partial` 时不提供原 `query` 的 index 映射，不能仅按数组位置关联主题。
2. **执行期限（Timeout）机制**：
   - 超时解析顺序为请求级 `timeout_ms` > 显式 `execution.search_timeout_ms` > 默认值。前两者都未提供时，`grok-multi-agent/research` 默认使用 600000 ms（10 分钟）；普通 search 默认仍为 30000 ms。
   - CLI 的 `--wait` 仅表示客户端本地等待返回的时间预算，不改变服务端或 provider 的实际执行期限。
   - 本地默认单作业最大并发数为 8（`max_concurrency: 8`），计划调用预算上限为 64；云端执行针对单作业与租户并发设有对应的有界限额。

```json
{
  "action": "run",
  "query": [
    "分析 WebAssembly 在服务端运行时的冷启动优化方案与主流方案对比",
    "梳理 2026 年基于 eBPF 的云原生网络可观测性实践现状与典型挑战"
  ],
  "lane": "gma.research",
  "execution": "async",
  "idempotency_key": "gma-research-batch-2026-09-08",
  "timeout_ms": 600000
}
```

## OpenAI 兼容综合源 (`oac.synthesis`)

用于接入任何遵循 OpenAI Chat Completions 规范的自建大模型服务或网关。输出通道为 `nb-search.synthesis@1`。
- 元数据标签：成本 `expensive`，延迟 `slow`。

### 配置要求

- 必需环境变量：
  - `NB_SEARCH_OAC_API_KEY`：调用密钥。
  - `NB_SEARCH_OAC_BASE_URL`：服务端点（系统自动追加 `/chat/completions`）。
  - `NB_SEARCH_OAC_MODEL`：模型名称。
- 可选 JSON 配置：`options.fallback_models`（备选模型列表）。

配置示例：

```json
{
  "schema_version": "4",
  "provider_instances": {
    "openai-compatible.default": {
      "provider_id": "openai-compatible",
      "enabled": true,
      "base_url": "https://llm-gateway.internal/v1",
      "options": {
        "model": "qwen-max",
        "fallback_models": ["qwen-plus"]
      }
    }
  }
}
```

::: tip 兼容性说明
OAC 提供标准的 HTTP JSON 适配，但具体的回答结构依赖上游模型对 Prompt 和 JSON Schema 的遵从程度，运行时本身不保证自建上游模型的语义准确性。
:::
