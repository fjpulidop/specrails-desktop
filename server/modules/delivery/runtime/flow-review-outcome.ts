/**
 * Flow → Spec outcome when a run stops before delivery because the work still
 * needs changes: the reviewer rejected the latest round, or the host checks
 * still fail, after the recipe's bounded repair rounds (`factory:flow-spec`,
 * terminal `changes-requested`). Read from the deterministic settle evidence
 * (reviewer verdict and host-run commands, never the model's prose), so the
 * card can say "the reviewer requested changes" with the actual issues instead
 * of a generic implementation failure. Pure; never throws.
 */
import type { PrDeliveryFlowReview } from '../../../types'
import type { DeliverySettleEvidence, DeliveryUnitEvidence } from './delivery-evidence'

/** `factory:flow-spec` (loops' FLOW_SPEC_LOOP_ID; a literal keeps this store-level module free of the loop catalog's imports — a test pins the equality). */
export const FLOW_SPEC_DELIVERY_LOOP_ID = 'factory:flow-spec'

export const FLOW_REVIEW_ISSUES_CAP = 20
const ISSUE_TEXT_CAP = 600
const SUMMARY_CAP = 1200
const COMMAND_CAP = 200

/**
 * `reason` — `review`: the latest review rejected the work; `check`: the latest
 * host verification failed. `issues` are the reviewer's latest issues (bounded,
 * `issuesOmitted` beyond it); `failingChecks` the host-run commands with a
 * non-zero exit.
 */
export type FlowReviewOutcome = PrDeliveryFlowReview

const clip = (text: string, cap: number): string => {
  const clean = text.trim()
  return clean.length <= cap ? clean : `${clean.slice(0, cap).trimEnd()}…`
}

function unitOutcome(unit: DeliveryUnitEvidence | undefined): FlowReviewOutcome | null {
  const runtime = unit?.runtime
  if (!runtime) return null
  const failingChecks = runtime.commands
    .filter((command) => command.outcome === 'failed' || (command.exitCode !== null && command.exitCode !== 0))
    .slice(0, 10)
    .map((command) => ({ command: clip(command.label, COMMAND_CAP), exitCode: command.exitCode }))
  const review = runtime.review
  const rejected = review !== null && review.approved === false
  if (!rejected && failingChecks.length === 0) return null
  const issues = rejected ? review!.issues.filter((issue) => issue.trim()) : []
  return {
    reason: rejected ? 'review' : 'check',
    summary: review?.summary ? clip(review.summary, SUMMARY_CAP) : null,
    issues: issues.slice(0, FLOW_REVIEW_ISSUES_CAP).map((issue) => clip(issue, ISSUE_TEXT_CAP)),
    issuesOmitted: Math.max(0, issues.length - FLOW_REVIEW_ISSUES_CAP),
    score: rejected && typeof review!.score === 'number' ? review!.score : null,
    failingChecks,
  }
}

/**
 * The outcome of a FAILED Flow → Spec delivery whose evidence shows changes
 * are still requested; null for every other loop, a succeeded run, or a
 * failure the evidence does not explain (derivation, provider, crash), which
 * keeps its generic failure presentation.
 */
export function flowReviewOutcome(input: {
  loopId: string | null
  implementationOutcome: string | null
  evidence: DeliverySettleEvidence | null | undefined
}): FlowReviewOutcome | null {
  if (input.loopId !== FLOW_SPEC_DELIVERY_LOOP_ID || input.implementationOutcome !== 'failed') return null
  // Flow hands off exactly one spec: one unit.
  return unitOutcome(input.evidence?.units?.[0])
}

/** One line for `statusDetail` (and the mission briefing): what still blocks the delivery. */
export function flowReviewStatusDetail(outcome: FlowReviewOutcome): string {
  if (outcome.reason === 'check') {
    const checks = outcome.failingChecks.map((check) => `${check.command}${check.exitCode !== null ? ` (exit ${check.exitCode})` : ''}`).join('; ')
    return clip(`Flow → Spec stopped: the checks still fail after the automatic correction rounds — ${checks}`, SUMMARY_CAP)
  }
  const first = outcome.issues[0]
  const more = outcome.issues.length + outcome.issuesOmitted - 1
  return clip(`The reviewer requested changes${outcome.score !== null ? ` (score ${outcome.score})` : ''}: ${first ?? outcome.summary ?? 'see the review'}${more > 0 ? ` (+${more} more)` : ''}`, SUMMARY_CAP)
}

interface FlowReviewRow {
  loop_id: string | null
  decision?: string | null
  implementation_outcome?: string | null
  status_code?: string | null
  settle_evidence?: string | null
}

const REVIEW_STATUS_CODES = new Set(['review_changes_requested', 'returned_to_flow'])

/**
 * A Flow → Spec delivery settled as a generic implementation failure — before
 * settlement classified requested changes (or with evidence healed later).
 * Its stored evidence decides on read whether it is really a review outcome;
 * a failure the evidence does not explain stays a failure.
 */
export function isLegacyFlowReviewCandidate(row: FlowReviewRow): boolean {
  return row.loop_id === FLOW_SPEC_DELIVERY_LOOP_ID
    && row.decision === 'implementation_failed'
    && row.implementation_outcome === 'failed'
    && !REVIEW_STATUS_CODES.has(row.status_code ?? '')
}

/** Parse the stored settle evidence of a row; null when absent or unreadable. */
export function readFlowReviewOutcome(row: FlowReviewRow): FlowReviewOutcome | null {
  if (row.loop_id !== FLOW_SPEC_DELIVERY_LOOP_ID || !row.settle_evidence) return null
  if (!REVIEW_STATUS_CODES.has(row.status_code ?? '') && !isLegacyFlowReviewCandidate(row)) return null
  try {
    return flowReviewOutcome({ loopId: row.loop_id, implementationOutcome: row.implementation_outcome ?? null, evidence: JSON.parse(row.settle_evidence) as DeliverySettleEvidence })
  } catch {
    return null
  }
}

/**
 * The presentation of a legacy candidate whose evidence shows requested
 * changes: exactly what a settlement records today (status code, detail, the
 * per-unit failure code). Null when the row is not such a candidate. Pure —
 * the snapshot applies it on read; the one-shot heal persists the same values.
 */
export function legacyFlowReviewReclassification<Unit extends { failureCode?: string | null }>(row: FlowReviewRow, units: readonly Unit[]): {
  flowReview: FlowReviewOutcome
  statusCode: 'review_changes_requested'
  statusDetail: string
  units: Unit[]
} | null {
  if (!isLegacyFlowReviewCandidate(row)) return null
  const flowReview = readFlowReviewOutcome(row)
  if (!flowReview) return null
  return {
    flowReview,
    statusCode: 'review_changes_requested',
    statusDetail: flowReviewStatusDetail(flowReview),
    units: units.map((unit) => unit.failureCode === 'settlement_interrupted' ? ({ ...unit, failureCode: 'review_changes_requested' }) as Unit : unit),
  }
}
