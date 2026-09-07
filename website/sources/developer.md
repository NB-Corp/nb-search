# 开发者与专用源 (Developer Sources)

除了全网通用搜索引擎，`nb-search` 还提供了面向软件工程和技术文档的专用检索源。

## GitHub 仓库搜索 (`github.repositories`)

- **操作契约**：`github/repositories`；输出 `nb-search.results@1`；支持 sync 与 async。
- **元数据标签**：成本 `free`，延迟 `fast`。
- **配置与认证**：
  - 可选环境变量：`NB_SEARCH_GITHUB_TOKEN`
  - 端点固定调用官方 API：`https://api.github.com/search/repositories`

::: warning 匿名频控限制
在不提供 GitHub Token 的情况下，该源仍可工作（Keyless 模式）。但是，GitHub 对未认证的 IP 请求具有极低的速率限制（Rate Limit）。建议在常规环境中配置 Token 以免触发频控错误。
:::

### 查询示例

```bash
node scripts/nb-search.mjs search "language:typescript stars:>1000 web search" \
  --lane github.repositories
```

## Context7 文档检索 (`context7.docs`)

- **操作契约**：`context7/docs`；输出 `nb-search.docs-context@1`；支持 sync 与 async。
- **元数据标签**：成本 `cheap`，延迟 `medium`。
- **配置与认证**：
  - 可选环境变量：`NB_SEARCH_CONTEXT7_API_KEY`
  - 默认端点：`https://context7.com`（调用 `/api/v2/libs/search` 与 `/api/v2/context`）

在未配置 API Key 时，以公用免费模式调用。返回的数据为文档上下文切片，适合代码助手查阅库手册。

### 查询示例

```bash
node scripts/nb-search.mjs search "fastify register plugins hook lifecycle" \
  --lane context7.docs
```
