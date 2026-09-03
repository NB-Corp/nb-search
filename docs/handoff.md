# nb-search project handoff

artifact_mode: handoff
handoff_type: model
created_at: 2026-09-03
status: final
receiver: 接手 nb-search 的新模型会话 / agent
confidence: high

## 1. Continuation Target

Objective: 接手 nb-search 的继续开发。下一批候选工作（优先级从高到低）：（a）用户授权后的 push 到 GitHub 远端与 npm publish（包名 `@nb-corp/nb-search`，当前无 remote、未发布、2FA 问题未解决）；（b）用真实 credential 做各 provider 的 live smoke；（c）新能力：本地 extractor/converter 接入（Defuddle / trafilatura / markitdown 做 pipeline 内部 processor）、P2 商业 lane（走 custom registration）、crawl/map 语义（需要新设计稿）。
Scope: 包含 `systems/nb-search` 仓库全部开发与文档；不包含 Python `search-layer` skill 的 cutover、不包含 workspace 其它 system。
First next action: 读 `README.md` 与本文 §6 文件地图 → 跑 `pnpm install && pnpm test` 确认 285 tests 绿 → 跑一次 `node dist/cli.mjs capabilities` 看真实 lane 面。
Stop or escalation condition: 任何公开合同（contracts/types/capabilities 形状）改动必须先写设计稿（`tasks/` 新 task）并过独立 reviewer 门；push / npm publish / 修改 Python search-layer skill 必须用户显式授权，不得自行执行。
Route note: 不要重做 task-0013/0014/0015 已完成的任何事（fetch 链、fetch 语义丰富、12 条新 lane、Phase 2 三 pipeline）；不要恢复 `grok.search`、gateway、任何 legacy env alias——它们是刻意删除的。

## 2. Executive Summary

nb-search 是一个**模型-facing 的确定性搜索执行引擎**（TypeScript，npm 包 + GitHub 仓库 + CLI/SDK/MCP/agent-skill 四种接入面）。循环思考留给模型，服务只做确定性执行：供给抽象是 **lane**（带 latency/cost 标注的 provider 通道），公开能力只有三个：`search / fetch / capabilities`。

当前状态：task-0013（fetch 串行链）、task-0014（fetch 语义丰富）、task-0015（P0+P1+OAC lane 扩展）全部完成并通过独立 reviewer 终审（共 7 轮审查、20+ 缺陷全部修复）。search 侧 15 条 lane（8 results + 7 typed），fetch 侧 9 条 pipeline（含 file/inline 输入、egress 硬边界、async jobs）。main @ `9d0a7dd`，typecheck 0 错误、285 tests 全绿、smoke 通过、worktree 干净。

本文件存在的原因：项目刚结束一轮大型多切片并行开发，需要把「这是什么、文档在哪、决定了什么、下一步做什么」完整转移给没有会话历史的接手方。

## 3. Current State Snapshot

Facts:
- 仓库：`C:/Programs/AI/Search/systems/nb-search`，独立 git，branch `main` @ `9d0a7dd`，**无 remote、未 push、npm 未发布**（`git log --oneline`）。
- search lanes（15）：results = `exa.search`、`tavily.search`、`firecrawl.search`、`brave.search`、`zhipu.search`、`github.repositories`、`parallel.search`、`searxng.search`；typed = `exa.synthesis`、`tavily.synthesis`、`grok.synthesis`、`grok.x-synthesis`、`gma.research`、`context7.docs`、`oac.synthesis`（`src/config-sources.ts`）。
- fetch pipelines（9）：`direct.fetch`、`direct.local`、`jina.reader`、`exa.contents`、`tavily.extract`、`firecrawl.scrape`、`wayback.fetch`、`browser.render`（async-only）、`oac.fetch`（同上）。
- 默认面：`defaults.search_lane` 未设置（无默认 search lane）、无内置 preset、默认 fetch chain `direct.fetch → jina.reader`（`src/config-sources.ts:62`）。
- fetch 语义：source = `url | inline_text | inline_bytes | file`；representation `markdown | text`（默认 markdown）；pipeline 命名选择；egress `none|url|content` 硬边界；`run/get/read/cancel` 复用 unified job substrate（`src/contracts.ts`、`src/core.ts`）。
- 验证基线：`pnpm typecheck` 0 错误、`pnpm test` 20 files / 285 tests 全绿、`pnpm smoke` 通过（2026-09-03 最终复跑）。
- Assay 工作区：nb-search 是 primary system（`C:/Programs/AI/Search/.assay/systems-registry.json`）；参考项目源码在 `C:/Programs/AI/Search/sources/`（argus、crawl4ai、defuddle、markitdown、smartsearch、web-search-plus/pro 等 14 个）。

