# 故障排查 (Troubleshooting)

本页汇总了 `nb-search` 运行过程中的常见错误代码、触发原因及对应的修复方法。

## CLI 退出码速查

| 退出码 | 含义 | 说明 |
|---:|---|---|
| `0` | 成功 | 操作执行成功，包括 offline doctor 成功、能力输出或取消请求已受理 |
| `2` | 错误 | 调用参数无效、配置错误、网络传输异常、协议校验失败、作业失败或迁移阻塞 |
| `3` | 部分成功 | 逻辑结果为 partial，或迁移报告为局部部分完成 |
| `4` | 空结果 | 搜索或抓取执行成功，但未匹配到任何结果 |
| `5` | 等待超时 | `--wait` 预算用尽，或底层任务达到超时阈值 |
| `6` | 已取消 | 作业已被调用方显式取消 |
| `7` | 作业进行中 | 异步作业当前仍处于 `queued` 或 `running` 状态 |

## 核心错误代码诊断

### `DEFAULT_NOT_CONFIGURED`
- **原因**：执行搜索时既没有通过 `--lane`（或 `--lanes`、`--preset`）指定目标源，配置文件中也没有设置 `defaults.search_lane`。
- **解决方法**：在命令行传入明确的 `--lane <lane_id>`，或者在 `config.json` 中配置 `"defaults": { "search_lane": "tavily.search" }`。

### `CREDENTIAL_NOT_CONFIGURED` / `LANE_NOT_CONFIGURED`
- **原因**：目标 Lane 所需的环境变量密钥不存在或为空字符串，或者该 Provider 实例处于未启用状态。
- **解决方法**：运行 `node scripts/nb-search.mjs capabilities` 检查对应 Lane 的缺少项，并在环境或受保护凭据文件中设置相应的 `NB_SEARCH_*_API_KEY`。

### `ENDPOINT_NOT_CONFIGURED`
- **原因**：使用了需要自定义基础端点的源（如 `searxng.search`、`gma.research`、`oac.synthesis`），但没有配置对应的 BASE_URL 环境变量。
- **解决方法**：检查是否设置了如 `NB_SEARCH_SEARXNG_BASE_URL` 或 `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL`。

### `LANE_EXECUTION_UNSUPPORTED`
- **原因**：请求的执行模式不被该源支持。例如试图对仅支持异步执行的 `browser.render` 发起同步请求，或对仅支持同步的自定义查询发起异步请求。
- **解决方法**：根据能力的静态目录说明，调整 `execution` 模式为支持的 `sync` 或 `async`。

### `FETCH_CHAIN_UNAVAILABLE`
- **原因**：未显式指定 Pipeline，且系统内置的默认抓取链无法满足当前的输入源，或链中的 Pipeline 均未就绪。
- **解决方法**：使用 `--pipeline` 显式指定具体管道，或在配置中完善对应输入类型的 `fetch_chain`。

### `FETCH_BLOCKED`
- **原因**：目标 URL 触碰了 SSRF 安全策略（包括私有 IP、回环地址、云元数据地址，或重定向到了私网地址）。
- **解决方法**：确保抓取的目标为公网可解析的公开 HTTP(S) 地址。SSRF 防护为硬性策略，禁止绕过。

### `FETCH_BYTES_LIMIT`
- **原因**：抓取的输入源（本地文本或文件）超过了 `execution.fetch.max_source_bytes`，或者 HTTP 响应体积超过了 `max_response_bytes`。
- **说明与处理**：区分输入与响应路径：本地输入超限会在进入管道前直接拒绝；第三方代抓 API 响应超限会作为传输错误失败；而 `direct.fetch` 管道在响应超限时可进行有界截断并返回，具体机制请参阅[内容抓取安全限制](/guide/fetch#安全限制与网络防护)。请根据实际场景优化目标内容或调整配置，避免盲目调大上限。

### `FETCH_CONTENT_TYPE_REJECTED`
- **原因**：响应的 MIME 类型不在白名单内。
- **解决方法**：确认目标内容类型为 `text/html`、`text/plain` 或 `text/markdown`。

### `QUALITY_GATE_FAILED`
- **原因**：抓取到的正文内容字符数低于用户显式配置的门禁下限（`min_content_chars`），或命中了拦截标记。
- **解决方法**：检查目标站点是否需要 JavaScript 动态渲染（可改用 `browser.render` 并走异步），或者调整配置中的 `quality.min_content_chars`。

### `OUTPUT_TOO_LARGE`
- **原因**：同步模式下返回的信封体积超过了 `execution.max_inline_bytes`（默认 16 MiB）。
- **说明与处理**：系统不会自动截断数据。注意：内置的 7 个公共 URL 抓取管道（`direct.fetch`、`jina.reader`、`exa.contents`、`tavily.extract`、`firecrawl.scrape`、`wayback.fetch`、`oac.fetch`）均为同步（Sync-only），不能直接切为异步；仅 `browser.render` 支持且要求异步。对于抓取，可通过调小 `max_content_chars`；若当前显式配置的 `max_inline_bytes` 低于 16 MiB，可适当调高至上限；对于搜索，可调小 `max_results` 或改用异步执行模式（`--execution async`）。重跑请求可能产生新的计费开销，请谨慎评估。

### `ENTRY_UNAVAILABLE`
- **原因**：通过 `scripts/nb-search.mjs` 启动时找不到构建产物 `dist/cli.mjs`。
- **解决方法**：如果是从源码运行，必须先在仓库根目录执行 `pnpm build`。如果是作为 Skill 依赖引入，请确保没有遗漏整个 `dist/` 目录。

## 离线配置校验与能力查询

当排查配置或凭据绑定问题时，优先使用离线诊断命令：

```bash
node scripts/nb-search.mjs --doctor
```

该命令仅验证本地配置格式与凭据环境变量的存在性，给出语法与槽位摘要，不证明底层运行时端口（ports）已就绪，也不会发起外部网络连接验证凭据真实可用性。

如需查看各源的就绪状态与执行模式：

```bash
node scripts/nb-search.mjs capabilities
```

在返回的目录中检查具体的 `availability`（`ready` 或 `unavailable`）、`issues` 列表以及支持的 `execution_modes`。注意即使标记为 `ready`，也仅代表本地初始化完成，不代表上游服务当前的真实网络连通性或配额健康度。
