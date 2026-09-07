# 异步作业与产物 (Jobs)

对于耗时较长、包含多步骤推演的研究源（如 `gma.research`、`browser.render`）或大吞吐量批量任务，`nb-search` 提供统一的异步作业管理机制。

## 作业生命周期与状态

在发起异步请求时（`execution: "async"`），必须提供 `idempotency_key`。系统接收后返回作业回执，包含用于后续跟进的合法 UUID 字符串 `job.job_id`。

异步作业包含以下公共状态：
- `queued`：已进入任务队列，等待处理。
- `running`：正在执行中。
- `succeeded`：执行完毕，不可变产物已成功生成并发布。
- `failed`：执行失败（例如遇到上游服务异常或 `DEADLINE_EXCEEDED` 预算耗尽）。
- `cancelled`：已被调用方显式取消。

::: tip 状态与业务结果的分离
作业生命周期状态 `succeeded` 仅代表作业完整执行并未发生崩溃，不代表返回的业务数据必然丰富。业务上的部分结果（`partial`）或空结果（`empty`）会在产物状态字段和 CLI 退出码中明确呈现。
:::

## 产物不可变性与保留期 (TTL)

- 异步作业成功执行完成后，会发布一个不可变（Immutable）的 JSON 产物文件。
- 产物从发布（Publication）时刻起开始计算保留时长，默认保留 72 小时（`NB_SEARCH_RETENTION_HOURS=72`）。
- 超过保留期后，尝试读取作业将返回 `JOB_NOT_FOUND`，系统不会自动重新执行或再次生成已过期的作业产物。

## CLI 异步操作流程

CLI 提供了完整的异步操作子命令：`run`、`get`、`read` 与 `cancel`。本地任务直接执行，远程任务显式加 `--profile <name>`。

### 1. 提交异步作业与等待预算 (`--wait`)

提交异步作业时必须带上 `--idempotency-key`。可以通过 `--wait` 参数指定原地同步等待的毫秒数（范围 1 至 3,600,000 ms）：

```bash
node scripts/nb-search.mjs search "deep research brief" \
  --lane gma.research \
  --execution async \
  --idempotency-key "brief-20260907-001" \
  --wait 120000
```

- **等待期间完成**：CLI 会输出最终重构的逻辑结果。退出码取决于逻辑数据状态：完全成功为 `0`，部分结果为 `3`，空结果为 `4`，失败为 `2`。
- **等待预算耗尽**：若指定的时间用完但任务仍在后台执行，CLI 输出超时状态 JSON，退出码为 **`5`**（注意：不是 7）。后台任务仍会继续运行，不会自动取消上游计算。

从提交回执中获取真实生成的 `job_id`（例如 `3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10`），用于后续操作。

### 2. 查询作业状态 (`get`)

```bash
node scripts/nb-search.mjs search get "3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10"
```

如果作业仍在队列中或正在运行，CLI 退出码为 **`7`**（Pending）。成功获取到元数据时退出码为 `0`（仅代表成功拿到状态，不代表业务数据已完成）。若针对远程服务作业，需显式添加 `--profile <name>`。

### 3. 读取完整产物 (`read --all`)

对于已成功发布的作业，底层通过分页与 Base64 切片存储。调用方无需手动拼接 Base64 分片，使用 `--all` 标志直接读取并重构标准逻辑对象：

```bash
node scripts/nb-search.mjs search read "3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10" --all
```

`--all` 参数会自动校验分片连续性、偏移量、SHA-256 哈希完整性、UTF-8 编码以及对应 Schema，随后直接输出完整的逻辑 JSON（搜索返回顶层 `results` 或 Typed 载荷；抓取返回顶层 `documents`）。

::: warning 注意
`--all` 是一次性重构完整产物的辅助指令，不能与分页参数（如 `--cursor` 或 `--page-size`）混用。
:::

### 4. 取消作业 (`cancel`)

```bash
node scripts/nb-search.mjs search cancel "3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10"
```

- 退出码 `0` 仅表示取消请求已被确认受理（Cancel request acknowledged），不保证上游已经完全停止，也不构成任何费用返还或开销回收承诺。
- 取消后可通过 `get` 查看作业是否已真正转换至 `cancelled` 终态。
