import fs from 'node:fs'
import path from 'node:path'
import type { HeadConfig, SiteConfig, TransformContext } from 'vitepress'

export const SITE_ORIGIN = 'https://nb-corp.github.io'
export const SITE_BASE = '/nb-search/'
export const SITE_URL = `${SITE_ORIGIN}${SITE_BASE}`
export const OG_IMAGE_URL = `${SITE_URL}og-card.png`

interface LlmsDocEntry {
  urlPath: string
  filePath: string
  title: string
  summary: string
}

const LLMS_SECTIONS: Array<{ heading: string; entries: LlmsDocEntry[] }> = [
  {
    heading: 'Overview & Agent Execution Protocol',
    entries: [
      {
        urlPath: 'en/',
        filePath: 'website/en/index.md',
        title: 'English Overview & Quickstart',
        summary: 'Zero-key CLI, 3-tool MCP (~1.4k tokens), Agent Skill (~110 idle tokens), TypeScript SDK, RRF fusion, 32-key failover, and comparison matrix.'
      },
      {
        urlPath: '',
        filePath: 'website/index.md',
        title: '中文首页与产品总览',
        summary: '面向 AI Agent 与 TypeScript 应用的统一搜索、URL 转 Markdown、RRF 融合与异步深度研究总览。'
      }
    ]
  },
  {
    heading: 'Guides (入门与核心指南)',
    entries: [
      {
        urlPath: 'guide/quickstart',
        filePath: 'website/guide/quickstart.md',
        title: 'Quickstart (快速上手)',
        summary: 'Node.js >= 24.15 setup, zero-key DuckDuckGo/Defuddle verification, Skill mounting, and BYOK RRF search.'
      },
      {
        urlPath: 'guide/configuration',
        filePath: 'website/guide/configuration.md',
        title: 'Configuration & Multi-Key Rotation (配置与多密钥轮转)',
        summary: 'Schema v4 config precedence, environment variables, 32-key rotation (round-robin/priority), 429/402 failover, and local SDK keyUsage().'
      },
      {
        urlPath: 'guide/integrations',
        filePath: 'website/guide/integrations.md',
        title: 'Integrations: SDK, CLI, MCP & Skill (集成方式)',
        summary: 'TypeScript SDK (search, fetch, capabilities, keyUsage), CLI --stdin, npx nb-search-mcp stdio config, Agent Skill, and Remote HTTP client.'
      },
      {
        urlPath: 'guide/search',
        filePath: 'website/guide/search.md',
        title: 'Web Search & RRF Fusion (多源网页搜索)',
        summary: 'Results (nb-search.results@1) vs Typed channels, URL canonicalization, Reciprocal Rank Fusion (RRF), and provenance.'
      },
      {
        urlPath: 'guide/fetch',
        filePath: 'website/guide/fetch.md',
        title: 'URL-to-Markdown & Routing (内容抓取与路由)',
        summary: 'Defuddle direct.fetch, ordered URL routing (kiki-common-direct@1), fallback chains, SSRF IP pinning, and byte limits.'
      },
      {
        urlPath: 'guide/jobs',
        filePath: 'website/guide/jobs.md',
        title: 'Detached Async Jobs (异步作业与产物)',
        summary: 'Idempotent run/get/read/cancel lifecycle, --wait budgets, immutable SHA-256 chunk reconstruction via read --all, and 72h retention.'
      },
      {
        urlPath: 'guide/troubleshooting',
        filePath: 'website/guide/troubleshooting.md',
        title: 'Troubleshooting & Exit Codes (故障排查)',
        summary: 'CLI exit codes (0/2/3/4/5/6/7), error diagnostics, --doctor offline checks, and capabilities inspection.'
      },
      {
        urlPath: 'guide/upgrading',
        filePath: 'website/guide/upgrading.md',
        title: 'Upgrading Guide (版本升级指南)',
        summary: 'Compatibility notes across 0.3, 0.4, and 0.5.x (zero-key default search, Defuddle direct.fetch, opt-in Zhihu, and adapter fingerprints).'
      }
    ]
  },
  {
    heading: 'Supported Sources (数据源目录)',
    entries: [
      {
        urlPath: 'sources/',
        filePath: 'website/sources/index.md',
        title: 'Sources Catalog (18 Search Lanes + 9 Fetch Pipelines + Opt-in)',
        summary: 'Complete cost, latency, schema, credential, and execution-mode matrix across all built-in and opt-in providers.'
      },
      {
        urlPath: 'sources/web-search',
        filePath: 'website/sources/web-search.md',
        title: 'Web & Regional Search + Opt-in Zhihu (#zhihu)',
        summary: 'DuckDuckGo, Tavily, Exa, Brave, Firecrawl, SearXNG, Zhipu, Parallel, and full opt-in Zhihu schema-4 config & UTC+8 free-quota guard.'
      },
      {
        urlPath: 'sources/developer',
        filePath: 'website/sources/developer.md',
        title: 'Developer Sources: GitHub & Context7',
        summary: 'Keyless and token-boosted repository search (github.repositories) and library/framework documentation lookup (context7.docs).'
      },
      {
        urlPath: 'sources/grok',
        filePath: 'website/sources/grok.md',
        title: 'Synthesis & Multi-Agent Research (Grok, GMA, OAC)',
        summary: 'Grok Responses web/X synthesis, Grok Multi-Agent deep research (10-min default deadline), and OpenAI-compatible synthesis.'
      },
      {
        urlPath: 'sources/custom',
        filePath: 'website/sources/custom.md',
        title: 'Custom Script Lanes & SDK ProviderRegistration',
        summary: 'Trusted local .js/.ts script lanes supporting sync + detached async, plus in-process TypeScript ProviderRegistration.'
      }
    ]
  },
  {
    heading: 'Reference & Wire Contracts (参考与协议规范)',
    entries: [
      {
        urlPath: 'reference/cli',
        filePath: 'docs/cli.md',
        title: 'Official CLI Reference',
        summary: 'Complete CLI flags, local/remote profiles, protected secrets.json, --stdin JSON contract, --wait, read --all, and exit codes.'
      },
      {
        urlPath: 'reference/runtime',
        filePath: 'docs/model-facing-lane-runtime.md',
        title: 'Runtime & Host Architecture',
        summary: 'Schema v4 composition, captured host configuration, custom HTTP transport, offline operation resolver, URL routing, and SSRF boundaries.'
      },
      {
        urlPath: 'reference/remote-protocol',
        filePath: 'docs/remote-protocol.md',
        title: 'Remote HTTP Protocol v1',
        summary: 'Wire protocol for nb-search-cloud and remote gateways: headers, strict status mapping, idempotency, and URL-only fetch rules.'
      },
      {
        urlPath: 'reference/changelog',
        filePath: 'CHANGELOG.md',
        title: 'Changelog',
        summary: 'Release history from 0.2.0 through 0.5.2.'
      }
    ]
  }
]