Inferences:
- 设计意图是「克制内置 + 显式选择」：lane 很多但默认面极窄，模型/用户必须显式选 lane/pipeline/preset，runtime 不做隐式路由（依据：README、SKILL、task-0012/0014 设计稿）。
- `browser.render` 与 `searxng.search` 在本机默认 unavailable：前者需 `pnpm add playwright` + Chromium（optional peer，未安装报 `BROWSER_NOT_INSTALLED`），后者需显式 `NB_SEARCH_SEARXNG_BASE_URL`。

Active constraints:
- 公开面精确三个工具，不得新增第四个动词（crawl/map/thread 若要做得先立新 task 设计）。
- typed lane 不进 preset/`lanes` 批选；fetch 无 preset，只有显式 pipeline 或 chain。
- egress 是硬边界：file/inline 输入永远进不了 `egress != 'none'` 的 pipeline。
- file scope 威胁模型：模型输入不可信（路径穿越/静态 symlink 逃逸/超限零外呼拒绝）；scope 目录是 host 可信资产，本机并发篡改出模型（task-0014 设计稿 R7，见 §6 文件地图）。
- 不留兼容：产品未发布，任何「旧形状」发现即删，不做 alias/迁移层。
- push / npm publish / 改 Python search-layer skill = 必须用户显式授权。

## 4. Decisions and Rationale

- Decision: 公开能力只有 `search / fetch / capabilities`；fetch 不改名为 document。
  Reason: 生态约定（官方 mcp-server-fetch 同样是 fetch+extract）+ 模型零学习成本；改名收益是理论的，成本是实的。
  Tradeoff: fetch 名义上 undersell 了 extraction/conversion 语义，靠 pipeline descriptor 和文档补足。
  Flip condition: 若将来本地文件/二进制转换成为主用法（URL 不再是主要输入），重评 `document`/`read`。
- Decision: fetch 多 lane = 有序串行链 + 首个合格即停 + 最小质量门 + 失败分类表；search 多 lane = 并行 fan-out + RRF。
  Reason: fetch 输出同构（一 URL 一文档），聚合无意义，意义在成功率分层；search 输出异构，意义在召回互补。外部先例：Browserless Smart Scrape、ScrapingBee、Crawl4AI、Argus。
  Tradeoff: 质量门只有两条规则（min_content_chars + blocked markers），牺牲「聪明」的内容充分性判定。
  Flip condition: 出现系统性「200 但空壳」漏判且两规则拦不住时，加显式 `min_content_chars` 之外的规则（先证据后加）。
- Decision: grok 从 chat/completions + prompt 编 JSON 迁移到 xAI Responses API，`grok.synthesis`/`grok.x-synthesis`（typed），旧 `grok.search` 删除不留双轨。
  Reason: prompt-JSON 不是可靠协议；Responses 的一等输出是 answer+citations，本质是 typed 而非 ranked results。
  Tradeoff: 失去唯一的 grok results lane；citation 不带 rank/snippet/页面标题。
  Flip condition: xAI 提供真正的 ranked-results endpoint。
- Decision: 商业 lane 克制内置（P0/P1 共 12 条新 lane），其余 P2 品牌（linkup/querit/you/valyu/serper/serpapi/keenable/perplexity）走 custom registration；`openai-compatible` 作为 generic provider 内置（oac.synthesis + oac.fetch）。
  Reason: 「又一个通用 web API」不构成生态位；协议兼容 ≠ 搜索合同兼容；OAC 例外是因为它能吃本机已有任意端点（含中转/自托管），符合「lane 受本机实际拥有制约」原则。
  Tradeoff: 用户想要 P2 品牌时需自己写 registration（当前 custom 仅 sync）。
  Flip condition: 某 P2 品牌出现明确用户需求或其独有语义（如 Perplexity Agent API 稳定）。
- Decision: 自托管二选一，内置 SearXNG（P1），不内置 OpenSERP。
  Reason: SearXNG 是薄 HTTP JSON 适配；OpenSERP 绑定 Go+Chromium 运行时，内置等于承诺运维。
  Tradeoff: 失去六引擎 scraper 生态位；本机已部署 OpenSERP 时可 custom 接入。
  Flip condition: 出现稳定托管的 OpenSERP endpoint 需求。
