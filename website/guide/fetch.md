# 内容抓取 (Fetch)

`nb-search` 的 fetch 主要用于在搜索后读取公共网络 URL 正文；`fetch`、`direct.local` 与 `browser.render` 等既有入口仍保留兼容，受控本地文件和 inline 输入的合同见下文。需要处理本地文件/HTML/PDF/Office（含 OCR），并保存完整 Markdown 与资源（assets）时，请使用独立的 [nb-extract](https://github.com/NB-Corp/nb-extract) 工具。

## 架构区分：Envelope 与 Document Schema

抓取调用返回的最外层信封为 `schema_version: "3.0"`，成功提取的内容存放在顶层 `documents` 数组中。每个文档的生成规范遵循抓取管道的 `nb-search.fetch@1` 操作契约。

## 输入类型与表示格式

### 输入源 (Source Kind)

- `url`：公共网络 HTTP(S) 地址。
- `file`：本地文件。仅允许使用相对路径，且必须在配置的 `file_scopes` 授权目录内。
- `inline_text` / `inline_bytes`：直接传入内存字符串或 Base64 编码数据。

### 输出表示格式 (Representation)

- `markdown`（默认）：输出 Markdown 文本。`direct` 管道采用轻量级文本/HTML 转换，并非保证结构化提炼；URL 正文提取可显式选择 `jina.reader`。
- `text`：输出纯文本。

## 抓取链 (Fetch Chain) 与执行规则

当调用未显式指定 `--pipeline` 时，系统根据输入类型匹配 `defaults.fetch_chain` 进行串行尝试：

- **URL 输入默认链**：
  1. `direct.fetch`：轻量级直接抓取，无外部密钥依赖。
  2. `jina.reader`：基于 Jina Reader 进行正文提取。
- **本地文件与行内数据默认链**：
  - 仅走 `direct.local`（不出外网，`egress: "none"`）。

### 错误中断与故障转移边界 (Fallback)

在抓取链中，**后备转移（Fallback）不等于网络重试**，而是按序尝试链中的下一个管道。在默认链尝试多个管道时，后备服务（例如 `jina.reader`）可能接收到该目标 URL。如果希望严格只调用某一个特定管道，请直接使用 `--pipeline <id>` 显式指定。

并非所有失败都会触发后备转移：
- **终态终止错误 (Terminal)**：遇到 404 或 410 状态码、SSRF 阻断（`FETCH_BLOCKED`）、内容类型不在白名单（`FETCH_CONTENT_TYPE_REJECTED`）、调用方取消（`CANCELLED`）、超时（`DEADLINE_EXCEEDED`）或超出预算（`BUDGET_EXCEEDED`）时，系统直接终止整个抓取，不会尝试链中的下一个管道。
- **触发后备转移错误 (Fallback)**：遇到质量门禁未通过（`QUALITY_GATE_FAILED`）、响应字节超限（`FETCH_BYTES_LIMIT`）、上游认证失败（`PROVIDER_AUTH`）、频率超限（`PROVIDER_RATE_LIMIT`）、服务不可用（`PROVIDER_UNAVAILABLE`）、内部错误（`INTERNAL`）以及非 404/410 的其他 HTTP 错误时，系统会记录当前 outcome 并转向链中的下一个候选管道。

## Pipeline 选择：默认链 vs. 显式指定

内置默认链只包含了 `direct.fetch` 与 `jina.reader`。其他抓取管道（包括 `exa.contents`、`tavily.extract`、`firecrawl.scrape`、`wayback.fetch`、`browser.render`、`oac.fetch` 以及本地 `direct.local`）在默认 URL 链中未启用。你可以：
1. 在调用时使用 `--pipeline <id>` 显式指定。
2. 或在宿主配置 `defaults.fetch_chain` 中定义自己的默认管道链。

显式指定示例：

```bash
# 抓取页面的 Wayback 历史归档快照
node scripts/nb-search.mjs fetch "https://nodejs.org/en/about/releases/" --pipeline wayback.fetch
```

## 安全限制与网络防护

抓取系统实施以下安全策略与边界控制：

1. **URL 校验与 SSRF 防护边界**：
   - 通用预检（`parsePublicUrl`）对 URL 进行语法格式与字面主机名/IP 检查，拒绝包含用户名密码、非法协议或字面私有/回环 IP 的地址。
   - 内置直接抓取（`direct.fetch`）实施严格的本地网络防护：在发起连接前解析 DNS，对所有返回的 IP 进行校验并锁定连接（IP Pinning），同时在每一次 HTTP 重定向时重新解析并严格检查，禁止跳转至私网或元数据地址。
   - 对于第三方代抓管道（如 `jina.reader`、`exa.contents`、`tavily.extract` 等），抓取请求由其云端服务发出，目标站点的内部 DNS 解析与重定向不受本机控制。
2. **字节与字符限制的处理路径**：
   - `direct.fetch` 直接 HTTP 抓取时，若响应超出 `max_response_bytes`，可进行有界截断，在 `warnings` 中记录 `FETCH_BYTES_LIMIT` 并设置 `documents[].truncated: true`。
   - 正文字符数超出 `max_content_chars` 时，提取正文会被截断，并在 `warnings` 中记录 `FETCH_CONTENT_CHARS_LIMIT`。
   - 本地 `inline_text`、`inline_bytes` 或 `file` 输入若超过 `max_source_bytes`，在进入管道前直接拒绝（报错 `FETCH_BYTES_LIMIT`）。
   - 第三方代抓管道（Jina、Exa、Tavily、Firecrawl 等）的 API 响应若超过客户端传输限制（`max_response_bytes`），该管道以 `FETCH_BYTES_LIMIT` 失败，不会将不完整的 API 响应当作成功内容。
   - 默认质量规则不设最短正文门禁（`min_content_chars: 0`）且不设默认拦截标记（`blocked_markers: []`）；若宿主显式配置了自定义质量门禁，截断后的内容仍须通过该门禁以及最终信封内联大小上限（`max_inline_bytes`）校验，才会作为成功结果返回。
   - 即使通过 CLI 的 `read --all` 读取了完整的 JSON Artifact，仅代表该作业产物文件完整读取，不代表抓取的上游网页未被截断。
3. **MIME 类型白名单**：非文本/HTML 类型直接被拒绝，返回 `FETCH_CONTENT_TYPE_REJECTED`。
4. **信封内联大小上限**：整个同步结果信封若超出 `execution.max_inline_bytes`（默认 16 MiB），返回 `OUTPUT_TOO_LARGE`。
