# 接入方式

`nb-search` 提供四种访问形态，满足不同的系统集成需求。无论通过哪种方式接入，底层的能力定义、输入验证与输出数据结构都保持一致。

## 1. Node.js SDK

SDK 适合直接嵌入在 Node.js 后端服务或宿主应用中运行，要求 Node.js `>=24.15.0`。

### 搜索与能力查询

```typescript
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = await createNbSearchRuntime({
  config: {
    schema_version: '4',
    defaults: {
      search_lane: 'brave.search'
    }
  }
});

// 执行同步搜索
const searchResponse = await runtime.search({
  action: 'run',
  query: 'node 24 LTS release notes',
  execution: 'sync'
});

// 获取能力目录元数据
const catalog = await runtime.capabilities();
```

### 读取 URL 正文

网页正文阅读是 `nb-search` 的主要抓取场景：

```typescript
const fetchResponse = await runtime.fetch({
  action: 'run',
  source: {
    kind: 'url',
    url: 'https://nodejs.org/en/about/releases/'
  },
  representation: 'markdown',
  execution: 'sync'
});

if (fetchResponse.action === 'run' && fetchResponse.execution === 'sync' && fetchResponse.status === 'succeeded' && fetchResponse.documents.length > 0) {
  console.log(fetchResponse.documents[0]!.content);
}
```

### 兼容：离线免网内容抓取

`direct.local` 及其 inline/file 输入仍保留兼容，可在进程内对已授权的本地文本或 HTML 进行清洗提取，不产生外部网络外发。需要处理本地文件/HTML/PDF/Office（含 OCR）并保存完整 Markdown 与资源（assets）时，请使用独立的 [nb-extract](https://github.com/NB-Corp/nb-extract) 工具：

```typescript
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = await createNbSearchRuntime();

const fetchResponse = await runtime.fetch({
  action: 'run',
  source: {
    kind: 'inline_text',
    content: '你好，nb-search 离线抓取。',
    media_type: 'text/plain'
  },
  pipeline: 'direct.local',
  execution: 'sync'
});

if (fetchResponse.action === 'run' && fetchResponse.execution === 'sync' && fetchResponse.status === 'succeeded' && fetchResponse.documents.length > 0) {
  const doc = fetchResponse.documents[0]!;
  console.log('Document fetched successfully, content:', doc.content);
}
```

SDK 暴露的核心操作仅有 `search`、`fetch` 和 `capabilities`。

### TypeScript 消费者兼容性提示

经过验证的 SDK 消费者构建设置采用 `skipLibCheck: true`。若在 TypeScript 6.0.2 环境下开启完整的第三方依赖声明检查（`skipLibCheck: false`），编译器会在打包内置的 Zod 类型声明中报告协变/逆变检查错误（TS2636）。设置 `skipLibCheck: true` 仅跳过外部依赖包的声明文件复检，不会降低应用自身业务代码的 strict 严格类型检查级别。对依赖声明有强行全检规范的项目，建议在集成前评估此兼容性特征。

### 高级宿主注入：Trusted HTTP Transport

对于需要在宿主进程内集中审计或代理网络流量的环境，`createNbSearchRuntime({ http_transport })` 支持传入实现根导出的 `HttpTransport` 对象（同时导出 `HttpRequest`、`HttpResponse`、`ResponseLimitError`）。该自定义传输对象由底层 Provider 适配器接收并处理其 HTTP 出网请求。需要注意：
- 注入 transport 会在当前运行时实例上禁用后台脱机异步任务（返回 `LANE_EXECUTION_UNSUPPORTED`），有效执行模式仅暴露同步（Sync）。
- `direct.fetch`、`wayback.fetch`、`browser.render` 及自定义 Provider 可能使用独立网络通道，并不保证全局受控于此注入对象。具体高级契约请参阅 [模型运行时规范](/reference/runtime)。

## 2. 命令行工具 (CLI)

CLI 适合脚本批处理、本地运维调试或作为独立子进程调用。

```bash
# 运行搜索
node scripts/nb-search.mjs search "site:github.com vitest" --lane exa.search

# 抓取页面
node scripts/nb-search.mjs fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch

# 查看能力目录
node scripts/nb-search.mjs capabilities
```

CLI 也支持通过标准输入传入完整的 JSON 参数，适用于复杂的结构化参数传递或 AI 宿主调度：

```bash
echo '{"action":"run","query":"typescript","lane":"tavily.search","execution":"sync"}' | \
  node scripts/nb-search.mjs search --stdin
```

::: warning Stdin 规则
使用 `--stdin` 时，输入必须是一个完整的 UTF-8 JSON 对象，且数据大小不能超过 4 MiB。不能在命令行上同时混用位置参数。
:::

## 3. MCP 服务器 (stdio)

`nb-search` 原生实现了 Model Context Protocol (MCP) 标准，通过 stdio 协议与 AI 桌面客户端（如 Claude Desktop）直接通信。

启动命令：

```bash
node dist/mcp.mjs
```

在 MCP 协议中，服务严格注册且仅注册 3 个工具：
- `search`
- `fetch`
- `capabilities`

所有工具参数均严格采用结构化命名参数，没有 CLI 的位置参数缩写。

## 4. 远程协议客户端 (Remote Client)

TypeScript 版本的远程客户端同样运行在 Node.js 环境中（同步工厂函数 `createNbSearchRemoteClient` 无需 `await`）。如果其他语言或服务需要在无 Node 依赖的环境下接入，可以直接遵循 [HTTP Protocol v1](/reference/remote-protocol) 实现调用。

```typescript
import { createNbSearchRemoteClient } from '@nb-corp/nb-search';

const accessKey = process.env.NB_SEARCH_REMOTE_KEY;
if (!accessKey) {
  throw new Error('Missing NB_SEARCH_REMOTE_KEY environment variable');
}

// 同步创建客户端实例，无需 await
const client = createNbSearchRemoteClient({
  base_url: 'https://search-service.internal/api/',
  access_key: accessKey
});

const result = await client.search({
  action: 'run',
  query: 'distributed systems',
  lane: 'searxng.search',
  execution: 'sync'
});
```

### 远程协议的重要约束

- **URL-only 抓取**：远程客户端发起 `fetch` 时仅支持公共 `url` 输入。`inline_text`、`inline_bytes` 和 `file` 输入会在发起网络请求前被客户端直接拒绝。
- **无静默重定向或重试**：远程客户端对 3xx 状态码直接判定为协议错误，绝不向重定向目标转发认证头；网络异常由调用方显式处理，客户端不做隐式网络重试。
- **服务边界**：官方并未提供公有云托管服务。这里的远程协议规范用于与自建或内部部署的兼容网关通信。
