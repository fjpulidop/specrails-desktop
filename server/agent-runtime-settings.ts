import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import runtimeSchema from './schemas/agent-runtime.schema.json'
import { resolveProjectExecution } from './workspace-resolution'
import { hasAdapter, adapterKind, isLocalAdapterId } from './providers/registry'

export type RuntimeRole = 'architect' | 'developer' | 'reviewer'
export type RuntimeCli = 'claude' | 'codex' | 'gemini' | 'kimi'
/** Desktop-only additive fields on an openai-compatible connection (local AI
 *  engines). Core's validator rejects unknown keys, so they are STRIPPED before
 *  any config reaches Core (`stripDesktopConnectionFields`). */
export interface LocalConnectionExtras {
  label?: string
  defaultModel?: string
  rates?: { inputPer1M: number; outputPer1M: number }
  supportsReasoningEffort?: boolean
  /** Core-owned (compact small-model runtime); stripped for cores without `compactAgentLoop`. */
  agentLoop?: 'compact' | 'free'
  contextWindowTokens?: number
  /** Core-owned: output budget (`max_tokens`) of one tool turn; stripped for cores without `compactOutputBudget`. */
  maxOutputTokens?: number
}
export type RuntimeProvider = { id: string; kind: 'cli'; cli: RuntimeCli } | ({ id: string; kind: 'openai-compatible'; baseUrl: string; apiKeyEnv?: string } & LocalConnectionExtras)
const DESKTOP_CONNECTION_FIELDS = ['label', 'defaultModel', 'rates'] as const
/** Core-owned small-model fields: known only to cores advertising `capabilities.compactAgentLoop`
 *  (`supportsReasoningEffort` moved here: core forwards it as OpenAI `reasoning_effort`). */
const CORE_COMPACT_FIELDS = ['agentLoop', 'contextWindowTokens', 'supportsReasoningEffort'] as const
/** Known only to cores advertising `capabilities.compactOutputBudget`. */
const CORE_OUTPUT_BUDGET_FIELDS = ['maxOutputTokens'] as const
export const CONTEXT_WINDOW_TOKENS_MIN = 4096
export const CONTEXT_WINDOW_TOKENS_MAX = 4_000_000
export const MAX_OUTPUT_TOKENS_MIN = 1024
export const MAX_OUTPUT_TOKENS_MAX = 1_000_000
const MODEL_PATTERN = /^[^-\r\n\u0000][^\r\n\u0000]*$/

/** Core-shaped providers: desktop-only connection fields removed. */
export function stripDesktopConnectionFields<T extends { kind: string }>(providers: readonly T[], opts?: { coreCompactLoop?: boolean; coreOutputBudget?: boolean }): T[] {
  return providers.map((provider) => {
    if (provider.kind !== 'openai-compatible') return { ...provider }
    const copy: Record<string, unknown> = { ...provider }
    for (const field of DESKTOP_CONNECTION_FIELDS) delete copy[field]
    // Older cores reject unknown keys: only hand the compact-loop fields to a
    // core that advertises them. Absent opts ⇒ conservative (strip).
    if (opts?.coreCompactLoop !== true) for (const field of CORE_COMPACT_FIELDS) delete copy[field]
    if (opts?.coreOutputBudget !== true) for (const field of CORE_OUTPUT_BUDGET_FIELDS) delete copy[field]
    return copy as T
  })
}

