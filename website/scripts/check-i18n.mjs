import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const [baseUrl, outDir] = process.argv.slice(2)
assert(baseUrl && outDir, 'Usage: node website/scripts/check-i18n.mjs <base-url> <screenshot-directory>')
const base = baseUrl.replace(/\/$/, '')
fs.mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] })
const errors = []

try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await desktop.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`)
  })

  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  await page.locator('.VPNavBarTranslations').hover()
  const english = page.locator('.VPNavBarTranslations').getByRole('link', { name: 'English', exact: true })
  await english.waitFor({ state: 'visible' })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.VPNavBarTranslations .menu')).opacity === '1')
  assert.equal(await english.getAttribute('href'), '/nb-search/en/')
  await page.screenshot({ path: path.join(outDir, 'zh-home-switcher-1440.png') })
  await english.click()
  await page.waitForURL(`${base}/en/`)
  await page.locator('html[lang="en-US"]').waitFor()
  await page.waitForLoadState('networkidle')
  assert.equal(await page.locator('html').getAttribute('lang'), 'en-US')
  assert.equal(await page.locator('.VPHome').count(), 1)
  await page.locator('.VPHero .name').click()
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.VPNavBarTranslations .menu')).opacity === '0')
  await page.screenshot({ path: path.join(outDir, 'en-home-1440.png') })

  // The local search UI and result index both follow the active locale.
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const input = page.locator('#localsearch-input')
  await input.fill('round-robin')
  const results = page.locator('.VPLocalSearchBox a.result')
  await results.first().waitFor({ state: 'visible' })
  for (const href of await results.evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    assert(href.startsWith('/nb-search/en/'), `English search returned a different locale: ${href}`)
  }
  await page.keyboard.press('Escape')

  await page.goto(`${base}/en/guide/configuration`, { waitUntil: 'networkidle' })
  await page.locator('.VPNavBarTranslations').hover()
  await page.locator('.VPNavBarTranslations').getByRole('link', { name: '简体中文', exact: true }).click()
  await page.waitForURL(`${base}/guide/configuration`)
  await page.locator('html[lang="zh-CN"]').waitFor()
  await page.waitForLoadState('networkidle')
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  await page.locator('h1').click()
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.VPNavBarTranslations .menu')).opacity === '0')
  await page.screenshot({ path: path.join(outDir, 'zh-config-switched-1440.png') })
  await page.getByRole('button', { name: '搜索文档', exact: true }).click()
  await input.fill('并发')
  await results.first().waitFor({ state: 'visible' })
  for (const href of await results.evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    assert(!href.startsWith('/nb-search/en/'), `Chinese search returned an English result: ${href}`)
  }
  await page.keyboard.press('Escape')

  await page.goto(`${base}/en/sources/web-search#zhihu`, { waitUntil: 'networkidle' })
  await page.locator('#zhihu').waitFor({ state: 'visible' })
  await page.locator('.VPNavBarTranslations').hover()
  const chinese = page.locator('.VPNavBarTranslations').getByRole('link', { name: '简体中文', exact: true })
  assert.equal(await chinese.getAttribute('href'), '/nb-search/sources/web-search#zhihu')
  await chinese.click()
  await page.waitForURL(`${base}/sources/web-search#zhihu`)

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const mobilePage = await mobile.newPage()
  mobilePage.on('pageerror', error => errors.push(error.message))
  await mobilePage.goto(`${base}/en/`, { waitUntil: 'networkidle' })
  assert.equal(await mobilePage.locator('html').getAttribute('lang'), 'en-US')
  assert(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
  await mobilePage.screenshot({ path: path.join(outDir, 'en-home-390.png') })

  await mobilePage.goto(`${base}/en/guide/configuration`, { waitUntil: 'networkidle' })
  await mobilePage.locator('.VPNavBarHamburger').click()
  const mobileTranslations = mobilePage.locator('.VPNavScreenTranslations')
  await mobileTranslations.getByRole('button', { name: 'English', exact: true }).click()
  await mobileTranslations.getByRole('link', { name: '简体中文', exact: true }).click()
  await mobilePage.waitForURL(`${base}/guide/configuration`)
  await mobilePage.locator('html[lang="zh-CN"]').waitFor()
  assert.equal(await mobilePage.locator('html').getAttribute('lang'), 'zh-CN')

  assert.deepEqual(errors, [], 'Unexpected browser errors')
  console.log('Native desktop/mobile language switching, route/hash parity, localized search, and screenshots passed.')
  console.log(`Screenshots: ${path.resolve(outDir)}`)
} finally {
  await browser.close()
}
