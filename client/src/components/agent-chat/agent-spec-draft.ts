// ─── Agent chat live spec-draft card: protocol parsing ─────────────────────────
// During spec refinement the operator agent ends each turn that changed the
// draft with ONE fenced ```spec-draft code block containing a FULL-SNAPSHOT
// JSON object (taught in server/agent-operator-prompt.ts; same field shape as
// Explore's server-side protocol — see server/spec-draft-parser.ts and
// client/src/lib/spec-draft.ts). The block is stripped from the rendered
// markdown and shown as a premium in-conversation draft card instead.
//
// Tolerance mirrors the Explore parser + the sibling ```options extractor:
// malformed JSON is dropped silently (its fenced span is still stripped when
// complete); the LAST valid block wins (snapshots, not diffs); a trailing
// unclosed fence is parsed leniently when its tail is already valid JSON, and
// while streaming an incomplete fence is cut so raw protocol JSON never leaks
// into the bubble.

import { SPEC_DRAFT_DEFAULTS, type SpecDraft, type SpecDraftPriority } from '../../lib/spec-draft'

const FENCE_RE = /```spec-draft[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g
const OPEN_FENCE = '```spec-draft'

const VALID_PRIORITIES = new Set<SpecDraftPriority>(['low', 'medium', 'high', 'critical'])

export interface ParsedAgentSpecDraft {
  /** Message body with every COMPLETE spec-draft block stripped (malformed
   *  payloads too — server-parser precedent). A settled unclosed fence with an
   *  invalid tail is left in place so content is never lost silently. */
  body: string
  /** The last valid draft snapshot in the message, or null. */
  draft: SpecDraft | null
  /** True only while streaming, when an opening fence exists but the block
   *  is not complete yet — the renderer shows a small placeholder chip. */
  pending: boolean
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is string => typeof s === 'string')
}

/** Parse one fenced payload into a normalized full draft; null when invalid. */
function parseDraftPayload(raw: string): SpecDraft | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const draft: SpecDraft = {
    title: typeof obj.title === 'string' ? obj.title : SPEC_DRAFT_DEFAULTS.title,
    description: typeof obj.description === 'string' ? obj.description : SPEC_DRAFT_DEFAULTS.description,
    labels: coerceStringArray(obj.labels),
    priority:
      typeof obj.priority === 'string' && VALID_PRIORITIES.has(obj.priority as SpecDraftPriority)
        ? (obj.priority as SpecDraftPriority)
        : SPEC_DRAFT_DEFAULTS.priority,
    acceptanceCriteria: coerceStringArray(obj.acceptanceCriteria),
  }
  // An all-empty object is not a draft — require some actual content.
  if (!draft.title.trim() && !draft.description.trim()) return null
  return draft
}

/** Trim stripped-block seams: collapse 3+ newlines and edge whitespace. */
function tidy(body: string): string {
  return body.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Extract the live spec-draft card from assistant content.
 * Run AFTER extractAgentOptions (the options block sits at the very end,
 * after the spec-draft block, per the operator protocol).
 */
export function extractAgentSpecDraft(content: string, streaming = false): ParsedAgentSpecDraft {
  if (!content.includes(OPEN_FENCE)) return { body: content, draft: null, pending: false }

  let draft: SpecDraft | null = null
  let stripped = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(content)) !== null) {
    stripped += content.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const parsed = parseDraftPayload(match[1])
    if (parsed) draft = parsed // last valid snapshot wins
  }
  stripped += content.slice(cursor)

  // Any OPEN_FENCE left in `stripped` is an unmatched (unclosed) fence.
  let pending = false
  const openIdx = stripped.indexOf(OPEN_FENCE)
  if (openIdx !== -1) {
    // Lenient tail: the model dropped the closing ``` but the JSON is whole.
    const tail = stripped
      .slice(openIdx + OPEN_FENCE.length)
      .replace(/^[^\S\n]*\n?/, '')
      .replace(/\s*(?:```)?\s*$/, '')
    const parsed = parseDraftPayload(tail)
    if (parsed) {
      draft = parsed
      stripped = stripped.slice(0, openIdx)
    } else if (streaming) {
      // Mid-stream: cut the raw protocol tail; the card arrives when complete.
      stripped = stripped.slice(0, openIdx)
      pending = true
    }
  }

  return { body: tidy(stripped), draft, pending }
}
