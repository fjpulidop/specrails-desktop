import type { RuntimeEfficiency, RuntimeEfficiencySummary } from './runtime-efficiency'
/** Version 1 wire contract shared with Core's agent-runtime.schema.json. */
export const RUNTIME_CLI_PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'] as const
export const RUNTIME_ROLES = ['architect', 'developer', 'reviewer'] as const
export type RuntimeRole = typeof RUNTIME_ROLES[number]
/** Roles with an editable prompt definition: the pipeline trio plus the FIXER stance the developer takes on correction rounds (Core ≥ the fixer-prompt catalog; older cores omit it). */
export const PROMPT_ROLES = [...RUNTIME_ROLES, 'fixer'] as const
export type PromptRole = typeof PROMPT_ROLES[number]
/** The optional correction-round role: absent ⇒ the developer corrects its own work. */
export const FIXER_ROLE = 'fixer' as const
export type RuntimeAgentRole = RuntimeRole | typeof FIXER_ROLE
export type RuntimeCli = typeof RUNTIME_CLI_PROVIDERS[number]
/** Optional USD per 1M tokens; when present the app flags the derived cost as estimated. */
export interface RuntimeProviderRates { inputPer1M: number; outputPer1M: number }
export interface RuntimeCliProvider { id: string; kind: 'cli'; cli: RuntimeCli }
/**
 * An OpenAI-compatible (local) connection. `label`, `defaultModel`, `rates` and
 * `supportsReasoningEffort` are additive — files without them load unchanged.
 */
export interface RuntimeLocalProvider {
  id: string
  kind: 'openai-compatible'
  baseUrl: string
  apiKeyEnv?: string
  label?: string
  defaultModel?: string
  rates?: RuntimeProviderRates
  supportsReasoningEffort?: boolean
  /** Core small-model runtime: 'compact' (default, host-driven micro-steps) or 'free' (single agentic loop). */
  agentLoop?: 'compact' | 'free'
  /** Server context window used for compaction budgets (tokens). */
  contextWindowTokens?: number
  /** Output budget (max_tokens) of one tool turn; the cut-off retry gets twice this, bounded by the window. Default 8192. */
  maxOutputTokens?: number
}
export type RuntimeProvider = RuntimeCliProvider | RuntimeLocalProvider

/** Live detection status of one connection (`GET /api/runtime-providers` → `status[id]`). */
export interface RuntimeProviderStatus {
  reachable?: boolean
  installed?: boolean
  executable?: boolean
  version?: string
  authState: 'authenticated' | 'unauthenticated' | 'unknown'
  models?: string[]
  latencyMs?: number
  error?: string
  apiKeyEnvMissing?: boolean
}
export interface RuntimeProvidersResponse { providers: RuntimeProvider[]; status: Record<string, RuntimeProviderStatus> }
/** `POST /api/runtime-providers/test` reply — a probe of the DRAFT values, nothing saved. */
export interface RuntimeProviderTestResult {
  reachable: boolean
  authState: RuntimeProviderStatus['authState']
  models: string[]
  latencyMs: number
  error?: string
  apiKeyEnvMissing?: boolean
}

export function isLocalRuntimeProvider(provider: RuntimeProvider): provider is RuntimeLocalProvider {
  return provider.kind === 'openai-compatible'
}

/** Display name for a connection: the user's label when set, else the stable id. */
export function runtimeProviderDisplayName(provider: RuntimeProvider): string {
  return provider.kind === 'openai-compatible' && provider.label?.trim() ? provider.label.trim() : provider.id
}

