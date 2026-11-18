// Helpers shared by the rails HTTP registrars (rails-*-http.ts): request
// project context, rail-mode normalization at the HTTP boundary, the
// rail.updated / PR-delivery broadcasts, best-effort ticket-store reads for
// review state and triage recommendations, the engine-support 409 mapping and
// the `:railIndex` guard. Registers no routes.

import type { Request, Response } from 'express'
import type { ProjectContext } from '../../../project-registry'
import { getRail, MAX_RAILS, type RailState } from './rails-store'
import { refreshPrCiOffer } from './pr-ci/pr-ci-projection'
import { resolveProjectExecution } from '../../../workspace-resolution'
import type { LoopGraph } from '../../loops/runtime/loop-graph'
import { getPrDelivery, toPrDecisionCardEnvelope, toPrDeliverySnapshot, toRailPrStateMessage } from './rail-pr-store'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { recommendedLoopForTickets } from '../../specs/domain/triage'
import { readStore, resolveTicketStoragePath } from '../../specs/runtime/ticket-store'
import type { RailUpdatedMessage } from '../../../types'

// Extend Express Request to carry resolved ProjectContext (declared in project-router)
declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: ProjectContext
  }
}

export const VALID_MODES = new Set(['implement', 'loop'])
/** Input aliases of the removed Batch mode. `implement` already runs every rail
 *  ticket in one aggregate run, so stored/agent/mobile `batch-implement` (or
 *  `batch`) requests are normalized to it at the HTTP boundary. */
const REMOVED_BATCH_MODES = new Set(['batch-implement', 'batch'])
/** `freestyle` (and its pre-rename spelling `ultracode`) is a retired rail mode:
 *  Freestyle is a gallery loop now. Both spellings normalize to `freestyle` so
 *  one check can recognize them: a launch answers `builtin_loop_retired`; a
 *  stored rail mode / ticket assignment folds to Implement. */
const RETIRED_FREESTYLE_MODES = new Set(['freestyle', 'ultracode'])
export function normalizeRailMode(mode: unknown): unknown {
  if (typeof mode !== 'string') return mode
  if (REMOVED_BATCH_MODES.has(mode)) return 'implement'
  if (RETIRED_FREESTYLE_MODES.has(mode)) return 'freestyle'
  return mode
}
/** The mode a rail STORES: retired modes fold to Implement. */
export function storedRailMode(mode: unknown): unknown {
  const normalized = normalizeRailMode(mode)
  return normalized === 'freestyle' ? 'implement' : normalized
}

export function emitPrDeliveryUpdate(c: ProjectContext, prDeliveryId: string): void {
  const row = getPrDelivery(c.db, prDeliveryId)
  if (!row) return
  const snap = toPrDeliverySnapshot(row)
  c.broadcast(toRailPrStateMessage(c.project.id, snap))
  if (row.origin_conversation_id) {
    getAgentChatManager()?.updatePrDecisionCard(
      row.origin_conversation_id,
      toPrDecisionCardEnvelope(c.project.id, snap),
    )
  }
  // pr-ci-loop: offer (or refresh) "Watch and fix the PR's CI" in the mission.
  refreshPrCiOffer(c, prDeliveryId)
}

/** Ticket ids currently `on_review` (best-effort: an unreadable store ⇒ none). */
export function onReviewTicketIds(c: ProjectContext): Set<number> {
  try {
    const execution = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
    const store = readStore(execution.relocated ? execution.ticketsPath : resolveTicketStoragePath(c.project.path))
    return new Set(Object.values(store.tickets).filter((t) => t.status === 'on_review').map((t) => t.id))
  } catch {
    return new Set()
  }
}

/** Spec triage (launch-triage): the loop recommended by the first triaged spec
 *  of the rail, in rail order (best-effort: an unreadable store ⇒ null). */
export function recommendedLoopForRail(c: ProjectContext, ticketIds: readonly number[]): string | null {
  try {
    const execution = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
    const store = readStore(execution.relocated ? execution.ticketsPath : resolveTicketStoragePath(c.project.path))
    return recommendedLoopForTickets(ticketIds.map((id) => store.tickets[String(id)]))
  } catch {
    return null
  }
}

/** Map an engine-availability refusal to the launch's 409 body; rethrow others. */
export async function engineSupportRejection(
  manager: ProjectContext['loopRunManager'], graph: LoopGraph, loopId: string,
): Promise<{ error: string; loopId: string; detail: string } | undefined> {
  try { await manager.assertEngineSupport?.(graph) } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = /^(legacy_engine_unavailable|engine_unsupported):/.exec(message)?.[1]
    if (!code) throw error
    return { error: code, loopId, detail: message.slice(code.length + 1).trim() }
  }
  return undefined
}

/** The project context resolved by the project router for this request. */
export function projectContextOf(req: Request): ProjectContext {
  return req.projectCtx!
}

// Broadcast the full post-mutation rail snapshot so every connected client
// (desktop dashboard + mobile companion) reflects non-launch rail changes
// live — ticket reassignments, renames, mode/profile/engine edits. Re-reads
// the canonical rail (getRail) so the snapshot always carries the CURRENT
// name — a mutation return value (e.g. setRailTickets) omits it, which would
// otherwise broadcast name:null and clobber the rail's label on receivers.
export function broadcastRailUpdated(
  c: ProjectContext,
  railIndex: number,
  changed: RailUpdatedMessage['changed'],
): void {
  const rail: RailState = getRail(c.db, railIndex)
  const msg: RailUpdatedMessage = {
    type: 'rail.updated',
    projectId: c.project.id,
    railIndex: rail.railIndex,
    changed,
    ticketIds: rail.ticketIds,
    name: rail.name ?? null,
    mode: rail.mode,
    profileName: rail.profileName ?? null,
    aiEngine: rail.aiEngine ?? null,
  }
  c.broadcast(msg)
}

/** Parse `:railIndex` (0..MAX_RAILS-1); responds 400 `Invalid rail index` and returns null otherwise. */
export function requireRailIndexParam(req: Request, res: Response): number | null {
  const railIndex = parseInt(req.params.railIndex as string, 10)
  if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
    res.status(400).json({ error: 'Invalid rail index' }); return null
  }
  return railIndex
}
