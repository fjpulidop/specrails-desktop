import { Router, type Request, type Response } from 'express'
import type { DbInstance } from '../db'
import { isTierEnabled, type McpTier } from '../mcp/mcp-tiers'
import type { InboxItem } from '../modules/inbox'
import { getAllowedProjects } from './mobile-devices'
import type { MobileAuthedRequest } from './mobile-auth'
import type { MobileUpstream } from './mobile-missions'
import { redact } from './mobile-redact'

/**
 * The paired companion as a decision remote for the "Needs you" inbox.
 *
 * Read: `GET /v1/inbox` is the desktop read-model, narrowed to the device's
 * project grant, with the SAFE actions each row offers right now.
 *
 * Act: a closed set of four actions, each forwarded to the very route the
 * desktop UI uses, addressed to ONE project and tier-checked with the MCP
 * permission tiers (so turning a tier off in Settings ▸ MCP also turns the
 * action off on the phone). Everything else (merge, discard, force-push,
 * settings, delete) has no route here and the catch-all refuses it.
 */

/** Actions a companion may run. Anything else is desktop-only. */
export const COMPANION_ACTIONS = ['answer', 'resume', 'retry', 'create-pr'] as const
export type CompanionActionId = (typeof COMPANION_ACTIONS)[number]

/**
 * Tier per action. Answering only continues work the person already started
 * (write); resume and retry spend tokens (ai-spawn); a draft PR pushes a branch
 * to the remote, an external-system mutation (destructive, as in the MCP tiers).
 */
export const COMPANION_ACTION_TIERS: Record<CompanionActionId, McpTier> = {
  answer: 'write',
  resume: 'ai-spawn',
  retry: 'ai-spawn',
  'create-pr': 'destructive',
}

export interface CompanionActionView { id: CompanionActionId; tier: McpTier; enabled: boolean }

export interface CompanionItemView {
  actions: CompanionActionView[]
  /** Run addressed by `answer` / `resume`. */
  runId?: string
  /** Delivery id, or `run:<id>`, addressed by `retry`. */
  sourceId?: string
  railIndex?: number
  /** Concurrency token `create-pr` must echo back. */
  expectedDecision?: string
}

const NOT_PRIMARY: ReadonlySet<string> = new Set(['open-logs', 'edit-spec'])

/** The first remedy a phone can act on, mirroring the desktop's ranking (open-logs / edit-spec need the desk). */
function primaryRemedy(item: InboxItem): string | null {
  const remedies = item.diagnosis?.remedies ?? []
  return remedies.find((remedy) => !NOT_PRIMARY.has(remedy)) ?? null
}

/** Which safe actions an item offers, and the identities the phone posts back. Pure. */
export function companionTargetsFor(item: InboxItem): { ids: CompanionActionId[]; target: Omit<CompanionItemView, 'actions'> } {
  const none = { ids: [] as CompanionActionId[], target: {} }
  if (item.action === 'raise-cap' || item.action === 'retry-jira') return none
  if (item.kind === 'question') return { ids: ['answer'], target: { runId: item.subjectId } }
  if (item.action === 'resume-run') return { ids: ['resume'], target: { runId: item.subjectId } }
  if (item.kind === 'review') {
    return item.decision === 'on_review'
      ? { ids: ['create-pr'], target: { expectedDecision: 'on_review' } }
      : none
  }
  if (item.kind === 'failed' || item.kind === 'blocked') {
    const primary = primaryRemedy(item)
    const isRun = item.action === 'open-run'
    if (primary === 'resume' && isRun) return { ids: ['resume'], target: { runId: item.subjectId } }
    if (primary === 'retry' && typeof item.railIndex === 'number') {
      return { ids: ['retry'], target: { sourceId: isRun ? `run:${item.subjectId}` : item.subjectId, railIndex: item.railIndex } }
    }
  }
  return none
}

export function companionView(db: DbInstance, item: InboxItem): CompanionItemView {
  const { ids, target } = companionTargetsFor(item)
  return {
    actions: ids.map((id) => ({ id, tier: COMPANION_ACTION_TIERS[id], enabled: isTierEnabled(db, COMPANION_ACTION_TIERS[id]) })),
    ...target,
  }
}

const PID = /^[A-Za-z0-9_-]{1,64}$/
const RUN_ID = /^[A-Za-z0-9-]{1,128}$/
const SOURCE_ID = /^(?:run:)?[A-Za-z0-9-]{1,128}$/
const MAX_ANSWER = 20_000
const MAX_RUN_CAP_USD = 10_000
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const pick = (value: unknown, keys: string[]) => Object.fromEntries(Object.entries(record(value)).filter(([key]) => keys.includes(key)))

