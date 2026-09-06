// Claude adapter. Ports the existing claude spawn / stream / result logic from
// chat-manager.ts, queue-manager.ts, agent-refine-manager.ts,
// project-router.ts (generate-spec), setup-manager.ts, and result-event.ts
// without behaviour change. Managers will migrate to consume this adapter in
// later tasks (see openspec/changes/add-multi-provider-support/tasks.md §2.x).
//
// Spec: openspec/specs/multi-provider-architecture/spec.md

import { execSync } from 'child_process'
import path from 'path'
import { getOpenSpecRuntimePluginArgs } from '../openspec-runtime-plugin'
import type {
  AdapterEvent,
  DetectionResult,
  NormalisedResult,
  ProviderAdapter,
  SpawnAction,
  SpawnOptions,
} from './types'

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet', default: true as const },
  { value: 'fable', label: 'Claude Fable' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
] as const

/** Mirror of ChatManager.normalizeClaudeCodeModel — pinned model strings the
 *  CLI accepts collapse to the short alias. */
function normaliseModel(model: string | null | undefined): string {
  switch (model) {
    case 'claude-sonnet-5':
    case 'claude-sonnet-4-6':
    case 'claude-sonnet-4-5':
    case 'claude-sonnet-4-0':
    case 'claude-sonnet-4-20250514':
      return 'sonnet'
    case 'claude-fable-5':
      return 'fable'
    case 'claude-opus-5':
    case 'claude-opus-4-8':
    case 'claude-opus-4-5':
    case 'claude-opus-4-1-20250805':
    case 'claude-opus-4-20250514':
      return 'opus'
    case 'claude-haiku-4-5-20251001':
    case 'claude-3-5-haiku-20241022':
    case 'claude-3-5-haiku-latest':
      return 'haiku'
    default:
      return model || 'sonnet'
  }
}

/**
 * Catalog aliases whose GENERATION Specrails pins explicitly.
 *
 * The catalog value (`opus`) stays the stored, validated and displayed identity
 * — profiles, project settings, conversation rows and analytics all keep using
 * it, and `normaliseModel` collapses the pinned id back to it. Only the spawn
 * argument is expanded, so picking "Claude Opus" is a product decision about
 * WHICH Opus runs instead of delegating that to whatever generation the CLI's
 * bare `opus` alias currently points at.
 */
const PINNED_ALIAS_MODEL_IDS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5',
}

/** Catalog value (or concrete id) in, spawn model id out. */
function resolveSpawnModel(model: string | null | undefined): string {
  const alias = normaliseModel(model)
  return PINNED_ALIAS_MODEL_IDS[alias] ?? alias
}

/**
 * Common flags + the effective tool boundary for this spawn.
 *
 * Default (`project,local`) isolates app-spawned claude from the *user's*
 * global Claude config. Without this, the child loads ~/.claude (user CLAUDE.md
 * memory, plugins like claude-mem, SessionStart hooks). That bled cross-project
 * memory into Explore turns (e.g. an unrelated "fighting game" surfaced for a
 * fresh project) and inflated spec-gen tool usage past --max-turns.
 *
 * When `opts.loadUserEnv` is set (the Add Spec "My approved MCPs" toggle), we
 * switch to `user,project,local` so the developer's user-scope, plugin-bundled,
 * and connector MCP servers are discovered. This is the ONLY way those MCP
 * servers load (verified empirically against claude 2.1.177 — plugin MCP
 * servers are gated by the `user` setting source); it also re-loads user
 * CLAUDE.md + hooks, which is the user's explicit opt-in via the toggle.
 */
