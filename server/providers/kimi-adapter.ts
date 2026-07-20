// Kimi Code CLI adapter for 0.27.0+.
//
// Official headless contract:
//   kimi -m <configured-alias> -p <prompt> --output-format stream-json
//   kimi -m <configured-alias> --session=<session-id> -p <prompt> --output-format stream-json
//
// Prompt mode owns its automatic permission policy and cannot be combined with
// --auto/--yolo/--plan. Kimi emits JSONL assistant/tool/meta records and a
// successful terminal `session.resume_hint`, but no authoritative token or USD
// cost envelope.

import { execSync } from 'child_process'
import path from 'path'
import { windowsSpawnEnv } from '../util/win-spawn'
import { formatKimiCoreCommand } from './kimi-skill-prompt'
import { isSafeCustomModelAlias } from './runtime'
import type {
  AdapterEvent,
  AdapterEventParseResult,
  DetectionResult,
  NormalisedResult,
  ProviderAdapter,
  SpawnAction,
  SpawnOptions,
} from './types'

const whichCommand = (): 'where' | 'which' =>
  process.platform === 'win32' ? 'where' : 'which'
const KIMI_MIN_VERSION = '0.27.0'

const KIMI_MODELS = [
  { value: 'k3', label: 'Kimi K3', default: true as const },
  { value: 'kimi-for-coding', label: 'Kimi for Coding' },
  { value: 'kimi-for-coding-highspeed', label: 'Kimi for Coding Highspeed' },
] as const

const OFFICIAL_RAW_MODELS: ReadonlySet<string> = new Set(
  KIMI_MODELS.map((model) => model.value),
)
const KIMI_EFFORTS = new Set(['low', 'high', 'max'])
const STREAM_JSON_FLAGS = ['--output-format', 'stream-json'] as const
// Keep this aligned with specrails-core's public Kimi runner contract. The
// host trusts a resume hint only after both parser and argv construction have
// enforced the same bounded grammar.
const KIMI_SESSION_ID_MAX_LENGTH = 128
const KIMI_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

function normaliseKimiModel(model: string): string {
  return OFFICIAL_RAW_MODELS.has(model) ? `kimi-code/${model}` : model
}

function isK3Model(model: string): boolean {
  return model === 'k3' || model === 'kimi-code/k3'
}

function isSafeKimiSessionId(sessionId: string): boolean {
  return sessionId.length > 0
    && sessionId.length <= KIMI_SESSION_ID_MAX_LENGTH
    && sessionId !== '.'
    && sessionId !== '..'
    && KIMI_SESSION_ID_PATTERN.test(sessionId)
}

function kimiSessionOption(sessionId: string): string {
  if (!isSafeKimiSessionId(sessionId)) {
    throw new Error('invalid_kimi_session_id')
  }
  // Commander's optional `[id]` value can reinterpret a following `--value`
  // as another flag. The equals form binds even option-shaped, otherwise-safe
  // upstream ids to the session option.
  return `--session=${sessionId}`
}

function fold(systemPrompt: string | undefined, prompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt
}

function appendMediaGuidance(prompt: string, imagePaths: readonly string[] | undefined): string {
  if (!imagePaths?.length) return prompt
  const files = imagePaths.map((imagePath) => `- ${path.resolve(imagePath)}`).join('\n')
  return [
    prompt,
    '',
    'Attached media files:',
    files,
    'Use ReadMediaFile to inspect each attached media file before responding.',
  ].join('\n')
}

function promptFor(action: SpawnAction, opts: SpawnOptions): string {
  // Explore chat cwd owns AGENTS.md. Keeping the user turn short avoids
  // overpowering it with a repeated system prompt on every resume.
  const prompt = action === 'chat-turn' || action === 'chat-resume'
    ? opts.prompt
    : fold(opts.systemPrompt, opts.prompt)
  return appendMediaGuidance(prompt, opts.imagePaths)
}