export function createMobileInboxRouter({ db, upstream }: { db: DbInstance; upstream: MobileUpstream }): Router {
  const router = Router()
  const seg = (value: unknown): string => (typeof value === 'string' ? value : '')

  const send = async (res: Response, method: string, path: string, body?: unknown, shape?: (json: unknown) => unknown) => {
    try {
      const result = await upstream(method, path, body)
      const ok = result.status >= 200 && result.status < 300
      res.status(result.status).json(redact(ok && shape ? shape(result.json) : result.json))
    } catch {
      res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' })
    }
  }

  /** 403 unless the action's permission tier is on. */
  const tierGate = (res: Response, action: CompanionActionId): boolean => {
    const tier = COMPANION_ACTION_TIERS[action]
    if (isTierEnabled(db, tier)) return true
    res.status(403).json({ error: 'tier_disabled', tier, action })
    return false
  }

  const base = (pid: string): string => `/api/projects/${encodeURIComponent(pid)}`

  router.get('/inbox', async (req: Request, res: Response) => {
    const allowed = getAllowedProjects(db, (req as MobileAuthedRequest).mobileDevice!.id)
    try {
      const result = await upstream('GET', '/api/inbox')
      if (result.status !== 200) { res.status(result.status).json(redact(result.json)); return }
      const snapshot = record(result.json)
      const visible = (projectId: unknown): boolean => typeof projectId === 'string' && (allowed === null || allowed.has(projectId))
      const items = (Array.isArray(snapshot.items) ? snapshot.items : [])
        .filter((item) => visible(record(item).projectId))
        .map((item) => ({ ...(item as InboxItem), companion: companionView(db, item as InboxItem) }))
      const projects = (Array.isArray(snapshot.projects) ? snapshot.projects : []).filter((p) => visible(record(p).projectId))
      res.json(redact({ items, projects, generatedAt: snapshot.generatedAt }))
    } catch {
      res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' })
    }
  })

  // The question a paused run is waiting on (the Answer sheet shows it verbatim).
  router.get('/projects/:pid/inbox/runs/:runId/question', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), runId = seg(req.params.runId)
    if (!PID.test(pid) || !RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    await send(res, 'GET', `${base(pid)}/agent-runtime/runs/${encodeURIComponent(runId)}`, undefined, (json) => {
      const run = record((Array.isArray(record(json).runs) ? record(json).runs as unknown[] : [])[0])
      const question = record(run.pendingQuestion)
      return typeof question.question === 'string'
        ? { pending: true, question: question.question, requestedAt: question.requestedAt ?? null }
        : { pending: false }
    })
  })

  // Answer agent question: the desktop's run "Answer" (runtime resume with an answer).
  router.post('/projects/:pid/inbox/answer', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), runId = seg(body.runId), answer = body.answer
    if (!PID.test(pid) || !RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (typeof answer !== 'string' || !answer.trim() || answer.length > MAX_ANSWER) { res.status(400).json({ error: `An answer of 1–${MAX_ANSWER} characters is required` }); return }
    if (!tierGate(res, 'answer')) return
    let run: Record<string, unknown>
    try {
      const status = await upstream('GET', `${base(pid)}/agent-runtime/runs/${encodeURIComponent(runId)}`)
      if (status.status !== 200) { res.status(status.status).json(redact(status.json)); return }
      run = record((Array.isArray(record(status.json).runs) ? record(status.json).runs as unknown[] : [])[0])
    } catch { res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' }); return }
    const question = record(run.pendingQuestion)
    if (typeof question.question !== 'string' || question.answeredAt !== undefined) { res.status(409).json({ error: 'no_pending_question' }); return }
    const definition = run.engineVersion === 2
    const path = definition
      ? `${base(pid)}/loop-runs/${encodeURIComponent(runId)}/resume`
      : `${base(pid)}/agent-runtime/runs/${encodeURIComponent(runId)}/resume`
    await send(res, 'POST', path, { answer: answer.trim(), ...(definition && typeof question.stepId === 'string' ? { interruptId: question.stepId } : {}) })
  })

  // Resume a budget/limit-paused or interrupted run; a run paused at its per-run cap takes the person's choice.
  router.post('/projects/:pid/inbox/resume', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), runId = seg(body.runId)
    if (!PID.test(pid) || !RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    const narrowed: Record<string, unknown> = {}
    if (body.runCap !== undefined) {
      if (body.runCap !== 'ignore') { res.status(400).json({ error: 'runCap must be "ignore"' }); return }
      narrowed.runCap = 'ignore'
    }
    if (body.runCapUsd !== undefined) {
      if (typeof body.runCapUsd !== 'number' || !Number.isFinite(body.runCapUsd) || body.runCapUsd <= 0 || body.runCapUsd > MAX_RUN_CAP_USD) { res.status(400).json({ error: 'runCapUsd must be a positive amount' }); return }
      if (narrowed.runCap) { res.status(400).json({ error: 'Choose ignore or raise, not both' }); return }
      narrowed.runCapUsd = body.runCapUsd
    }
    if (!tierGate(res, 'resume')) return
    await send(res, 'POST', `${base(pid)}/loop-runs/${encodeURIComponent(runId)}/resume`, narrowed)
  })

  // Retry the failed attempt: the cockpit's relaunch of the same rail, same source.
  router.post('/projects/:pid/inbox/retry', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), sourceId = seg(body.sourceId), railIndex = body.railIndex
    if (!PID.test(pid) || !SOURCE_ID.test(sourceId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (typeof railIndex !== 'number' || !Number.isSafeInteger(railIndex) || railIndex < 0 || railIndex > 1000) { res.status(400).json({ error: 'Invalid rail' }); return }
    if (!tierGate(res, 'retry')) return
    await send(res, 'POST', `${base(pid)}/rails/${railIndex}/relaunch`, { sourceId })
  })

  // Create draft PR: the PR decision, narrowed to create-pr on a delivery that is still on review.
  router.post('/projects/:pid/inbox/create-pr', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), prDeliveryId = seg(body.prDeliveryId)
    if (!PID.test(pid) || !RUN_ID.test(prDeliveryId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (body.expectedDecision !== 'on_review') { res.status(400).json({ error: 'expectedDecision must be on_review' }); return }
    if (!tierGate(res, 'create-pr')) return
    await send(res, 'POST', `${base(pid)}/rails/pr-decision`,
      { prDeliveryId, action: 'create-pr', expectedDecision: 'on_review' },
      (json) => pick(json, ['ok', 'decision', 'prUrl', 'prState', 'detail']))
  })

  // Deny by name, not by silence: merge, discard, publish, force-push, settings, delete.
  router.all('/projects/:pid/inbox/:action', (_req: Request, res: Response) => {
    res.status(403).json({ error: 'action_not_allowed_for_companion', detail: 'This decision stays on Desktop.' })
  })

  return router
}
