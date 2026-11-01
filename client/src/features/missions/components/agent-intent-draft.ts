// ─── Agent chat intent card: protocol parsing (intent-mode) ────────────────────
// Before drafting a spec, the operator agent writes the INTENT as ONE fenced
// ```intent-draft code block containing a FULL-SNAPSHOT JSON object (taught in
// server/modules/missions/runtime/agent-operator-prompt.ts). The payload rules
// live in the shared intent domain (features/specs/lib/spec-intent.ts, a
// byte-identical copy of server/modules/specs/domain/intent.ts), so the card
// and the commit_draft gate (agent-spec-framing.ts) accept exactly the same
// blocks. The block is stripped from the rendered markdown and shown as the
// intent card instead.
//
// Tolerance mirrors agent-problem-frame.ts: malformed JSON is dropped silently
// (its fenced span is still stripped when complete); the LAST valid block wins
// (snapshots, not diffs); a trailing unclosed fence is parsed leniently when its
// tail is already valid JSON, and while streaming an incomplete fence is cut so
// raw protocol JSON never leaks into the bubble.

import { parseIntentDraft, type IntentDraft } from '../../specs/lib/spec-intent'

const FENCE_RE = /```intent-draft[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g
const OPEN_FENCE = '```intent-draft'

export interface ParsedAgentIntentDraft {
  /** Message body with every COMPLETE intent-draft block stripped. */
  body: string
  /** The last valid snapshot in the message, or null. */
  draft: IntentDraft | null
  /** Streaming, with an opening fence whose block is not complete yet. */
  pending: boolean
}

function parsePayload(raw: string): IntentDraft | null {
  try {
    return parseIntentDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

function tidy(body: string): string {
  return body.replace(/\n{3,}/g, '\n\n').trim()
}

/** Extract the intent card from assistant content. */
export function extractAgentIntentDraft(content: string, streaming = false): ParsedAgentIntentDraft {
  if (!content.includes(OPEN_FENCE)) return { body: content, draft: null, pending: false }

  let draft: IntentDraft | null = null
  let stripped = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(content)) !== null) {
    stripped += content.slice(cursor, match.index)
    cursor = match.index + match[0].length
    draft = parsePayload(match[1]) ?? draft // last valid snapshot wins
  }
  stripped += content.slice(cursor)

  let pending = false
  const openIdx = stripped.indexOf(OPEN_FENCE)
  if (openIdx !== -1) {
    const tail = stripped
      .slice(openIdx + OPEN_FENCE.length)
      .replace(/^[^\S\n]*\n?/, '')
      .replace(/\s*(?:```)?\s*$/, '')
    const parsed = parsePayload(tail)
    if (parsed) {
      draft = parsed
      stripped = stripped.slice(0, openIdx)
    } else if (streaming) {
      stripped = stripped.slice(0, openIdx)
      pending = true
    }
  }

  return { body: tidy(stripped), draft, pending }
}
