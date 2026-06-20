// Claude adapter. Ports the existing claude spawn / stream / result logic from
// chat-manager.ts, queue-manager.ts, agent-refine-manager.ts,
// project-router.ts (generate-spec), setup-manager.ts, and result-event.ts
// without behaviour change. Managers will migrate to consume this adapter in
// later tasks (see openspec/changes/add-multi-provider-support/tasks.md §2.x).
//
// Spec: openspec/specs/multi-provider-architecture/spec.md

import { execSync } from 'child_process'
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
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
] as const

/** Mirror of ChatManager.normalizeClaudeCodeModel — pinned model strings the
 *  CLI accepts collapse to the short alias. */
function normaliseModel(model: string | null | undefined): string {
  switch (model) {
    case 'claude-sonnet-4-6':
    case 'claude-sonnet-4-5':
    case 'claude-sonnet-4-0':
    case 'claude-sonnet-4-20250514':
      return 'sonnet'
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

/** Default arg block every claude spawn shares. `--setting-sources` is appended
 *  separately per-spawn (see `commonFlagsFor`) because its value depends on
 *  whether the caller opted into loading the user's full Claude environment. */
const COMMON_FLAGS = [
  '--dangerously-skip-permissions',
  '--tools', 'default',
  '--output-format', 'stream-json',
  '--verbose',
] as const

/**
 * COMMON_FLAGS + the `--setting-sources` value for this spawn.
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
  return [
    ...COMMON_FLAGS,
    '--setting-sources',
    opts.loadUserEnv ? 'user,project,local' : 'project,local',
  ]
}

function buildClaudeArgs(action: SpawnAction, opts: SpawnOptions): string[] {
  const args: string[] = []
  const model = normaliseModel(opts.model)
  const commonFlags = commonFlagsFor(opts)

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
      // 'default' from COMMON_FLAGS applies.
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
    return { kind: 'result', payload: parsed }
  }

  if (type === 'assistant') {
    const msg = parsed.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined
    const blocks = msg?.content ?? []
    // Concatenate all text blocks; tool_use blocks are surfaced separately as a
    // tool-use event. For simplicity we synthesise the first text block here
    // and let callers consume tool_use from a fan-out (matching current
    // chat-manager behaviour).
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    if (text) return { kind: 'text-delta', text }
    // Surface a single tool-use (the historical pattern only emitted one per
    // assistant frame anyway).
    const tool = blocks.find((b) => b.type === 'tool_use')
    if (tool?.name) {
      const input = JSON.stringify(
        (parsed.message as { content?: Array<{ input?: unknown }> })?.content?.[0]?.input ?? {},
      )
      return { kind: 'tool-use', name: tool.name, inputPreview: input.slice(0, 200) }
    }
    return { kind: 'other', type, raw: parsed }
  }

  if (type === 'tool_use') {
    const name = (parsed.name as string) ?? '<unnamed>'
    const input = JSON.stringify(parsed.input ?? {})
    return { kind: 'tool-use', name, inputPreview: input.slice(0, 200) }
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
  if (!resultPayload) return { session_id: sessionId }

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

export const claudeAdapter: ProviderAdapter = {
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
  },
  modelCatalog: () => CLAUDE_MODELS,
  defaultModel: () => 'sonnet',
  buildArgs: buildClaudeArgs,
  parseStreamLine: parseClaudeStreamLine,
  extractResult: extractClaudeResult,
  baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
  detectInstalled: detectClaudeInstalled,
}

export { normaliseModel as _normaliseClaudeModel }
