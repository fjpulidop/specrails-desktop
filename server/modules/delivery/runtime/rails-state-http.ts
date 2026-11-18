// Rail slot lifecycle and read routes: the rails list with active job/loop
// state, creating a slot (lowest free index, capped at MAX_RAILS), deleting a
// slot with its ticket assignments in one transaction, and the display-only
// open-PR candidates for the "deliver into existing PR" affordance.

import { PageCursorError, pageOf, parsePageQuery } from '../../../util/page-cursor'
import type { Router, Request, Response } from 'express'
import { getRails, getRail, createRail, deleteRail, railCount, railExists, MAX_RAILS, type RailState } from './rails-store'
import { getLoopRun, getRunEventCounts, listActiveLoopRuns } from '../../loops/runtime/loop-runs-store'
import { getActivePrDeliveryByRail, listActivePrDeliveries, toPrDeliverySnapshot, type PrDeliverySnapshot } from './rail-pr-store'
import { listPrCandidatesForTickets } from './active-pr-continuation'
import { defaultExec } from './pr-publisher'
import type { RailRemovedMessage } from '../../../types'
import { projectContextOf, broadcastRailUpdated, requireRailIndexParam, onReviewTicketIds } from './rails-http-shared'

export function registerRailStateRoutes(router: Router): void {
  const ctx = projectContextOf

  // GET /rails — list all rail assignments + active job info
  router.get('/', (_req: Request, res: Response) => {
    const c = ctx(_req)
    try {
      const rails = getRails(c.db)
      // Include which rails have active jobs (so clients can reconcile stale 'running' state)
      const activeJobs: Record<number, { jobId: string; mode: string }> = {}
      for (const [jobId, meta] of c.railJobs.entries()) {
        activeJobs[meta.railIndex] = { jobId, mode: meta.mode }
      }
      // Active loop runs (Loops mode) so clients can reconcile a 'running' rail
      // that's executing a loop rather than a queue job. Enriched from the
      // loop_runs row with the loop identity + resolved provider/model so a
      // mirror (e.g. the mobile companion) can label the run instead of showing a
      // stale `mode`/null engine — these never land on the rail row itself.
      const activeLoopRuns: Record<number, {
        loopRunId: string; loopId?: string; loopName?: string | null; provider?: string | null; model?: string | null; iteration?: number
        startedAt?: string; steps?: number; lines?: number
      }> = {}
      for (const [runId, meta] of c.railLoopRuns.entries()) {
        const run = getLoopRun(c.db, runId)
        // Seed counts so the dashboard's live metrics survive a page refresh.
        const counts = getRunEventCounts(c.db, runId)
        activeLoopRuns[meta.railIndex] = run
          ? { loopRunId: runId, loopId: run.loop_id, loopName: run.loop_name, provider: run.provider, model: run.model, iteration: run.iteration_count, startedAt: run.started_at, steps: counts.steps, lines: counts.lines }
          : { loopRunId: runId, steps: counts.steps, lines: counts.lines }
      }
      // Also surface DB 'running' runs not tracked in-memory (the rail map is
      // cleared on every server restart) — DB is the authoritative source, so the
      // dashboard metrics survive both a page refresh AND a server restart.
      for (const run of listActiveLoopRuns(c.db, c.project.id)) {
        if (run.rail_index == null || activeLoopRuns[run.rail_index]) continue
        const counts = getRunEventCounts(c.db, run.id)
        activeLoopRuns[run.rail_index] = { loopRunId: run.id, loopId: run.loop_id, loopName: run.loop_name, provider: run.provider, model: run.model, iteration: run.iteration_count, startedAt: run.started_at, steps: counts.steps, lines: counts.lines }
      }
      // Pending ask-first PR decisions (safe-pr-review-flow): the newest ACTIVE
      // (non-terminal) delivery per rail slot, so a refreshed client re-renders
      // the decision surface without waiting for a broadcast. The store lists
      // newest-first within each rail — keep the first per index.
      const prDeliveries: Record<number, PrDeliverySnapshot> = {}
      for (const row of listActivePrDeliveries(c.db)) {
        if (!(row.rail_index in prDeliveries)) prDeliveries[row.rail_index] = toPrDeliverySnapshot(row)
      }
      // mission-rail-cards: per-rail availability so an agent proposal (or the
      // launch card) can target a usable rail without re-deriving the rules.
      const onReviewIds = onReviewTicketIds(c)
      const railsWithAvailability = rails.map((rail) => ({
        ...rail,
        availability: rail.railIndex in activeJobs || rail.railIndex in activeLoopRuns
          ? 'busy' as const
          : rail.railIndex in prDeliveries
            ? 'pending_decision' as const
            : rail.ticketIds.some((id) => onReviewIds.has(id))
              ? 'on_review' as const
              : 'free' as const,
      }))
      // review-wip-limit: the project's limit and the deliveries counting
      // against it (absent in bare contexts without the gate).
      const wip = c.reviewWipGate?.status()
      const reviewWip = wip ? { limit: wip.limit, pending: wip.pending, reached: wip.limit !== null && wip.pending.length + wip.reserved >= wip.limit } : undefined
      // Optional paging (limit + cursor/offset): the per-rail maps keep only the page's rails.
      const page = parsePageQuery(_req.query as Record<string, unknown>, { max: 100 })
      if (page) {
        const { items, ...paging } = pageOf(railsWithAvailability, page)
        const indexes = new Set(items.map((rail) => rail.railIndex))
        const only = <T>(map: Record<number, T>) => Object.fromEntries(Object.entries(map).filter(([index]) => indexes.has(Number(index)))) as Record<number, T>
        res.json({ rails: items, activeJobs: only(activeJobs), activeLoopRuns: only(activeLoopRuns), prDeliveries: only(prDeliveries), ...(reviewWip ? { reviewWip } : {}), total: railsWithAvailability.length, ...paging })
        return
      }
      res.json({ rails: railsWithAvailability, activeJobs, activeLoopRuns, prDeliveries, ...(reviewWip ? { reviewWip } : {}) })
    } catch (err) {
      if (err instanceof PageCursorError) { res.status(err.status).json({ error: err.code, message: err.message }); return }
      console.error('[rails-router] get rails error:', err)
      res.status(500).json({ error: 'Failed to fetch rails' })
    }
  })

  // POST /rails — create a new rail slot (dynamic rails). Body: { name? }.
  // Allocates the lowest free index; capped at MAX_RAILS per project so the
  // railIndex-keyed maps (metrics, PR deliveries, worktree progress) stay
  // bounded. Broadcast rides the existing rail.updated shape (changed:'name')
  // so every client — including the mobile companion — adopts the new slot
  // without a new wire message.
  router.post('/', (req: Request, res: Response) => {
    const c = ctx(req)
    const body = req.body ?? {}
    const name = body.name
    if (name !== undefined && name !== null && typeof name !== 'string') {
      res.status(400).json({ error: 'name must be a string or null' }); return
    }
    if (typeof name === 'string' && name.length > 60) {
      res.status(400).json({ error: 'name must be 60 characters or fewer' }); return
    }
    try {
      if (railCount(c.db) >= MAX_RAILS) {
        res.status(400).json({ error: 'rail_limit_reached', maxRails: MAX_RAILS }); return
      }
      const rail = createRail(c.db, typeof name === 'string' ? name : null)
      broadcastRailUpdated(c, rail.railIndex, 'name')
      res.status(201).json({ rail })
    } catch (err) {
      console.error('[rails-router] create rail error:', err)
      res.status(500).json({ error: 'Failed to create rail' })
    }
  })

  // DELETE /rails/:railIndex — remove a rail slot and release its ticket
  // assignments as one transaction. All rejection guards run before the
  // delete, so a failed last/active/pending-PR deletion cannot strand tickets
  // in an unassigned intermediate state. Indices are identity — deleting a
  // middle rail leaves a gap (never re-numbered).
  router.delete('/:railIndex', (req: Request, res: Response) => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return
    const c = ctx(req)
    try {
      if (!railExists(c.db, railIndex)) {
        res.status(404).json({ error: 'Rail not found' }); return
      }
      if (railCount(c.db) <= 1) {
        res.status(400).json({ error: 'cannot_delete_last_rail' }); return
      }
      const hasActiveJob = Array.from(c.railJobs.values()).some((m) => m.railIndex === railIndex)
      const hasActiveRun = Array.from(c.railLoopRuns.values()).some((m) => m.railIndex === railIndex)
      if (hasActiveJob || hasActiveRun) {
        res.status(409).json({ error: 'rail_active' }); return
      }
      const pending = getActivePrDeliveryByRail(c.db, railIndex)
      if (pending) {
        res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pending.id }); return
      }
      deleteRail(c.db, railIndex)
      const msg: RailRemovedMessage = { type: 'rail.removed', projectId: c.project.id, railIndex }
      c.broadcast(msg)
      res.json({ ok: true, railIndex })
    } catch (err) {
      console.error('[rails-router] delete rail error:', err)
      res.status(500).json({ error: 'Failed to delete rail' })
    }
  })

  // GET /rails/:railIndex/pr-candidates — display-only open-PR suggestions for
  // the "deliver into existing PR" launch affordance. Reuses the automatic-
  // continuation matchers WITHOUT the ticket-status gate: suggestions are
  // informational, selection is always an explicit user action. No side effects.
  router.get('/:railIndex/pr-candidates', async (req: Request, res: Response) => {
    const c = ctx(req)
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return
    try {
      const rail: RailState = getRail(c.db, railIndex)
      const candidates = await listPrCandidatesForTickets({
        db: c.db,
        exec: defaultExec,
        repoDir: c.project.path,
        ticketIds: [...(rail?.ticketIds ?? [])],
        getTicketSpec: (ticketId) => {
          try { return c.getTicketSpec(ticketId) ?? undefined } catch { return undefined }
        },
      })
      res.json({ candidates })
    } catch (err) {
      console.error('[rails-router] pr-candidates error:', err)
      res.status(500).json({ error: 'Failed to list PR candidates' })
    }
  })
}
