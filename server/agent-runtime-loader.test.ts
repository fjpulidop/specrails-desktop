import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
const scope = vi.hoisted(() => ({ bundled: null as string | null, source: 'bundled', error: null as string | null }))
vi.mock('./core-runtime', () => ({ getCoreRuntimeStatus: () => ({ runtime: scope.bundled ? { root: scope.bundled, source: scope.source } : null, error: scope.error }) }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => process.execPath }))
import { findCoreAgentRuntimeCli, findCoreAgentRuntimeEntry, loadCoreAgentRuntime, resetCoreAgentRuntimeApiCache } from './agent-runtime-loader'
let root: string
beforeEach(() => { resetCoreAgentRuntimeApiCache(); root = mkdtempSync(join(tmpdir(), 'runtime loader ')); vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', ''); vi.stubEnv('NODE_ENV', 'production') })
afterEach(() => { scope.bundled = null; scope.source = 'bundled'; scope.error = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
function file(relative: string, content = '') { const target = join(root, relative); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); return target }
it('finds and validates an explicit compatible API through ordinary Node with spaces', async () => {
  const entry = file('custom runtime/index.mjs', 'export const RUNTIME_API_VERSION=1;')
  vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', entry)
  expect(findCoreAgentRuntimeEntry()).toBe(entry)
  expect(findCoreAgentRuntimeCli()).toBeNull()
  file('custom runtime/cli.js', `if(process.argv[2]==='api')console.log(JSON.stringify({type:'runtime-api',apiVersion:1}));else {const c=JSON.parse(require('node:fs').readFileSync(0,'utf8')); if(c.enabled!==true)process.exit(1); console.log(JSON.stringify({type:'runtime-config-valid'}));}`)
  expect(findCoreAgentRuntimeCli()).toBe(join(dirname(entry), 'cli.js'))
  const api = await loadCoreAgentRuntime()
  expect(api.validateRuntimeConfig({ enabled: true })).toEqual({ enabled: true })
  expect(() => api.validateRuntimeConfig({ enabled: false })).toThrow()
})
it('probes the API once per CLI file revision while validating every configuration', async () => {
  const entry = file('runtime/index.js')
  vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', entry)
  const probes = join(root, 'probes.log')
  const cliSource = (version: number) => `const fs=require('node:fs');if(process.argv[2]==='api'){fs.appendFileSync(${JSON.stringify(probes)},'api\\n');console.log(JSON.stringify({type:'runtime-api',apiVersion:${version}}))}else{fs.appendFileSync(${JSON.stringify(probes)},'validate\\n');console.log(JSON.stringify({type:'runtime-config-valid'}))}`
  const cli = file('runtime/cli.js', cliSource(1))
  const count = (kind: string) => readFileSync(probes, 'utf8').split('\n').filter((line) => line === kind).length
  ;(await loadCoreAgentRuntime()).validateRuntimeConfig({ enabled: true })
  ;(await loadCoreAgentRuntime()).validateRuntimeConfig({ enabled: true })
  expect(count('api')).toBe(1)
  expect(count('validate')).toBe(2)
  // A rebuilt CLI (new mtime) is probed again and can fail compatibility.
  writeFileSync(cli, cliSource(0)); utimesSync(cli, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  await expect(loadCoreAgentRuntime()).rejects.toThrow('expected version 1')
  expect(count('api')).toBe(2)
})
it('does not replace a missing explicit installation with a sibling checkout', async () => {
  vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', join(root, 'missing.js'))
  expect(findCoreAgentRuntimeEntry()).toBeNull()
  expect(findCoreAgentRuntimeCli()).toBeNull()
  await expect(loadCoreAgentRuntime()).rejects.toThrow('unavailable')
})
it('rejects an incompatible API', async () => {
  vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', file('old.mjs', 'export const RUNTIME_API_VERSION=0;'))
  file('cli.js', 'console.log(JSON.stringify({type:"runtime-api",apiVersion:0}))')
  await expect(loadCoreAgentRuntime()).rejects.toThrow('expected version 1')
})
it('uses a bundled installation authoritatively', () => {
  scope.bundled = root
  expect(findCoreAgentRuntimeEntry()).toBeNull()
  const entry = file('dist/agent-runtime/index.js')
  expect(findCoreAgentRuntimeEntry()).toBe(entry)
})
it('respects managed Core upgrades and fails closed on a broken active package', () => {
  scope.source = 'managed'; scope.bundled = root
  vi.stubEnv('NODE_ENV', 'development')
  expect(findCoreAgentRuntimeEntry()).toBeNull()
  const entry = file('dist/agent-runtime/index.js')
  expect(findCoreAgentRuntimeEntry()).toBe(entry)
  scope.error = 'Active package missing'
  expect(findCoreAgentRuntimeEntry()).toBeNull()
})
it('allows a sibling development build only outside production', () => {
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'desktop'))
  const entry = file('specrails-core/dist/agent-runtime/index.js')
  expect(findCoreAgentRuntimeEntry()).toBeNull()
  vi.stubEnv('NODE_ENV', 'development')
  expect(findCoreAgentRuntimeEntry()).toBe(entry)
  rmSync(entry)
  expect(findCoreAgentRuntimeEntry()).toBeNull()
})
it('resolves an installed package export before development fallback', () => {
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'consumer'))
  file('consumer/node_modules/specrails-core/package.json', JSON.stringify({ name: 'specrails-core', exports: { './agent-runtime': './entry.js' } }))
  const entry = file('consumer/node_modules/specrails-core/entry.js')
  expect(findCoreAgentRuntimeEntry()).toBe(realpathSync(entry))
})