function commonFlagsFor(opts: SpawnOptions): string[] {
  const toolPolicy = opts.toolPolicy ?? 'default'
  const toolArgs = toolPolicy === 'none'
    // Claude silently drops an empty tool list on some versions and falls back
    // to the default toolkit. A non-existent sentinel is the established,
    // tested way this repo disables every tool (see context-scope.ts).
    ? ['--tools', '__none__']
    : toolPolicy === 'read-only'
      ? ['--tools', 'Read,Grep,Glob']
      : ['--tools', 'default']
  return [
    // No approval bypass is necessary when no tool can be invoked. Keeping it
    // off also makes the pure-output boundary fail closed if Claude ever
    // changes how it interprets the sentinel. Read-only work uses Claude's
    // native plan mode: Read/Grep/Glob stay usable without granting the
    // blanket permission bypass carried by normal autonomous turns.
    ...(toolPolicy === 'default'
      ? ['--dangerously-skip-permissions']
      : toolPolicy === 'read-only'
        ? ['--permission-mode', 'plan', '--safe-mode']
        : []),
    ...toolArgs,
    ...(toolPolicy === 'default' ? getOpenSpecRuntimePluginArgs() : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources',
    opts.loadUserEnv ? 'user,project,local' : 'project,local',
    // Native reasoning-effort flag (claude CLI accepts low|medium|high|xhigh|max).
    // Emitted only when requested; absent ⇒ the CLI's default effort.
    ...(opts.reasoning_effort ? ['--effort', opts.reasoning_effort] : []),
  ]
}

function buildClaudeArgs(action: SpawnAction, opts: SpawnOptions): string[] {
  const args: string[] = []
  const model = resolveSpawnModel(opts.model)
  // Titles are unconditionally pure-output. Centralising the policy here keeps
  // both ChatManager and AgentChatManager from accidentally regaining tools.
  const commonFlags = commonFlagsFor(
    action === 'auto-title' ? { ...opts, toolPolicy: 'none' } : opts,
  )

  switch (action) {
    case 'chat-turn': {
      args.push('--model', model)
      args.push(...commonFlags)
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      args.push('-p', opts.prompt)
      if (opts.maxTurns != null) args.push('--max-turns', String(opts.maxTurns))
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'chat-resume': {
      if (!opts.sessionId) {
        throw new Error('chat-resume requires sessionId')
      }
      args.push('--model', model)
      args.push(...commonFlags)
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      args.push('--resume', opts.sessionId)
      args.push('-p', opts.prompt)
      if (opts.maxTurns != null) args.push('--max-turns', String(opts.maxTurns))
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'chat-stream': {
      // Persistent multi-turn transport: one child stays alive and reads
      // newline-delimited stream-json user messages from stdin (no `-p
      // <prompt>` argument — the prompt arrives over stdin). The system prompt
      // is fixed once at spawn (the Explore lightweight prompt is byte-stable,
      // so this is sound). `--max-turns` is intentionally omitted: it would
      // terminate the whole process after N agentic turns and end the session.
      args.push('--model', model)
      args.push(...commonFlags)
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      // When the conversation already has a session (a re-spawn after idle-kill
      // or crash), resume it so the persistent child restores prior context
      // instead of starting a fresh thread. Absent on the very first turn.
      if (opts.sessionId) args.push('--resume', opts.sessionId)
      args.push('-p')
      args.push('--input-format', 'stream-json')
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'rail-job': {
      // QueueManager spawns with `--append-system-prompt` (not `--system-prompt`)
      // because the slash command in the prompt brings its own system prompt;
      // we ADD to it rather than overwrite.
      args.push(...commonFlags)
      args.push('--model', model)
      if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
      args.push('-p', opts.prompt)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'spec-gen': {
      args.push(...commonFlags)
      args.push('--model', model)
      if (opts.maxTurns != null) args.push('--max-turns', String(opts.maxTurns))
      // Caller passes --tools override via extraArgs when scoped; otherwise
      // the default policy from commonFlagsFor applies.
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      args.push('-p', opts.prompt)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'agent-refine': {
      args.push(...commonFlags)
      if (opts.sessionId) args.push('--resume', opts.sessionId)
      args.push('-p', opts.prompt)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'setup-enrich': {
      args.push('-p', opts.prompt)
      args.push(...commonFlags)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'setup-enrich-resume': {
      if (!opts.sessionId) {
        throw new Error('setup-enrich-resume requires sessionId')
      }
      args.push('--resume', opts.sessionId)
      args.push(...commonFlags)
      args.push('-p', opts.prompt)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'auto-title': {
      args.push(...commonFlags)
      args.push('-p', opts.prompt)
      return args
    }
  }
}

/** Per-API-call usage block carried on claude `assistant` stream events
 *  (`message.usage`). Anthropic semantics: `input_tokens` EXCLUDES the cache
 *  read/write counts (they are reported separately). */
export interface AssistantEventUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Claude adapter events optionally carry the assistant frame's usage snapshot
 * so cumulative token usage can be reconstructed for runs killed before their
 * terminal `result` event (COST-ACCOUNTING-AUDIT HIGH-8 / CRIT-1). `messageId`
 * is the API message id — the dedup key, because one message can be split into
 * multiple `assistant` frames (one per content block) that all repeat the same
 * usage; summing frames naively would double-count. `model` is the full model
 * id from `message.model`.
 */
export type ClaudeUsageEvent = AdapterEvent & {
  usage?: AssistantEventUsage
  messageId?: string
  model?: string
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Attach the assistant frame's usage/model/message-id onto the emitted
 *  adapter event (mutating in place keeps the union shape intact). No-op when
 *  the frame carries no usage block. */
function withAssistantUsage(
  ev: AdapterEvent,
  msg: { id?: unknown; model?: unknown; usage?: unknown } | undefined,
): AdapterEvent {
  const usage = msg?.usage
  if (!usage || typeof usage !== 'object') return ev
  const carrier = ev as ClaudeUsageEvent
  carrier.usage = usage as AssistantEventUsage
  if (typeof msg?.id === 'string') carrier.messageId = msg.id
  if (typeof msg?.model === 'string') carrier.model = msg.model
  return ev
}

/** True when a claude `result` frame is a CLI-INTERNAL notification turn, NOT
 *  the answer to a prompt the caller wrote. Live evidence (loop run 5c958db2,
 *  claude 2.1.260): a `--resume` of a session whose previous process exited
 *  with background tasks still running makes the CLI report those tasks as
 *  orphaned and emit a turn of its own — `origin: {kind:'task-notification'}`,
 *  `num_turns: 0`, `stop_reason: null`, empty `result`, zero usage — BEFORE it
 *  processes the caller's prompt. A consumer that closes its turn on the first
 *  `result` (interactive job/loop sessions, persistent Explore turns) would
 *  settle on that frame and tear the real turn down mid-thought. The caller's
 *  own turns carry no `origin` at all. */
export function isClaudeNotificationResultFrame(frame: Record<string, unknown>): boolean {
  const origin = frame.origin
  if (!origin || typeof origin !== 'object') return false
  return (origin as { kind?: unknown }).kind === 'task-notification'
}

function parseClaudeStreamLine(line: string): AdapterEvent | null {
  if (line.length === 0) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }

  const type = parsed.type as string | undefined
  if (!type) return { kind: 'other', type: '<missing>', raw: parsed }

  if (type === 'system' || type === 'init') {
    const sid =
      (parsed.session_id as string | undefined) ??
      ((parsed.session as { id?: string } | undefined)?.id ?? undefined)
    if (sid) return { kind: 'session-started', sessionId: sid }
    return { kind: 'other', type, raw: parsed }
  }

  if (type === 'result') {
    // A CLI-internal notification turn surfaces as a NON-terminal 'other'
    // event so no consumer (turn-closing sessions, extractResult, recovery)
    // mistakes it for the caller's turn result.
    if (isClaudeNotificationResultFrame(parsed)) return { kind: 'other', type, raw: parsed }
    return { kind: 'result', payload: parsed, ...(parsed.is_error === true ? { isError: true } : {}) }
  }

  if (type === 'assistant') {
    const msg = parsed.message as
      | { id?: unknown; model?: unknown; usage?: unknown; content?: Array<{ type: string; text?: string; name?: string }> }
      | undefined
    const blocks = msg?.content ?? []
    // Concatenate all text blocks; tool_use blocks are surfaced separately as a
    // tool-use event. For simplicity we synthesise the first text block here
    // and let callers consume tool_use from a fan-out (matching current
    // chat-manager behaviour). Every assistant-derived event carries the
    // frame's `message.usage` (see withAssistantUsage) so interrupted runs
    // remain estimable.
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    if (text) return withAssistantUsage({ kind: 'text-delta', text }, msg)
    // Surface a single tool-use (the historical pattern only emitted one per
    // assistant frame anyway).
    const tool = blocks.find((b) => b.type === 'tool_use')
    if (tool?.name) {
      const input = JSON.stringify(
        (parsed.message as { content?: Array<{ input?: unknown }> })?.content?.[0]?.input ?? {},
      )
      return withAssistantUsage(
        {
          kind: 'tool-use',
          name: tool.name,
          inputPreview: input.slice(0, 200),
          ...(typeof (tool as { id?: unknown }).id === 'string'
            ? { toolUseId: (tool as unknown as { id: string }).id }
            : {}),
        },
        msg,
      )
    }
    return withAssistantUsage({ kind: 'other', type, raw: parsed }, msg)
  }

  if (type === 'tool_use') {
    const name = (parsed.name as string) ?? '<unnamed>'
    const input = JSON.stringify(parsed.input ?? {})
    return {
      kind: 'tool-use',
      name,
      inputPreview: input.slice(0, 200),
      ...(typeof parsed.id === 'string' ? { toolUseId: parsed.id } : {}),
    }
  }

  // `user`-role frames carry tool RESULTS back to the model. Surface a bounded
  // text projection so activity surfaces (agent chat's execution log) can show
  // what a tool returned; frames without a tool_result block stay 'other'.
  if (type === 'user') {
    const msg = (parsed as { message?: { content?: unknown } }).message
    const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : []
    const resultBlock = blocks.find((b) => b.type === 'tool_result')
    if (resultBlock) {
      const content = resultBlock.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n')
          : ''
      return {
        kind: 'tool-result',
        outputPreview: text.slice(0, 600),
        ...(typeof resultBlock.tool_use_id === 'string' ? { toolUseId: resultBlock.tool_use_id } : {}),
        ...(resultBlock.is_error === true ? { isError: true } : {}),
      }
    }
  }

  return { kind: 'other', type, raw: parsed }
}

function extractClaudeResult(events: readonly AdapterEvent[]): NormalisedResult {
  // Find the latest `result` event and the latest `session-started` event.
  let resultPayload: Record<string, unknown> | null = null
  let sessionId: string | undefined
  for (const ev of events) {
    if (ev.kind === 'result') resultPayload = ev.payload
    else if (ev.kind === 'session-started') sessionId = ev.sessionId
  }
  if (!resultPayload) {
    // No terminal `result` frame arrived (spawn killed/aborted/timed out).
    // Reconstruct cumulative token usage from the per-assistant-event usage
    // snapshots so the caller can estimate cost from the rate card instead of
    // persisting NULL/$0 (COST-ACCOUNTING-AUDIT CRIT-1 / HIGH-8). Dedup by
    // message id, last snapshot wins: a multi-block message emits several
    // assistant frames repeating the same usage, and later snapshots of the
    // same message supersede earlier ones. Each DISTINCT message is a separate
    // API call, so summing across messages is the correct billing model
    // (every call bills its own full input). `total_cost_usd` is deliberately
    // left undefined — estimation is the caller's job (finaliseInvocationResult).
    const perMessage = new Map<string, AssistantEventUsage>()
    let model: string | undefined
    let anonymous = 0
    for (const ev of events) {
      const carrier = ev as ClaudeUsageEvent
      if (!carrier.usage) continue
      perMessage.set(carrier.messageId ?? `__anon-${anonymous++}`, carrier.usage)
      if (carrier.model) model = carrier.model
    }
    if (perMessage.size === 0) return { session_id: sessionId }
    let tokensIn = 0
    let tokensOut = 0
    let cacheRead = 0
    let cacheCreate = 0
    for (const u of perMessage.values()) {
      tokensIn += readNumber(u.input_tokens)
      tokensOut += readNumber(u.output_tokens)
      cacheRead += readNumber(u.cache_read_input_tokens)
      cacheCreate += readNumber(u.cache_creation_input_tokens)
    }
    return {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cache_read: cacheRead,
      tokens_cache_create: cacheCreate,
      model,
      session_id: sessionId,
    }
  }

  const usage = resultPayload.usage as Record<string, number> | undefined
  // result event may also carry session_id directly — prefer that over the
  // earlier captured one (it's authoritative for the final state).
  const finalSessionId = (resultPayload.session_id as string | undefined) ?? sessionId

  return {
    tokens_in: usage?.input_tokens,
    tokens_out: usage?.output_tokens,
    tokens_cache_read: usage?.cache_read_input_tokens,
    tokens_cache_create: usage?.cache_creation_input_tokens,
    total_cost_usd: resultPayload.total_cost_usd as number | undefined,
    num_turns: resultPayload.num_turns as number | undefined,
    model: resultPayload.model as string | undefined,
    duration_ms: resultPayload.duration_ms as number | undefined,
    // The Claude Code CLI emits `duration_api_ms`; the old `api_duration_ms`
    // lookup always resolved undefined (persisted NULL). Read both, real first.
    duration_api_ms: (resultPayload.duration_api_ms ?? resultPayload.api_duration_ms) as number | undefined,
    session_id: finalSessionId,
  }
}

async function detectClaudeInstalled(): Promise<DetectionResult> {
  let installed = false
  try {
    execSync(`${WHICH_CMD} claude`, { stdio: 'ignore' })
    installed = true
  } catch {
    return { installed: false, executable: false }
  }

  // Probe version for executability + reporting.
  try {
    const raw = execSync('claude --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    const match = raw.match(/\d+\.\d+\.\d+[\w.-]*/)
    return {
      installed,
      executable: true,
      version: match ? match[0] : raw,
      meetsMinimum: true, // claude has no pinned minimum in this adapter
    }
  } catch {
    return { installed, executable: false }
  }
}

export const claudeAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  minCliVersion: null,
  projectDirName: '.claude',
  instructionsFilename: 'CLAUDE.md',
  mcpRegistration: 'project-json',
  capabilities: {
    nativeResume: true,
    nativeStreamJson: true,
    nativeCostUsd: true,
    nativeOtelEnv: true,
    profileEnvSupport: true,
    systemPromptArg: true,
    persistentStdin: true,
    liveInputTransport: 'claude-stream-json',
    supportsReasoningEffort: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], // claude-code --effort tiers
    supportsImageInput: true, // images ride as `@<abs-path>` prompt refs
    structuredActions: true,
    toolPolicies: ['none', 'read-only'],
    profiles: true,
    customRoles: true,
    freestyle: true,
    userMcp: true,
  },
  modelCatalog: () => CLAUDE_MODELS,
  defaultModel: () => 'sonnet',
  buildArgs: buildClaudeArgs,
  parseStreamLine: parseClaudeStreamLine,
  extractResult: extractClaudeResult,
  formatCoreCommand: (command: string) => command,
  buildRepoAccessArgs: (paths: readonly string[]) =>
    paths.flatMap((repoPath) => ['--add-dir', repoPath]),
  projectMcpPath: (root: string) => path.join(root, '.mcp.json'),
  customRolePath: (root: string, roleId: string) =>
    path.join(root, '.claude', 'agents', `${roleId}.md`),
  baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
  detectInstalled: detectClaudeInstalled,
} satisfies ProviderAdapter

export { normaliseModel as _normaliseClaudeModel, resolveSpawnModel as _resolveClaudeSpawnModel }
