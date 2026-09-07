import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const websiteDir = path.resolve(__dirname, '..')
const distDir = path.resolve(websiteDir, '.vitepress/dist')

console.log('=== Checking Documentation Site Build & Assets ===')

// 1. Trigger VitePress build and verify build works cleanly
try {
  console.log('1. Verifying VitePress build...');
  execSync('pnpm build', { cwd: websiteDir, stdio: 'pipe' });
  console.log('✓ VitePress build succeeded.');
} catch (err) {
  console.error('✗ VitePress build failed:', err.stdout?.toString() || err.message);
  process.exit(1);
}

// 2. Validate essential generated HTML pages
const expectedPages = [
  'index.html',
  '404.html',
  'guide/quickstart.html',
  'guide/configuration.html',
  'guide/integrations.html',
  'guide/search.html',
  'guide/fetch.html',
  'guide/jobs.html',
  'guide/troubleshooting.html',
  'guide/upgrading.html',
  'sources/index.html',
  'sources/web-search.html',
  'sources/grok.html',
  'sources/developer.html',
  'sources/custom.html',
  'reference/cli.html',
  'reference/remote-protocol.html',
  'reference/runtime.html',
  'reference/changelog.html'
];

let missingPages = [];
for (const p of expectedPages) {
  const fullPath = path.join(distDir, p);
  if (!fs.existsSync(fullPath)) {
    missingPages.push(p);
  }
}

if (missingPages.length > 0) {
  console.error('✗ Missing expected HTML pages:', missingPages);
  process.exit(1);
}
console.log(`✓ All ${expectedPages.length} expected HTML pages generated.`);

// 3. Check base path /nb-search/ in index.html
const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
if (!indexHtml.includes('/nb-search/assets/') || !indexHtml.includes('/nb-search/vp-icons.css')) {
  console.error('✗ Base path /nb-search/ missing from asset links in index.html');
  process.exit(1);
}
console.log('✓ Base path /nb-search/ verified in output assets.');

// 4. Deadlink scan across all generated HTML files (verifies that /nb-search/ target files exist; does not validate hash/anchor fragments)
function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      results.push(file);
    }
  });
  return results;
}

const allDistFiles = walk(distDir);
const allHtmlFiles = allDistFiles.filter(f => f.endsWith('.html'));

let deadlinkErrors = [];
for (const htmlFile of allHtmlFiles) {
  const content = fs.readFileSync(htmlFile, 'utf-8');
  // Match internal links under /nb-search/
  const linkMatches = content.matchAll(/href="(\/nb-search\/[^"#?]+)/g);
  for (const match of linkMatches) {
    const rawLink = match[1];
    // map /nb-search/foo/bar to dist/foo/bar.html or dist/foo/bar/index.html
    const rel = rawLink.replace(/^\/nb-search\//, '');
    if (!rel) continue; // home page
    const directFile = path.join(distDir, rel);
    const htmlFileTarget = path.join(distDir, `${rel}.html`);
    const indexFileTarget = path.join(distDir, rel, 'index.html');

    if (!fs.existsSync(directFile) && !fs.existsSync(htmlFileTarget) && !fs.existsSync(indexFileTarget)) {
      deadlinkErrors.push({ from: path.relative(distDir, htmlFile), to: rawLink });
    }
  }
}

if (deadlinkErrors.length > 0) {
  console.error('✗ Internal dead links detected:', deadlinkErrors);
  process.exit(1);
}
console.log(`✓ Dead link verification passed across ${allHtmlFiles.length} HTML files (targets exist; anchors excluded).`);

// 5. OutDir path blacklist hygiene check (verifies no forbidden workspace paths leaked into dist)
const forbiddenPathPatterns = [
  /\.env(\.|$)/i,
  /task-00/i,
  /research[\/\\]/i,
  /TODO\.md/i
];

let pathViolations = [];
for (const file of allDistFiles) {
  const rel = path.relative(distDir, file);
  for (const pattern of forbiddenPathPatterns) {
    if (pattern.test(rel)) {
      pathViolations.push(rel);
    }
  }
}

if (pathViolations.length > 0) {
  console.error('✗ OutDir path violations found (forbidden output paths in dist):', pathViolations);
  process.exit(1);
}
console.log('✓ OutDir hygiene check passed (0 forbidden output paths).');

console.log('=== Documentation Site Checks All Passed ===');
