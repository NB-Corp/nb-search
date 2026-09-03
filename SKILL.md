---
name: nb-search
description: 使用显式 lane 执行查询，并以 pipeline 将 URL、内联内容或授权文件转换为文档
---

# nb-search 使用协议

## 核心原则

- 公开能力只有 `search`、`fetch`、`capabilities`。
- 对 `search`，模型负责判断查什么、是否拆分 query、选择哪个 lane；runtime 只执行显式选择或本机默认，不自动 fallback。
- 对 `fetch`，不传 `pipeline` 时 runtime 按 input kind 与 representation 匹配配置链；显式 `pipeline` 会绕过配置链。
- `execution` 只改变交付方式，不改变 search lane、fetch pipeline 或 plan。
- `capabilities` 用于选择、配置检查和诊断，不是每次查询前的强制步骤。

## `search`

`search` 使用 `action` 区分四种请求。内置配置没有 `defaults.search_lane`；省略 `lane`、`lanes` 和 `preset` 时，只有宿主已配置默认 lane 才能执行，否则返回 `DEFAULT_NOT_CONFIGURED`。

### 内置 lane

| Lane | Output |
| --- | --- |
| `brave.search` | results |
| `context7.docs` | typed (`nb-search.docs-context@1`) |
| `exa.search` | results |
| `exa.synthesis` | typed (`nb-search.synthesis@1`) |
| `firecrawl.search` | results |
| `github.repositories` | results |
| `gma.research` | typed (`nb-search.multi-agent-research@1`) |
| `grok.synthesis` | typed (`nb-search.synthesis@1`) |
| `grok.x-synthesis` | typed (`nb-search.synthesis@1`) |
| `oac.synthesis` | typed (`nb-search.synthesis@1`) |
| `parallel.search` | results |
| `searxng.search` | results |
| `tavily.search` | results |
| `tavily.synthesis` | typed (`nb-search.synthesis@1`) |
| `zhipu.search` | results |

### `action: "run"`

- `query` 可为一个字符串或有序字符串数组。
- results operation 可使用单个 `lane`、有序 `lanes` 或 results-only `preset`。
- typed operation 只使用单个 `lane`；不要放进 `lanes` 或 preset。
- sync 是默认执行方式。async 必须提供稳定的 `idempotency_key`；sync 不传该字段。
- 同一 idempotency key 与同一规范化请求复用既有 job；同 key 不同请求会冲突。
- 单 query × 单 results lane 保留 provider 顺序；多列表由 runtime 做 canonical 去重、RRF、独立 evidence group 统计和稳定排序。
- typed output 以 lane registration 声明的 `schema_id` 返回 JSON。
- sync output 过大时会返回 `OUTPUT_TOO_LARGE`；如需完整值，显式改为 async，不要期待截断或自动切换。

### `action: "get"`

- 传 `job_id` 查询 async job 状态。
- 终态成功时读取唯一 result artifact 的 metadata。

### `action: "read"`

- 传 `job_id`，可选 `cursor` 与 `page_size`。
- 按 `next_cursor` 继续读取，直至 cursor 缺省；将所有 base64 chunk 按顺序拼接为 UTF-8 JSON。
- cursor 与 artifact SHA 绑定，不跨 job 或 artifact 重用。

### `action: "cancel"`

- 传 `job_id` 记录取消请求。
- 返回值只表示请求已记录，不代表上游已经停止，也不保证不会计费。

## `fetch`

内置 pipeline 是 `direct.fetch`、`direct.local`、`jina.reader`、`exa.contents`、`tavily.extract`、`firecrawl.scrape`。默认 URL 链为 `direct.fetch` → `jina.reader`；`inline_text`、`inline_bytes` 和 `file` 默认使用 `direct.local`。

### `action: "run"`

- `source` 是 `{ kind: "url", url }`、`{ kind: "inline_text", content, media_type, base_url? }`、`{ kind: "inline_bytes", content_base64, media_type, filename? }` 或 `{ kind: "file", scope, path }`。
- `representation` 是 `markdown`（默认）或 `text`。
- 不传 `pipeline` 时按 `capabilities.fetch.chains` 的 input kind 与 representation 匹配并串行尝试；显式 `pipeline` 只调用该 pipeline，且必须支持请求的 source、representation 与 execution mode。
- file 与 inline source 只能进入 `egress: none` pipeline；file 使用 capabilities 暴露的 scope id 与 scope 内相对路径，未配置 scope 时 file input 不可用。
- 内置 `direct.local` 支持 sync/async；其余内置 fetch pipeline 仅支持 sync。以 `capabilities.fetch.pipelines[].execution_modes` 为准。
- 非 404/410 的 HTTP 失败、provider/auth/rate-limit、transport、字节上限或质量门失败可进入下一 pipeline；`FETCH_BLOCKED`、404、410、`FETCH_CONTENT_TYPE_REJECTED`、取消、deadline 或预算耗尽会终止。
- `direct.fetch` 只提供受限文本抓取和确定性 HTML→text，不代表浏览器渲染或高保真版面还原。
- 成功内容位于 `documents`；每次尝试或跳过记录在 `lane_outcomes`，document 同时报告 `representation` 与 source `media_type`。
- async 必须提供稳定的 `idempotency_key`；sync 不传该字段。

### `action: "get" | "read" | "cancel"`

- `get` 传 `job_id` 查询 fetch job 状态与成功 artifact metadata。
- `read` 传 `job_id`，可选 `cursor` 与 `page_size`，并按 `next_cursor` 读取完整 JSON artifact。
- `cancel` 传 `job_id` 记录取消请求，不承诺上游已停止或不会计费。

## `capabilities`

- 静态查看 query lane、fetch pipeline descriptor、chains、inputs、有效 execution modes、availability 和运行上限。
- 结果不进行网络健康探测，也不应被用作 runtime 自动选路输入。

## 禁止模式

- 不读取隐藏 history/session 作为强制前置步骤。
- 不假定 runtime 会做查询扩展、按成本/延迟/健康自动选择或替换 lane。
- 不把 fetch 内容称为已语义核验的引用。
- 不尝试枚举 job，也不传 artifact selector、checkpoint 或 revision。