export function toCanonicalUrl(relativePath: string): string {
  const clean = relativePath
    .replace(/\\/g, '/')
    .replace(/(^|\/)index\.md$/, '$1')
    .replace(/\.md$/, '')
  return `${SITE_URL}${clean}`
}

function buildJsonLd(version: string): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareSourceCode',
        name: '@nb-corp/nb-search',
        version,
        description:
          'Unified web search, URL-to-Markdown extraction, RRF multi-source fusion, multi-key rotation, and async deep research — TypeScript SDK, CLI, MCP server, and Agent Skill.',
        codeRepository: 'https://github.com/NB-Corp/nb-search',
        url: SITE_URL,
        license: 'https://opensource.org/licenses/MIT',
        programmingLanguage: 'TypeScript',
        runtimePlatform: 'Node.js >= 24.15.0'
      },
      {
        '@type': 'SoftwareApplication',
        name: '@nb-corp/nb-search',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Windows',
        softwareVersion: version,
        url: SITE_URL,
        downloadUrl: 'https://www.npmjs.com/package/@nb-corp/nb-search',
        license: 'https://opensource.org/licenses/MIT',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD'
        }
      }
    ]
  })
}

export function createTransformHead(version: string, fallbackDescription: string) {
  const jsonLd = buildJsonLd(version)

  return function transformHead(context: TransformContext): HeadConfig[] {
    if (context.pageData.isNotFound) return []

    const rel = context.pageData.relativePath.replace(/\\/g, '/')
    const canonical = toCanonicalUrl(rel)
    const isEnglish = rel.startsWith('en/')
    const pageTitle = context.title || context.pageData.title || 'nb-search'
    const pageDescription =
      context.description || context.pageData.description || fallbackDescription

    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'nb-search' }],
      ['meta', { property: 'og:title', content: pageTitle }],
      ['meta', { property: 'og:description', content: pageDescription }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:image', content: OG_IMAGE_URL }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:locale', content: isEnglish ? 'en_US' : 'zh_CN' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: pageTitle }],
      ['meta', { name: 'twitter:description', content: pageDescription }],
      ['meta', { name: 'twitter:image', content: OG_IMAGE_URL }]
    ]

    if (rel === 'index.md' || rel === 'en/index.md') {
      head.push(
        ['link', { rel: 'alternate', hreflang: 'zh-CN', href: SITE_URL }],
        ['link', { rel: 'alternate', hreflang: 'en', href: `${SITE_URL}en/` }],
        ['link', { rel: 'alternate', hreflang: 'x-default', href: `${SITE_URL}en/` }],
        ['script', { type: 'application/ld+json' }, jsonLd]
      )
    }

    return head
  }
}

