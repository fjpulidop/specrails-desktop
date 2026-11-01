// ─── The framing gate: understanding is checked like a fact, not assumed ──────
// The operator agent verifies facts about the codebase before writing them down
// (it may not name a path it did not open) but had no equivalent check on the
// REQUEST. This module supplies it: before a spec the agent authored may be
// persisted, the conversation must hold an `intent-draft` block (intent-mode;
// the legacy `problem-frame` still counts) the user has seen and answered. The
// answered intent then rides into the committed spec as its `intent` field.
//
// Everything here is DERIVED from rows that already exist in `agent_messages` —
// no migration, no counter column, no new event. The frame is an assistant
// message; the answer is the user message that follows it; consumption is a
// `system`-role marker written when a spec lands, the same app-authored-row
// pattern the PR decision card already uses.
//
// Deliberate limits, stated rather than engineered around:
//  • This proves the user SAW the frame and replied — NOT that they agreed.
//    Intent cannot be parsed reliably from free text, and a check that guesses
//    would be confidently wrong. Preventing the step from being SKIPPED is the
//    guarantee on offer; disagreement is handled by the manual, which requires
//    a corrected frame when the user pushes back.
//  • The waiver is a literal token in a USER-role message, never a phrase the
//    model can emit on the user's behalf. It is a command word, not sentiment.
//
// The frame validation below MIRRORS the client parser in
// client/src/features/missions/components/agent-problem-frame.ts — the same
// server/client parser pair the spec-draft protocol already maintains between
// server/modules/specs/runtime/spec-draft-parser.ts and client/src/features/specs/lib/spec-draft.ts.

import type { DbInstance } from '../../../db'
import { addAgentMessage, listAgentMessages, getAgentConversation } from '../../agents/runtime/agent-store'
import { promoteAgentProtocolFences } from './agent-fence-promotion'
import { isLocalAdapterId } from '../../../providers/registry'
import { parseIntentDraft, type IntentDraft, type SpecIntent } from '../../specs/domain/intent'

/** User-typed command word that switches framing off for the conversation. */
export const FRAMING_WAIVER_TOKEN = '#noframe'
/** User-typed command word that switches it back on. */
export const FRAMING_RESTORE_TOKEN = '#frame'

/** Envelope kind for the app-authored system row marking a consumed frame. */
export const SPEC_FRAMING_MARKER_KIND = 'spec-framing.committed'

const FENCE_RE = /```problem-frame[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g
const OPEN_FENCE = '```problem-frame'
const INTENT_FENCE_RE = /```intent-draft[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g
const INTENT_OPEN_FENCE = '```intent-draft'

export type FramingRefusalReason = 'no_frame' | 'frame_unanswered' | 'frame_consumed'

export interface FramingState {
  satisfied: boolean
  /** True while the conversation is running with framing switched off. */
  waived: boolean
  reason: FramingRefusalReason | null
  /** The newest answered, unspent intent-draft (null for a legacy frame or a waiver). */
  intent: SpecIntent | null
}

/** One conversation row, narrowed to what the derivation actually reads. */
export interface FramingMessage {
  role: string
  content: string
}

/** A reading is valid only with non-empty prose; `touches` may be empty. */
function readingOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.reading !== 'string' || !obj.reading.trim()) return null
  return obj.reading
}

/** Validate one fenced payload against the client parser's exact rules. */
function payloadIsValidFrame(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>

  const restated = readingOf(obj.restated)
  const alternative = readingOf(obj.alternative)
  if (restated === null || alternative === null) return false
  if (typeof obj.discriminator !== 'string' || !obj.discriminator.trim()) return false
  // Byte-identical readings ARE the same reading — the one degenerate case that
  // can be judged deterministically (see the client parser for why nothing
  // softer than exact equality is applied).
  if (restated.trim() === alternative.trim()) return false
  // `assumptions` / `unknowns` are coerced to [] client-side rather than
  // required, so a frame is never rejected for omitting an empty list.
  return true
}

