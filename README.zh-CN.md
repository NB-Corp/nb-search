<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img src="docs/assets/banner-light.svg" alt="nb-search — 让你的 AI，看到更大的世界。" width="1200">
</picture>

**搜得到，读得懂，研究得更深。一个接口，接入你的 AI。**

[![Node.js](https://img.shields.io/badge/Node.js-24.15%2B-2d4b35?style=flat-square)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2d4b35?style=flat-square)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-read_the_wiki-2d4b35?style=flat-square)](https://nb-corp.github.io/nb-search/)

[快速开始](#快速开始) · [完整文档](https://nb-corp.github.io/nb-search/) · [数据源目录](https://nb-corp.github.io/nb-search/sources/) · [Agent Skill](SKILL.md)

[English](README.md) · **简体中文**

</div>

不用再为每个数据源接一套工具。**nb-search** 把网页搜索、网页阅读和研究能力放进同一个 TypeScript 接口，数据源由你选择。

嵌入应用、在终端调用、连接 MCP，或直接交给 AI 助手使用。你可以在本地运行，也可以通过相同的客户端接口连接自己的 [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud) 服务。

<p align="center"><img src="docs/assets/workflow.svg" alt="AI 助手或应用 → nb-search → 搜索引擎、文档和研究来源" width="1200"></p>

## 为什么用 nb-search？

- **让 AI 不止会查一个来源。** Exa、Tavily、Brave、Grok、Jina、Firecrawl、GitHub，以及需显式启用的知乎内置来源。可组合检索结果，也可选择专门的研究能力。[查看支持的来源 →](https://nb-corp.github.io/nb-search/sources/)
- **多个主题，一起研究。** 独立问题并行发起；耗时研究交给异步任务，状态可查、任务可取消、结果可完整取回。
- **拿到能直接用的数据。** 带来源链接的搜索结果、提取后的文档、结构化研究内容，而不是再解析一大段聊天文本。
- **接入工作流，不接管工作流。** SDK、CLI、MCP、Skill 共用运行时。复用本地来源配置，或连接远程 profile，不必在每个助手里重复配置每个来源。

## 快速开始

**需要 Node.js ≥ 24.15。** 从官方 npm registry 安装 CLI：

```bash
npm install -g @nb-corp/nb-search@0.5.1 --registry=https://registry.npmjs.org
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

命令返回 JSON，正文位于 `documents[].content`，`status` 表示提取状态。这个直接抓取示例不需要服务商密钥。

从源码检出时，才需要 pnpm 安装依赖并构建：

```bash
git clone https://github.com/NB-Corp/nb-search.git
cd nb-search
pnpm install --frozen-lockfile
pnpm build
node scripts/nb-search.mjs fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

**0.5.1** 默认使用 DuckDuckGo 搜索通用网页，无需注册、API 密钥或手选 lane：

```bash
node scripts/nb-search.mjs search "中国 大熊猫 国家公园"
```

DuckDuckGo 的公共 HTML 端点可能触发验证或限流；工具会报告错误，不会伪装为空结果。等待后再试，或显式选择其他已配置的来源。仓库检索仍可选择 `github.repositories`。已配置的默认值和显式选择优先，显式删除默认值也会保留；失败不会静默切换到收费来源。*Lane* 就是命名的来源操作。[查看配置方式 →](https://nb-corp.github.io/nb-search/guide/configuration) 服务商费用与限额仍适用。

Direct HTML 主体提取和可配置的 URL 路由也可用：已知 GitHub raw 文本、仓库 JSON、npm 元数据及 PyPI JSON 默认仅走 Direct；用户规则可替换完整顺序列表，或恢复原抓取链。未命中的 URL 仍使用 Direct→Jina 默认链。回执显示路由来源、实际尝试与内容警告。[查看路由配置和宿主接口 →](docs/model-facing-lane-runtime.md#fetch)

## 显式启用知乎来源

知乎内置来源默认不创建 provider instance、credential slot 或 lane。要使用它，请在 schema 4 配置中同时声明三者，再显式选择 lane。下面的 `latency` 和 `cost` 是 lane 元数据，不是请求限额；请按部署情况填写：

```json
{
  "provider_instances": {
    "zhihu.manual": {
      "provider_id": "zhihu",
      "enabled": true,
      "credential_slot_id": "zhihu.manual",
      "base_url": "https://developer.zhihu.com",
      "options": {
        "allow_paid": false,
        "search_db": "all",
        "zhida_model": "zhida-fast-1p5",
        "search_path": "/api/v1/content/zhihu_search",
        "global_search_path": "/api/v1/content/global_search",
        "synthesis_path": "/v1/chat/completions",
        "quota_path": "/api/v1/quota"
      }
    }
  },
  "credential_slots": {
    "zhihu.manual": {
      "provider_id": "zhihu",
      "env": "NB_SEARCH_ZHIHU_API_KEY"
    }
  },
  "lanes": {
    "zhihu.search": {
      "provider_instance_id": "zhihu.manual",
      "operation_id": "search",
      "latency": "fast",
      "cost": "cheap"
    },
    "zhihu.global": {
      "provider_instance_id": "zhihu.manual",
      "operation_id": "global",
      "latency": "fast",
      "cost": "cheap"
    },
    "zhihu.synthesis": {
      "provider_instance_id": "zhihu.manual",
      "operation_id": "synthesis",
      "latency": "medium",
      "cost": "cheap"
    }
  }
}
```

在运行 nb-search 的环境中，把 `NB_SEARCH_ZHIHU_API_KEY` 设置为 `YOUR_API_KEY`，再显式选择 lane：

```bash
node scripts/nb-search.mjs search "人工智能" --lane zhihu.search
node scripts/nb-search.mjs search "人工智能" --lane zhihu.global
node scripts/nb-search.mjs search "比较近期的人工智能研究趋势" --lane zhihu.synthesis
```

- `zhihu.search` 发送 `GET /api/v1/content/zhihu_search`。`query` 会先去除首尾空白，长度必须为 2–100；请求数量会被限制在 1–10。
- `zhihu.global` 发送 `GET /api/v1/content/global_search`；请求数量会被限制在 1–20。`options.search_db` 默认是 `all`，也可设为 `realtime` 或 `static`。
- `zhihu.synthesis` 发送 `POST /v1/chat/completions`，输出类型为 `nb-search.synthesis@1`。`options.zhida_model` 默认是 `zhida-fast-1p5`，也可使用 `zhida-thinking-1p5`、`zhida-agent` 或其他非空自定义模型名。
- 三个 lane 都支持同步和异步执行。可配置的路径选项是 `search_path`、`global_search_path`、`synthesis_path` 和 `quota_path`；上面的示例使用官方默认值。

官方 `base_url` 默认值是 `https://developer.zhihu.com`，它是 URL 前缀：配置的路径会追加到此前缀后，不会替换此前缀。知乎以及 Tavily、Firecrawl 的用量请求都保持这一前缀语义。如需经反向代理转发，可将 `base_url` 指向代理前缀（例如 `https://relay.example.test/zhihu`）。

`allow_paid` 默认是 `false`。免费配额耗尽或无法验证时，配额守卫会拒绝请求；配额账本在同一运行时内按配额端点与凭据共享预留，并对未收到明确回执的异常发送保留扣减直至上游 `TotalUsed` 推进或北京时间 00:00 重置；只有确认剩余量大于 32 时才缓存配额（最长 60 秒）。每日配额在 Asia/Shanghai（UTC+8）00:00 重置。只有明确选择钱包计费时，才设置 `allow_paid: true`。

`keyUsage()` 同样读取 `GET /api/v1/quota`，在 `KeyUsage.usage.meters` 中返回按 API 分开的 request 计数。旧版 credits 摘要取自 `zhihu_search`，没有该项时使用首个 meter；仅当 `zhihu_search` 和 `global_search` 的剩余量都为零时，才将密钥标记为耗尽。

## 三个方法，接入你的应用

```bash
npm install @nb-corp/nb-search@0.5.1 --registry=https://registry.npmjs.org
```

```js
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const search = createNbSearchRuntime();
const page = await search.fetch({
  action: 'run',
  source: {
    kind: 'url',
    url: 'https://nodejs.org/en/about/releases/'
  },
  pipeline: 'direct.fetch'
});

if (page.action === 'run' && page.execution === 'sync' && page.status === 'succeeded' && page.documents.length > 0) {
  console.log(page.documents[0].content);
}
```

这段代码读取公共网页，需要联网但不需要服务商密钥。用 `search.search()` 检索，用 `search.capabilities()` 查看可用能力。[SDK 示例、MCP 与远程连接 →](https://nb-corp.github.io/nb-search/guide/integrations)

TypeScript 项目使用当前打包声明时，应启用 `skipLibCheck: true`。[查看兼容性说明 →](https://nb-corp.github.io/nb-search/guide/integrations)

## 用自己的 JS/TS 脚本扩展 Lane

在配置中为 `script` provider 指定可信本地模块，导出 `execute(request, context)` 或 `search(query, context)` 并返回结果数组，即可通过标准 CLI、SDK 和 detached async 作业使用，无需另写 CLI 封装。

[可运行的本地目录样例](examples/script-lane/config.json) 不需要联网或凭据。将 `NB_SEARCH_CONFIG` 指向该文件后运行 `nb-search search "Node" --lane local.search`。配置文件里的相对模块路径以配置目录为基准，SDK inline 配置以调用 cwd 为基准。

脚本与运行进程同权限，并非沙箱。请配合 `context.signal` 取消，使用 `context.logger` 输出 stderr，不要写 stdout 破坏 CLI JSON。[模块合同、TS 限制与部署说明 →](https://nb-corp.github.io/nb-search/sources/custom)

## 选一个入口，开始用

| 你想做什么 | 从这里开始 |
| --- | --- |
| 给 AI 助手接入搜索与研究 | [官方 nb-search Skill](SKILL.md) |
| 把网页或文件转换为 Markdown | [nb-extract](https://github.com/NB-Corp/nb-extract)：网页/文件→Markdown 文档转换入口 |
| 在应用或 MCP 宿主中集成 | [接入指南](https://nb-corp.github.io/nb-search/guide/integrations) |
| 团队统一管理来源凭证与调用 | [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud)：自托管用户、密钥与用量管理 |

## 详细用法交给 Wiki

[配置与凭证](https://nb-corp.github.io/nb-search/guide/configuration) · [正文提取](https://nb-corp.github.io/nb-search/guide/fetch) · [异步任务](https://nb-corp.github.io/nb-search/guide/jobs) · [故障排查](https://nb-corp.github.io/nb-search/guide/troubleshooting) · [升级指南](https://nb-corp.github.io/nb-search/guide/upgrading)

发现来源失效、接入问题，或者有更好的示例？欢迎[提交 Issue](https://github.com/NB-Corp/nb-search/issues) 或一个聚焦改进的 PR。报告中不要包含凭证。

[MIT](LICENSE) · [NB-Corp](https://github.com/NB-Corp)