function normalizeMarkdownForLlms(raw: string, baseDir: string): string {
  const withIncludes = raw.replace(/<!--@include:\s*([^\s>]+)\s*-->/g, (_match, relInclude: string) => {
    const target = path.resolve(baseDir, relInclude)
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : ''
  })

  const withoutFrontmatter = withIncludes.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')

  return withoutFrontmatter
    .replace(/^:::\s*code-group\s*$/gm, '')
    .replace(/^:::\s*(info|tip|warning|danger)(?:\s+(.*))?$/gm, (_m, kind: string, label?: string) =>
      `> **${(label || kind).trim()}**`
    )
    .replace(/^:::\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function writeLlmsArtifacts(siteConfig: SiteConfig, repoRoot: string, version: string): void {
  const llmsLines: string[] = [
    `# @nb-corp/nb-search (v${version})`,
    '',
    '> Unified web search, URL-to-Markdown extraction, Reciprocal Rank Fusion (RRF), 32-key failover, and detached async deep research — shipped as a 3-tool MCP server (~1.4k tokens), Agent Skill (~110 idle tokens), CLI, and TypeScript SDK (Node.js >= 24.15, MIT).',
    '',
    '- Install CLI / Skill: `npm install -g @nb-corp/nb-search`',
    '- Install TypeScript SDK: `npm install @nb-corp/nb-search`',
    '- Run MCP Server (stdio): `npx -y --package=@nb-corp/nb-search nb-search-mcp`',
    `- Complete Single-File Documentation Corpus: [llms-full.txt](${SITE_URL}llms-full.txt)`,
    '- Repository: [GitHub NB-Corp/nb-search](https://github.com/NB-Corp/nb-search) · [npm @nb-corp/nb-search](https://www.npmjs.com/package/@nb-corp/nb-search)',
    ''
  ]

  for (const section of LLMS_SECTIONS) {
    llmsLines.push(`## ${section.heading}`, '')
    for (const entry of section.entries) {
      llmsLines.push(`- [${entry.title}](${SITE_URL}${entry.urlPath}): ${entry.summary}`)
    }
    llmsLines.push('')
  }

  llmsLines.push(
    '## Optional & Sibling Tools',
    '',
    '- [Agent Skill Protocol (SKILL.md)](https://github.com/NB-Corp/nb-search/blob/main/SKILL.md): Full CLI execution rules, lane selection, URL routing, async job polling, and exit codes for coding agents.',
    '- [nb-extract](https://github.com/NB-Corp/nb-extract): Sibling tool for local PDF/Office/OCR conversion to Markdown and webpage media asset export.',
    '- [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud): Self-hosted team gateway implementing nb-search HTTP Protocol v1.',
    ''
  )

  const fullParts: string[] = [
    `# @nb-corp/nb-search v${version} — Complete Documentation Corpus`,
    '',
    `Canonical documentation index: ${SITE_URL}llms.txt`,
    'Package: @nb-corp/nb-search (TypeScript SDK, CLI, 3-tool MCP server, and Agent Skill)',
    'Repository: https://github.com/NB-Corp/nb-search',
    ''
  ]

  const skillPath = path.resolve(repoRoot, 'SKILL.md')
  if (fs.existsSync(skillPath)) {
    fullParts.push(
      '---',
      '',
      'Source: https://github.com/NB-Corp/nb-search/blob/main/SKILL.md',
      '',
      normalizeMarkdownForLlms(fs.readFileSync(skillPath, 'utf-8'), repoRoot),
      ''
    )
  }

  for (const section of LLMS_SECTIONS) {
    for (const entry of section.entries) {
      if (entry.urlPath === '') continue
      const absPath = path.resolve(repoRoot, entry.filePath)
      if (!fs.existsSync(absPath)) continue
      const cleaned = normalizeMarkdownForLlms(fs.readFileSync(absPath, 'utf-8'), path.dirname(absPath))
      fullParts.push(
        '---',
        '',
        `Source: ${SITE_URL}${entry.urlPath}`,
        '',
        cleaned,
        ''
      )
    }
  }

  fs.writeFileSync(path.join(siteConfig.outDir, 'llms.txt'), `${llmsLines.join('\n').trimEnd()}\n`, 'utf-8')
  fs.writeFileSync(path.join(siteConfig.outDir, 'llms-full.txt'), `${fullParts.join('\n').trimEnd()}\n`, 'utf-8')
}
