---
layout: home
title: nb-search — 统一网页搜索、URL 转 Markdown 与深度研究
description: 用一个 3 工具 MCP (~1.4k Token) 或 Agent Skill (~110 Token) 替代 5 个高消耗搜索服务，内置零密钥启动、多源 RRF 融合、32 密钥池容灾与后台异步研究。

hero:
  name: nb-search
  text: 网页搜索、正文提取与深度研究
  tagline: 用 3 工具 MCP（~1.4k Token）或 Agent Skill（~110 Token）替代 5 套独立工具——开箱免密即用，按需接入 14+ 数据源、RRF 融合与 32 密钥池轮转。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quickstart
    - theme: alt
      text: 数据源目录
      link: /sources/

features:
  - title: 省下 90% 上下文开销
    details: 严格仅暴露 search、fetch、capabilities 3 个 MCP 工具（约 1.4k Token）或挂载 Agent Skill（静默约 110 Token），告别叠加多个厂商 MCP 动辄消耗 15k–35k Token。
  - title: 零密钥即用 + 按需 BYOK
    details: 内置 DuckDuckGo、GitHub、Context7、Defuddle 直抓、Jina Reader 与 Wayback 免密源；接入 Exa、Tavily、Brave、Firecrawl、Grok、智谱、SearXNG 或知乎即可解锁全量检索。
  - title: 多源 RRF 与额度保护
    details: 并行检索多引擎并完成 URL 规范化去重与倒数排名融合（RRF）；静态网页、GitHub/npm/PyPI 元数据优先走本地 Defuddle 提取，遇到验证墙明确报错不烧积分。
  - title: 32 密钥容灾与异步任务
    details: 单源支持逗号分隔最多 32 把密钥自动冷却 429 与跳过 402；长耗时深度研究、整站爬取与 Playwright 渲染走后台异步任务，彻底避开 MCP stdio 60 秒超时。
---

## 30 秒免密钥体验

需要 **Node.js >= 24.15**。全局安装后即可直接运行通用搜索、库文档检索与网页转 Markdown：

```bash
npm install -g @nb-corp/nb-search

nb-search search "WebAssembly component model"
nb-search search "react useOptimistic" --lane context7.docs
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

在 `Claude Code`、`Codex`、`Claude Desktop` 或 `Cursor` 中通过 `npx` 一键挂载 MCP 服务（仅使用免密源时可省略 `env`）：

```json
{
  "mcpServers": {
    "nb-search": {
      "command": "npx",
      "args": ["-y", "--package=@nb-corp/nb-search", "nb-search-mcp"],
      "env": {
        "NB_SEARCH_TAVILY_API_KEY": "YOUR_API_KEY",
        "NB_SEARCH_EXA_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

## 为什么不用叠加多个独立 MCP？

| 能力维度 | 叠加 4–5 个厂商官方 MCP | 多源 BYOK 封装 (`mcp-omnisearch`) | 纯免密爬虫 (`open-webSearch`) | `@nb-corp/nb-search` |
| --- | --- | --- | --- | --- |
| **上下文开销** | 约 15k–35k Token（20+ 工具） | 约 4k–8k Token（按厂商拆工具） | 约 1k–2k Token | **约 1.4k Token（MCP）/ 约 110 Token（Skill）** |
| **零密钥启动** | 不支持 | 不支持（强制前置配 Key） | 仅公共网页 HTML | **支持 6 类免密源 + 10+ 类商业/自建 BYOK** |
| **多引擎 RRF 融合** | 需模型手工合并去重 | 单次仅调单一引擎 | 无官方 API 证据归属 | **URL 规范化去重 + RRF 排序 + 来源归属追溯** |
| **多 Key `429` 容灾** | 无 | 单源单密钥 | 无（单 IP 易受限） | **单源最多 32 Key 轮转、`Retry-After` 冷却与 `402` 跳过** |
| **URL 抓取额度保护** | 每次抓取均扣付费积分 | 直接请求商业抓取接口 | 仅基础 HTML 提取 | **Defuddle Direct 优先 + 有序路由 + 验证墙阻断** |
| **>60s 异步研究与渲染** | 触发 60 秒 `stdio` 超时 | 长任务同步阻塞超时 | 不支持 | **后台脱机 `run`/`get`/`read`/`cancel` 异步作业** |

## 文档与 AI 检索导航

- **入门与集成**：[快速开始](/guide/quickstart) · [配置与 32 密钥轮转](/guide/configuration) · [SDK / CLI / MCP / Skill 接入](/guide/integrations)
- **能力与数据源**：[数据源总览](/sources/) · [通用与区域网页搜索](/sources/web-search) · [URL 抓取与路由](/guide/fetch) · [异步作业管理](/guide/jobs)
- **参考与机器可读索引**：[CLI 参考](/reference/cli) · [运行时契约](/reference/runtime) · [llms.txt](/llms.txt) · [llms-full.txt](/llms-full.txt)
