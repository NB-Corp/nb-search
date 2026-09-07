const path = require('path');
const fs = require('fs');

// 1. Parse CLI flags: --base-url <url> and --out <dir> are strictly required.
// Unknown flags or missing values cause immediate failure.
const args = process.argv.slice(2);
let baseUrl = null;
let outDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base-url') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Fatal: --base-url requires a non-empty URL argument.');
      process.exit(1);
    }
    baseUrl = args[i + 1].replace(/\/$/, '');
    i++;
  } else if (args[i] === '--out') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Fatal: --out requires a non-empty directory path argument.');
      process.exit(1);
    }
    outDir = path.resolve(process.cwd(), args[i + 1]);
    i++;
  } else {
    console.error(`Fatal: Unknown command line argument: ${args[i]}`);
    process.exit(1);
  }
}

if (!baseUrl) {
  console.error('Fatal: Missing mandatory argument --base-url <url>. Example: --base-url http://localhost:4173/nb-search');
  process.exit(1);
}

if (!outDir) {
  console.error('Fatal: Missing mandatory argument --out <dir>. Example: --out ./research/docs-site');
  process.exit(1);
}

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Ensure Playwright is available from local workspace node_modules
let playwright;
try {
  playwright = require('../node_modules/playwright');
} catch {
  try {
    playwright = require('../../node_modules/playwright');
  } catch (err) {
    console.error('Fatal: Playwright is not installed in local workspace node_modules.', err.message);
    process.exit(1);
  }
}

const { chromium } = playwright;

