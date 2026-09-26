import type { RuntimeConfig } from './agent-runtime-settings'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { getCoreRuntimeStatus } from '../../../core-runtime'
import { resolveCoreNodeRuntime } from '../../../core-node-runtime'
import { windowsSpawnEnv } from '../../../util/win-spawn'
import { runtimeEntryFingerprint } from './agent-runtime-package'

export interface RuntimeApi {
  type: 'runtime-api'
  apiVersion: 1
  coreVersion?: string
  runtimeIdentity?: { packageVersion: string; workflowVersion: string; instructionsVersion: string; packageIntegrity: string; apiVersion: 1 }
  workflowVersions?: string[]
  engineVersion?: number
  nodeKinds?: string[]
  nodeKindsVersion?: number
  builtins?: Array<{ id: string; version: string; deprecated: boolean }>
  capabilities?: Record<string, number>
  /** Configurable guardrail catalog (Core ≥ configurableGuardrails: 1). */
  guardrails?: Array<{ id: string; phase: 'architect' | 'developer' | 'host' }>
}

export interface CoreAgentRuntimeModule {
  RUNTIME_API_VERSION: number
  api?: RuntimeApi
  capabilities?(input: unknown): unknown
  /** `fixer` is present only on cores that publish the fixer stance definition. */
  rolePromptDefaults(): Record<'architect' | 'developer' | 'reviewer', string> & { fixer?: string }
  validateRuntimeConfig(input: unknown): unknown
  validateWorkflowDefinition(input: unknown): WorkflowDefinitionValidation
  [key: string]: unknown
}

export type WorkflowDefinitionValidation =
  | { ok: true; version: string; graph: { nodes: unknown[]; edges: unknown[] } }
  | { ok: false; errors: Array<{ code: string; nodeId?: string; path?: string; message: string }> }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validation is a protocol result even when Core exits 1 for an invalid definition. */
function readDefinitionValidation(value: unknown): WorkflowDefinitionValidation {
  const invalid = (): never => { throw new Error('Core returned malformed workflow definition validation') }
  if (!object(value) || value.type !== 'runtime-definition-validated') return invalid()
  if (value.ok === true) {
    if (typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) || !object(value.graph) || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges)) return invalid()
    return { ok: true, version: value.version, graph: { nodes: value.graph.nodes, edges: value.graph.edges } }
  }
  if (value.ok !== false || !Array.isArray(value.errors) || !value.errors.length || !value.errors.every(error => object(error) && typeof error.code === 'string' && error.code.length > 0 && typeof error.message === 'string' && ['nodeId', 'path'].every(key => error[key] === undefined || typeof error[key] === 'string'))) return invalid()
  return { ok: false, errors: value.errors as Extract<WorkflowDefinitionValidation, { ok: false }>['errors'] }
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

/** The api probe is stable for executable package content; settings saves need not respawn it.
 * Validation stays uncached because its answer depends on the submitted configuration. */
const apiProbeCache = new Map<string, { fingerprint: string; api: RuntimeApi }>()
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
  const fingerprint = runtimeEntryFingerprint(cli)
  const cached = apiProbeCache.get(cli)
  let api = cached?.fingerprint === fingerprint ? cached.api : undefined
  if (!api) {
    api = JSON.parse(invoke(['api'])) as RuntimeApi
    if (api.type !== 'runtime-api' || api.apiVersion !== 1) {
      throw new Error('Incompatible Core agent runtime API; expected version 1. Update the paired Core bundle.')
    }
    if (api.capabilities !== undefined && (!api.capabilities || typeof api.capabilities !== 'object' || Array.isArray(api.capabilities) || Object.values(api.capabilities).some(value => !Number.isSafeInteger(value) || value < 1))) throw new Error('Core returned malformed runtime capabilities')
    if (api.workflowVersions !== undefined && (!Array.isArray(api.workflowVersions) || !api.workflowVersions.every(value => typeof value === 'string' && /^\d+$/.test(value)))) throw new Error('Core returned malformed workflow versions')
    for (const key of ['engineVersion', 'nodeKindsVersion'] as const) {
      const value = api[key]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'engineVersion' ? 1 : 0))) throw new Error(`Core returned malformed ${key}`)
    }
    if (api.nodeKinds !== undefined && (!Array.isArray(api.nodeKinds) || !api.nodeKinds.every(value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)) || new Set(api.nodeKinds).size !== api.nodeKinds.length)) throw new Error('Core returned malformed node kinds')
    if (api.builtins !== undefined && (!Array.isArray(api.builtins) || !api.builtins.every(value => object(value) && typeof value.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 128 && typeof value.deprecated === 'boolean') || new Set(api.builtins.map(value => value.id)).size !== api.builtins.length)) throw new Error('Core returned malformed builtins')
    if (api.runtimeIdentity !== undefined) {
      const identity = api.runtimeIdentity
      if (!identity || identity.apiVersion !== 1 || !['packageVersion', 'workflowVersion', 'instructionsVersion', 'packageIntegrity'].every(key => typeof identity[key as keyof typeof identity] === 'string') || !/^sha256:[a-f0-9]{64}$/.test(identity.packageIntegrity)) throw new Error('Core returned malformed runtime identity')
    }
    apiProbeCache.set(cli, { fingerprint, api })
  }
  return {
    RUNTIME_API_VERSION: 1,
    api,
    capabilities(input: unknown): unknown {
      if (api.capabilities?.efficientRoleExecution !== 1) throw new Error('Installed Core does not support role capability introspection. Update the paired Core package.')
      const result = JSON.parse(invoke(['capabilities', '--stdin'], JSON.stringify(input)))
      return { ...validateRoleCapabilities(result, input), runtimeIdentity: api.runtimeIdentity }
    },
    rolePromptDefaults() {
      const result = JSON.parse(invoke(['prompts']))
      if (result.type !== 'runtime-role-prompts' || !['architect', 'developer', 'reviewer'].every(role => typeof result.defaults?.[role] === 'string' && result.defaults[role].trim())) throw new Error('Core role prompt catalog is unavailable. Update the paired Core bundle.')
      return result.defaults
    },
    validateRuntimeConfig(input: unknown): unknown {
      requireRuntimeCapabilities(api, input)
      const result = JSON.parse(invoke(['validate', '--stdin'], JSON.stringify(input))) as { type?: string }
      if (result.type !== 'runtime-config-valid') throw new Error('Core did not validate the runtime configuration')
      return input
    },
    validateWorkflowDefinition(input: unknown): WorkflowDefinitionValidation {
      if (api.capabilities?.workflowDefinitions !== 1) throw new Error('Installed Core does not support workflow definitions. Update the paired Core package.')
      let output: string
      try { output = invoke(['workflows', 'validate', '--stdin'], JSON.stringify(input)) }
      catch (error) {
        const failure = error as { status?: unknown; stdout?: unknown }
        if (failure.status !== 1 || typeof failure.stdout !== 'string') throw error
        const result = readDefinitionValidation(JSON.parse(failure.stdout))
        if (result.ok) throw error
        return result
      }
      return readDefinitionValidation(JSON.parse(output))
    },
  }
}

