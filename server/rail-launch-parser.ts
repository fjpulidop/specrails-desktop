// ─── Rail launch proposal protocol (mission-rail-cards) ──────────────────────
// The operator agent proposes "assign these specs to a rail and launch" as ONE
// fenced ```rail-launch JSON block instead of prose. The mission renders it as
// an editable launch card (client/src/components/agent-chat/AgentRailLaunchCard).
// This module is the parser HALF shared by server and client — the client copy
// lives at client/src/lib/rail-launch-draft.ts and MUST stay byte-identical
// except for its import path (a parity test guards that).
//
// Tolerance (spec-draft precedent + snapshot hardening): unknown keys are
// dropped, a malformed block is reported in `rejected[]` (never silent), a
// string-aware tolerant JSON repair runs before rejecting, an open trailing
// fence is cut while streaming (`pending`) and reported `truncated` once the
// turn settled. Every VALID block is kept in order (one card per block: a
// batch proposal is N blocks).

import { parseJsonTolerant } from './json-tolerant'
import { parseFollowUpInput, type PrFollowUp } from './pr-follow-up-scope'

export const RAIL_LAUNCH_FENCE = 'rail-launch'
export const RAIL_LAUNCH_PROPOSAL_VERSION = 1

export const RAIL_LAUNCH_MODES = ['implement', 'batch-implement', 'freestyle', 'loop'] as const
export type RailLaunchMode = (typeof RAIL_LAUNCH_MODES)[number]

export interface RailLaunchProposal {
  version: 1
  /** 0-based server rail index; null ⇒ the card picks a free rail or creates one. */
  railIndex: number | null
  /** Create a fresh rail (name optional). Wins over railIndex when both are set. */
  newRail: { name: string | null } | null
  ticketIds: number[]
  mode: RailLaunchMode
  loopId: string | null
  aiEngine: string | null
  model: string | null
  reasoningEffort: string | null
  profileName: string | null
  targetPrNumber: number | null
  baseBranch: string | null
  railName: string | null
  /** One sentence the agent gives for its recommendation (rendered muted). */
  rationale: string | null
  /** PR review follow-up scope (pr-follow-up-fixes): validated with the same
   * parser the launch route uses; an invalid block reads as null so the card
   * still renders (the route re-validates on Play). */
  followUp: FollowUpProposal | null
}

export type FollowUpProposal = Omit<PrFollowUp, 'id' | 'hash'>

export interface RejectedRailLaunchBlock {
  reason: 'invalid_json' | 'not_object' | 'unsupported_version' | 'no_tickets' | 'invalid_mode'
  /** ≤ 160 chars of the offending payload for the muted "unreadable" note. */
  excerpt: string
}

export interface ParsedRailLaunch {
  /** Message body with every rail-launch fence removed (valid or not). */
  body: string
  proposals: RailLaunchProposal[]
  rejected: RejectedRailLaunchBlock[]
  /** Streaming only: an open fence exists and is being cut from the body. */
  pending: boolean
  /** Settled: an open fence never closed and its tail is not valid JSON. */
  truncated: boolean
  /** True when at least one block needed the tolerant repair pass. */
  repaired: boolean
}

const FENCE_RE = /```rail-launch[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g
const OPEN_FENCE = '```rail-launch'
const EXCERPT_MAX = 160

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function optString(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function optInt(v: unknown, min = 0): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= min) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim())
    return n >= min ? n : null
  }
  return null
}

