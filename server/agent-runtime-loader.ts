import { existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { getCoreRuntimeStatus } from './core-runtime'
import { resolveCoreNodeRuntime } from './core-node-runtime'
import { windowsSpawnEnv } from './util/win-spawn'

export interface CoreAgentRuntimeModule {
  RUNTIME_API_VERSION: number
  rolePromptDefaults(): Record<'architect' | 'developer' | 'reviewer', string>
  validateRuntimeConfig(input: unknown): unknown
  [key: string]: unknown
}

/** An explicit or bundled installation is authoritative: never silently replace
 * a broken production bundle with a developer's checkout. */
export function findCoreAgentRuntimeEntry(): string | null {
  const explicit = process.env.SPECRAILS_CORE_RUNTIME_PATH
  if (explicit) {
    const entry = resolve(explicit)
    return existsSync(entry) ? entry : null
  }
  const selected = getCoreRuntimeStatus()
  if (selected.error) return null
  if (selected.runtime) {
    const entry = join(selected.runtime.root, 'dist', 'agent-runtime', 'index.js')
    if (existsSync(entry)) return entry
    // Match Desktop's activated Core package, including managed upgrades. A
    // missing API must never load an older bundle behind an active framework.
    if (process.env.NODE_ENV === 'production' || ['managed', 'override', 'bundled'].includes(selected.runtime.source)) return null
  }
  try {
    return createRequire(join(process.cwd(), 'package.json')).resolve('specrails-core/agent-runtime')
  } catch { /* A source checkout can use the sibling Core build. */ }
  if (process.env.NODE_ENV !== 'production') {
    const entry = resolve(process.cwd(), '..', 'specrails-core', 'dist', 'agent-runtime', 'index.js')
    if (existsSync(entry)) return entry
  }
  return null
}

/** The api probe is stable for a given CLI file; repeated settings saves need not respawn it.
 * Validation stays uncached because its answer depends on the submitted configuration. */
const apiProbeCache = new Map<string, { mtimeMs: number; size: number }>()
export function resetCoreAgentRuntimeApiCache(): void { apiProbeCache.clear() }

export async function loadCoreAgentRuntime(): Promise<CoreAgentRuntimeModule> {
  const cli = findCoreAgentRuntimeCli()
  if (!cli) throw new Error('Programmatic agent runtime is unavailable. Build or bundle a compatible specrails-core release.')
  // Core is ESM. Desktop ships both CJS and a pkg sidecar; importing external
  // ESM from either depends on host-loader details. The bundled ordinary Node
  // process is the same portable boundary used for execution and inspection.
  const invoke = (args: string[], input?: string): string => execFileSync(resolveCoreNodeRuntime(), [cli, ...args], {
    cwd: dirname(cli), env: windowsSpawnEnv(process.env), input, encoding: 'utf8',
    timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stat = statSync(cli)
  const cached = apiProbeCache.get(cli)
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    const api = JSON.parse(invoke(['api'])) as { type?: string; apiVersion?: number }
    if (api.type !== 'runtime-api' || api.apiVersion !== 1) {
      throw new Error('Incompatible Core agent runtime API; expected version 1. Update the paired Core bundle.')
    }
    apiProbeCache.set(cli, { mtimeMs: stat.mtimeMs, size: stat.size })
  }
  return {
    RUNTIME_API_VERSION: 1,
    rolePromptDefaults() {
      const result = JSON.parse(invoke(['prompts']))
      if (result.type !== 'runtime-role-prompts' || !['architect', 'developer', 'reviewer'].every(role => typeof result.defaults?.[role] === 'string' && result.defaults[role].trim())) throw new Error('Core role prompt catalog is unavailable. Update the paired Core bundle.')
      return result.defaults
    },
    validateRuntimeConfig(input: unknown): unknown {
      const result = JSON.parse(invoke(['validate', '--stdin'], JSON.stringify(input))) as { type?: string }
      if (result.type !== 'runtime-config-valid') throw new Error('Core did not validate the runtime configuration')
      return input
    },
  }
}

export function findCoreAgentRuntimeCli(): string | null {
  const entry = findCoreAgentRuntimeEntry()
  if (!entry) return null
  const cli = join(dirname(entry), 'cli.js')
  return existsSync(cli) ? cli : null
}
