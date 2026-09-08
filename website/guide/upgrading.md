# 版本与升级指南 (Upgrading)

本页说明版本规则、重要协议演进注意事项以及从旧版升级到当前版本的兼容性边界。

## 版本适用说明

本页说明针对 `@nb-corp/nb-search` `0.3.1` 及以上版本。在升级或排查兼容性前，请先检查本地安装的实际包版本并参阅 [CHANGELOG](/reference/changelog)。

CLI 或项目 SDK 均从官方 npm registry 更新：

```bash
# 全局 CLI
npm install -g @nb-corp/nb-search@0.3.1 --registry=https://registry.npmjs.org
# 项目 SDK
npm install @nb-corp/nb-search@0.3.1 --registry=https://registry.npmjs.org
```

## 升级注意项

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
