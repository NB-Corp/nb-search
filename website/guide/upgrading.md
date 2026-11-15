# 版本与升级指南 (Upgrading)

本页说明版本规则、重要协议演进注意事项以及从旧版升级到当前版本的兼容性边界。

## 版本适用说明

本页说明覆盖 `@nb-corp/nb-search` 从 `0.3.x` / `0.4.x` 演进至 `0.5.2` 的重要兼容性边界。在升级或排查兼容性前，请先检查本地安装版本并参阅 [CHANGELOG](/reference/changelog)。

CLI 或项目 SDK 均从官方 npm registry 更新：

```bash
# 全局 CLI
npm install -g @nb-corp/nb-search
# 项目 SDK
npm install @nb-corp/nb-search
```

## 升级注意项

### 0.5.1 – 0.5.2：显式启用知乎、多密钥轮转与 `keyUsage()`

- **Opt-in 知乎适配器 (`zhihu`)**：新增 `zhihu.search`、`zhihu.global` 与 `zhihu.synthesis` 支持，但不会向内置默认配置注入任何实例、凭据槽或通道；升级不会影响现有默认配置。启用方式与免费配额门禁详见[网页搜索源：显式启用知乎](/sources/web-search#zhihu)。
- **最多 32 密钥池与 `keyUsage()`**：现有 `NB_SEARCH_*_API_KEY` 环境变量直接兼容单密钥与逗号分隔多密钥列表；本地 SDK 新增 `runtime.keyUsage()` 方法（`LocalNbSearchRuntime`），远端客户端与 MCP 工具列表保持不变。

### 0.5.0：免密默认搜索、Defuddle 直抓与有序 URL 路由

- **默认搜索源 (`duckduckgo.search`)**：未显式配置 `defaults.search_lane` 时，通用搜索默认走免密 `duckduckgo.search`。若上层宿主依赖旧版“无默认源即返回 `DEFAULT_NOT_CONFIGURED`”的拦截语义，请在 `config.json` 中显式声明 `"defaults": { "search_lane": null }`。
- **Defuddle 直抓与 URL 路由 (`kiki-common-direct@1`)**：`direct.fetch` 升级为 Defuddle 0.19.3 + linkedom 静态提取并支持异步作业；内置 URL 路由默认将已知 GitHub Raw/API、npm、PyPI JSON 固定至仅 `direct.fetch`（可通过 `fetch.routing` 覆盖或关闭）。
- **进行中作业指纹变更**：`duckduckgo`（v2）、`direct-http` 与新增 `crawl`/`research` 操作的 `tavily` 适配器更新了操作指纹；升级前请先等待进行中的旧版异步任务执行完毕，已持久化的旧快照不会被静默重建。

### 0.4.0：Script provider/lane

`0.4.0` 新增 `script` provider/lane，可沿用现有 CLI、SDK 与 detached async 作业入口，不改变既有 API；从 0.2→0.3 升级的历史说明仍按原文处理。

### 1. GMA 协议演化与模式匹配

在早期的开发快照中，GMA（Grok Multi-Agent）适配器结构与现有版本不同：
- GMA 适配器从 Version 1 升级到 Version 2 后，旧的进行中作业快照无法由新适配器反序列化。升级前请确保旧的长时间运行任务已经完结。
- 新版支持显式指定 `options.api_mode`：
  - `chat_completions`：服务端点补全 `/chat/completions`。
  - `messages`：服务端点补全 `/messages`，采用结构化 relay 契约。
- **端点冲突保护**：如果配置的 Base URL 已经包含了与模式不符的后缀（例如将 Grok 的 `/responses` 填入 GMA 端点），系统会直接报错并禁用该实例，不会发生静默 fallback。

### 2. Grok Responses 独立性

`grok.synthesis` 和 `grok.x-synthesis` 基于独立的 Grok Responses API 构建，直接调用 `/v1/responses` 端点。它与传统的 Chat Completions 接口不通用。如果你从旧版配置迁移，原先只支持 Chat Completions 的旧凭据不能自动用于新的 Responses 操作。

### 3. 配置 Schema 演进与 search-layer 迁移

当前运行时基于 **Configuration Schema Version 4**（`schema_version: "4"`）。
- 如果你维护有早期 search-layer 凭据源（如 `SEARCH_LAYER_CREDENTIALS` 或 `~/.openclaw/credentials/search.json`），可使用 CLI 提供的显式导入功能（`nb-search --import-search-layer --dry-run`）预览映射报告；确认无冲突后再通过 `--apply` 执行实际应用。该工具并非任意旧版本通用升级器，具体规则请参阅 [CLI 迁移指南](/reference/cli)。
- 早期版本中部分私有的环境变量（如 `NB_SEARCH_GROK_MULTI_AGENT_API_KEY`）在标准 Schema v4 中已统一规范化，GMA 默认槽位环境变量与 Grok 统一为 `NB_SEARCH_GROK_API_KEY`。

### 4. 并发控制与状态恢复

在执行配置中，参数 `max_concurrency`（默认 8）与 `max_provider_calls`（默认 64）属于单次查询执行内部的并发与调用预算控制，并非多个独立 CLI 进程间的全局排队队列。
- 当多任务或多进程运行并遇到配置写入冲突时，应等待前序写操作或迁移完成。
- 若进程异常中断提示存在未释放状态，切勿盲目删除 `jobs` 产物目录、备份文件或未知锁；请依据 CLI 诊断提示确认配置与凭据一致性后再行恢复。
