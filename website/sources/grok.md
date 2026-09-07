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
2. `messages`：向 Base URL 追加 `/messages` 端点，遵循特定的 Relay 转发合同（POST `/messages`，顶层 `system` 字段，附带 `x-api-key` 与 `anthropic-version` 请求头，请求体 JSON 中包含 `reasoning: { effort }`，单次流关闭请求）。

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