function buildKimiArgs(action: SpawnAction, opts: SpawnOptions): string[] {
  if (action === 'chat-stream') {
    throw new Error('kimi does not support persistent stdin streaming (chat-stream)')
  }
  // Print mode does not run Kimi's TUI/ACP slash-command interceptor. Every
  // Core/skill spawn boundary must materialize the SKILL.md first; reject a
  // missed callsite here so it cannot settle as a deceptive zero-work success.
  if (/^\/(?:skill|specrails|sr|opsx):[^\s]+/.test(opts.prompt.trimStart())) {
    throw new Error('kimi_headless_skill_not_materialized')
  }
  // Kimi Code 0.27 prompt mode creates/resumes sessions in `auto` permission
  // mode and installs an approval handler that approves every tool call;
  // `--prompt` also rejects `--plan`. Enforce the capability contract here as
  // the final backstop: no caller may silently turn `none`/`read-only` into an
  // autonomous invocation. AI auto-title is intrinsically pure-output, so it
  // fails closed even if an older caller omitted the explicit policy.
  const requestedToolPolicy =
    action === 'auto-title' ? 'none' : (opts.toolPolicy ?? 'default')
  if (requestedToolPolicy !== 'default') {
    throw new Error(`provider_tool_policy_unsupported:kimi:${requestedToolPolicy}`)
  }
  // Routes and selectors validate custom aliases, but restored queue state and
  // internal callers can bypass those surfaces. Keep the spawn boundary
  // authoritative so a corrupt value can never become a CLI flag.
  if (!isSafeCustomModelAlias(opts.model)) {
    throw new Error('invalid_provider_model_alias:kimi')
  }

  const requiresSession = action === 'chat-resume' || action === 'setup-enrich-resume'
  if (requiresSession && !opts.sessionId) throw new Error(`${action} requires sessionId`)

  const args = ['-m', normaliseKimiModel(opts.model)]
  if (opts.sessionId && (requiresSession || action === 'agent-refine')) {
    args.push(kimiSessionOption(opts.sessionId))
  }
  args.push('-p', promptFor(action, opts), ...STREAM_JSON_FLAGS)
  if (opts.extraArgs) args.push(...opts.extraArgs)
  return args
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('')
}

function stringifyPreview(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 200)
  try {
    return JSON.stringify(value ?? '').slice(0, 200)
  } catch {
    return String(value ?? '').slice(0, 200)
  }
}

function errorMessage(parsed: Record<string, unknown>): string {
  if (typeof parsed.message === 'string') return parsed.message
  if (typeof parsed.content === 'string') return parsed.content
  if (parsed.error && typeof parsed.error === 'object') {
    const nested = parsed.error as Record<string, unknown>
    if (typeof nested.message === 'string') return nested.message
    return stringifyPreview(nested)
  }
  return 'Kimi invocation failed'
}

function assistantEvents(parsed: Record<string, unknown>): AdapterEventParseResult {
  const events: AdapterEvent[] = []
  const text = contentText(parsed.content)
  if (text) events.push({ kind: 'text-delta', text })

  const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const functionRecord = (call as Record<string, unknown>).function
    if (!functionRecord || typeof functionRecord !== 'object') continue
    const fn = functionRecord as Record<string, unknown>
    events.push({
      kind: 'tool-use',
      name: typeof fn.name === 'string' ? fn.name : '<unnamed>',
      inputPreview: stringifyPreview(fn.arguments),
    })
  }

  if (events.length === 0) {
    return { kind: 'other', type: 'assistant', raw: parsed }
  }
  return events.length === 1 ? events[0] : events
}

function parseKimiStreamLine(line: string): AdapterEventParseResult {
  if (line.trim().length === 0) return null
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }

  const role = typeof parsed.role === 'string' ? parsed.role : undefined
  const type = typeof parsed.type === 'string' ? parsed.type : undefined

  if (role === 'meta' && type === 'session.resume_hint') {
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : ''
    if (!sessionId) return { kind: 'other', type, raw: parsed }
    return isSafeKimiSessionId(sessionId)
      ? { kind: 'session-started', sessionId }
      : { kind: 'error', message: 'Kimi emitted an invalid session id' }
  }

  if (
    role === 'error' ||
    type === 'error' ||
    type === 'system.error' ||
    type?.endsWith('.failed')
  ) {
    return { kind: 'error', message: errorMessage(parsed) }
  }

  if (role === 'assistant') return assistantEvents(parsed)

  // Tool results, retry records, system.version, and future meta records remain
  // available as `other` diagnostics instead of being discarded.
  return { kind: 'other', type: type ?? role ?? '<missing>', raw: parsed }
}

function extractKimiResult(events: readonly AdapterEvent[]): NormalisedResult {
  let sessionId: string | undefined
  for (const event of events) {
    if (event.kind === 'session-started') sessionId = event.sessionId
  }
  return {
    session_id: sessionId,
  }
}

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map((value) => Number.parseInt(value, 10))
  const right = b.split('.').map((value) => Number.parseInt(value, 10))
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