- Decision: 不设内置默认 search lane。
  Reason: credential readiness 因机器而异，静态默认只会制造 `LANE_NOT_CONFIGURED`；「只有一个 ready 就自动选」也是隐式路由。
  Tradeoff: 用户必须自己在 config 里设 `defaults.search_lane`。
  Flip condition: 用户明确要求内置默认。

## 5. Evidence and Source Map

- Evidence ID: E1
  Type: file
  Pointer: `tasks/` 下 task-0013 / task-0014 / task-0015 三个任务目录各自的 `design.md`（完整 slug 见 `tasks/` 目录列表）
  Supports: fetch 链、fetch 语义、lane 组合的全部设计合同与 AC
  Freshness: 2026-09-02/03，task-0014 R5/R7 有 2026-09-03 修订（direct.local async、file scope 威胁模型）
- Evidence ID: E2
  Type: test
  Pointer: `pnpm typecheck && pnpm test && pnpm smoke`（`systems/nb-search`）
  Supports: 最终态 typecheck 0 错误、20 files / 285 tests 全绿、smoke 通过
  Freshness: 2026-09-03 19:23 最终复跑
- Evidence ID: E3
  Type: review
  Pointer: 7 轮独立 reviewer 终审（rev_p0/rev_p1/rev_merge/rev_a/rev_phase2），结论全部 PASS；发现 20+ 缺陷（Context7/Zhipu 请求合同、GitHub 403 分类、file TOCTOU、egress 顺序、browser SSRF 三绕过、max_redirects 真实路径）全部修复并复检
  Supports: 各切片可收口结论
  Freshness: 2026-09-03
- Evidence ID: E4
  Type: source
  Pointer: `C:/Programs/AI/Search/sources/`（14 个参考项目 checkout）+ 逐项目 explore 报告（会话产出）
  Supports: lane 组合决策、fetch 链先例、文档转换/浏览器渲染候选
  Freshness: 2026-09-02 吸纳
- Evidence ID: E5
  Type: file
  Pointer: `systems/nb-search/.env.example`（29 个 canonical 变量，与 `src/config-sources.ts` 集合核对 missing=[] extra=[]）
  Supports: 配置面事实源
  Freshness: 2026-09-03

## 6. Artifacts and File Map

- `systems/nb-search/README.md` — 项目门面：架构、15+9 lane catalog（credential/typed/results/keyless 标注）、fetch 语义、默认行为。当前已收口。
- `systems/nb-search/SKILL.md` 与 `systems/nb-search/skills/nb-search/SKILL.md` — agent skill 两份（npm 包用 + agent 目录用），教学三能力与 fetch 新语义。改一个必须想另一个。
- `systems/nb-search/docs/model-facing-lane-runtime.md` — runtime 合同长文（lane 模型、fetch 语义、egress、job 协议）。
- `systems/nb-search/docs/handoff.md` — 本文件。
- `systems/nb-search/.env.example` — 29 个 canonical 环境变量（唯一事实源是 `src/config-sources.ts`）。
- `systems/nb-search/src/` — 关键文件：`contracts.ts`（公开 schema）、`types.ts`、`core.ts`（QueryEngine + FetchService）、`planner.ts`（lane/pipeline 解析与 egress 前置）、`provider-registry.ts`（registration 合同，`fetch_operations[]` + 按 operation id 索引的 ports）、`config-sources.ts`（内置配置 + env 映射）、`config.ts`（lane binding/availability/issue）、`config-schema.ts`（schema v4）、`providers.ts` + `providers/*.ts`（search adapters）、`fetch-providers.ts`（remote fetch pipelines）、`fetch-security.ts`（direct SSRF/redirect/有界读取原语）、`fetch-sources.ts`（file/inline source 安全）、`fetch-quality.ts`（质量门两规则）、`browser-render.ts`（Chromium + pinned proxy）、`query-jobs.ts`/`job-store.ts`/`execution-snapshot.ts`/`worker.ts`（unified job substrate）、`transport.ts`（JSON transport，非 2xx 有界读取）。
- `systems/nb-search/test/` — 20 个测试文件 285 tests；provider 测试全 mock transport；browser 测试含真实 Chromium probes。
- `tasks/task-0013..0015/`（workspace 根下）— 三个设计稿 + task.json（均 done）；历史 task-0003..0012 同目录。
- `C:/Programs/AI/Search/sources/` — 14 个参考项目（absorb 结构，源码在各自 `checkout/`）。
- `C:/Programs/AI/Search/.assay/systems-registry.json` — Assay 系统注册表（nb-search = primary）。

