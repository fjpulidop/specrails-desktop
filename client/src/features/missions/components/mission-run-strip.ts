// ─── Mission run strip: the pure model ────────────────────────────────────────
// One strip above the composer is the single live representation of the runs
// of a mission (mission-rail-cards, Flow). This module owns the vocabulary the
// strip, the history lines and the sidebar's attention dot share:
//   - the state a live delivery shows (launching · running · waiting for you ·
//     failed · paused) and how urgent it is,
//   - which run the strip shows when several are live,
//   - the honest totals of a run's vitals (elapsed, billed cost, progress).
// No React, no network: everything here is derived from envelopes and the
// vitals the run chips already measure.

import type { AgentPrDecisionEnvelope, MissionRunRuntime } from '../lib/agent-api'
import { isPrEnvelopePinned } from './agent-pr-pinning'

/**
 * How the strip renders a run. `launching` is a skeleton, the rest carry data.
 * `info` is a settled, informational state: nothing to decide right now (the
 * run finished without changes, its PR was closed, a Flow needs a look).
 */
export type MissionRunTone = 'launching' | 'running' | 'decision' | 'failed' | 'paused' | 'info'

/** Strip priority: what needs you first, then what broke, then what moves, then what waits, then what only informs. */
export type MissionRunUrgency = 'decision' | 'failed' | 'running' | 'paused' | 'info'

const URGENCY_RANK: Readonly<Record<MissionRunUrgency, number>> = Object.freeze({
  decision: 0,
  failed: 1,
  running: 2,
  paused: 3,
  info: 4,
})

export function urgencyRank(urgency: MissionRunUrgency): number {
  return URGENCY_RANK[urgency]
}

export function urgencyOfTone(tone: MissionRunTone): MissionRunUrgency {
  return tone === 'launching' ? 'running' : tone
}

/** What the run card measured about the run itself (reported while it is mounted). */
export interface MissionRunCardSummary {
  /** The run's next / current step id (live runtime), null when unknown. */
  step: string | null
  /** A run of this delivery is paused and needs the person to resume or stop it. */
  paused: boolean
  pausedReason: string | null
  /** The live runtime says the run is stalled. */
  stalled: boolean
  /** The live runtime waits for an approval. */
  pendingApproval: boolean
}

/** One run's vitals as measured by its log chip (REAL numbers only). */
export interface MissionRunVitalsSnapshot {
  running: boolean
  /** The initial read settled; a finished run has a status. */
  loaded: boolean
  status: string | null
  elapsedMs: number | null
  costUsd: number | null
}

export interface MissionRunTotals {
  /** Wall-clock of the longest run (runs of a rail run side by side). */
  elapsedMs: number | null
  /** Sum of the billed cost; null until any run reports a cost above zero. */
  costUsd: number | null
  /** Some runs have no billed cost yet while others do. */
  costPartial: boolean
  /** Finished / total runs, only when the delivery has more than one run. */
  progress: { done: number; total: number } | null
}

/** Honest totals over a delivery's runs: never an estimate, never a guess. */
export function missionRunTotals(runIds: readonly string[], vitals: ReadonlyMap<string, MissionRunVitalsSnapshot> | undefined): MissionRunTotals {
  let elapsedMs: number | null = null
  let costUsd: number | null = null
  let unpriced = 0
  let done = 0
  for (const runId of runIds) {
    const v = vitals?.get(runId)
    if (!v) { unpriced += 1; continue }
    if (v.elapsedMs !== null) elapsedMs = Math.max(elapsedMs ?? 0, v.elapsedMs)
    if (v.costUsd !== null && v.costUsd > 0) costUsd = (costUsd ?? 0) + v.costUsd
    else unpriced += 1
    if (v.loaded && !v.running && v.status !== null) done += 1
  }
  return {
    elapsedMs,
    costUsd,
    costPartial: costUsd !== null && unpriced > 0,
    progress: runIds.length > 1 ? { done, total: runIds.length } : null,
  }
}

