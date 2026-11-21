/**
 * How a policy denial travels from the hook to Specrails.
 *
 * The hook returns `permissionDecision: "deny"` with a reason that ends in a
 * stable marker, `[specrails-policy:<rule>]`. Claude turns that into the
 * blocked tool's error result (`PreToolUse:<Tool> hook error: <reason>` in
 * stream-json, the bare reason in other places; verified on Claude Code
 * 2.1.322 in bypassPermissions mode), and every stream
 * Specrails already consumes carries it: Claude stream-json `user` frames
 * (with `tool_result_meta[].permission_decision.source: "hook"`) and Core
 * `turn.tool` outputs. Recognising the marker there is how denials reach the
 * audit and the transcripts — the hook needs no port, token or server.
 *
 * Pure.
 */
import { isPolicyRule, type PolicyRule } from './rules'

const MARKER_RE = /\[specrails-policy:([a-z-]+)\]\s*$/
/**
 * What may precede the reason: Claude's hook-error prefix
 * (`PreToolUse:Bash hook error: `, seen in stream-json) or nothing (the
 * transcript and some tools carry the bare reason), optionally wrapped in
 * `Error:` / `<tool_use_error>`.
 */
const LEAD_RE = /^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?(?:PreToolUse:[^\s:]+\s+hook\s+error:\s*)?Blocked by Specrails policy:\s*/i

export interface PolicyDenial {
  rule: PolicyRule
  /** Human reason without the marker (and without Claude's prefix). */
  reason: string
}

export function policyMarker(rule: PolicyRule): string {
  return `[specrails-policy:${rule}]`
}

const RETRY_HINT = 'Do not retry it another way; continue without it or explain what you need.'

/** The reason text the hook returns to Claude. */
export function formatDenialReason(rule: PolicyRule, reason: string): string {
  return `Blocked by Specrails policy: ${reason} ${RETRY_HINT} ${policyMarker(rule)}`
}

/**
 * Recognise a policy denial in a blocked tool call's error text: it starts
 * with the hook's own lead ("Blocked by Specrails policy:", possibly behind
 * Claude's hook-error prefix) and ends with the marker. Ordinary command
 * output that merely prints the marker does not qualify (a failed Bash call
 * starts with "Exit code"). `fromHook` (Claude's `tool_result_meta` says a
 * hook rejected the call) accepts any text ending with the marker.
 */
export function parsePolicyDenial(text: unknown, options: { fromHook?: boolean } = {}): PolicyDenial | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8192) return null
  const body = text.replace(/\s*<\/tool_use_error>\s*$/i, '')
  const marker = MARKER_RE.exec(body)
  if (!marker || !isPolicyRule(marker[1])) return null
  const lead = LEAD_RE.exec(body)
  if (!lead && !options.fromHook) return null
  const reason = body.slice(lead ? lead[0].length : 0, marker.index)
    .replace(/^\s*(?:PreToolUse:[^\s:]+\s+hook\s+error:\s*)/i, '')
    .replace(RETRY_HINT, '')
    .trim()
  return { rule: marker[1], reason }
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
