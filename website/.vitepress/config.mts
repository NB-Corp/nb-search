import { defineConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_URL, createTransformHead, writeLlmsArtifacts } from './seo'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const rootPkgPath = path.resolve(repoRoot, 'package.json')

let rootVersion = '0.5.2'
try {
  if (fs.existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'))
    if (rootPkg.version) {
      rootVersion = rootPkg.version
    }
  }
} catch {
  // fallback default
}

const siteDescription =
  '面向 AI Agent 与 TypeScript 应用的统一网页搜索、URL 转 Markdown、多源 RRF 融合、多密钥容灾与异步深度研究工具（MCP / Agent Skill / CLI / SDK）'

export default defineConfig({
  base: '/nb-search/',
  title: 'nb-search',
  description: siteDescription,
  lang: 'zh-CN',
  lastUpdated: true,
  cleanUrls: true,

  sitemap: {
    hostname: SITE_URL
  },

  transformHead: createTransformHead(rootVersion, siteDescription),

  buildEnd(siteConfig) {
    writeLlmsArtifacts(siteConfig, repoRoot, rootVersion)
  },

  // 避免将 workspace 临时历史、任务文档或环境密钥包含入站点构建
  srcExclude: [
    '**/README.md',
    '**/TODO.md',
    '**/.env*',
    '**/tasks/**',
    '**/task-*/**',
    '**/research/**'
  ],

  outDir: './.vitepress/dist',
  cacheDir: './.vitepress/cache',

  themeConfig: {
    siteTitle: 'nb-search',
    logo: '/logo.svg',

    nav: [
      { text: '指南', link: '/guide/quickstart', activeMatch: '^/guide/' },
      { text: '数据源', link: '/sources/', activeMatch: '^/sources/' },
      { text: '参考与协议', link: '/reference/cli', activeMatch: '^/reference/' },
      { text: 'English', link: '/en/', activeMatch: '^/en/' },
      {
        text: `v${rootVersion}`,
        items: [
          { text: '变更日志 (CHANGELOG)', link: '/reference/changelog' },
          { text: '版本升级指南', link: '/guide/upgrading' },
          { text: 'GitHub 源码仓库', link: 'https://github.com/NB-Corp/nb-search' }
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: '入门指南',
          items: [
            { text: '快速开始', link: '/guide/quickstart' },
            { text: '通道与凭证配置', link: '/guide/configuration' },
            { text: '集成方式 (SDK / CLI / MCP)', link: '/guide/integrations' }
          ]
        },
        {
          text: '核心功能',
          items: [
            { text: '多源网页搜索 (Search)', link: '/guide/search' },
            { text: '网页抓取与路由 (Fetch)', link: '/guide/fetch' },
            { text: '异步任务与并发 (Jobs)', link: '/guide/jobs' }
          ]
        },
        {
          text: '运维与迁移',
          items: [
            { text: '排错与诊断 (Troubleshooting)', link: '/guide/troubleshooting' },
            { text: '版本升级指南', link: '/guide/upgrading' }
          ]
        }
      ],
      '/sources/': [
        {
          text: '数据源总览',
          items: [
            { text: '数据源编目与通道设计', link: '/sources/' }
          ]
        },
        {
          text: '内置数据源与管道',
          items: [
            { text: '通用网页搜索与知乎源', link: '/sources/web-search' },
            { text: 'Grok 与多代理研究源', link: '/sources/grok' },
            { text: '开发者技术源 (GitHub / Docs)', link: '/sources/developer' },
            { text: '自定义脚本与 Provider 接入', link: '/sources/custom' }
          ]
        }
      ],
      '/reference/': [
        {
          text: '接口与参考规范',
          items: [
            { text: 'CLI 命令行参考', link: '/reference/cli' },
            { text: 'Remote HTTP 协议规范', link: '/reference/remote-protocol' },
            { text: '运行时与宿主契约', link: '/reference/runtime' },
            { text: '发布变更日志', link: '/reference/changelog' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/NB-Corp/nb-search' }
    ],

    editLink: {
      pattern: 'https://github.com/NB-Corp/nb-search/edit/main/website/:path',
      text: '在 GitHub 上编辑此页'
    },

    search: {
      provider: 'local',
      options: {
        detailedView: true,
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            displayDetails: '显示详细列表',
            resetButtonTitle: '清除查询',
            backButtonTitle: '关闭搜索',
            noResultsText: '无法找到相关结果',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车确认',
              navigateText: '切换',
              navigateUpKeyAriaLabel: '向上箭头',
              navigateDownKeyAriaLabel: '向下箭头',
              closeText: '关闭',
              closeKeyAriaLabel: 'ESC 退出'
            }
          }
        }
      }
    },

    outline: {
      level: [2, 3],
      label: '本页目录'
    },

    docFooter: {
      prev: '上一页',
      next: '下一页'
    },

    lastUpdated: {
      text: '最后更新于'
    },

    darkModeSwitchLabel: '外观模式',
    lightModeSwitchTitle: '切换至浅色模式',
    darkModeSwitchTitle: '切换至深色模式',
    sidebarMenuLabel: '目录菜单',
    returnToTopLabel: '返回顶部',
    langMenuLabel: '切换语言',
    skipToContentLabel: '跳转到主体内容',

    notFound: {
      title: '页面未找到',
      quote: '您访问的技术文档页面可能已移动或尚未就绪。',
      linkLabel: '返回文档首页',
      linkText: '返回文档首页',
      code: '404'
    },

    footer: {
      message: '基于 MIT 协议开源 · AI 索引: /nb-search/llms.txt',
      copyright: 'Copyright © 2026 NB-Corp & nb-search contributors'
    }
  }
})
