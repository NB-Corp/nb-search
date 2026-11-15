import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(websiteDir, '.vitepress/dist')
const siteUrl = 'https://nb-corp.github.io/nb-search/'
const base = '/nb-search/'
const routes = [
  'index',
  'guide/quickstart',
  'guide/configuration',
  'guide/integrations',
  'guide/search',
  'guide/fetch',
  'guide/jobs',
  'guide/troubleshooting',
  'guide/upgrading',
  'sources/index',
  'sources/web-search',
  'sources/grok',
  'sources/developer',
  'sources/custom',
  'reference/cli',
  'reference/remote-protocol',
  'reference/runtime',
  'reference/changelog'
]
const expectedPages = routes.flatMap(route => [`${route}.html`, `en/${route}.html`]).concat('404.html')
const expectedArtifacts = ['sitemap.xml', 'robots.txt', 'llms.txt', 'llms-full.txt', 'og-card.png']

console.log('Building documentation site…')
execSync('pnpm build', { cwd: websiteDir, stdio: 'inherit' })

for (const file of [...expectedPages, ...expectedArtifacts]) {
  const target = path.join(distDir, file)
  assert(fs.existsSync(target), `Missing generated file: ${file}`)
  assert(fs.statSync(target).size > 0, `Empty generated file: ${file}`)
}
console.log(`Verified ${expectedPages.length} HTML pages and ${expectedArtifacts.length} static artifacts.`)

for (const route of routes) {
  const urlPath = route.replace(/(^|\/)index$/, '$1')
  const zhUrl = `${siteUrl}${urlPath}`
  const enUrl = `${siteUrl}en/${urlPath}`
  for (const prefix of ['', 'en/']) {
    const file = `${prefix}${route}.html`
    const html = fs.readFileSync(path.join(distDir, file), 'utf-8')
    const canonical = prefix ? enUrl : zhUrl
    assert(html.includes(`rel="canonical" href="${canonical}"`), `Missing canonical: ${file}`)
    for (const [lang, href] of [['zh-CN', zhUrl], ['en', enUrl], ['x-default', enUrl]]) {
      assert(html.includes(`rel="alternate" hreflang="${lang}" href="${href}"`), `Missing ${lang} alternate: ${file}`)
    }
    assert(html.includes(`<html lang="${prefix ? 'en-US' : 'zh-CN'}"`), `Incorrect locale: ${file}`)
    assert(html.includes('VPNavBarTranslations'), `Missing native desktop language switcher: ${file}`)
    if (route === 'index') {
      assert(html.includes('application/ld+json'), `Missing homepage JSON-LD: ${file}`)
      assert(html.includes('class="VPHome"'), `Homepage must use layout: home: ${file}`)
      assert(html.includes(`${base}assets/`) && html.includes(`${base}vp-icons.css`), `Incorrect asset base: ${file}`)
      assert(html.includes(`${siteUrl}og-card.png`), `Missing OpenGraph image: ${file}`)
    }
  }
}
for (const prefix of ['', 'en/']) {
  const html = fs.readFileSync(path.join(distDir, `${prefix}sources/web-search.html`), 'utf-8')
  assert(html.includes('id="zhihu"'), `Missing explicit #zhihu anchor in ${prefix}sources/web-search`)
}
console.log('Verified canonical URLs, symmetric hreflang, native switchers, home layouts, and #zhihu anchors.')

const allFiles = fs.readdirSync(distDir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => path.join(entry.parentPath, entry.name))
const available = new Set(allFiles.map(file => path.resolve(file)))
const htmlFiles = allFiles.filter(file => file.endsWith('.html'))
assert.equal(htmlFiles.length, expectedPages.length, 'Unexpected HTML route count')

// Match the generated href/src gate in .github/workflows/pages.yml.
for (const source of htmlFiles) {
  const html = fs.readFileSync(source, 'utf-8')
  for (const match of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1]
    if (value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue
    let target = value.split('#', 1)[0].split('?', 1)[0]
    if (target.startsWith(base)) target = target.slice(base.length)
    else if (target.startsWith('/')) target = target.slice(1)
    target = decodeURIComponent(target)
    assert(!target.includes('\0'), `Invalid link ${value} in ${path.relative(distDir, source)}`)
    const candidates = target === '' ? ['index.html'] : target.endsWith('/')
      ? [`${target}index.html`] : [target, `${target}.html`, `${target}/index.html`]
    assert(candidates.some(candidate => available.has(path.resolve(distDir, candidate))),
      `Broken local link ${value} in ${path.relative(distDir, source)}`)
  }
}
console.log(`Generated href/src check passed across ${htmlFiles.length} HTML files.`)

const llms = fs.readFileSync(path.join(distDir, 'llms.txt'), 'utf-8')
const full = fs.readFileSync(path.join(distDir, 'llms-full.txt'), 'utf-8')
assert.equal([...full.matchAll(/^Source: /gm)].length, routes.length, 'Corpus must include each of the 18 English documents once')
const docUrls = [...llms.matchAll(/\]\((https:\/\/nb-corp\.github\.io\/nb-search\/en\/[^)]*)\)/g)].map(match => match[1])
assert.equal(docUrls.length, routes.length, 'AI index must list all 18 English routes once')
assert.equal(new Set(docUrls).size, routes.length, 'Duplicate AI index route')
for (const url of docUrls) {
  assert.equal(full.split(`Source: ${url}\n`).length - 1, 1, `Duplicate or missing corpus entry: ${url}`)
}
assert(!/[\u3400-\u9fff]/u.test(llms), 'AI index headings and summaries must be English')

for (const file of allFiles) {
  const relative = path.relative(distDir, file)
  assert(!/\.env(?:\.|$)|task-00|research[\/\\]|TODO\.md/i.test(relative), `Forbidden build path: ${relative}`)
}
console.log('English AI indexes and output hygiene verified. Documentation checks passed.')
