/**
 * How a policy denial travels from the hook to Specrails.
 *
 * The hook returns `permissionDecision: "deny"` with a reason that ends in a
 * stable marker, `[specrails-policy:<rule>]`. Claude turns that into the
 * blocked tool's error result (`PreToolUse:<Tool> hook error: <reason>`,
 * verified on Claude Code 2.1.322 in bypassPermissions mode), and every stream
 * Specrails already consumes carries it: Claude stream-json `user` frames
 * (with `tool_result_meta[].permission_decision.source: "hook"`) and Core
 * `turn.tool` outputs. Recognising the marker there is how denials reach the
 * audit and the transcripts — the hook needs no port, token or server.
 *
 * Pure.
 */
import { isPolicyRule, type PolicyRule } from './rules'

const MARKER_RE = /\[specrails-policy:([a-z-]+)\]\s*$/
/** First line of Claude's blocked-tool error, e.g. `PreToolUse:Bash hook error: …`. */
const HOOK_PREFIX_RE = /^\s*(?:Error:\s*)?PreToolUse:[^\s:]+\s+hook\b/i

export interface PolicyDenial {
  rule: PolicyRule
  /** Human reason without the marker (and without Claude's prefix). */
  reason: string
}

export function policyMarker(rule: PolicyRule): string {
  return `[specrails-policy:${rule}]`
}

/** The reason text the hook returns to Claude. */
export function formatDenialReason(rule: PolicyRule, reason: string): string {
  return `Blocked by Specrails policy: ${reason} Do not retry it another way; continue without it or explain what you need. ${policyMarker(rule)}`
}

/**
 * Recognise a policy denial in a blocked tool call's error text. `fromHook`
 * says the transport already attributed the rejection to a hook (Claude's
 * `tool_result_meta`); otherwise the text must start with Claude's hook-error
 * prefix, so ordinary command output that merely prints the marker is not a
 * denial.
 */
export function parsePolicyDenial(text: unknown, options: { fromHook?: boolean } = {}): PolicyDenial | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8192) return null
  const marker = MARKER_RE.exec(text)
  if (!marker || !isPolicyRule(marker[1])) return null
  if (!options.fromHook && !HOOK_PREFIX_RE.test(text)) return null
  const body = text.slice(0, marker.index)
    .replace(HOOK_PREFIX_RE, '')
    .replace(/^[^:]*?error:\s*/i, '')
    .replace(/^\s*Blocked by Specrails policy:\s*/i, '')
    .replace(/\s*Do not retry it another way;[\s\S]*$/, '')
    .trim()
  return { rule: marker[1], reason: body }
}

/** Text of a Claude `tool_result` content (string or text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('')
}

export interface ClaudeFrameDenial extends PolicyDenial {
  toolUseId: string
}

/**
 * Policy denials in one Claude stream-json frame (a `user` frame whose
 * `tool_result` blocks are hook rejections). Never throws.
 */
export function claudeFrameDenials(frame: unknown): ClaudeFrameDenial[] {
  try {
    if (!frame || typeof frame !== 'object') return []
    const record = frame as { type?: unknown; message?: { content?: unknown }; tool_result_meta?: unknown }
    if (record.type !== 'user') return []
    const content = Array.isArray(record.message?.content) ? record.message!.content as unknown[] : []
    const meta = Array.isArray(record.tool_result_meta) ? record.tool_result_meta as Array<Record<string, unknown>> : []
    const out: ClaudeFrameDenial[] = []
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || block.is_error !== true) continue
      const decision = meta.find((entry) => entry?.id === block.tool_use_id)?.permission_decision as { source?: unknown } | undefined
      const denial = parsePolicyDenial(toolResultText(block.content), { fromHook: decision?.source === 'hook' })
      if (denial) out.push({ ...denial, toolUseId: block.tool_use_id })
    }
    return out
  } catch {
    return []
  }
}
