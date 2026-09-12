import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import runtimeSchema from './schemas/agent-runtime.schema.json'
import { resolveProjectExecution } from './workspace-resolution'

export type RuntimeRole = 'architect' | 'developer' | 'reviewer'
export type RuntimeCli = 'claude' | 'codex' | 'gemini' | 'kimi'
export type RuntimeProvider = { id: string; kind: 'cli'; cli: RuntimeCli } | { id: string; kind: 'openai-compatible'; baseUrl: string; apiKeyEnv?: string }
export interface RuntimeConfig {
  schemaVersion: 1
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
    schemaVersion: 1, enabled: false,
    providers: CLI_PROVIDERS.map((cli) => ({ id: cli, kind: 'cli', cli })),
    agents: { architect: { provider }, developer: { provider }, reviewer: { provider } },
    verification: [],
  }
}

export function agentRuntimeConfigPath(project: RuntimeConfigProject): string {
  return path.join(resolveProjectExecution(project).specrailsDir, 'agent-runtime.json')
}

/** Missing configuration preserves legacy execution. Malformed files fail closed. */
export function loadAgentRuntimeConfig(project: RuntimeConfigProject): RuntimeConfig | null {
  let text: string
  try { text = fs.readFileSync(agentRuntimeConfigPath(project), 'utf8') }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new AgentRuntimeConfigError('Saved runtime configuration is not valid JSON') }
  return validateAgentRuntimeConfig(parsed)
}

/** Atomic replacement works on macOS and Windows, with no partial file on errors. */
export function saveAgentRuntimeConfig(project: RuntimeConfigProject, input: unknown): RuntimeConfig {
  const config = validateAgentRuntimeConfig(input)
  const file = agentRuntimeConfigPath(project)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return config
}
