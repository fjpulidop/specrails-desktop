import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import runtimeSchema from './schemas/agent-runtime.schema.json'
import { resolveProjectExecution } from './workspace-resolution'

export type RuntimeRole = 'architect' | 'developer' | 'reviewer'
export type RuntimeCli = 'claude' | 'codex' | 'gemini' | 'kimi'
export type RuntimeProvider = { id: string; kind: 'cli'; cli: RuntimeCli } | { id: string; kind: 'openai-compatible'; baseUrl: string; apiKeyEnv?: string }
export interface RuntimeConfig {
  schemaVersion: 1
  rolePrompts?: Partial<Record<RuntimeRole, string>>
  enabled: boolean
  providers: RuntimeProvider[]
  agents: Record<RuntimeRole, { provider: string; model?: string; maxTurns?: number }>
  limits?: { maxAttempts?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number }
  verification: Array<{ repositoryId: string; command: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }>
  approvalBeforeArchive?: boolean
  review?: { minScore?: number; aspects?: Partial<Record<ReviewAspect, number>> }
  architect?: { onLowConfidence?: 'ask' | 'proceed' }
}
export type ReviewAspect = 'type_correctness' | 'pattern_adherence' | 'test_coverage' | 'security' | 'architectural_alignment'
/** Core's own review gate. Configured thresholds may only tighten it (mirrors Core's config.ts). */
export const REVIEW_THRESHOLD_FLOORS: { minScore: number; aspects: Record<ReviewAspect, number> } = {
  minScore: 70,
  aspects: { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 },
}
export interface RuntimeConfigProject { path: string; slug?: string; provider?: string }
const CLI_PROVIDERS: RuntimeCli[] = ['claude', 'codex', 'gemini', 'kimi']
const ROLES: RuntimeRole[] = ['architect', 'developer', 'reviewer']
const schemaValidator = new Ajv({ allErrors: true }).compile<RuntimeConfig>(runtimeSchema)

export class AgentRuntimeConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentRuntimeConfigError' }
}

/** Vendored from Core's schema; parity tests keep offline configuration aligned.
 *  Semantic checks mirror Core because JSON Schema cannot check provider refs. */
