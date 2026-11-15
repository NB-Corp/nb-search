# 快速上手

本指南介绍如何在本地准备运行环境、检查可用能力目录，并完成第一次搜索与抓取验证。

::: info 版本适用范围
以下文档适用于 `@nb-corp/nb-search` `0.5.0` 及以上版本（当前版本 `0.5.2`）。
:::

## 环境要求

- **Node.js**：`>=24.15.0`
- **源码构建工具**：`pnpm@10.33.0`（仅从源码仓库构建时需要）

## 获取与构建

::: code-group

```bash [全局 CLI]
npm install -g @nb-corp/nb-search
nb-search search "WebAssembly component model"
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

```bash [项目 SDK]
npm install @nb-corp/nb-search
```

```bash [从源码构建]
git clone https://github.com/NB-Corp/nb-search.git
cd nb-search
pnpm install --frozen-lockfile
pnpm build
```

:::

安装包或构建源码后，包内提供官方 launcher。如果作为 Skill 使用，必须保留包根目录及完整的 `SKILL.md`、`scripts/`、`dist/` 结构；不能只复制部分目录，否则启动器会返回 `ENTRY_UNAVAILABLE`。

### 作为官方 Skill 装载

宿主代理（Agent）或工作流环境可直接将 npm 包或源码目录挂载为 Skill：
- **npm 全局安装**：运行 `npm install -g @nb-corp/nb-search` 后，使用 `$(npm root -g)/@nb-corp/nb-search/skills/nb-search`（或包根目录 `$(npm root -g)/@nb-corp/nb-search`）；项目内安装则使用 `node_modules/@nb-corp/nb-search/skills/nb-search`。
- **源码构建**：将仓库根目录指定为 `<skill_dir>`。
- **调用约定**：Skill 调度脚本固定为 `node "<skill_dir>/scripts/nb-search.mjs"`，启动器会自动定位并加载包内 `dist/cli.mjs`，无需宿主另行配置系统 PATH。
- **嵌套结构**：包内同时包含兼容入口 `skills/nb-search` 以适配特定宿主布局，但它并非可独立搬移的隔离包，仍依赖根目录的 `scripts/` 与构建产物，必须完整保留与包根目录的相对路径关系。

### 命令行调试入口

- 作为 npm 依赖安装时：使用 `node node_modules/@nb-corp/nb-search/scripts/nb-search.mjs`，或调用本地可执行文件 `npx nb-search`
- 源码仓库检出时：在仓库根目录使用 `node scripts/nb-search.mjs`

在后续教程中，统一以 `nb-search` 指代上述入口命令。如果你在源码根目录调试，可将 `nb-search` 替换为 `node scripts/nb-search.mjs`；如果你在应用项目中调试，可替换为 `npx nb-search`。

## 第一步：查看能力清单 (Capabilities)

`capabilities` 命令用于输出当前运行时支持的 Provider、Lane 与 Pipeline 列表，不需要提供任何 Provider 密钥，也不会发起外部网络探测。

::: code-group

```bash [POSIX (Linux / macOS)]
nb-search capabilities
```

```powershell [Windows PowerShell]
nb-search capabilities
```

:::

输出为符合全局 `3.0` Schema Envelope 的 JSON 对象。在未配置任何第三方密钥前，大部分需要外部凭据的 Lane 会标记为未就绪，但静态目录本身可以完整查看。

::: tip 状态说明
输出中的 `ready` 仅代表本地配置与运行时端口已经初始化完成，并不代表上游 Provider 的网络连通性、配额或服务健康度。
:::

## 第二步：免 Key 验证抓取功能

验证本地运行时可以使用具有正文内容的公共网页，或者使用无需外网的 `direct.local` 行内内容进行测试：

::: code-group

```bash [POSIX (公共 URL 抓取)]
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

```powershell [Windows PowerShell (公共 URL 抓取)]
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

```bash [POSIX (本地行内数据免网验证)]
nb-search fetch --stdin << 'EOF'
{"action":"run","source":{"kind":"inline_text","content":"你好，nb-search 本地抓取验证。","media_type":"text/plain"},"pipeline":"direct.local"}
EOF
```

:::

抓取成功后，返回顶层属性包含 `schema_version: "3.0"` 的 Envelope 对象，实际提取的文档位于顶层 `documents` 数组中。单个管道的抓取操作契约遵循 `nb-search.fetch@1`。

## 第三步：零密钥搜索与 BYOK 多源检索

`0.5.0` 及以上版本默认将通用网页搜索绑定到免密的 `duckduckgo.search`（同时内置免密的 `github.repositories` 与 `context7.docs`），无需配置任何 API Key 即可直接执行首次搜索：

```bash
nb-search search "VitePress sitemap generation"
nb-search search "react useOptimistic" --lane context7.docs
nb-search search "language:typescript model context protocol" --lane github.repositories
```

::: warning 免密源错误边界
`duckduckgo.search` 的公共 HTML 端点若触发人机验证或 `429` 限流，CLI 会直接返回明确错误码，**绝不伪装为空结果，也不会静默切换到付费 API**。仅当配置中显式清除了默认源（`"defaults": { "search_lane": null }`）且命令行未传 `--lane` 时，才会返回 `DEFAULT_NOT_CONFIGURED`。
:::

接入自有商业 API Key（BYOK）后，可指定单个高精度引擎或通过 `--lanes` 执行多源 RRF 去重融合：

::: code-group

```bash [POSIX (Linux / macOS)]
export NB_SEARCH_TAVILY_API_KEY="YOUR_API_KEY"
export NB_SEARCH_EXA_API_KEY="YOUR_API_KEY"
nb-search search "site:github.com node" --lanes exa.search,tavily.search
```

```powershell [Windows PowerShell]
$env:NB_SEARCH_TAVILY_API_KEY = "YOUR_API_KEY"
$env:NB_SEARCH_EXA_API_KEY = "YOUR_API_KEY"
nb-search search "site:github.com node" --lanes exa.search,tavily.search
```

:::

执行后，`stdout` 返回顶层包含 `schema_version: "3.0"` 的执行信封，其中的 `output` 对应 `nb-search.results@1`（或 `context7.docs` 等单源 Typed Schema）数据对象。如需调整默认源、配置最多 32 把密钥轮转或设置 URL 路由，详见[配置系统指南](/guide/configuration)。