/** `$0.84` — two decimals, the run chips' format. */
export function formatRunCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`
}

/** A Flow → Spec run stopped because the review still asks for changes. */
function reviewChangesRequested(envelope: Pick<AgentPrDecisionEnvelope, 'decision' | 'statusCode'>): boolean {
  return envelope.decision === 'implementation_failed' && envelope.statusCode === 'review_changes_requested'
}

function runtimeFailed(runtime: MissionRunRuntime | null | undefined): boolean {
  if (!runtime) return false
  return runtime.status === 'failed' || runtime.status === 'stalled' || runtime.failure !== null
}

/**
 * The tone a live delivery shows. Decisions the person must take come first;
 * a failure is a failure even when the card also offers recovery; a building
 * delivery is paused, launching or running depending on what the card saw.
 */
export function deliveryRunTone(
  envelope: Pick<AgentPrDecisionEnvelope, 'decision' | 'phase' | 'runtime' | 'statusCode'>,
  card: MissionRunCardSummary | null,
): MissionRunTone {
  const { decision } = envelope
  if (decision === 'building') {
    if (card?.pendingApproval) return 'decision'
    if (card?.paused) return 'paused'
    if (card?.stalled) return 'failed'
    if (envelope.phase === 'launched' && !card?.step) return 'launching'
    return 'running'
  }
  if (card?.pendingApproval || envelope.runtime?.pendingApproval) return 'decision'
  if (reviewChangesRequested(envelope)) return 'decision'
  if (decision === 'implementation_failed' || decision === 'pr_failed') return 'failed'
  if (decision === 'on_review' || decision === 'pr_draft' || decision === 'no_changes' || decision === 'pr_closed') return 'decision'
  if (runtimeFailed(envelope.runtime)) return 'failed'
  if (envelope.phase === 'launched') return card?.step ? 'running' : 'launching'
  if (envelope.phase === 'running' || envelope.runtime?.status === 'running') return card?.paused ? 'paused' : 'running'
  return 'decision'
}

/**
 * The delivery waits for the person (the sidebar's attention dot): a review
 * decision, an approval, or a failure nobody acted on yet. Envelope-only, so it
 * also works for conversations that are not open.
 */
export function deliveryNeedsPerson(envelope: Pick<AgentPrDecisionEnvelope, 'decision' | 'phase' | 'runtime' | 'statusCode' | 'hasDelivery'>): boolean {
  if (!isPrEnvelopePinned(envelope)) return false
  const tone = deliveryRunTone(envelope, null)
  return tone === 'decision' || tone === 'failed'
}

/** A stable identity per strip entry. */
export const deliveryRunKey = (prDeliveryId: string): string => `delivery:${prDeliveryId}`
export const proposalRunKey = (messageId: string, proposalIndex: number): string => `proposal:${messageId}:${proposalIndex}`

export interface RankedRun {
  key: string
  urgency: MissionRunUrgency
}

/**
 * The run the strip shows: the person's pick while it is still live, else the
 * most urgent one (ties: the newest, i.e. the last in message order).
 */
export function pickStripRun<T extends RankedRun>(runs: readonly T[], picked: string | null): T | null {
  if (runs.length === 0) return null
  if (picked) {
    const chosen = runs.find((run) => run.key === picked)
    if (chosen) return chosen
  }
  let best = runs[0]
  for (const run of runs.slice(1)) {
    if (urgencyRank(run.urgency) <= urgencyRank(best.urgency)) best = run
  }
  return best
}

/**
 * The key that just became urgent (newly waiting for the person or newly
 * failed). The strip never swaps to it while the person is using the strip —
 * see heldStripKey — it marks the switcher entry and announces it instead.
 */
export function newlyUrgentKey(previous: ReadonlyMap<string, MissionRunUrgency>, runs: readonly RankedRun[]): string | null {
  let found: RankedRun | null = null
  for (const run of runs) {
    if (run.urgency !== 'decision' && run.urgency !== 'failed') continue
    const before = previous.get(run.key)
    if (before === run.urgency) continue
    if (before !== undefined && urgencyRank(before) <= urgencyRank(run.urgency)) continue
    if (!found || urgencyRank(run.urgency) <= urgencyRank(found.urgency)) found = run
  }
  return found?.key ?? null
}

/** What the person is doing with the strip right now. */
export interface StripHold {
  /** The run picked in the switcher (session-only). */
  pick: string | null
  /** The run whose panel is open. */
  open: string | null
  /** The run shown when focus entered the strip (held while focus stays inside). */
  focus: string | null
}

/**
 * The run the strip must keep showing, or null when the strip is IDLE (nothing
 * picked, no panel open, focus elsewhere) — only then may it follow urgency on
 * its own. A hold on a run that left the strip no longer holds.
 */
export function heldStripKey(liveKeys: readonly string[], hold: StripHold): string | null {
  for (const key of [hold.pick, hold.open, hold.focus]) {
    if (key && liveKeys.includes(key)) return key
  }
  return null
}

/** `implement-fix` → `Implement fix`: a readable fallback when no extension names the step. */
export function humanizeStepId(stepId: string): string {
  const words = stepId.replace(/^[a-z]+:/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return stepId
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ── Session-only pick per conversation ────────────────────────────────────────
// Like the old dock's collapse state: SESSION storage, so a fresh app session
// re-surfaces the most urgent run.
const pickKey = (conversationId: string): string => `specrails-desktop:run-strip-pick:${conversationId}`

export function readStripPick(conversationId: string): string | null {
  try {
    return sessionStorage.getItem(pickKey(conversationId))
  } catch {
    return null
  }
}

export function writeStripPick(conversationId: string, key: string | null): void {
  try {
    if (key) sessionStorage.setItem(pickKey(conversationId), key)
    else sessionStorage.removeItem(pickKey(conversationId))
  } catch {
    /* storage unavailable — the pick stays component-local */
  }
}
