import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
const scope = vi.hoisted(() => ({ bundled: null as string | null, source: 'bundled', error: null as string | null }))
vi.mock('./core-runtime', () => ({ getCoreRuntimeStatus: () => ({ runtime: scope.bundled ? { root: scope.bundled, source: scope.source } : null, error: scope.error }) }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => process.execPath }))
import { findCoreAgentRuntimeCli, findCoreAgentRuntimeEntry, loadCoreAgentRuntime } from './agent-runtime-loader'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runtime loader ')); vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', ''); vi.stubEnv('NODE_ENV', 'production') })
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
