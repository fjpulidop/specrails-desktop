/**
 * Revision context seed (nontech-review-experience Wave 3).
 *
 * A revision run starts a FRESH provider session seeded from durable state —
 * never from the previous run's session. That is a deliberate contract, not a
 * fallback:
 *
 *  · Provider sessions are cwd-scoped. The previous run's session belongs to a
 *    per-run worktree path that the decision flow releases; resuming from
 *    anywhere else hits the exact "No conversation found with session ID"
 *    failure Contract Refine documents.
 *  · `jobs.session_id` is last-non-null-wins, so it holds the FINAL step's
 *    session (the verify/reviewer step) — not the developer session a revision
 *    would actually want.
 *  · The codebase already made this call everywhere else: the loop engine drops
 *    sessions at each loop-back, contract-refine retries fresh, agent chat
 *    auto-heals by starting over. "Fresh session + durable state on disk" is
 *    the house pattern.
 *
 * So the carrier of the work is the BRANCH (resumed by the shipped
 * rail_worktrees ledger), and the carrier of the intent is this seed.
 */
import type { DeliverySpecSnapshotEntry } from './rail-pr-store'
import type { DeliverySettleEvidence } from './delivery-evidence'

/** Bounds keep the seed a briefing, not a transcript. */
export const SEED_SPEC_BODY_CAP = 4000
export const SEED_DIFF_CAP = 4000
export const SEED_EVIDENCE_CAP = 1200

export interface RevisionSeedInput {
  /** The user's one-sentence instruction. */
  note: string
  /** Launch-time snapshot of the covered tickets (what was ASKED, frozen). */
  specSnapshot: DeliverySpecSnapshotEntry[] | null
  ticketIds: number[]
  /** Branches the previous generation produced, for orientation. */
  branches: string[]
  baseBranch: string
  /** Diff summary of what already exists on the branch (name-status or shortstat). */
  branchDiffSummary: string | null
  /** Harvested verification evidence from the generation being revised. */
  evidence: DeliverySettleEvidence | null
  /** How many revisions came before this one (1 = first revision). */
  revisionNumber: number
}

function clamp(value: string, cap: number): string {
  const trimmed = value.trim()
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}\n…(truncated)`
}

/** One-line digest of what the previous run's verification actually reported. */
function evidenceLine(evidence: DeliverySettleEvidence | null): string {
  if (!evidence || evidence.units.length === 0) return 'No verification evidence was captured for the previous run.'
  const failed = evidence.units.filter((unit) => unit.sentinel === 'fail')
  const passed = evidence.units.filter((unit) => unit.sentinel === 'pass')
  const parts: string[] = []
  if (failed.length > 0) {
    // Failure first: a revision briefing must not bury it behind a pass.
    const detail = failed.map((unit) => unit.sentinelDetail).find(Boolean)
    parts.push(`The previous run REPORTED FAILED verification${detail ? ` (${clamp(detail, 200)})` : ''}.`)
  }
  if (passed.length > 0) parts.push('The previous run reported its verification passed.')
  if (parts.length === 0) parts.push('The previous run did not report a verification verdict.')
  const score = evidence.units.map((unit) => unit.confidence?.overall).find((value) => typeof value === 'number')
  if (typeof score === 'number') parts.push(`Its reviewer scored the work ${score}/100.`)
  return parts.join(' ')
}

/**
 * The briefing a revision run is seeded with. Deterministic (same input ⇒ same
 * text) so it is cache-friendly and testable, and honest: it never claims the
 * previous run verified anything the evidence does not say.
 */
export function buildRevisionSeed(input: RevisionSeedInput): string {
  const specs = (input.specSnapshot ?? []).length > 0
    ? (input.specSnapshot ?? []).map((entry) => [
        `### #${entry.ticketId} ${entry.title ?? '(untitled)'}`,
        entry.description ? clamp(entry.description, SEED_SPEC_BODY_CAP) : '(no description recorded)',
      ].join('\n')).join('\n\n')
    : input.ticketIds.map((id) => `### #${id}\n(spec text was not captured at launch)`).join('\n\n')

  return [
    '## Revision briefing',
    '',
    `This is revision ${input.revisionNumber} of work that has ALREADY been delivered for the spec(s) below.`,
    'The code exists on the branch listed here. Do NOT start over, re-plan, or re-implement it.',
    '',
    '## What the user asked to change',
    '',
    clamp(input.note, SEED_SPEC_BODY_CAP),
    '',
    '## The original request (frozen at launch)',
    '',
    specs,
    '',
    '## Where the existing work lives',
    '',
    input.branches.length > 0
      ? `Branch(es): ${input.branches.join(', ')} (based on ${input.baseBranch}).`
      : `Base branch: ${input.baseBranch}.`,
    ...(input.branchDiffSummary
      ? ['', 'Already changed on that branch:', '', clamp(input.branchDiffSummary, SEED_DIFF_CAP)]
      : []),
    '',
    '## What the previous run reported',
    '',
    clamp(evidenceLine(input.evidence), SEED_EVIDENCE_CAP),
  ].join('\n')
}