/** Older servers omit `status`; a malformed body must never be treated as a connection list. */
export function isRuntimeProvidersResponse(value: unknown): value is RuntimeProvidersResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<RuntimeProvidersResponse>
  return Array.isArray(data.providers) && data.providers.every((provider) => provider && typeof provider.id === 'string' && ['cli', 'openai-compatible'].includes(provider.kind))
    && (data.status === undefined || (typeof data.status === 'object' && data.status !== null))
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
export interface RuntimeAgent { provider: string; model?: string; maxTurns?: number; effort?: string; /** Local engines only: private thinking; unset = off. */ thinking?: 'on' | 'off'; escalation?: { model: string; effort?: string } }
export interface RuntimeVerificationCommand { key?: string; label?: string; policy?: RuntimeCheckPolicy; repositoryId: string; command: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }
export interface RuntimeRoleDescriptor extends RuntimeAgent {
  access: 'read' | 'write'
  artifacts: 'none' | 'tasks-checkboxes' | 'all'
  prompt?: string
  openspecSkill?: 'openspec-ff-change' | 'openspec-apply-change' | 'openspec-verify-change'
}
export const CUSTOM_ROLE_ID = /^[a-z][a-z0-9-]{0,63}$/
export interface AgentRuntimeConfig {
  roles?: Record<string, RuntimeRoleDescriptor>
  rolePrompts?: Record<string, string>
  efficiency?: RuntimeEfficiencyPolicy
  schemaVersion: 1
  enabled: boolean
  providers: RuntimeProvider[]
  agents: Record<RuntimeRole, RuntimeAgent>
  /**
   * Optional engine for correction rounds (after a failed verification or a
   * rejected review). Same shape as an `agents` entry; absent ⇒ the developer
   * corrects its own work.
   */
  fixer?: RuntimeAgent
  limits?: { maxAttempts?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number }
  verification: RuntimeVerificationCommand[]
  approvalBeforeArchive?: boolean
  review?: { minScore?: number; aspects?: Partial<Record<ReviewAspect, number>> }
  architect?: { onLowConfidence?: ArchitectLowConfidencePolicy }
  /** Compact-runtime guardrails switched OFF (`id → false`). A missing id is on; `true` is never stored. */
  guardrails?: Record<string, boolean>
}
/** `GET …/agent-runtime/guardrails` — the host's process rules around local models, grouped by phase. */
export const GUARDRAIL_PHASES = ['architect', 'developer', 'host'] as const
export type GuardrailPhase = typeof GUARDRAIL_PHASES[number]
export interface GuardrailDescriptor { id: string; phase: GuardrailPhase }
export interface GuardrailsCatalogResponse { supported: boolean; catalog: GuardrailDescriptor[] }
/** An older Core (or a malformed body) renders the section disabled instead of crashing. */
export function isGuardrailsCatalogResponse(value: unknown): value is GuardrailsCatalogResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<GuardrailsCatalogResponse>
  return typeof data.supported === 'boolean' && Array.isArray(data.catalog) &&
    data.catalog.every((item) => item && typeof item.id === 'string' && (GUARDRAIL_PHASES as readonly string[]).includes(item.phase))
}
/** Only `false` entries persist; turning a guardrail back on deletes its key (undefined when nothing is off). */
export function setGuardrail(current: Record<string, boolean> | undefined, id: string, enabled: boolean): Record<string, boolean> | undefined {
  const next = { ...current }
  if (enabled) delete next[id]
  else next[id] = false
  return Object.keys(next).length ? next : undefined
}
export const REVIEW_ASPECTS = ['type_correctness', 'pattern_adherence', 'test_coverage', 'security', 'architectural_alignment'] as const
export type ReviewAspect = typeof REVIEW_ASPECTS[number]
export const ARCHITECT_LOW_CONFIDENCE_POLICIES = ['ask', 'proceed'] as const
export type ArchitectLowConfidencePolicy = typeof ARCHITECT_LOW_CONFIDENCE_POLICIES[number]
/** Core's own review gate: configured thresholds may only tighten it, so the defaults are also the floors. */
export const REVIEW_THRESHOLD_DEFAULTS: { minScore: number; aspects: Record<ReviewAspect, number> } = {
  minScore: 70,
  aspects: { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 },
}
/** An architect question that pauses the run until the operator answers through resume. */
export interface RuntimePendingQuestion { stepId: string; requestedAt: string; question: string; answeredAt?: string; answer?: string }
export interface RuntimeRun {
  historical?: boolean
  efficiencySummary?: RuntimeEfficiencySummary
  canSettle?: boolean
  metrics?: RuntimeEfficiency
  runId: string; traceId?: string; status: string; nextStep: string | null; error?: string
  pendingApproval?: { stepId: string; reason?: string }
  pendingQuestion?: RuntimePendingQuestion
  recoverableSteps: string[]; active: boolean; canResume: boolean; canCancel: boolean
  /** Settled continuation removable from the rail card (stays in the history). */
  canDismiss?: boolean
  dismissed?: boolean
}
export interface AgentRuntimeSettingsResponse {
  openRolesAvailable?: boolean
  efficiencyAvailable?: boolean
  configured: boolean
  config: AgentRuntimeConfig
  runtimeAvailable: boolean
}
export interface VerificationSuggestion { repositoryId: string; command: string; args: string[]; reason: string }
export interface VerificationSuggestionsResponse { repositories: Array<{ id: string; name: string }>; suggestions: VerificationSuggestion[] }