async function run() {
  console.log(`Starting visual verification against base URL: ${baseUrl}`);
  console.log(`Saving screenshots to output directory: ${outDir}`);

  let browser = null;
  let desktopContext = null;
  let mobileContext = null;

  try {
    browser = await chromium.launch({ headless: true });

    // Track unexpected console errors, page errors, and failed requests
    const unexpectedErrors = [];
    let expected404ExactUrl = null;

    function attachMonitoring(page, label) {
      page.on('console', msg => {
        if (msg.type() === 'error') {
          const text = msg.text();
          const msgLocUrl = msg.location()?.url || '';
          // Only permit the specific console error from the intentional navigation 404 test probe
          if (expected404ExactUrl && (msgLocUrl === expected404ExactUrl || text.includes(expected404ExactUrl)) && text.includes('404')) {
            return;
          }
          unexpectedErrors.push(`[${label} Console Error] ${text} (location: ${msgLocUrl})`);
        }
      });
      page.on('pageerror', err => {
        unexpectedErrors.push(`[${label} Page Error] ${err.message}`);
      });
      page.on('requestfailed', req => {
        unexpectedErrors.push(`[${label} Request Failed] ${req.url()} (${req.failure()?.errorText})`);
      });
      page.on('response', res => {
        const status = res.status();
        const url = res.url();
        if (status >= 400) {
          const req = res.request();
          const isNav = typeof req.isNavigationRequest === 'function' ? req.isNavigationRequest() : false;
          // Permit strictly if the response URL exactly matches the expected 404 navigation URL
          if (expected404ExactUrl && url === expected404ExactUrl && isNav && status === 404) {
            return;
          }
          unexpectedErrors.push(`[${label} HTTP ${status}] ${url} (isNavigation: ${isNav})`);
        }
      });
    }

    // Helper: assert that whole-document scrollWidth does not exceed clientWidth
    async function assertNoHorizontalWholePageOverflow(p, pageName) {
      const overflow = await p.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      if (overflow) {
        throw new Error(`Layout failure: Document has unexpected horizontal whole-page overflow on ${pageName}`);
      }
    }

    // ----------------------------------------------------
    // Desktop Suite (1440x900)
    // ----------------------------------------------------
    desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });
    const page = await desktopContext.newPage();
    attachMonitoring(page, 'Desktop');

    // 1. Desktop Home
    console.log('1. Navigating to Home...');
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(page, 'Desktop Home');
    await page.screenshot({ path: path.join(outDir, '01-desktop-home.png'), fullPage: true });

    // 2. Desktop Quickstart
    console.log('2. Navigating to Quickstart...');
    await page.goto(`${baseUrl}/guide/quickstart`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(page, 'Desktop Quickstart');
    await page.screenshot({ path: path.join(outDir, '02-desktop-quickstart.png') });

    // 3. Desktop Sources (Catalog table)
    console.log('3. Navigating to Sources...');
    await page.goto(`${baseUrl}/sources/`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(page, 'Desktop Sources');
    const tableCount = await page.locator('table').count();
    if (tableCount === 0) {
      throw new Error('Sources page failed to render expected lane/pipeline tables.');
    }
    await page.screenshot({ path: path.join(outDir, '03-desktop-sources.png') });

    // 4. Desktop Reference CLI (Include resolution)
    console.log('4. Navigating to Reference CLI...');
    await page.goto(`${baseUrl}/reference/cli`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(page, 'Desktop Reference CLI');
    const hasCliHeading = await page.locator('h1, h2').filter({ hasText: /CLI/i }).count();
    if (hasCliHeading === 0) {
      throw new Error('Reference CLI page failed to render expected CLI heading from markdown include.');
    }
    await page.screenshot({ path: path.join(outDir, '04-desktop-reference-cli.png') });

    // 5. Desktop Local MiniSearch Modal & Exact Navigation Test
    console.log('5. Testing MiniSearch modal with query "并发"...');
    const searchBtn = page.getByRole('button', { name: /搜索/i }).or(page.locator('button.DocSearch-Button'));
    await searchBtn.first().waitFor({ state: 'visible', timeout: 5000 });
    await searchBtn.first().click();

    // Dialog input must be visible
    const searchInput = page.locator('.VPLocalSearchBox input, #localsearch-input, .DocSearch-Input').first();
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });

    // Type query '并发'
    await searchInput.fill('并发');

    // Wait for search results container to populate with matching items
    const resultItems = page.locator('.VPLocalSearchBox .results .result, .DocSearch-Hit');
    await resultItems.first().waitFor({ state: 'visible', timeout: 5000 });
    const resultCount = await resultItems.count();
    console.log(`✓ MiniSearch returned ${resultCount} matching items for "并发"`);
    if (resultCount === 0) {
      throw new Error('MiniSearch failed to return any results for keyword "并发"');
    }

    // Capture open search modal screenshot
    await page.screenshot({ path: path.join(outDir, '05-desktop-search-modal.png') });

    // Inspect the selected/first result item to get its exact destination href
    const firstResultLink = page.locator('.VPLocalSearchBox .results a.result, .DocSearch-Hit a').first();
    let expectedTargetHref = await firstResultLink.getAttribute('href');
    if (!expectedTargetHref) {
      throw new Error('Selected search result item does not contain a valid href attribute.');
    }
    // Normalize target URL (href could be relative or absolute)
    const currentOrigin = new URL(page.url()).origin;
    const resolvedTargetUrl = new URL(expectedTargetHref, currentOrigin).toString();
    console.log(`Expected target destination from selected item: ${resolvedTargetUrl}`);

    // Press Enter to navigate to the selected result
    console.log('Testing keyboard navigation (Enter key)...');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');

    // Assert that search modal is now hidden/detached
    await searchInput.waitFor({ state: 'hidden', timeout: 5000 });

    // Assert URL matches the exact resolved target destination
    const destinationUrl = page.url();
    console.log(`Actual URL after Enter navigation: ${destinationUrl}`);
    if (destinationUrl !== resolvedTargetUrl) {
      throw new Error(`Search navigation mismatch: expected URL "${resolvedTargetUrl}", but navigated to "${destinationUrl}"`);
    }
    console.log('✓ Enter navigation accurately reached the target URL and closed the search modal.');

    // Test Escape key closes modal
    await searchBtn.first().click();
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await searchInput.waitFor({ state: 'hidden', timeout: 5000 });
    console.log('✓ Escape key cleanly closes search modal');

    // 6. 404 Page Verification
    console.log('6. Navigating to non-existent route for 404 check...');
    expected404ExactUrl = `${baseUrl}/non-existent-probe-route`;
    const res404 = await page.goto(expected404ExactUrl, { waitUntil: 'networkidle' });
    if (res404 && res404.status() !== 404 && res404.status() !== 200) {
      throw new Error(`Unexpected status code for 404 probe route: ${res404.status()}`);
    }
    const notFoundHeading = page.locator('h1, .code, .title').filter({ hasText: /404|页面未找到/ });
    if (await notFoundHeading.count() === 0) {
      throw new Error('404 page does not show expected 404 or "页面未找到" heading.');
    }
    await page.screenshot({ path: path.join(outDir, '06-desktop-404.png') });
    expected404ExactUrl = null; // Clear allowed exact 404 target

    await desktopContext.close();
    desktopContext = null;

    // ----------------------------------------------------
    // Mobile Suite (390x844)
    // ----------------------------------------------------
    console.log('7. Running Mobile verification suite...');
    mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const mPage = await mobileContext.newPage();
    attachMonitoring(mPage, 'Mobile');

    // Mobile Home
    console.log('Navigating Mobile Home...');
    await mPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(mPage, 'Mobile Home');
    await mPage.screenshot({ path: path.join(outDir, '07-mobile-home.png') });

    // Mobile Sources (tables must scroll internally, body must not overflow horizontally)
    console.log('Navigating Mobile Sources (Catalog table)...');
    await mPage.goto(`${baseUrl}/sources/`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(mPage, 'Mobile Sources (Tables)');
    await mPage.screenshot({ path: path.join(outDir, '09-mobile-sources.png') });

    // Mobile Quickstart
    console.log('Navigating Mobile Quickstart...');
    await mPage.goto(`${baseUrl}/guide/quickstart`, { waitUntil: 'networkidle' });
    await assertNoHorizontalWholePageOverflow(mPage, 'Mobile Quickstart');

    // Mobile Hamburger Menu Interaction & Assertions
    console.log('8. Testing Mobile hamburger drawer interaction...');
    const hamburger = mPage.locator('.VPNavBarHamburger, button[aria-label="mobile navigation"]');
    await hamburger.first().waitFor({ state: 'visible', timeout: 5000 });

    // Initial state: not expanded
    const initialExpanded = await hamburger.first().getAttribute('aria-expanded');
    if (initialExpanded === 'true') {
      throw new Error('Mobile hamburger menu was unexpectedly expanded before click.');
    }

    // Click to open drawer
    await hamburger.first().click();

    // Assert hamburger aria-expanded is 'true'
    await hamburger.first().waitFor({ state: 'visible' });
    const openedExpanded = await hamburger.first().getAttribute('aria-expanded');
    if (openedExpanded !== 'true') {
      throw new Error(`Mobile hamburger aria-expanded expected "true", got "${openedExpanded}"`);
    }

    // Assert nav screen container #VPNavScreen is visible
    const navScreen = mPage.locator('#VPNavScreen');
    await navScreen.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✓ Mobile hamburger menu opened, aria-expanded="true", and #VPNavScreen is visible');

    // Click hamburger again to close drawer
    await hamburger.first().click();
    const closedExpanded = await hamburger.first().getAttribute('aria-expanded');
    if (closedExpanded === 'true') {
      throw new Error('Mobile hamburger aria-expanded did not reset after second click.');
    }
    await navScreen.waitFor({ state: 'hidden', timeout: 5000 });
    console.log('✓ Mobile hamburger menu closed cleanly and #VPNavScreen is hidden');

    // Capture screenshot while on quickstart page
    await mPage.screenshot({ path: path.join(outDir, '08-mobile-quickstart.png') });

    await mobileContext.close();
    mobileContext = null;

    // Fail if any unexpected errors occurred during the test run
    if (unexpectedErrors.length > 0) {
      console.error('Fatal: Unexpected errors encountered during visual verification:');
      unexpectedErrors.forEach(e => console.error('  ', e));
      throw new Error(`Visual verification encountered ${unexpectedErrors.length} unexpected error(s).`);
    }

    console.log('✓ All visual, interaction, and layout checks passed with 0 unexpected errors.');
  } finally {
    if (desktopContext) {
      await desktopContext.close().catch(() => {});
    }
    if (mobileContext) {
      await mobileContext.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

run().catch(err => {
  console.error('Execution failure:', err.message);
  process.exit(1);
});