export function validateAgentRuntimeConfig(input: unknown): RuntimeConfig {
  if (!schemaValidator(input)) {
    const error = schemaValidator.errors?.[0]
    throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${error?.instancePath || '/'}: ${error?.message ?? 'invalid value'}`)
  }
  const config = input as RuntimeConfig
  if (config.rolePrompts !== undefined) validateRuntimeRolePrompts(config.rolePrompts)
  if (new Set(config.providers.map(({ id }) => id)).size !== config.providers.length) throw new AgentRuntimeConfigError('Provider IDs must be unique')
  for (const provider of config.providers) {
    if (provider.kind !== 'openai-compatible') continue
    let url: URL
    try { url = new URL(provider.baseUrl) } catch { throw new AgentRuntimeConfigError('Provider base URL must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || provider.baseUrl.includes('\0')) throw new AgentRuntimeConfigError('Provider URLs must use HTTP(S) without credentials, query parameters or fragments')
  }
  for (const role of ROLES) {
    const agent = config.agents[role]
    const provider = config.providers.find(({ id }) => id === agent.provider)
    if (!provider) throw new AgentRuntimeConfigError(`Role ${role} references a provider that is not configured`)
    if (provider.kind === 'openai-compatible' && !agent.model) throw new AgentRuntimeConfigError(`Role ${role} requires a model for its API provider`)
    if (agent.model !== undefined && !agent.model.trim()) throw new AgentRuntimeConfigError(`Role ${role} requires a nonempty model identifier`)
    if (agent.maxTurns !== undefined && !Number.isSafeInteger(agent.maxTurns)) throw new AgentRuntimeConfigError(`Role ${role} maxTurns must be a safe integer`)
  }
  for (const [key, value] of Object.entries(config.limits ?? {})) {
    if (!Number.isFinite(value) || (key !== 'maxCostUsd' && !Number.isSafeInteger(value))) throw new AgentRuntimeConfigError('Workflow limits must be finite, safe numbers')
  }
  for (const command of config.verification) {
    if (![command.command, ...command.args, ...(command.cwd === undefined ? [] : [command.cwd])].every((value) => !value.includes('\0')) || !command.command.trim() || (command.cwd !== undefined && !command.cwd.trim())) throw new AgentRuntimeConfigError('Verification command contains an empty or invalid value')
    if (command.timeoutMs !== undefined && !Number.isSafeInteger(command.timeoutMs)) throw new AgentRuntimeConfigError('Verification timeout must be a safe integer')
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (/(?:token|secret|password|api_?key|credential)/i.test(key)) throw new AgentRuntimeConfigError('Verification credentials must be inherited from environment variables, never saved')
      if (value.includes('\0')) throw new AgentRuntimeConfigError('Verification environment contains an invalid value')
    }
  }
  if (config.review?.minScore !== undefined && config.review.minScore < REVIEW_THRESHOLD_FLOORS.minScore) throw new AgentRuntimeConfigError(`Review threshold review.minScore must be at least ${REVIEW_THRESHOLD_FLOORS.minScore} (Core's own review gate)`)
  for (const [aspect, value] of Object.entries(config.review?.aspects ?? {}) as Array<[ReviewAspect, number]>) {
    if (value < REVIEW_THRESHOLD_FLOORS.aspects[aspect]) throw new AgentRuntimeConfigError(`Review threshold review.aspects.${aspect} must be at least ${REVIEW_THRESHOLD_FLOORS.aspects[aspect]} (Core's own review gate)`)
  }
  return structuredClone(config)
}

export function defaultAgentRuntimeConfig(project: RuntimeConfigProject): RuntimeConfig {
  const provider = CLI_PROVIDERS.includes(project.provider as RuntimeCli) ? project.provider! : 'claude'
  return {
    schemaVersion: 1, enabled: true,
    providers: CLI_PROVIDERS.map((cli) => ({ id: cli, kind: 'cli', cli })),
    agents: { architect: { provider }, developer: { provider }, reviewer: { provider } },
    verification: [],
  }
}

export function agentRuntimeConfigPath(project: RuntimeConfigProject): string {
  return path.join(resolveProjectExecution(project).specrailsDir, 'agent-runtime.json')
}

/** Global connections are resolved for new runs; admitted runs keep their snapshot. */
export function runtimeProvidersPath(): string { return path.join(os.homedir(), '.specrails', 'runtime-providers.json') }

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

export function loadRuntimeProviders(): RuntimeProvider[] {
  try { return validateRuntimeProviders(JSON.parse(fs.readFileSync(runtimeProvidersPath(), 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultAgentRuntimeConfig({ path: '' }).providers
    throw error
  }
}

export function validateRuntimeProviders(input: unknown): RuntimeProvider[] {
  if (!Array.isArray(input) || !input.length) throw new AgentRuntimeConfigError('At least one provider connection is required')
  const first = input[0] as RuntimeProvider
  const role = { provider: first?.id, ...(first?.kind === 'openai-compatible' ? { model: 'validation' } : {}) }
  return validateAgentRuntimeConfig({ schemaVersion: 1, enabled: true, providers: input, agents: { architect: role, developer: role, reviewer: role }, verification: [] }).providers
}

export function saveRuntimeProviders(input: unknown): RuntimeProvider[] {
  const providers = validateRuntimeProviders(input)
  atomicJson(runtimeProvidersPath(), providers)
  return providers
}

/** Migrate embedded connections once. Conflicting IDs receive a stable ID so
 *  two projects with different endpoints never silently share a connection. */
export function loadRuntimeConfigFile(file: string, fallbackProvider?: string): RuntimeConfig {
  let parsed: Record<string, unknown> | undefined
  let text: string | undefined
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (text !== undefined) {
    try { parsed = JSON.parse(text) }
    catch { throw new AgentRuntimeConfigError('Saved runtime configuration is not valid JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentRuntimeConfigError('Saved runtime configuration must be an object')
  }
  const providers = loadRuntimeProviders()
  if (!parsed) {
    const config = defaultAgentRuntimeConfig({ path: '', provider: fallbackProvider })
    const selected = providers.find(item => item.id === config.agents.architect.provider) ?? providers.find(item => item.kind === 'cli')
    if (!selected || selected.kind !== 'cli') throw new AgentRuntimeConfigError('Configure project role models before using API-only connections')
    for (const role of ROLES) config.agents[role].provider = selected.id
    return validateAgentRuntimeConfig({ ...config, providers })
  }
  if (Array.isArray(parsed.providers)) {
    const legacy = validateAgentRuntimeConfig(parsed)
    for (const original of legacy.providers) {
      let connection = providers.find(item => item.id === original.id)
      if (connection && JSON.stringify(connection) !== JSON.stringify(original)) {
        const id = `${original.id.slice(0, 117)}-${createHash('sha256').update(JSON.stringify(original)).digest('hex').slice(0, 10)}`
        for (const role of ROLES) if (legacy.agents[role].provider === original.id) legacy.agents[role].provider = id
        connection = providers.find(item => item.id === id)
        if (!connection) providers.push({ ...original, id })
      } else if (!connection) providers.push(original)
    }
    saveRuntimeProviders(providers)
    const { providers: _embedded, enabled: _enabled, ...settings } = legacy
    atomicJson(file, settings)
    parsed = settings
  }
  return validateAgentRuntimeConfig({ ...parsed, enabled: true, providers })
}

/** Missing settings use the programmatic engine. Malformed files fail closed. */
export function loadAgentRuntimeConfig(project: RuntimeConfigProject): RuntimeConfig | null {
  return loadRuntimeConfigFile(agentRuntimeConfigPath(project), project.provider)
}

/** Atomic replacement works on macOS and Windows, with no partial file on errors. */
export function saveAgentRuntimeConfig(project: RuntimeConfigProject, input: unknown): RuntimeConfig {
  const config = validateAgentRuntimeConfig({ ...(input as object), enabled: true, providers: loadRuntimeProviders() })
  const file = agentRuntimeConfigPath(project)
  const { providers: _providers, enabled: _enabled, ...settings } = config
  atomicJson(file, settings)
  return config
}

export function validateRuntimeRolePrompts(input: unknown): Partial<Record<RuntimeRole, string>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentRuntimeConfigError('Role prompts must be an object')
  const prompts: Partial<Record<RuntimeRole, string>> = {}
  for (const [role, text] of Object.entries(input)) {
    if (!ROLES.includes(role as RuntimeRole) || typeof text !== 'string' || !text.trim() || text.length > 20000 || text.includes('\0')) throw new AgentRuntimeConfigError('Role prompts must use architect, developer or reviewer with 1–20000 nonblank characters and no null bytes')
    prompts[role as RuntimeRole] = text
  }
  return prompts
}
export function loadRuntimeRolePrompts(): Partial<Record<RuntimeRole, string>> {
  try { return validateRuntimeRolePrompts(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.specrails', 'runtime-role-prompts.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
export function saveRuntimeRolePrompts(input: unknown): Partial<Record<RuntimeRole, string>> {
  const prompts = validateRuntimeRolePrompts(input)
  atomicJson(path.join(os.homedir(), '.specrails', 'runtime-role-prompts.json'), prompts)
  return prompts
}
