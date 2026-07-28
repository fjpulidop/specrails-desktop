import type { EventRow } from '../types'

// ─── Activity derivation (HONEST live signal) — SHARED ────────────────────────
//
// `steps` is a count of concrete observed actions (real), labelled "pasos". One
// streamed frame can carry several parallel tool_use blocks, each counted. This
// is the SINGLE source for both the Job status panel and the dashboard rail
// metrics, so the two always show the same number.

export const ARG_ACTIONS = new Set(['editing', 'writing', 'reading', 'searching', 'running'])

export function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 39)}…` : s
}

export function basename(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) return ''
  const seg = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  return clip(seg)
}

export function firstToken(c: unknown): string {
  if (typeof c !== 'string' || c.length === 0) return ''
  // A wrapped command arrives quoted (`zsh -lc 'npm run build'`), so the token
  // can carry a leading quote once the wrapper is stripped.
  const token = (c.trim().split(/\s+/)[0] ?? '').replace(/^['"`]+/, '')
  return clip(token)
}

/** Codex `function_call`/`local_shell_call` carry their command in the
 *  `item.arguments` JSON string (NOT `item.command`). Extract the first token
 *  of the command for the activity label. Never throws. */
/** Shells codex wraps its commands in. `["/bin/zsh","-lc","npm test"]` must
 *  surface as `npm`, not `/bin/zsh` — the wrapper is identical for every call,
 *  so reporting it says nothing about what the agent actually did. */
const SHELL_WRAPPER_RE = /(^|\/)(ba|z|k|da|fi)?sh$/

function unwrapShell(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens
  if (!SHELL_WRAPPER_RE.test(tokens[0])) return tokens
  // Drop the shell and its flags (-lc, -c, --login …); what follows is the
  // real command, possibly as one quoted string.
  const rest = tokens.slice(1).filter((token) => !token.startsWith('-'))
  return rest.length > 0 ? rest : tokens
}

/** First meaningful token of a command, with any shell wrapper removed. Use this
 *  instead of `firstToken` wherever the value may be a wrapped invocation. */
export function commandLabel(command: unknown): string {
  if (Array.isArray(command)) {
    return firstToken(unwrapShell(command.filter((x): x is string => typeof x === 'string')).join(' '))
  }
  if (typeof command !== 'string' || command.length === 0) return ''
  return firstToken(unwrapShell(command.trim().split(/\s+/)).join(' '))
}

/** The whole command with any shell wrapper removed, for callers that need to
 *  read the subcommand (narration translates intent, not just the binary). */
export function fullCommand(command: unknown): string {
  if (Array.isArray(command)) {
    return unwrapShell(command.filter((x): x is string => typeof x === 'string')).join(' ').trim()
  }
  if (typeof command !== 'string' || command.length === 0) return ''
  return unwrapShell(command.trim().split(/\s+/)).join(' ').trim()
}

export function codexCallCommand(args: unknown): string {
  if (typeof args !== 'string') return ''
  try {
    const parsed = JSON.parse(args) as { command?: unknown }
    const cmd = parsed?.command
    if (Array.isArray(cmd) || typeof cmd === 'string') return commandLabel(cmd)
  } catch {
    // arguments not JSON — no command to surface
  }
  return ''
}

export interface FrameActivity {
  step: boolean
  actionKey?: string
  actionArg?: string
  /** Number of concrete steps this frame represents (default 1). A single
   *  claude assistant frame can carry several parallel tool_use blocks. */
  stepCount?: number
}

export function mapTool(name: unknown, input: Record<string, unknown> | undefined): FrameActivity {
  const inp = input ?? {}
  const file = basename(inp.file_path ?? inp.path)
  const normalizedName = typeof name === 'string' ? name.toLowerCase() : ''
  switch (normalizedName) {
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'update':
    case 'editfile':
    case 'strreplace':
    case 'searchreplace':
      return { step: true, actionKey: 'editing', actionArg: file }
    case 'write':
    case 'create':
    case 'writefile':
      return { step: true, actionKey: 'writing', actionArg: file }
    case 'read':
    case 'readfile':
    case 'readmediafile':
      return { step: true, actionKey: 'reading', actionArg: file }
    case 'grep':
    case 'glob':
    case 'search':
    case 'websearch':
      return { step: true, actionKey: 'searching', actionArg: clip(String(inp.pattern ?? inp.query ?? '')) }
    case 'bash':
    case 'shell':
      return { step: true, actionKey: 'running', actionArg: commandLabel(inp.command) }
    case 'task':
      // A subagent spawn is the most informative frame the pipeline emits: it is
      // the hand-off to the architect / developer / reviewer. It was landing in
      // the generic 'working' bucket, hiding the pipeline's own structure.
      return {
        step: true,
        actionKey: 'delegating',
        actionArg: clip(String(inp.subagent_type ?? inp.description ?? '').replace(/^sr-/, '')),
      }
    default:
      return { step: true, actionKey: 'working' }
  }
}

function toolArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export function deriveFrameActivity(ev: EventRow): FrameActivity {
  const t = ev.event_type
  // Coerce to a safe empty object for null / arrays / primitives — JSON.parse
  // does NOT throw on the literal `null`/`42`/`"x"`, so a bare catch isn't
  // enough to keep the property reads below from dereferencing a non-object.
  let parsed: Record<string, unknown> = {}
  try {
    const j = JSON.parse(ev.payload)
    if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j as Record<string, unknown>
  } catch {
    // unparseable payload — parsed stays {}
  }

  // ── Claude stream-json ──
  if (t === 'assistant') {
    const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined
    const content = message?.content
    if (Array.isArray(content)) {
      // A single assistant frame can carry several parallel tool_use blocks;
      // count them all as steps, label from the last.
      const toolUses = content.filter((c) => c?.type === 'tool_use')
      if (toolUses.length > 0) {
        const last = toolUses[toolUses.length - 1]
        return { ...mapTool(last.name, last.input as Record<string, unknown> | undefined), stepCount: toolUses.length }
      }
      if (content.some((c) => c?.type === 'text')) return { step: true, actionKey: 'thinking' }
    }

    // ── Kimi Code stream-json ──
    // Kimi emits the assistant record directly (rather than under `message`)
    // and uses OpenAI-style function calls whose arguments are JSON strings.
    const kimiCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
    const callable = kimiCalls.flatMap((call) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) return []
      const fn = (call as Record<string, unknown>).function
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return []
      return [fn as Record<string, unknown>]
    })
    if (callable.length > 0) {
      const last = callable[callable.length - 1]
      return {
        ...mapTool(last.name, toolArguments(last.arguments)),
        stepCount: callable.length,
      }
    }
    if (
      typeof parsed.content === 'string' ||
      (Array.isArray(parsed.content) && parsed.content.length > 0)
    ) {
      return { step: true, actionKey: 'thinking' }
    }
    return { step: true }
  }
  if (t === 'tool_use') {
    return mapTool(parsed.name, parsed.input as Record<string, unknown> | undefined)
  }

  // ── Codex exec --json ──
  if (t === 'item.completed') {
    const item = parsed.item as Record<string, unknown> | undefined
    const it = item?.type
    if (it === 'agent_message') return { step: true, actionKey: 'thinking' }
    if (it === 'agent_reasoning') return { step: true, actionKey: 'reasoning' }
    if (it === 'function_call' || it === 'local_shell_call' || it === 'command_execution') {
      // function_call/local_shell_call carry the command in item.arguments (a
      // JSON string), command_execution in item.command — read both.
      const arg = commandLabel(item?.command) || codexCallCommand(item?.arguments) ||
        (typeof item?.name === 'string' ? clip(item.name) : '') ||
        (it === 'local_shell_call' ? 'shell' : '')
      return { step: true, actionKey: 'running', actionArg: arg }
    }
    return { step: true }
  }

  return { step: false }
}

/** Total activity-step count across a list of frames — the same number the Job
 *  status panel shows as "pasos". */
export function countActivitySteps(events: EventRow[]): number {
  let steps = 0
  for (const ev of events) {
    const d = deriveFrameActivity(ev)
    if (d.step) steps += d.stepCount ?? 1
  }
  return steps
}

/**
 * Full command carried by an event, whatever provider shape it arrived in
 * (claude Bash tool_use, codex local_shell_call/function_call/command_execution).
 * Returns '' when the event carries no command. Never throws.
 */
export function commandFromEvent(ev: EventRow): string {
  let parsed: Record<string, unknown> = {}
  try {
    const j = JSON.parse(ev.payload)
    if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j as Record<string, unknown>
  } catch {
    return ''
  }

  if (ev.event_type === 'assistant') {
    const content = (parsed.message as { content?: Array<Record<string, unknown>> } | undefined)?.content
    if (!Array.isArray(content)) return ''
    for (const block of content) {
      if (block?.type !== 'tool_use') continue
      const input = block.input as Record<string, unknown> | undefined
      const command = input?.command
      if (command) return fullCommand(command)
    }
    return ''
  }

  if (ev.event_type === 'item.completed') {
    const item = parsed.item as Record<string, unknown> | undefined
    if (!item) return ''
    if (item.command) return fullCommand(item.command)
    if (typeof item.arguments === 'string') {
      try {
        const args = JSON.parse(item.arguments) as { command?: unknown }
        if (args?.command) return fullCommand(args.command)
      } catch {
        return ''
      }
    }
  }
  return ''
}