/** True when an assistant message carries at least one VALID frame block. */
export function hasValidProblemFrame(rawContent: string, opts?: { tolerantFences?: boolean }): boolean {
  // Local (OpenAI-compatible) engines only — mirrors the client: a ```json
  // fence with a frame-shaped body counts. CLI providers stay strict.
  const content = opts?.tolerantFences ? promoteAgentProtocolFences(rawContent) : rawContent
  if (!content.includes(OPEN_FENCE)) return false

  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  let seenComplete = false
  while ((match = FENCE_RE.exec(content)) !== null) {
    seenComplete = true
    if (payloadIsValidFrame(match[1])) return true
  }

  // Lenient close: the model dropped the trailing fence but the JSON is whole.
  // Only meaningful when no complete block already satisfied the check.
  if (!seenComplete) {
    const openIdx = content.indexOf(OPEN_FENCE)
    const tail = content
      .slice(openIdx + OPEN_FENCE.length)
      .replace(/^[^\S\n]*\n?/, '')
      .replace(/\s*(?:```)?\s*$/, '')
    return payloadIsValidFrame(tail)
  }
  return false
}

/**
 * The LAST valid ```intent-draft snapshot of an assistant message (complete
 * fences, else a whole JSON tail after an unclosed fence), or null.
 */
export function lastIntentDraft(rawContent: string, opts?: { tolerantFences?: boolean }): IntentDraft | null {
  const content = opts?.tolerantFences ? promoteAgentProtocolFences(rawContent) : rawContent
  if (!content.includes(INTENT_OPEN_FENCE)) return null
  const parse = (raw: string): IntentDraft | null => {
    try { return parseIntentDraft(JSON.parse(raw)) } catch { return null }
  }
  INTENT_FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  let last: IntentDraft | null = null
  let seenComplete = false
  while ((match = INTENT_FENCE_RE.exec(content)) !== null) {
    seenComplete = true
    last = parse(match[1]) ?? last
  }
  if (last || seenComplete) return last
  const tail = content
    .slice(content.indexOf(INTENT_OPEN_FENCE) + INTENT_OPEN_FENCE.length)
    .replace(/^[^\S\n]*\n?/, '')
    .replace(/\s*(?:```)?\s*$/, '')
  return parse(tail)
}

/** Standalone-token match — a command word, never a sentiment guess. */
function containsToken(content: string, token: string): boolean {
  const re = new RegExp(`(^|[\\s(\\[])${token}(?=$|[\\s).,!?\\]])`, 'i')
  return re.test(content)
}

function isFramingMarker(content: string): boolean {
  if (!content.includes(SPEC_FRAMING_MARKER_KIND)) return false
  try {
    const parsed = JSON.parse(content) as { kind?: unknown }
    return parsed?.kind === SPEC_FRAMING_MARKER_KIND
  } catch {
    return false
  }
}

/**
 * Fold the conversation into the framing state at its tail.
 *
 * A frame becomes ANSWERED when a user message follows it, and is CONSUMED by
 * the next spec commit — which is what makes one frame authorise one spec
 * rather than a series. A waiver is sticky for the rest of the conversation and
 * is cleared only by the restore token.
 */
export function evaluateFramingState(messages: readonly FramingMessage[], opts?: { tolerantFences?: boolean }): FramingState {
  let waived = false
  let pendingFrame = false // emitted, awaiting the user's answer
  let answeredFrame = false // answered and not yet spent on a spec
  let sawFrame = false
  let pendingIntent: SpecIntent | null = null
  let answeredIntent: SpecIntent | null = null

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (isFramingMarker(msg.content)) { answeredFrame = false; answeredIntent = null } // spent
      continue
    }
    if (msg.role === 'assistant') {
      const draft = lastIntentDraft(msg.content, opts)
      if (draft || hasValidProblemFrame(msg.content, opts)) {
        pendingFrame = true
        sawFrame = true
        pendingIntent = draft?.intent ?? null
      }
      continue
    }
    if (msg.role !== 'user') continue

    // Restore wins over waive when a message somehow carries both: the safer
    // of the two readings of an ambiguous instruction is "keep the check".
    if (containsToken(msg.content, FRAMING_RESTORE_TOKEN)) waived = false
    else if (containsToken(msg.content, FRAMING_WAIVER_TOKEN)) waived = true

    if (pendingFrame) {
      answeredFrame = true
      answeredIntent = pendingIntent
      pendingFrame = false
    }
  }

  if (waived) return { satisfied: true, waived: true, reason: null, intent: answeredFrame ? answeredIntent : null }
  if (answeredFrame) return { satisfied: true, waived: false, reason: null, intent: answeredIntent }
  if (pendingFrame) return { satisfied: false, waived: false, reason: 'frame_unanswered', intent: null }
  return { satisfied: false, waived: false, reason: sawFrame ? 'frame_consumed' : 'no_frame', intent: null }
}

const REFUSAL_BASE =
  'Refused: this spec has no intent the user has answered. ' +
  'Emit ONE fenced ```intent-draft block (problem, outcome, hypothesis?, successSignals, affects, constraints, ' +
  'openQuestions, readings{restated, alternative, discriminator}), end your reply on that question, and call commit_draft ' +
  'after the user answers. Only the user waives this, by sending #noframe.'

const REFUSAL_DETAIL: Record<FramingRefusalReason, string> = {
  no_frame: 'No intent has been shown in this conversation yet.',
  frame_unanswered: 'An intent was shown but the user has not answered it yet — end the turn and wait.',
  frame_consumed: 'The previous intent was already spent on an earlier spec; each spec needs its own.',
}

export function framingRefusalMessage(reason: FramingRefusalReason): string {
  return `${REFUSAL_DETAIL[reason]} ${REFUSAL_BASE}`
}

/**
 * Gate entry point. Returns a refusal message, or null when the commit may
 * proceed. Callers apply it ONLY to first-party in-app agent calls: an external
 * MCP client cannot render the card and holds no conversation here.
 */
export function checkSpecFraming(db: DbInstance, conversationId: string): string | null {
  const state = framingStateOf(db, conversationId)
  if (state.satisfied) return null
  return framingRefusalMessage(state.reason ?? 'no_frame')
}

function framingStateOf(db: DbInstance, conversationId: string): FramingState {
  const tolerantFences = isLocalAdapterId(getAgentConversation(db, conversationId)?.provider)
  return evaluateFramingState(listAgentMessages(db, conversationId), { tolerantFences })
}

/** The answered intent a first-party commit_draft attaches to its spec (null when none). */
export function answeredSpecIntent(db: DbInstance, conversationId: string): SpecIntent | null {
  return framingStateOf(db, conversationId).intent
}

/**
 * Mark the conversation's answered frame as spent. Written as a `system` row so
 * the fact survives a restart and stays derivable from the same message list the
 * gate already reads. The client skips this row silently — it is a record, not
 * a card.
 */
export function recordSpecCommitted(db: DbInstance, conversationId: string): void {
  addAgentMessage(db, {
    conversationId,
    role: 'system',
    content: JSON.stringify({ kind: SPEC_FRAMING_MARKER_KIND, at: new Date().toISOString() }),
  })
}
