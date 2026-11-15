// Which specs are being worked on right now, and from which mission.
//
// Derived, never stored: the two live sources the app already keeps converged
// for the active project are
//   - the rails' active PR deliveries (`RailPrDecisionContext`: GET /rails seed
//     + `rail.pr_state` WS) — Implement runs and Intent → Spec runs alike, with
//     their `ticketIds` and launching mission (`originConversationId`);
//   - a spec held by a live Intent (`metadata.flow.state` active/paused, with
//     its mission's `conversationId`), before any rail exists.
// `ticket.status` alone is not activity: a spec can sit `in_progress` with
// nothing running.

import type { LocalTicket, RailPrDecision, RailPrStateSnapshot } from '../../../types'

export type SpecActivityPhase = 'running' | 'waiting' | 'failed' | 'paused'
export type SpecActivityKind = 'implement' | 'intent'

export interface SpecActivity {
  ticketId: number
  kind: SpecActivityKind
  phase: SpecActivityPhase
  /** The mission working on it; null for a dashboard launch. */
  conversationId: string | null
  /** 0-based rail index; null for a live Intent not handed to a rail yet. */
  railIndex: number | null
  prDeliveryId: string | null
  runIds: string[]
  updatedAt: string | null
}

/** What a spec row shows (`shown`, the most urgent run) and where its
 * shortcut goes (`link`: the run of the most recently CREATED mission working
 * on the spec; a dashboard launch's run when no mission has it). */
export interface SpecActivityEntry {
  shown: SpecActivity
  link: SpecActivity
}

const DECISION_PHASE: Partial<Record<RailPrDecision, SpecActivityPhase>> = {
  building: 'running',
  on_review: 'waiting',
  no_changes: 'waiting',
  pr_draft: 'waiting',
  pr_ready: 'waiting',
  pr_closed: 'waiting',
  implementation_failed: 'failed',
  pr_failed: 'failed',
}

/** The run strip's urgency order: waiting for you › failed › running › paused. */
const PHASE_RANK: Record<SpecActivityPhase, number> = { waiting: 0, failed: 1, running: 2, paused: 3 }

function time(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** True when `a` should be shown over `b` for the same spec. */
function outranks(a: SpecActivity, b: SpecActivity): boolean {
  const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase]
  if (rank !== 0) return rank < 0
  // A rail run is more concrete than the Intent label it came from.
  if (a.railIndex !== null && b.railIndex === null) return true
  if (a.railIndex === null && b.railIndex !== null) return false
  return time(a.updatedAt) > time(b.updatedAt)
}

export interface MissionFacts {
  /** Creation time (ms); null when unknown (falls back to the run's update time). */
  createdAt: number | null
  archived: boolean
}

const UNKNOWN_MISSION: MissionFacts = { createdAt: null, archived: false }

/**
 * @param mission what the mission list knows about a mission: the shortcut
 *   skips archived missions unless only archived ones have the spec.
 */
export function deriveSpecActivity(
  tickets: readonly Pick<LocalTicket, 'id' | 'metadata'>[],
  deliveries: Iterable<RailPrStateSnapshot>,
  mission: (conversationId: string) => MissionFacts = () => UNKNOWN_MISSION,
): Map<number, SpecActivityEntry> {
  const candidates = new Map<number, SpecActivity[]>()
  const offer = (activity: SpecActivity) => {
    const list = candidates.get(activity.ticketId)
    if (list) list.push(activity)
    else candidates.set(activity.ticketId, [activity])
  }

  const intentTickets = new Set<number>()
  for (const ticket of tickets) {
    const flow = ticket.metadata?.flow
    if (!flow || (flow.state !== 'active' && flow.state !== 'paused')) continue
    intentTickets.add(ticket.id)
    offer({
      ticketId: ticket.id,
      kind: 'intent',
      phase: flow.state === 'active' ? 'running' : 'paused',
      conversationId: typeof flow.conversationId === 'string' && flow.conversationId ? flow.conversationId : null,
      railIndex: null,
      prDeliveryId: null,
      runIds: [],
      updatedAt: typeof flow.startedAt === 'string' ? flow.startedAt : null,
    })
  }

  for (const delivery of deliveries) {
    const phase = DECISION_PHASE[delivery.decision]
    if (!phase) continue
    for (const ticketId of delivery.ticketIds) {
      offer({
        ticketId,
        kind: delivery.flowReview || intentTickets.has(ticketId) ? 'intent' : 'implement',
        phase,
        conversationId: delivery.originConversationId ?? null,
        railIndex: delivery.railIndex,
        prDeliveryId: delivery.prDeliveryId,
        runIds: delivery.runIds ?? [],
        updatedAt: delivery.updatedAt ?? delivery.createdAt ?? null,
      })
    }
  }

  const facts = (activity: SpecActivity): MissionFacts =>
    activity.conversationId ? mission(activity.conversationId) : UNKNOWN_MISSION
  const missionTime = (activity: SpecActivity): number => facts(activity).createdAt ?? time(activity.updatedAt)
  const result = new Map<number, SpecActivityEntry>()
  for (const [ticketId, list] of candidates) {
    let shown = list[0]
    for (const activity of list) if (outranks(activity, shown)) shown = activity
    let link: SpecActivity | null = null
    for (const activity of list) {
      if (!activity.conversationId) continue
      if (!link) { link = activity; continue }
      // An active mission always beats an archived one; archived only when nothing else has the spec.
      const archived = facts(activity).archived
      if (archived !== facts(link).archived) {
        if (!archived) link = activity
        continue
      }
      const newer = missionTime(activity) - missionTime(link)
      // Same mission (or same creation time): its most urgent run.
      if (newer > 0 || (newer === 0 && outranks(activity, link))) link = activity
    }
    result.set(ticketId, { shown, link: link ?? shown })
  }
  return result
}
