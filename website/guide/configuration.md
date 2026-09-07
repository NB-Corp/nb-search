# 配置系统

`nb-search` 使用 Configuration Schema Version 4（`schema_version: "4"`）。配置用于声明 Provider 实例、自定义 Lane/Pipeline、凭据槽位绑定以及默认行为。

## 配置来源与合并优先级

运行时解析配置时，严格按照由低到高的优先级进行合并。高优先级的值会覆盖低优先级的值：

1. **内置默认配置**（Built-in structure）
2. **本地配置文件**：`$NB_SEARCH_HOME/config.json`，或环境变量 `NB_SEARCH_CONFIG` 指定的绝对/相对路径文件（若设置了该变量但目标文件不存在，解析直接失败）
3. **标准环境变量**：以 `NB_SEARCH_*` 开头的环境变量
4. **进程内配置**（In-process `config`）
5. **进程内覆盖**（In-process `overrides`）

在合并补丁（Patch）时：
- 字段值为 `null` 具有显式删除字段的语义。
- 数组做整体替换，不执行追加合并。

## 标准环境变量

标准环境变量分为运行时基础环境与 Provider 凭据/端点配置。

### 运行时基础环境

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `NB_SEARCH_HOME` | 配置与本地状态目录 | 用户主目录下的 `.nb-search`（`~/.nb-search`） |
| `NB_SEARCH_CONFIG` | 显式指定配置 JSON 文件路径 | 无（默认读取 `$NB_SEARCH_HOME/config.json`） |
| `NB_SEARCH_JOBS_ROOT` | 异步作业产物存储根目录 | `$NB_SEARCH_HOME/jobs` |
| `NB_SEARCH_RETENTION_HOURS`| 异步产物保留时间（小时） | `72` |
| `NB_SEARCH_LOG_LEVEL` | 日志级别 (`error`, `warn`, `info`, `debug`) | `warn` |

### 核心 Provider 环境变量

仅当环境变量非空时才会绑定凭据；空字符串视为未配置，且会覆盖更低优先级的凭据。

::: code-group

```bash [通用与聚合搜索]
NB_SEARCH_EXA_API_KEY=""
NB_SEARCH_EXA_BASE_URL=""

NB_SEARCH_TAVILY_API_KEY=""
NB_SEARCH_TAVILY_BASE_URL=""

NB_SEARCH_BRAVE_API_KEY=""
NB_SEARCH_BRAVE_BASE_URL=""

NB_SEARCH_FIRECRAWL_API_KEY=""
NB_SEARCH_FIRECRAWL_BASE_URL=""

NB_SEARCH_SEARXNG_BASE_URL=""
```

```bash [抓取与专业源]
NB_SEARCH_JINA_API_KEY=""
NB_SEARCH_JINA_BASE_URL=""

NB_SEARCH_GITHUB_TOKEN=""

NB_SEARCH_CONTEXT7_API_KEY=""

NB_SEARCH_ZHIPU_API_KEY=""
NB_SEARCH_ZHIPU_BASE_URL=""

NB_SEARCH_PARALLEL_API_KEY=""
```

```bash [模型与高级综合源]
NB_SEARCH_GROK_API_KEY=""
NB_SEARCH_GROK_BASE_URL=""
NB_SEARCH_GROK_MODEL=""

# GMA 内置独立实例与槽位 (grok-multi-agent.default)，默认槽位环境变量指向 NB_SEARCH_GROK_API_KEY
NB_SEARCH_GROK_MULTI_AGENT_BASE_URL=""
NB_SEARCH_GROK_MULTI_AGENT_MODEL=""

# OpenAI-Compatible (OAC)
NB_SEARCH_OAC_API_KEY=""
NB_SEARCH_OAC_BASE_URL=""
NB_SEARCH_OAC_MODEL=""
```

:::

## 配置文件结构 (`config.json`)

以下是一个合法的 `config.json` 示例，配置了默认搜索源、URL 抓取链、本地文件授权域以及抓取字节上限：

```json
{
  "schema_version": "4",
  "defaults": {
    "search_lane": "tavily.search",
    "fetch_chain": [
      {
        "input_kind": "url",
        "representation": "markdown",
        "pipelines": ["direct.fetch", "jina.reader"]
      }
    ]
  },
  "fetch": {
    "file_scopes": [
      {
        "id": "workspace",
        "root": "/path/to/project/docs",
        "media_types": ["text/plain", "text/markdown"]
      }
    ]
  },
  "execution": {
    "fetch": {
      "max_source_bytes": 10485760
    }
  }
}
```

::: tip 字段名称约束
- 配置 Schema 版本字段名称为 `schema_version`，类型为字符串字面量 `"4"`。
- 抓取链中的管道列表属性名为 `pipelines`（数组），不是 `pipeline_ids`。
- 本地抓取源大小限制在 `execution.fetch.max_source_bytes` 中声明，`file_scopes` 项本身仅支持 `id`、`root` 与可选的 `media_types`。
:::

## GMA 自定义凭据槽位示例