async function detectKimiInstalled(): Promise<DetectionResult> {
  const env = windowsSpawnEnv()
  try {
    execSync(`${whichCommand()} kimi`, { stdio: 'ignore', env })
  } catch {
    return { installed: false, executable: false }
  }

  try {
    // The only official, non-billable bounded readiness probe is --version.
    // Authentication has no safe probe in 0.27; setup directs users to login.
    // `exec` intentionally uses the platform shell for this constant command:
    // Windows npm installs expose `kimi.cmd`, which direct execFile cannot
    // launch. No user-controlled text enters this command.
    const raw = execSync('kimi --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // ProviderAdapter.detectInstalled() is a UI/startup health probe. Keep
      // the contract's hard three-second ceiling on every platform, including
      // npm-installed Windows `.cmd` shims.
      timeout: 3_000,
      env,
    }).trim()
    const match = raw.match(/\d+\.\d+\.\d+/)
    const version = match?.[0] ?? raw
    const meetsMinimum = !!match && compareSemver(version, KIMI_MIN_VERSION) >= 0
    return {
      installed: true,
      executable: true,
      version,
      meetsMinimum,
      ...(!meetsMinimum
        ? {
            error:
              `kimi ${version || '?'} is older than required ${KIMI_MIN_VERSION}. ` +
              'Install the latest Kimi Code, run `kimi login`, then restart Specrails.',
          }
        : {}),
    }
  } catch {
    return { installed: true, executable: false }
  }
}

function buildKimiEnv(
  opts: SpawnOptions,
): Readonly<Record<string, string | undefined>> {
  const effort = opts.reasoning_effort
  return {
    KIMI_MODEL_THINKING_EFFORT:
      isK3Model(opts.model) && effort && KIMI_EFFORTS.has(effort)
        ? effort
        : undefined,
    // Desktop's stream parser and permission analysis are qualified against
    // Kimi Code 0.27's stable v1 engine. Never inherit the user's experimental
    // v2 opt-in: it selects a different runtime with an unverified policy
    // wiring and would silently invalidate those guarantees.
    KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
    // Prompt mode auto-approves tools. Desktop has no scheduler lifecycle/UI
    // for Kimi's persistent CronCreate facility, so prevent a managed child
    // from leaving scheduled work behind after its owned process exits.
    KIMI_DISABLE_CRON: '1',
    // A managed invocation must run the version that passed Desktop's
    // compatibility probe, not mutate the external CLI during startup.
    KIMI_CODE_NO_AUTO_UPDATE: '1',
  }
}

export const kimiAdapter = {
  id: 'kimi',
  displayName: 'Kimi Code',
  binary: 'kimi',
  minCliVersion: KIMI_MIN_VERSION,
  projectDirName: '.kimi-code',
  // Unlike Codex's root AGENTS.md, Kimi's provider-local project instructions
  // live inside its project tree. Keep the relative path explicit so isolated
  // Explore workspaces and integration guidance land where Kimi actually
  // loads them.
  instructionsFilename: path.join('.kimi-code', 'AGENTS.md'),
  mcpRegistration: 'project-json',
  capabilities: {
    nativeResume: true,
    nativeStreamJson: true,
    nativeCostUsd: false,
    reportsUsage: false,
    nativeOtelEnv: false,
    profileEnvSupport: true,
    systemPromptArg: false,
    foldProjectChatSystemPrompt: true,
    persistentStdin: false,
    supportsReasoningEffort: true,
    reasoningEfforts: ['low', 'high', 'max'],
    // Kimi has no image argv; validated absolute paths are inspected through
    // ReadMediaFile by provider-neutral workflow guidance.
    supportsImageInput: true,
    structuredActions: false,
    toolPolicies: [],
    profiles: true,
    // Kimi aliases are configured by the user; the built-in catalog is only a
    // convenient default/discovery set, not an exhaustive validation boundary.
    customModelAliases: true,
    customRoles: true,
    materializeHeadlessSkills: true,
    freestyle: true,
    userMcp: false,
  },
  modelCatalog: () => KIMI_MODELS,
  defaultModel: () => 'k3',
  reasoningEffortsForModel: (model: string) =>
    isK3Model(model) ? ['low', 'high', 'max'] : [],
  buildArgs: buildKimiArgs,
  buildEnv: buildKimiEnv,
  formatCoreCommand: formatKimiCoreCommand,
  buildRepoAccessArgs: (paths: readonly string[]) =>
    paths.flatMap((repoPath) => ['--add-dir', repoPath]),
  projectMcpPath: (root: string) => path.join(root, '.kimi-code', 'mcp.json'),
  customRolePath: (root: string, roleId: string) =>
    // Kimi discovers only direct children of each skills root:
    // `.kimi-code/skills/<name>/SKILL.md`. A nested `skills/rails/<name>`
    // catalog is not scanned by the upstream CLI.
    path.join(root, '.kimi-code', 'skills', roleId, 'SKILL.md'),
  parseStreamLine: parseKimiStreamLine,
  extractResult: extractKimiResult,
  baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
  detectInstalled: detectKimiInstalled,
} satisfies ProviderAdapter

export {
  KIMI_MIN_VERSION as _KIMI_MIN_VERSION,
  KIMI_MODELS as _KIMI_MODELS,
  compareSemver as _compareSemver,
  normaliseKimiModel as _normaliseKimiModel,
}
