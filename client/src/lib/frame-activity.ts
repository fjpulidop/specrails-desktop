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
  return clip(c.trim().split(/\s+/)[0] ?? '')
}

/** Codex `function_call`/`local_shell_call` carry their command in the
 *  `item.arguments` JSON string (NOT `item.command`). Extract the first token
 *  of the command for the activity label. Never throws. */
export function codexCallCommand(args: unknown): string {
  if (typeof args !== 'string') return ''
  try {
    const parsed = JSON.parse(args) as { command?: unknown }
    const cmd = parsed?.command
    if (Array.isArray(cmd)) return firstToken(cmd.filter((x) => typeof x === 'string').join(' '))
    if (typeof cmd === 'string') return firstToken(cmd)
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
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Update':
      return { step: true, actionKey: 'editing', actionArg: file }
    case 'Write':
    case 'create':
      return { step: true, actionKey: 'writing', actionArg: file }
    case 'Read':
      return { step: true, actionKey: 'reading', actionArg: file }
    case 'Grep':
    case 'Glob':
    case 'search':
      return { step: true, actionKey: 'searching', actionArg: clip(String(inp.pattern ?? inp.query ?? '')) }
    case 'Bash':
    case 'shell':
      return { step: true, actionKey: 'running', actionArg: firstToken(inp.command) }
    default:
      return { step: true, actionKey: 'working' }
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
      const arg = firstToken(item?.command) || codexCallCommand(item?.arguments) ||
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
