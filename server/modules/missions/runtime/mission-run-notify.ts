// ─── Mission run cards + the failure trigger (mission-rail-cards) ────────────
// ONE chokepoint through which every mission-originated run reports to the
// conversation that launched it:
//   - `postRunCard` / `settleRunCard`: the run card for SHARED-CWD launches
//     (no git repo / no commits — no `rail_pr_deliveries` row, so before this
//     change the mission had NO object for the run at all). The card reuses
//     the PR-decision envelope keyed on a synthetic `run:<runId>` id with
//     `hasDelivery:false`, so cold-load / pinning / rendering are shared.
//   - `notifyMissionRunFailure`: on failed / stalled / provider-limit / stuck
//     outcomes: (a) update the card in place with the failure as TEXT,
//     (b) insert the compact `run-failure` system row, (c) start ONE bounded
//     automatic agent turn with the briefing. Untagged launches → no-op.
// Never throws — it runs inside settle paths.

import { getAgentChatManager } from './agent-chat-registry'
import { isMissionRailCardsEnabled } from '../../../feature-flags'
import { buildFailureBriefing, failureBriefingRef } from './agent-failure-briefing'
import type { MissionRunFailure, MissionRunRuntime, PrDecisionCardEnvelope, RunFailureRow } from '../../../types'
import type { RuntimeRunSummary } from '../../agent-runtime/runtime/agent-runtime-controls'

export const RUN_CARD_ID_PREFIX = 'run:'
export function runCardId(runId: string): string { return `${RUN_CARD_ID_PREFIX}${runId}` }
export function isRunCardId(prDeliveryId: string): boolean { return prDeliveryId.startsWith(RUN_CARD_ID_PREFIX) }

export interface RunCardIdentity {
  projectId: string
  runId: string
  railIndex: number
  railName?: string | null
  ticketIds: number[]
}

/** The envelope of a delivery-less (shared-cwd) run card. */
export function buildRunCardEnvelope(
  id: RunCardIdentity,
  state: { phase: 'launched' | 'running' | 'settled'; decision: 'building' | 'completed' | 'implementation_failed' | 'discarded'; runtime?: MissionRunRuntime | null; statusCode?: string | null; statusDetail?: string | null },
): PrDecisionCardEnvelope {
  const now = new Date().toISOString()
  const failed = state.decision === 'implementation_failed'
  return {
    kind: 'pr_decision',
    prDeliveryId: runCardId(id.runId),
    railIndex: id.railIndex,
    projectId: id.projectId,
    baseBranch: '',
    ticketIds: id.ticketIds,
    decision: state.decision,
    implementationOutcome: state.decision === 'building' ? 'running' : state.decision === 'completed' ? 'succeeded' : failed ? 'failed' : 'unknown',
    deliveryOutcome: 'not_started',
    statusCode: state.statusCode ?? (failed ? 'implementation_failed' : state.decision === 'discarded' ? 'cancelled' : null),
    statusDetail: state.statusDetail ?? null,
    deliverySha: null,
    isContinuation: false,
    supersedesDeliveryId: null,
    restoredFromDeliveryId: null,
    operation: null,
    cleanupWarnings: [],
    safetyArchives: [],
    units: id.ticketIds.map((ticketId) => ({ ticketId, branch: '', succeeded: state.decision === 'completed', runId: id.runId })),
    prUrl: null,
    prNumber: null,
    prState: 'none',
    branch: null,
    runIds: [id.runId],
    createdAt: now,
    updatedAt: now,
    hasDelivery: false,
    phase: state.phase,
    railName: id.railName ?? null,
    runtime: state.runtime ?? null,
  }
}

/** Map a loop outcome (+ stall reason) to a card failure; null when not a failure. */
export function failureForLoopOutcome(outcome: string, stallReason?: string | null, detail?: string | null): MissionRunFailure | null {
  if (outcome === 'success') return null
  if (stallReason === 'provider_limit') return { code: 'provider_limit', detail: detail ?? null, stepId: null }
  if (outcome === 'stalled') return { code: 'stalled', detail: detail ?? (stallReason ? `reason: ${stallReason}` : null), stepId: null }
  if (outcome === 'stopped') return { code: 'cancelled', detail: detail ?? null, stepId: null }
  if (outcome === 'blocked') return { code: 'blocked', detail: detail ?? (stallReason ?? null), stepId: null }
  return { code: 'implementation_failed', detail: detail ?? (stallReason ?? null), stepId: null }
}

export function runtimeFromSummary(summary: RuntimeRunSummary | null, failure: MissionRunFailure | null): MissionRunRuntime {
  const status: MissionRunRuntime['status'] = summary
    ? (summary.active ? 'running' : summary.status === 'succeeded' ? 'succeeded' : summary.status === 'cancelled' ? 'cancelled' : summary.status === 'stalled' ? 'stalled' : failure ? 'failed' : 'unknown')
    : failure ? (failure.code === 'stalled' ? 'stalled' : failure.code === 'cancelled' ? 'cancelled' : 'failed') : 'unknown'
  return {
    status,
    currentStep: summary?.nextStep ?? null,
    canResume: summary?.canResume ?? false,
    recoverableSteps: summary?.recoverableSteps ?? [],
    pendingApproval: Boolean(summary?.pendingApproval),
    failure: failure ? { ...failure, stepId: failure.stepId ?? summary?.pendingApproval?.stepId ?? null } : null,
    at: new Date().toISOString(),
  }
}