## 7. Open Questions, Assumptions, and Risks

Open questions:
- 是否/何时 push 到 GitHub 远端 + npm publish？需要用户授权；npm 2FA（早期 E403）未解决。影响：对外可用性。
- P2 品牌（linkup/you/valyu/perplexity 等）与本地 extractor（Defuddle/trafilatura/markitdown/MinerU）哪个先进？两者方向不同（更多 lane vs 更强 pipeline 内部）。影响：下一个 task 的选题。
- crawl/map 是否值得做公开语义？Tavily map、Firecrawl crawl、SearXNG 站点发现都在等这个决定。影响：是否出现第四个动词或 search 的 action 扩展。

Assumptions:
- 各 provider adapter 的请求形状正确（高置信）：全部经官方文档/WebSearch 核对 + mock 测试，但**除 Context7 匿名 endpoint 外未做真实 credential live call**。验证方式：配齐 key 后逐 lane 跑一次真实 query。
- `browser.render` 的 Playwright optional peer 方案在干净机器上可安装可用（中置信）：本机有 Playwright 1.62.1 实测通过；未在全新环境验证安装路径。

Risks:
- 商业 API 形状漂移（中）：Context7 已发生过一次 endpoint 漂移（`/api/v2/search` → `/api/v2/libs/search`）。缓解：adapter 测试 + live smoke 纳入常规验证。
- `browser.render` 资源约束是应用层（deadline/字节/JS heap），无 OS 级 CPU/RSS quota（低-中）。缓解：不进默认 chain，显式调用。
- tsdown 构建有 Zod CommonJS d.ts bundling 警告（低，非致命，不影响产物）。

## 8. Next Actions

1. 用户确认 push/publish 意向 — Owner/status: 用户/待决定 — Success check: `git remote -v` 有 origin 且 push 成功；`npm view @nb-corp/nb-search` 可解析。
2. 真实 credential live smoke — Owner/status: 接手方/待做 — Success check: 每个已配 key 的 lane 一次真实 query 返回 `succeeded` 且结果形状符合 schema；失败项记录到 issue。
3. 选定下一 task（本地 extractor pipeline 内部接入 / P2 品牌 / crawl-map 语义 三选一或明确都不做） — Owner/status: 用户+接手方/待决定 — Success check: 新 `tasks/task-0016-*/design.md` 落盘。
4. （可选）`pnpm add playwright` 验证 `browser.render` ready — Owner/status: 接手方/可做可不做 — Success check: `capabilities` 中 `browser.render.availability === 'ready'`，一次真实 JS 页面抓取成功。

## 9. Validation State

Checks run:
- Command/review: `pnpm typecheck`（`systems/nb-search`）
  Result: pass
  Notes: 0 错误；构建有非致命 Zod d.ts bundling 警告。
- Command/review: `pnpm test`
  Result: pass
  Notes: 20 files / 285 tests 全绿（2026-09-03 19:23 最终复跑）；含真实 Chromium security probes（DNS pinning、popup/WS 阻断、attachment、redirect 上限、共享字节预算）与 Windows rename EPERM/EACCES/EBUSY。
- Command/review: `pnpm smoke`
  Result: pass
  Notes: SDK 精确 `search/fetch/capabilities`；公开 exports 与 SKILL 检查通过。
- Command/review: 7 轮独立 reviewer（rev_p0、rev_p1、rev_merge、rev_a、rev_phase2 及各自复检）
  Result: pass
  Notes: 全部终审 PASS；无遗留 finding。

Known validation gaps:
- 未做真实 credential 的上游 live call（除 Context7 匿名 endpoint 实测）。关闭方式：Next Action 2。
- 未在干净环境验证 `pnpm add playwright` 后 `browser.render` 的 ready 路径。关闭方式：Next Action 4。
- `query-jobs` Unicode cursor 测试在高负载并行时偶发 15s 超时（单独重跑稳定通过），与本轮改动无关。关闭方式：如需消除可单独调测试超时，非阻塞。
