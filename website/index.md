# nb-search

`nb-search` 面向 AI 宿主与工具集成环境，提供统一的 `search`、`fetch` 与 `capabilities` 运行时。它不自动替你挑选搜索服务，也不做静默的 fallback，而是通过确定的 Lane 与 Pipeline 合同，让模型或宿主在明确配置的前提下获得结构化数据。

本仓库实现本地运行时与 HTTP 协议客户端，不包含公开托管服务或在线控制台。

---

## 快速导航

- [首次配置](/guide/quickstart)：Node/pnpm 环境准备、目录检查与最小可用配置
- [配置系统与凭据](/guide/configuration)：Schema v4 规则、环境变量与优先级
- [接入方式](/guide/integrations)：SDK、CLI、MCP stdio 与远程协议客户端
- [信息源目录](/sources/index)：15 个 Search Lanes 与 9 个 Fetch Pipelines 完整清单
- [异步任务管理](/guide/jobs)：长耗时作业与完整产物获取
- [故障排查与诊断](/guide/troubleshooting)：常见错误码与定位步骤

---

## 核心设计原则

1. **确定性执行**：未指定 Lane 且未配置默认 Lane 时直接报错，不会隐式轮询其他源。
2. **凭据安全与边界隔离**：capabilities catalog 只暴露配置就绪状态，不回显原始密钥与真实地址；本地文件抓取严格限制在授权路径内。
3. **结构化输出**：搜索结果采用 `nb-search.results@1` 或显式 Typed Schema，抓取结果采用 `nb-search.fetch@1`，保证下游消费一致。