function validateDesktopConnectionFields(provider: Record<string, unknown>, index: number): LocalConnectionExtras {
  const at = `/providers/${index}`
  const extras: LocalConnectionExtras = {}
  if (provider.label !== undefined) {
    if (typeof provider.label !== 'string' || !provider.label.trim() || provider.label.length > 64 || /[\r\n\u0000]/.test(provider.label)) throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/label: must be 1–64 characters`)
    extras.label = provider.label
  }
  if (provider.defaultModel !== undefined) {
    if (typeof provider.defaultModel !== 'string' || !provider.defaultModel.trim() || provider.defaultModel.length > 256 || !MODEL_PATTERN.test(provider.defaultModel)) throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/defaultModel: must be a model id (no leading '-', no control characters)`)
    extras.defaultModel = provider.defaultModel
  }
  if (provider.rates !== undefined) {
    const rates = provider.rates as Record<string, unknown> | null
    if (!rates || typeof rates !== 'object' || Array.isArray(rates) || Object.keys(rates).some((key) => key !== 'inputPer1M' && key !== 'outputPer1M')) throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/rates: expected { inputPer1M, outputPer1M }`)
    for (const key of ['inputPer1M', 'outputPer1M'] as const) {
      const value = rates[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/rates/${key}: must be a non-negative number`)
    }
    extras.rates = { inputPer1M: rates.inputPer1M as number, outputPer1M: rates.outputPer1M as number }
  }
  if (provider.supportsReasoningEffort !== undefined) {
    if (typeof provider.supportsReasoningEffort !== 'boolean') throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/supportsReasoningEffort: must be a boolean`)
    extras.supportsReasoningEffort = provider.supportsReasoningEffort
  }
  if (provider.agentLoop !== undefined) {
    if (provider.agentLoop !== 'compact' && provider.agentLoop !== 'free') throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/agentLoop: must be "compact" or "free"`)
    extras.agentLoop = provider.agentLoop
  }
  if (provider.contextWindowTokens !== undefined) {
    const n = provider.contextWindowTokens
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < CONTEXT_WINDOW_TOKENS_MIN || n > CONTEXT_WINDOW_TOKENS_MAX) throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/contextWindowTokens: must be an integer between ${CONTEXT_WINDOW_TOKENS_MIN} and ${CONTEXT_WINDOW_TOKENS_MAX}`)
    extras.contextWindowTokens = n
  }
  if (provider.maxOutputTokens !== undefined) {
    const n = provider.maxOutputTokens
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < MAX_OUTPUT_TOKENS_MIN || n > MAX_OUTPUT_TOKENS_MAX) throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${at}/maxOutputTokens: must be an integer between ${MAX_OUTPUT_TOKENS_MIN} and ${MAX_OUTPUT_TOKENS_MAX}`)
    extras.maxOutputTokens = n
  }
  return extras
}
/** The strip options for a loaded core: each core-owned field family travels only when the core advertises it. */
export function coreConnectionFieldGates(capabilities: Record<string, unknown> | undefined): { coreCompactLoop: boolean; coreOutputBudget: boolean } {
  return { coreCompactLoop: capabilities?.compactAgentLoop === 1, coreOutputBudget: capabilities?.compactOutputBudget === 1 }
}
export interface RuntimeEfficiencyPolicy {
  schemaVersion: 1
  contextMode?: 'full' | 'incremental'
  reviewMode?: 'full' | 'incremental'
  planning?: 'full' | 'proportional'
  acceptDeveloperChecks?: boolean
  verification?: { maxConcurrency?: number }
}
export interface RuntimeCheckPolicy {
  reuse?: 'never' | 'snapshot-local'
  inputs?: string[]
  deterministic?: boolean
  readOnly?: boolean
  toolchainInputs?: string[]
  independentGroup?: string
  resources?: string[]
}
export interface RuntimeConfig {
  efficiency?: RuntimeEfficiencyPolicy
  schemaVersion: 1
  rolePrompts?: Partial<Record<RuntimeRole | 'fixer', string>>
  enabled: boolean
  providers: RuntimeProvider[]
  agents: Record<RuntimeRole, { provider: string; model?: string; maxTurns?: number; effort?: string; thinking?: 'on' | 'off'; escalation?: { model: string; effort?: string } }>
  /** Optional engine for correction rounds (failed verification / rejected review); unset ⇒ the developer corrects. */
  fixer?: { provider: string; model?: string; maxTurns?: number; effort?: string; thinking?: 'on' | 'off'; escalation?: { model: string; effort?: string } }
  limits?: { maxAttempts?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number }
  verification: Array<{ key?: string; label?: string; policy?: RuntimeCheckPolicy; repositoryId: string; command: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }>
  approvalBeforeArchive?: boolean
  review?: { minScore?: number; aspects?: Partial<Record<ReviewAspect, number>> }
  architect?: { onLowConfidence?: 'ask' | 'proceed' }
  /** Compact-runtime guardrails the project switched OFF (`{ id: false }`); unset = all on. Forwarded to Core only when it advertises `configurableGuardrails`. */
  guardrails?: Record<string, boolean>
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
  // Desktop-only connection fields ride the openai-compatible entries; the
  // vendored (byte-identical to Core) schema forbids unknown keys, so they are
  // validated here and re-attached after the schema pass.
  const extrasByIndex = new Map<number, LocalConnectionExtras>()
  if (input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as { providers?: unknown }).providers)) {
    const rawProviders = (input as { providers: unknown[] }).providers
    rawProviders.forEach((provider, index) => {
      if (!provider || typeof provider !== 'object' || (provider as { kind?: unknown }).kind !== 'openai-compatible') return
      extrasByIndex.set(index, validateDesktopConnectionFields(provider as Record<string, unknown>, index))
    })
    input = { ...(input as object), providers: stripDesktopConnectionFields(rawProviders as { kind: string }[]) }
  }
  if (!schemaValidator(input)) {
    const error = schemaValidator.errors?.[0]
    throw new AgentRuntimeConfigError(`Invalid runtime configuration at ${error?.instancePath || '/'}: ${error?.message ?? 'invalid value'}`)
  }
  const config = input as RuntimeConfig
  if (config.rolePrompts !== undefined) validateRuntimeRolePrompts(config.rolePrompts)
  if (new Set(config.providers.map(({ id }) => id)).size !== config.providers.length) throw new AgentRuntimeConfigError('Provider IDs must be unique')
  for (const provider of config.providers) {
    if (provider.kind !== 'openai-compatible') continue
    // A connection id may never shadow a registered CLI adapter (claude/codex/
    // gemini/kimi): local adapters register under the connection id.
    if (hasAdapter(provider.id) && adapterKind(provider.id) !== 'local') throw new AgentRuntimeConfigError(`Provider id '${provider.id}' is reserved for the ${provider.id} CLI adapter`)
    let url: URL
    try { url = new URL(provider.baseUrl) } catch { throw new AgentRuntimeConfigError('Provider base URL must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || provider.baseUrl.includes('\0')) throw new AgentRuntimeConfigError('Provider URLs must use HTTP(S) without credentials, query parameters or fragments')
  }
  for (const role of [...ROLES, ...(config.fixer ? ['fixer' as const] : [])]) {
    const agent = role === 'fixer' ? config.fixer! : config.agents[role]
    const provider = config.providers.find(({ id }) => id === agent.provider)
    if (!provider) throw new AgentRuntimeConfigError(`Role ${role} references a provider that is not configured`)
    // Core requires a model on API providers, but a LOCAL engine (a registered
    // connection with a discovered/stored default) may be saved as "provider
    // default": the launch path fills the connection's CURRENT default
    // (`fillDefaultRoleModels`), so changing the connection's default later
    // applies to every role that did not pin one. Persisting the filled value
    // used to freeze gpt-oss-fast into the architect after the user switched
    // the connection to qwen3-coder.
    if (provider.kind === 'openai-compatible' && !agent.model && !(hasAdapter(provider.id) && isLocalAdapterId(provider.id))) throw new AgentRuntimeConfigError(`Role ${role} requires a model for its API provider`)
    if (agent.model !== undefined && !agent.model.trim()) throw new AgentRuntimeConfigError(`Role ${role} requires a nonempty model identifier`)
    for (const value of [agent.model, agent.effort, agent.escalation?.model, agent.escalation?.effort]) if (value !== undefined && (!value.trim() || value.includes('\0'))) throw new AgentRuntimeConfigError(`Role ${role} has an invalid model or effort`)
    if (agent.escalation && (!agent.model || (agent.escalation.model === agent.model && agent.escalation.effort === agent.effort))) throw new AgentRuntimeConfigError(`Role ${role} escalation requires an explicit base and a different model or effort`)
    if (agent.maxTurns !== undefined && !Number.isSafeInteger(agent.maxTurns)) throw new AgentRuntimeConfigError(`Role ${role} maxTurns must be a safe integer`)
    if (agent.thinking !== undefined && agent.thinking !== 'on' && agent.thinking !== 'off') throw new AgentRuntimeConfigError(`Role ${role} thinking must be "on" or "off"`)
  }
  for (const [key, value] of Object.entries(config.limits ?? {})) {
    if (!Number.isFinite(value) || (key !== 'maxCostUsd' && !Number.isSafeInteger(value))) throw new AgentRuntimeConfigError('Workflow limits must be finite, safe numbers')
  }
  const keys = config.verification.flatMap(command => command.key ? [command.key] : [])
  if (new Set(keys).size !== keys.length) throw new AgentRuntimeConfigError('Verification check keys must be unique')
  for (const command of config.verification) {
    for (const value of [command.label, ...(command.policy?.inputs ?? []), ...(command.policy?.toolchainInputs ?? []), ...(command.policy?.resources ?? [])]) if (value !== undefined && (!value.trim() || value.includes('\0'))) throw new AgentRuntimeConfigError('Invalid verification label or policy input')
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
  const cloned = structuredClone(config)
  for (const [index, extras] of extrasByIndex) cloned.providers[index] = { ...cloned.providers[index], ...extras } as RuntimeProvider
  return cloned
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

/** Roles with an editable definition: the trio plus the FIXER stance (the developer role on a correction round). */
export type RuntimePromptRole = RuntimeRole | 'fixer'
const PROMPT_ROLES: RuntimePromptRole[] = [...ROLES, 'fixer']
export function validateRuntimeRolePrompts(input: unknown): Partial<Record<RuntimePromptRole, string>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentRuntimeConfigError('Role prompts must be an object')
  const prompts: Partial<Record<RuntimePromptRole, string>> = {}
  for (const [role, text] of Object.entries(input)) {
    if (!PROMPT_ROLES.includes(role as RuntimePromptRole) || typeof text !== 'string' || !text.trim() || text.length > 20000 || text.includes('\0')) throw new AgentRuntimeConfigError('Role prompts must use architect, developer, reviewer or fixer with 1–20000 nonblank characters and no null bytes')
    prompts[role as RuntimePromptRole] = text
  }
  return prompts
}
export function loadRuntimeRolePrompts(): Partial<Record<RuntimePromptRole, string>> {
  try { return validateRuntimeRolePrompts(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.specrails', 'runtime-role-prompts.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
export function saveRuntimeRolePrompts(input: unknown): Partial<Record<RuntimePromptRole, string>> {
  const prompts = validateRuntimeRolePrompts(input)
  atomicJson(path.join(os.homedir(), '.specrails', 'runtime-role-prompts.json'), prompts)
  return prompts
}


export interface RuntimeProviderOverride { provider: string; model?: string; effort?: string }
export function validateRuntimeProviderOverride(value: unknown): RuntimeProviderOverride | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentRuntimeConfigError('Invalid runtime provider override')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['provider', 'model', 'effort'].includes(key)) || typeof raw.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.provider)) throw new AgentRuntimeConfigError('Invalid runtime provider override provider')
  if (raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 256 || /^-|[\r\n\0]/.test(raw.model))) throw new AgentRuntimeConfigError('Invalid runtime provider override model')
  if (raw.effort !== undefined && (typeof raw.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(raw.effort))) throw new AgentRuntimeConfigError('Invalid runtime provider override effort')
  return structuredClone(raw) as unknown as RuntimeProviderOverride
}

/** Older Core runtimes reject unknown top-level keys: drop `guardrails` unless the loaded Core advertises `configurableGuardrails`. */
export function forCoreRuntime<T extends { guardrails?: unknown; agents?: Record<string, { thinking?: unknown }>; fixer?: { thinking?: unknown } }>(config: T, capabilities: Record<string, number> | undefined): T {
  let out: T = config
  if (capabilities?.configurableGuardrails !== 1 && out.guardrails !== undefined) { const { guardrails: _dropped, ...rest } = out; out = rest as T }
  // The per-role thinking switch is known only to cores advertising `roleThinkingControl`.
  if (capabilities?.roleThinkingControl !== 1 && (Object.values(out.agents ?? {}).some(agent => agent?.thinking !== undefined) || out.fixer?.thinking !== undefined)) {
    const strip = <A extends { thinking?: unknown }>(agent: A): A => { const { thinking: _t, ...rest } = agent; return rest as A }
    out = { ...out, ...(out.agents ? { agents: Object.fromEntries(Object.entries(out.agents).map(([role, agent]) => [role, strip(agent)])) } : {}), ...(out.fixer ? { fixer: strip(out.fixer) } : {}) }
  }
  return out
}