/** Post the run card at launch (shared-cwd path). */
export function postRunCard(originConversationId: string | null | undefined, id: RunCardIdentity): void {
  if (!originConversationId || !isMissionRailCardsEnabled()) return
  const mgr = getAgentChatManager()
  if (!mgr) return
  try {
    mgr.postPrDecisionCard(originConversationId, buildRunCardEnvelope(id, { phase: 'running', decision: 'building' }))
  } catch (err) {
    console.error('[mission-run] postRunCard failed:', err)
  }
}

/** Settle a shared-cwd run card: success → completed, cancel → discarded; failures go through notifyMissionRunFailure. */
export function settleRunCard(originConversationId: string | null | undefined, id: RunCardIdentity, outcome: string, summary: RuntimeRunSummary | null = null): void {
  if (!originConversationId || !isMissionRailCardsEnabled()) return
  const mgr = getAgentChatManager()
  if (!mgr) return
  try {
    const decision = outcome === 'success' ? 'completed' : outcome === 'stopped' ? 'discarded' : 'implementation_failed'
    const runtime = runtimeFromSummary(summary, failureForLoopOutcome(outcome))
    if (outcome === 'success' && !summary) runtime.status = 'succeeded'
    mgr.updatePrDecisionCard(originConversationId, buildRunCardEnvelope(id, { phase: 'settled', decision, runtime }))
  } catch (err) {
    console.error('[mission-run] settleRunCard failed:', err)
  }
}

export interface NotifyMissionRunFailureInput extends RunCardIdentity {
  originConversationId: string | null | undefined
  failure: MissionRunFailure
  /** The card envelope to write (already carrying the run's final decision).
   *  Omit for shared-cwd runs — a settled run-card envelope is built here. */
  envelope?: PrDecisionCardEnvelope
  summary?: RuntimeRunSummary | null
  tickets?: Array<{ id: number; title?: string | null }>
  outputTail?: string | null
  hasDelivery?: boolean
  prDeliveryId?: string | null
}

export interface NotifyMissionRunFailureResult {
  card: boolean
  row: string | null
  turn: 'started' | 'skipped'
}

const SKIPPED: NotifyMissionRunFailureResult = { card: false, row: null, turn: 'skipped' }

/**
 * The failure trigger job → card → agent. Resolves to what actually happened
 * so callers/tests can assert; NEVER throws.
 */
export async function notifyMissionRunFailure(input: NotifyMissionRunFailureInput): Promise<NotifyMissionRunFailureResult> {
  if (!input.originConversationId || !isMissionRailCardsEnabled()) return SKIPPED
  const mgr = getAgentChatManager()
  if (!mgr) return SKIPPED
  const origin = input.originConversationId
  const runtime = runtimeFromSummary(input.summary ?? null, input.failure)
  const hasDelivery = input.hasDelivery ?? Boolean(input.envelope && input.envelope.hasDelivery !== false)
  const envelope: PrDecisionCardEnvelope = input.envelope
    ? { ...input.envelope, phase: input.envelope.decision === 'building' ? 'running' : input.envelope.phase ?? 'settled', runtime, railName: input.railName ?? input.envelope.railName ?? null }
    : buildRunCardEnvelope(input, { phase: 'settled', decision: input.failure.code === 'cancelled' ? 'discarded' : 'implementation_failed', runtime, statusCode: input.failure.code, statusDetail: input.failure.detail })
  let card = false
  try { mgr.updatePrDecisionCard(origin, envelope); card = true } catch (err) { console.error('[mission-run] card update failed:', err) }
  const rowPayload: RunFailureRow = {
    kind: 'run-failure', runId: input.runId, railIndex: input.railIndex, projectId: input.projectId,
    prDeliveryId: envelope.prDeliveryId, ticketIds: input.ticketIds,
    code: input.failure.code, detail: input.failure.detail, stepId: runtime.failure?.stepId ?? null, at: new Date().toISOString(),
  }
  const row = mgr.postRunFailureRow(origin, rowPayload)
  // A cancelled run is the user's own decision — no briefing turn for it.
  if (input.failure.code === 'cancelled') return { card, row, turn: 'skipped' }
  const briefing = buildFailureBriefing({
    runId: input.runId, railIndex: input.railIndex, railName: input.railName, ticketIds: input.ticketIds, tickets: input.tickets,
    failure: runtime.failure ?? input.failure, outputTail: input.outputTail,
    recovery: { canResume: runtime.canResume, recoverableSteps: runtime.recoverableSteps, pendingApproval: runtime.pendingApproval, pendingQuestion: input.summary?.pendingQuestion?.question ?? null },
    hasDelivery, prDeliveryId: hasDelivery ? envelope.prDeliveryId : null,
  })
  const turn = await mgr.startSystemTurn(origin, briefing, { runId: input.runId, ref: failureBriefingRef(input.runId, input.railIndex, input.failure.code) })
  return { card, row, turn }
}
