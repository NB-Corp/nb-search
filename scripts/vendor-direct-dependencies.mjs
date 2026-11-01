import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
// Recovery utility added during maintenance-source restoration, not the lost
// archive build script. Normal builds consume maintained sources without rewriting.
const mode = process.argv[2]
if (!['--check', '--write'].includes(mode)) throw new Error('Use --check or --write')
const input = resolve(import.meta.dirname, '../vendor/direct-dependencies/guarded-fetch')
const metadata = JSON.parse(await readFile(resolve(input, 'package.json'), 'utf8'))
if (metadata.version !== '0.1.5') throw new Error('Expected guarded-fetch 0.1.5')
const map = JSON.parse(await readFile(resolve(input, 'source-map/index.mjs.map'), 'utf8'))
if (map.sources.length !== 12) throw new Error('Expected the twelve recovered source-map modules')
const output = resolve(import.meta.dirname, '../src/vendor/guarded-fetch')
if (mode === '--write') await mkdir(output, { recursive: true })
async function emit(name, source) {
  // Repository convention: explicit `.ts` relative specifiers so Node can run src/ directly.
  source = source.replace(/(from\s+'\.\/[A-Za-z0-9-]+)(')/g, '$1.ts$2')
  const path = resolve(output, name)
  if (mode === '--write') await writeFile(path, source)
  else if (await readFile(path, 'utf8') !== source) throw new Error('Recovered source differs: ' + name)
}
function replace(text, before, after) {
  if (!text.includes(before)) throw new Error('Pinned guarded-fetch source changed: ' + before)
  return text.replace(before, after)
}
for (let index = 0; index < map.sources.length; index++) {
  const name = basename(map.sources[index])
  let source = map.sourcesContent[index]
  if (typeof source !== 'string') throw new Error('Source content missing: ' + name)
  if (name === 'hostname-safety.ts') {
    source = replace(source, '  hostname: string,\n): Promise<HostnameSafetyResult>', '  hostname: string,\n  targetUrl?: URL,\n  allowSyntheticDnsAddress?: (address: string, target: URL) => boolean,\n): Promise<HostnameSafetyResult>')
    source = replace(source, 'addresses.some(({ address }) => isAddressUnsafeForServerSideFetch(address))', 'addresses.some(({ address }) => isAddressUnsafeForServerSideFetch(address) && !allowSyntheticDnsAddress?.(address, targetUrl!))')
  }
  if (name === 'assert-url-safe.ts') {
    source = replace(source, '  skipSsrfCheckForAllowedHosts?: boolean;', '  skipSsrfCheckForAllowedHosts?: boolean;\n\n  /** NB Search: permit synthetic hostname DNS tokens only on the selected proxy route. */\n  allowSyntheticDnsAddress?: (address: string, target: URL) => boolean;')
    source = replace(source, '    skipSsrfCheckForAllowedHosts = false,', '    skipSsrfCheckForAllowedHosts = false,\n    allowSyntheticDnsAddress,')
    source = replace(source, 'checkHostnameSafetyForServerSideFetch(lookupHost)', 'checkHostnameSafetyForServerSideFetch(lookupHost, url, allowSyntheticDnsAddress)')
  }
  if (name === 'guarded-fetch.ts') {
    source = replace(source, '    skipSsrfCheckForAllowedHosts,', '    skipSsrfCheckForAllowedHosts,\n    allowSyntheticDnsAddress,')
    source = replace(source, '    skipSsrfCheckForAllowedHosts,\n    opaqueErrors,', '    skipSsrfCheckForAllowedHosts,\n    allowSyntheticDnsAddress,\n    opaqueErrors,')
  }
  if (name === 'guarded-fetch.ts') source = replace(source, '(fetchInit as Record<string, unknown>).dispatcher', "(fetchInit as Record<string, unknown>)['dispatcher']")
  await emit(name, '// Recovered from guarded-fetch 0.1.5 source map (Apache-2.0); NB Search synthetic-DNS addition where noted.\n' + source)
}
await emit('index.ts', '// Recovered from guarded-fetch 0.1.5 upstream commit bacdd4336d2b4b2474da02fb0e0c6212578964be (Apache-2.0).\n' + await readFile(resolve(input, 'src/index.ts'), 'utf8'))
console.log('guarded-fetch 0.1.5: twelve source-map modules and upstream export barrel ' + (mode === '--write' ? 'restored' : 'verified'))