function coerceTicketIds(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const item of v) {
    // Accept 12, "12" and "#12" — models mirror the user's `#12` vocabulary.
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item.trim().replace(/^#/, '')) : NaN
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

function excerpt(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1)}…` : t
}

/** Validate ONE parsed payload; returns the proposal or a rejection reason. */
export function coerceRailLaunchProposal(value: unknown): { ok: true; proposal: RailLaunchProposal } | { ok: false; reason: RejectedRailLaunchBlock['reason'] } {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const version = optInt(value.version, 1) ?? optInt(value.blueprintVersion, 1)
  if (version !== null && version !== RAIL_LAUNCH_PROPOSAL_VERSION) return { ok: false, reason: 'unsupported_version' }
  const ticketIds = coerceTicketIds(value.ticketIds ?? value.specs ?? value.tickets)
  if (ticketIds.length === 0) return { ok: false, reason: 'no_tickets' }
  const modeRaw = optString(value.mode)?.toLowerCase().replace(/_/g, '-') ?? 'implement'
  const mode = modeRaw === 'batch' ? 'batch-implement' : modeRaw
  if (!(RAIL_LAUNCH_MODES as readonly string[]).includes(mode)) return { ok: false, reason: 'invalid_mode' }
  const newRailRaw = value.newRail
  const newRail = newRailRaw === true
    ? { name: null }
    : isRecord(newRailRaw) ? { name: optString(newRailRaw.name, 80) } : null
  // The agent may say railIndex 1-based by mistake ("Rail 2"); we cannot know,
  // so we trust the number and let the card reconcile against live rails.
  const railIndex = newRail ? null : optInt(value.railIndex, 0)
  return {
    ok: true,
    proposal: {
      version: 1,
      railIndex,
      newRail,
      ticketIds,
      mode: mode as RailLaunchMode,
      loopId: optString(value.loopId, 120),
      aiEngine: optString(value.aiEngine ?? value.provider ?? value.engine, 80),
      model: optString(value.model, 120),
      reasoningEffort: optString(value.reasoningEffort ?? value.reasoning_effort ?? value.effort, 20),
      profileName: optString(value.profileName ?? value.profile, 80),
      targetPrNumber: optInt(value.targetPrNumber, 1),
      baseBranch: optString(value.baseBranch, 200),
      railName: optString(value.railName ?? value.name, 80),
      rationale: optString(value.rationale ?? value.reason ?? value.why, 400),
      followUp: coerceFollowUp(value.followUp),
    },
  }
}

function coerceFollowUp(value: unknown): FollowUpProposal | null {
  if (value === undefined || value === null) return null
  try { return parseFollowUpInput(value) } catch { return null }
}

function tidy(body: string): string {
  return body.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Extract every rail-launch block from assistant content.
 * `streaming` cuts an open fence from the body instead of reporting truncation.
 */
export function extractRailLaunchProposals(content: string, streaming = false): ParsedRailLaunch {
  const empty: ParsedRailLaunch = { body: content ?? '', proposals: [], rejected: [], pending: false, truncated: false, repaired: false }
  if (!content || !content.includes(OPEN_FENCE)) return empty
  const proposals: RailLaunchProposal[] = []
  const rejected: RejectedRailLaunchBlock[] = []
  let repaired = false
  let stripped = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  const consume = (raw: string) => {
    const parsed = parseJsonTolerant(raw)
    if (!parsed.ok) { rejected.push({ reason: 'invalid_json', excerpt: excerpt(raw) }); return }
    if (parsed.repaired) repaired = true
    const result = coerceRailLaunchProposal(parsed.value)
    if (result.ok) proposals.push(result.proposal)
    else rejected.push({ reason: result.reason, excerpt: excerpt(raw) })
  }
  while ((match = FENCE_RE.exec(content)) !== null) {
    stripped += content.slice(cursor, match.index)
    cursor = match.index + match[0].length
    consume(match[1])
  }
  stripped += content.slice(cursor)

  let pending = false
  let truncated = false
  const openIdx = stripped.indexOf(OPEN_FENCE)
  if (openIdx !== -1) {
    const tail = stripped
      .slice(openIdx + OPEN_FENCE.length)
      .replace(/^[^\S\n]*\n?/, '')
      .replace(/\s*(?:```)?\s*$/, '')
    const parsed = tail.trim() ? parseJsonTolerant(tail) : null
    if (parsed && parsed.ok) {
      if (parsed.repaired) repaired = true
      const result = coerceRailLaunchProposal(parsed.value)
      if (result.ok) proposals.push(result.proposal)
      else rejected.push({ reason: result.reason, excerpt: excerpt(tail) })
      stripped = stripped.slice(0, openIdx)
    } else if (streaming) {
      stripped = stripped.slice(0, openIdx)
      pending = true
    } else {
      // Settled and unreadable: cut the raw JSON (never leak protocol text) and
      // say so — the card shows the muted "unreadable" note.
      stripped = stripped.slice(0, openIdx)
      truncated = true
      rejected.push({ reason: 'invalid_json', excerpt: excerpt(tail) })
    }
  }
  return { body: tidy(stripped), proposals, rejected, pending, truncated, repaired }
}

/** Shape detector for the generic-fence promotion pass (small local models). */
export function looksLikeRailLaunch(value: unknown): boolean {
  if (!isRecord(value)) return false
  const tickets = value.ticketIds ?? value.specs ?? value.tickets
  if (!Array.isArray(tickets) || tickets.length === 0) return false
  return 'railIndex' in value || 'newRail' in value || 'mode' in value || 'loopId' in value || 'aiEngine' in value || 'railName' in value
}