GMA 内置实例为 `grok-multi-agent.default`，其默认凭据槽位与 Grok 一样指向 `NB_SEARCH_GROK_API_KEY` 环境变量。当需要为 GMA 绑定独立的专用环境变量（例如 `MY_GMA_KEY`）并指定通信协议时，可在配置中声明独立的凭据槽位：

```json
{
  "schema_version": "4",
  "provider_instances": {
    "grok-multi-agent.default": {
      "provider_id": "grok-multi-agent",
      "enabled": true,
      "credential_slot_id": "gma.custom",
      "base_url": "https://relay.internal/gma",
      "options": {
        "api_mode": "messages",
        "reasoning_effort": "high"
      }
    }
  },
  "credential_slots": {
    "gma.custom": {
      "provider_id": "grok-multi-agent",
      "env": "MY_GMA_KEY"
    }
  }
}
```

::: warning 槽位约束
声明 `credential_slots` 时，槽位配置对象的 `provider_id` 必须与引用该槽位的 `provider_instance` 的 `provider_id` 完全一致（在此处均为 `"grok-multi-agent"`），否则会抛出配置错误。
:::

## 本地与远程凭据存储 (`secrets.json` / `remote-secrets.json`)

为了避免在终端命令行历史或配置文件中写入明文密钥，CLI 提供了受保护的文件凭据存储机制：

### 1. 本地凭据存储 (`$NB_SEARCH_HOME/secrets.json`)
```json
{
  "schema_version": "1",
  "values": {
    "NB_SEARCH_TAVILY_API_KEY": "YOUR_TAVILY_KEY",
    "NB_SEARCH_BRAVE_API_KEY": "YOUR_BRAVE_KEY"
  }
}
```
- `secrets.json` 仅用于为未在进程环境变量中设置的项填充值；如果当前 shell 环境变量已经存在该变量（即使为空字符串），则环境变量优先。
- 仅 CLI 默认读取该文件并传递给本地子进程；SDK 与 MCP 不会自动读取 CLI 的 `secrets.json`。

### 2. 远程客户端凭据与配置文件 (`profiles.json` / `remote-secrets.json`)
在 `$NB_SEARCH_HOME/profiles.json` 中配置远程服务端点：
```json
{
  "schema_version": "1",
  "profiles": {
    "cloud": {
      "kind": "remote",
      "base_url": "https://search.internal/api/",
      "token_env": "NB_SEARCH_CLOUD_TOKEN",
      "timeout_ms": 120000
    }
  }
}
```
远程服务的 Access Key 通过环境变量 `NB_SEARCH_CLOUD_TOKEN` 或受保护的 `$NB_SEARCH_HOME/remote-secrets.json` 提供：
```json
{
  "schema_version": "1",
  "values": {
    "NB_SEARCH_CLOUD_TOKEN": "YOUR_SERVICE_KEY"
  }
}
```
远程配置与本地 Provider 凭据完全隔离：选择远程 profile 不会加载本地搜索源密钥。

### 3. 文件存储与安全恢复
- **存储与链接支持**：配置文件与目录遵循操作系统的标准创建权限（文件 0600，目录 0700），完整支持普通配置文件的符号链接（symlink）与父目录连接点（junction），且不限制同名目录或近似的普通文件名；保留元数据叶名（`.config-access.lock`、`.config-revision.json`、`.<basename>.nb-search.lock`、`.<basename>.nb-search-revision.json`）不可用作配置文件/密钥文件，亦不可将元数据叶本身重定向为符号链接。系统不会强制更改已有权限或重写用户的数据链接。
- **并发快照与事务锁**：本地并发读取（capabilities、search、fetch、jobs）无需加锁，通过版本快照安全并发运行；仅在配置写入或执行迁移时创建事务锁与版本标记。当多个 home 共享自定义配置路径时，每个真实数据目标相邻配有专用锁（`.<basename>.nb-search.lock`）与版本文件（`.<basename>.nb-search-revision.json`），防止多 home 交叉覆盖。
- **配置写入与安全恢复**：日常手动修改配置文件直接生效，无需手动管理版本文件。CLI 仅在执行配置写入或迁移时保障原子配对与事务协调。若命令行提示配置繁忙或需要恢复（给出具体的 marker 路径），切勿盲目删除单个锁文件或删除 revision。应先确认前序写入或迁移进程已停止，根据 home 下的备份文件（`.migration-*-backup.json`）恢复完整配置与凭据对，为该事务关联的目标发布新版本并清理对应的锁后方可恢复运行。正常使用的读者无需手动创建或管理任何锁文件。

## 离线配置健康检查 (`--doctor`)

CLI 提供了 `--doctor` 选项，用于在离线状态下校验当前配置格式与凭据槽位：

```bash
node scripts/nb-search.mjs --doctor
```

该命令仅对本地 JSON 语法与凭据环境变量的存在性给出摘要，合法的无密钥配置同样会返回成功。它不构建运行时端口，也不证明上游 Provider 真实可用。若需检查各源的可用性状态与运行时端口就绪情况，请使用 `capabilities`。
