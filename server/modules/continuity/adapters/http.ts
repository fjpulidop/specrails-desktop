import type { Router } from 'express'
import type { TurnContinuity } from '../application'

export interface ActiveWork {
  /** Mission turns in flight (including Core sessions with live sub-agents). */
  missions: number
  /** Rail jobs and loop runs running across every project. */
  runs: number
}

export interface ContinuityRouteDeps {
  continuity: TurnContinuity
  activeWork: () => ActiveWork
  /** When this server process started (ISO): the client lists runs paused by THIS restart. */
  bootedAt: string
  /** Title of a mission for the dialog (null when unknown). */
  missionTitle: (conversationId: string) => string | null
}

const MAX_IDS = 200

function ids(body: unknown): string[] | null {
  const value = (body as { conversationIds?: unknown } | null)?.conversationIds
  if (!Array.isArray(value) || value.length > MAX_IDS) return null
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
}

/**
 * App-level continuity routes (mounted under /api):
 *   GET  /continuity/resume-offers           interrupted mission turns, runs + bootedAt
 *   POST /continuity/resume-offers/settle    { conversationIds, runs? } resumed or dismissed by the person
 *   POST /continuity/shutdown-intent         { trigger: 'update' } right before an update restart
 *   GET  /continuity/active-work             what an update restart would interrupt now
 */
export function registerContinuityRoutes(router: Router, deps: ContinuityRouteDeps): void {
  router.get('/continuity/resume-offers', (_req, res) => {
    const offers = deps.continuity.offers().map((offer) => ({ ...offer, title: deps.missionTitle(offer.conversationId) }))
    res.json({ offers, runs: deps.continuity.interruptedRuns(), bootedAt: deps.bootedAt })
  })
  router.post('/continuity/resume-offers/settle', (req, res) => {
    const list = ids(req.body)
    if (!list) { res.status(400).json({ error: 'conversationIds must be an array of ids' }); return }
    if ((req.body as { runs?: unknown }).runs === true) deps.continuity.clearInterruptedRuns()
    res.json({ settled: deps.continuity.settleOffers(list) })
  })
  router.post('/continuity/shutdown-intent', (req, res) => {
    if ((req.body as { trigger?: unknown } | null)?.trigger !== 'update') { res.status(400).json({ error: "trigger must be 'update'" }); return }
    deps.continuity.noteUpdateRestart()
    res.json({ ok: true })
  })
  router.get('/continuity/active-work', (_req, res) => {
    const work = deps.activeWork()
    res.json({ ...work, total: work.missions + work.runs })
  })
}