/** Core defaults, shown in the form so an empty field never hides what will run. */
export const RUNTIME_DEFAULTS = {
  maxTurns: 100,
  maxAttempts: 3,
  timeoutMs: 15 * 60_000,
} as const

/** Older servers or malformed responses must never poison the project cache. */
export function isAgentRuntimeSettingsResponse(value: unknown): value is AgentRuntimeSettingsResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<AgentRuntimeSettingsResponse>
  const config = data.config
  return typeof data.configured === 'boolean' && typeof data.runtimeAvailable === 'boolean' &&
    config?.schemaVersion === 1 && typeof config.enabled === 'boolean' &&
    Array.isArray(config.providers) && config.providers.every((provider) => provider && typeof provider.id === 'string' && ['cli', 'openai-compatible'].includes(provider.kind)) &&
    Array.isArray(config.verification) && Boolean(config.agents) &&
    RUNTIME_ROLES.every((role) => typeof config.agents[role]?.provider === 'string') &&
    (config.roles === undefined || (config.roles !== null && typeof config.roles === 'object' && !Array.isArray(config.roles) && Object.entries(config.roles).every(([id, role]) => CUSTOM_ROLE_ID.test(id) && id !== 'fixer' && role && typeof role.provider === 'string' && ['read', 'write'].includes(role.access) && ['none', 'tasks-checkboxes', 'all'].includes(role.artifacts))))
}

export function isVerificationSuggestionsResponse(value: unknown): value is VerificationSuggestionsResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<VerificationSuggestionsResponse>
  return Array.isArray(data.repositories) && Array.isArray(data.suggestions) &&
    data.suggestions.every((item) => item && typeof item.repositoryId === 'string' && typeof item.command === 'string' && Array.isArray(item.args))
}

/** Stable IDs let role assignments survive edits to an endpoint. */
export function nextRuntimeProviderId(providers: RuntimeProvider[], prefix: string): string {
  let candidate = prefix
  let suffix = 2
  while (providers.some(({ id }) => id === candidate)) candidate = `${prefix}-${suffix++}`
  return candidate
}

/** One editable line per command: `npm run test`. Quotes group arguments with spaces. */
export function formatVerificationCommand(command: Pick<RuntimeVerificationCommand, 'command' | 'args'>): string {
  return [command.command, ...command.args].map((word) => /[\s"]/.test(word) ? JSON.stringify(word) : word).join(' ')
}

/** Inverse of formatVerificationCommand; null when the line is empty or has an unterminated quote. */
export function parseVerificationCommand(line: string): { command: string; args: string[] } | null {
  const words: string[] = []
  let current = '', quoted = false, hasWord = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === '\\' && i + 1 < line.length) { current += line[++i]; continue }
      if (char === '"') { quoted = false; continue }
      current += char
      continue
    }
    if (char === '"') { quoted = true; hasWord = true; continue }
    if (/\s/.test(char)) { if (hasWord) { words.push(current); current = ''; hasWord = false }; continue }
    current += char; hasWord = true
  }
  if (quoted) return null
  if (hasWord) words.push(current)
  if (!words.length || !words[0]) return null
  return { command: words[0], args: words.slice(1) }
}
