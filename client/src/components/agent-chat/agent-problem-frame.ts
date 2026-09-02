// ─── Agent chat problem-frame card: protocol parsing ───────────────────────────
// Before drafting a spec, the operator agent states its framing of the request
// as ONE fenced ```problem-frame code block containing a FULL-SNAPSHOT JSON
// object (taught in server/agent-operator-prompt.ts; the server mirrors this
// validation in server/agent-spec-framing.ts, which gates commit_draft — the
// same parser-pair split the spec-draft protocol already uses between
// server/spec-draft-parser.ts and client/src/lib/spec-draft.ts). The block is
// stripped from the rendered markdown and shown as a framing card instead.
//
// The frame carries TWO readings of the same request, each anchored to the
// surfaces it would touch, plus the question that separates them. Those fields
// are what make a fabricated second reading visible: two identical readings
// cannot produce a coherent discriminating question, and identical `reading`
// strings are rejected outright here.
//
// Tolerance mirrors agent-spec-draft.ts exactly: malformed JSON is dropped
// silently (its fenced span is still stripped when complete); the LAST valid
// block wins (snapshots, not diffs); a trailing unclosed fence is parsed
// leniently when its tail is already valid JSON, and while streaming an
// incomplete fence is cut so raw protocol JSON never leaks into the bubble.

const FENCE_RE = /```problem-frame[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g
const OPEN_FENCE = '```problem-frame'

/** One reading of the request, anchored to the surfaces it would change. */
export interface ProblemFrameReading {
  reading: string
  /** Files or surfaces this reading would touch, from code the agent read. */
  touches: string[]
}

export interface ProblemFrame {
  /** What the agent believes it was asked. */
  restated: ProblemFrameReading
  /** A genuinely different reading of the SAME request. */
  alternative: ProblemFrameReading
  /** The one thing the user could say that picks between the two readings. */
  discriminator: string
  assumptions: string[]
  unknowns: string[]
}

export interface ParsedAgentProblemFrame {
  /** Message body with every COMPLETE problem-frame block stripped (malformed
   *  payloads too — spec-draft precedent). A settled unclosed fence with an
   *  invalid tail is left in place so content is never lost silently. */
  body: string
  /** The last valid frame snapshot in the message, or null. */
  frame: ProblemFrame | null
  /** True only while streaming, when an opening fence exists but the block is
   *  not complete yet — the renderer shows a small placeholder chip. */
  pending: boolean
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is string => typeof s === 'string')
}

/** A reading is valid only with non-empty prose; `touches` may be empty. */
function parseReading(value: unknown): ProblemFrameReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.reading !== 'string' || !obj.reading.trim()) return null
  return { reading: obj.reading, touches: coerceStringArray(obj.touches) }
}

/** Parse one fenced payload into a full frame; null when invalid. */
function parseFramePayload(raw: string): ProblemFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const restated = parseReading(obj.restated)
  const alternative = parseReading(obj.alternative)
  if (!restated || !alternative) return null
  if (typeof obj.discriminator !== 'string' || !obj.discriminator.trim()) return null
  // Byte-identical readings ARE the same reading — the one degenerate case that
  // can be judged deterministically. Everything softer than exact equality is
  // left to the user's eye and to the discriminating question, deliberately:
  // a similarity threshold fires on distinct readings that share vocabulary.
  if (restated.reading.trim() === alternative.reading.trim()) return null

  return {
    restated,
    alternative,
    discriminator: obj.discriminator,
    assumptions: coerceStringArray(obj.assumptions),
    unknowns: coerceStringArray(obj.unknowns),
  }
}

/** Trim stripped-block seams: collapse 3+ newlines and edge whitespace. */
function tidy(body: string): string {
  return body.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Extract the framing card from assistant content.
 * Run alongside extractAgentSpecDraft — a turn may legitimately carry both when
 * the agent re-frames and re-drafts in one reply.
 */
export function extractAgentProblemFrame(content: string, streaming = false): ParsedAgentProblemFrame {
  if (!content.includes(OPEN_FENCE)) return { body: content, frame: null, pending: false }

  let frame: ProblemFrame | null = null
  let stripped = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(content)) !== null) {
    stripped += content.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const parsed = parseFramePayload(match[1])
    if (parsed) frame = parsed // last valid snapshot wins
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
    const parsed = parseFramePayload(tail)
    if (parsed) {
      frame = parsed
      stripped = stripped.slice(0, openIdx)
    } else if (streaming) {
      // Mid-stream: cut the raw protocol tail; the card arrives when complete.
      stripped = stripped.slice(0, openIdx)
      pending = true
    }
  }

  return { body: tidy(stripped), frame, pending }
}
