import type { RuntimeEfficiency } from './runtime-efficiency'
/** Version 1 wire contract shared with Core's agent-runtime.schema.json. */
export const RUNTIME_CLI_PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'] as const
export const RUNTIME_ROLES = ['architect', 'developer', 'reviewer'] as const
export type RuntimeRole = typeof RUNTIME_ROLES[number]
export type RuntimeCli = typeof RUNTIME_CLI_PROVIDERS[number]
export type RuntimeProvider =
  | { id: string; kind: 'cli'; cli: RuntimeCli }
  | { id: string; kind: 'openai-compatible'; baseUrl: string; apiKeyEnv?: string }
export interface RuntimeAgent { provider: string; model?: string; maxTurns?: number }
export interface RuntimeVerificationCommand { repositoryId: string; command: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }
export interface AgentRuntimeConfig {
  schemaVersion: 1
  enabled: boolean
  providers: RuntimeProvider[]
  agents: Record<RuntimeRole, RuntimeAgent>
  limits?: { maxAttempts?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number }
  verification: RuntimeVerificationCommand[]
  approvalBeforeArchive?: boolean
  review?: { minScore?: number; aspects?: Partial<Record<ReviewAspect, number>> }
  architect?: { onLowConfidence?: ArchitectLowConfidencePolicy }
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
  canSettle?: boolean
  metrics?: RuntimeEfficiency
  runId: string; traceId?: string; status: string; nextStep: string | null; error?: string
  pendingApproval?: { stepId: string; reason?: string }
  pendingQuestion?: RuntimePendingQuestion
  recoverableSteps: string[]; active: boolean; canResume: boolean; canCancel: boolean
}
export interface AgentRuntimeSettingsResponse {
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
    RUNTIME_ROLES.every((role) => typeof config.agents[role]?.provider === 'string')
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