export function requireRuntimeCapabilities(api: RuntimeApi, input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const config = input as { efficiency?: unknown; agents?: Record<string, { effort?: unknown; escalation?: unknown }>; verification?: Array<{ policy?: unknown; key?: unknown; label?: unknown }> }
  if ((config.efficiency !== undefined || Object.values(config.agents ?? {}).some(role => role?.effort !== undefined || role?.escalation !== undefined)) && api.capabilities?.efficientRoleExecution !== 1) throw new Error('Requested role efficiency policy is unsupported by this Core runtime. Update the paired Core package.')
  if (Array.isArray(config.verification) && config.verification.some(check => check?.policy !== undefined || check?.key !== undefined || check?.label !== undefined) && api.capabilities?.reproducibleVerification !== 1) throw new Error('Requested verification policy is unsupported by this Core runtime. Update the paired Core package.')
}

/** Validate transport evidence against the exact submitted role selections. */
export function validateRoleCapabilities(value: unknown, input: unknown) {
  const invalid = (): never => { throw new Error('Core returned malformed role capabilities') }
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
  const result = object(value), config = object(input)
  const choices = Object.entries(object(config.agents))
  if (result.type !== 'runtime-capabilities' || result.schemaVersion !== 1 || !Array.isArray(result.roles) || result.roles.length > 6) return invalid()
  const expected = choices.flatMap(([role, value]) => {
    const selected = object(value)
    return [['base', selected], ...(selected.escalation ? [['escalation', object(selected.escalation)]] : [])].map(([tier, choice]) => {
      const model = choice as Record<string, unknown>
      return { role, tier: String(tier), provider: selected.provider, model: model.model ?? null, requestedEffort: model.effort ?? null }
    })
  })
  if (expected.length !== result.roles.length || expected.length < 3) return invalid()
  const seen = new Set<string>()
  const roles = result.roles.map(value => {
    const row = object(value)
    const selected = expected.find(item => Object.entries(item).every(([key, value]) => row[key] === value))
    if (!selected) return invalid()
    const key = String(row.role) + ':' + String(row.tier)
    if (seen.has(key)) return invalid()
    seen.add(key)
    if (typeof row.transport !== 'string' || !row.transport || row.transport.length > 128 || !['supported', 'unsupported', 'unknown'].includes(String(row.continuation)) || !['supported', 'unsupported', 'unknown'].includes(String(row.effortSupport)) || typeof row.observedModel !== 'boolean' || typeof row.observedEffort !== 'boolean') return invalid()
    if (row.supportedEfforts !== null && (!Array.isArray(row.supportedEfforts) || row.supportedEfforts.length > 32 || !row.supportedEfforts.every((level: unknown) => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))) return invalid()
    const levels = row.supportedEfforts as string[] | null
    if (row.effortSupport === 'supported' && !levels?.length || row.effortSupport === 'unknown' && levels !== null || row.effortSupport === 'unsupported' && levels?.length !== 0) return invalid()
    return { ...selected, transport: row.transport, continuation: row.continuation, effortSupport: row.effortSupport, supportedEfforts: levels, observedModel: row.observedModel, observedEffort: row.observedEffort }
  })
  return { type: 'runtime-capabilities', schemaVersion: 1, roles }
}

export function validateRequestedRoleEfforts(runtime: CoreAgentRuntimeModule, config: Pick<RuntimeConfig, 'agents'>): void {
  if (!Object.values(config.agents).some(role => role.effort !== undefined || role.escalation?.effort !== undefined)) return
  if (!runtime.capabilities) throw new Error('Installed Core cannot validate requested role effort')
  const result = validateRoleCapabilities(runtime.capabilities(config), config)
  for (const row of result.roles) if (row.requestedEffort !== null && (row.effortSupport !== 'supported' || !row.supportedEfforts?.includes(String(row.requestedEffort)))) throw new Error(`${row.role} (${row.tier}): effort '${row.requestedEffort}' is not confirmed for ${row.transport}. Select provider default or a supported effort.`)
}

export function findCoreAgentRuntimeCli(): string | null {
  const entry = findCoreAgentRuntimeEntry()
  if (!entry) return null
  const cli = join(dirname(entry), 'cli.js')
  return existsSync(cli) ? cli : null
}
