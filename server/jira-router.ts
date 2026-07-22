import { Router, Request, Response } from 'express'
import type { ProjectContext } from './project-registry'
import { getConnectionPublic } from './jira/jira-db'
import { isJiraEnabled } from './feature-flags'
import type { OutboxState, SpecLogicalState } from './jira/types'

// req.projectCtx is declared in project-router / rails-router.

/**
 * Per-project Jira router, mounted at /api/projects/:projectId/jira. Gated by
 * SPECRAILS_JIRA_SECTION; 404s entirely when the flag is off. Endpoints back the
 * step-by-step setup wizard (test → pick project → optional status map → connect)
 * and the sync/outbox management surfaces. The token is never returned to the
 * client (connection responses carry `hasToken` only).
 */
export function createJiraRouter(): Router {
  const router = Router({ mergeParams: true })

  function ctx(req: Request): ProjectContext {
    return req.projectCtx!
  }

  // Feature-flag gate for every route under /jira.
  router.use((_req: Request, res: Response, next) => {
    if (!isJiraEnabled()) {
      res.status(404).json({ error: 'Jira integration disabled' })
      return
    }
    next()
  })

  // ─── Connection ──────────────────────────────────────────────────────────────

  // GET /connection — current connection (token redacted) or { connected: false }.
  router.get('/connection', (req: Request, res: Response) => {
    const c = ctx(req)
    const conn = getConnectionPublic(c.db, c.project.id)
    if (!conn) {
      res.json({ connected: false })
      return
    }
    res.json({ connected: true, connection: conn, outbox: c.jiraSyncManager.outboxCounts() })
  })

  // POST /test — wizard step 1: validate credentials without saving.
  router.post('/test', async (req: Request, res: Response) => {
    const { baseUrl, accountEmail, token } = req.body ?? {}
    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(token)) {
      res.status(400).json({ error: 'baseUrl and token are required' })
      return
    }
    const result = await ctx(req).jiraSyncManager.probeCredentials({
      baseUrl: baseUrl.trim(),
      accountEmail: isNonEmptyString(accountEmail) ? accountEmail.trim() : null,
      token,
    })
    if (!result.ok) {
      res.status(result.status === 401 ? 401 : 400).json({ error: result.error })
      return
    }
    res.json(result)
  })

  // POST /discover-projects — wizard step 2: list visible projects.
  router.post('/discover-projects', async (req: Request, res: Response) => {
    const { baseUrl, accountEmail, token, query } = req.body ?? {}
    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(token)) {
      res.status(400).json({ error: 'baseUrl and token are required' })
      return
    }
    const result = await ctx(req).jiraSyncManager.discoverProjects({
      baseUrl: baseUrl.trim(),
      accountEmail: isNonEmptyString(accountEmail) ? accountEmail.trim() : null,
      token,
      query: isNonEmptyString(query) ? query.trim() : undefined,
    })
    if (!result.ok) {
      res.status(400).json({ error: result.error })
      return
    }
    res.json({ projects: result.projects })
  })

  // POST /discover-statuses — wizard step 3 (optional): the project's statuses.
  router.post('/discover-statuses', async (req: Request, res: Response) => {
    const { baseUrl, accountEmail, token, projectKey } = req.body ?? {}
    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(token) || !isNonEmptyString(projectKey)) {
      res.status(400).json({ error: 'baseUrl, token and projectKey are required' })
      return
    }
    const result = await ctx(req).jiraSyncManager.discoverStatuses({
      baseUrl: baseUrl.trim(),
      accountEmail: isNonEmptyString(accountEmail) ? accountEmail.trim() : null,
      token,
      projectKey: projectKey.trim(),
    })
    if (!result.ok) {
      res.status(400).json({ error: result.error })
      return
    }
    res.json({ statuses: result.statuses })
  })

  // POST /connect — wizard final step: validate + persist + start sync.
  router.post('/connect', async (req: Request, res: Response) => {
    const c = ctx(req)
    const { baseUrl, accountEmail, token, jiraProjectKey, statusMap, discardStatus } = req.body ?? {}
    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(token) || !isNonEmptyString(jiraProjectKey)) {
      res.status(400).json({ error: 'baseUrl, token and jiraProjectKey are required' })
      return
    }
    const cleanMap = sanitizeStatusMap(statusMap)
    const result = await c.jiraSyncManager.connect({
      baseUrl: baseUrl.trim(),
      accountEmail: isNonEmptyString(accountEmail) ? accountEmail.trim() : null,
      token,
      jiraProjectKey: jiraProjectKey.trim(),
      statusMap: cleanMap,
      discardStatus: isNonEmptyString(discardStatus) ? discardStatus.trim() : null,
    })
    if (!result.ok) {
      res.status(result.status === 401 ? 401 : 400).json({ error: result.error })
      return
    }
    res.status(201).json({ connection: getConnectionPublic(c.db, c.project.id) })
  })

  // PATCH /connection — toggle enabled (hot-swap local↔Jira) and/or update the
  // discard "move-to" status. `discardStatus: ''`/null clears it.
  router.patch('/connection', (req: Request, res: Response) => {
    const c = ctx(req)
    const existing = getConnectionPublic(c.db, c.project.id)
    if (!existing) {
      res.status(404).json({ error: 'No Jira connection configured' })
      return
    }
    const { enabled, discardStatus, statusMap } = req.body ?? {}
    if (typeof enabled === 'boolean') {
      c.jiraSyncManager.setEnabled(enabled)
    }
    if (discardStatus !== undefined) {
      c.jiraSyncManager.setDiscardStatus(isNonEmptyString(discardStatus) ? discardStatus.trim() : null)
    }
    if (statusMap !== undefined) {
      c.jiraSyncManager.setStatusMap(sanitizeStatusMap(statusMap))
    }
    res.json({ connection: getConnectionPublic(c.db, c.project.id) })
  })

  // GET /statuses — the connected project's real statuses (post-connect picker
  // for the discard "move-to" status). Uses the stored credentials.
  router.get('/statuses', async (req: Request, res: Response) => {
    const result = await ctx(req).jiraSyncManager.listStatusesForConnection()
    if (!result.ok) {
      res.status(400).json({ error: result.error })
      return
    }
    res.json({ statuses: result.statuses })
  })

  // DELETE /connection — remove the connection + restore local backlog config.
  router.delete('/connection', (req: Request, res: Response) => {
    const c = ctx(req)
    c.jiraSyncManager.disconnect()
    res.json({ connected: false })
  })

  // POST /resume — re-paste of a fresh token after a 401: drain the parked outbox.
  router.post('/resume', (req: Request, res: Response) => {
    ctx(req).jiraSyncManager.resumeAfterReauth()
    res.json({ ok: true })
  })

  // ─── Sync + outbox management ───────────────────────────────────────────────

  // POST /sync — manual "Sync now": a FULL re-fetch (ignores the high-water) so
  // it back-fills any data the cache is missing (e.g. sprint/epic fields).
  router.post('/sync', async (req: Request, res: Response) => {
    const result = await ctx(req).jiraSyncManager.pollOnce(true)
    res.json({ ok: true, upserted: result?.upserted ?? 0 })
  })

  // GET /outbox?state= — list outbox ops (defaults to all).
  router.get('/outbox', (req: Request, res: Response) => {
    const c = ctx(req)
    const state = req.query.state as string | undefined
    const valid: OutboxState[] = ['pending', 'inflight', 'done', 'dead']
    const filter = valid.includes(state as OutboxState) ? (state as OutboxState) : undefined
    res.json({ ops: c.jiraSyncManager.listOutbox(filter), counts: c.jiraSyncManager.outboxCounts() })
  })

  // POST /outbox/:id/retry — re-queue a dead-lettered op for a manual retry.
  router.post('/outbox/:id/retry', async (req: Request, res: Response) => {
    const c = ctx(req)
    const id = parseInt(req.params.id as string, 10)
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid op id' })
      return
    }
    const { retryDeadOutbox } = await import('./jira/jira-db')
    const ok = retryDeadOutbox(c.db, id)
    if (!ok) {
      res.status(404).json({ error: 'Op not found or not in dead state' })
      return
    }
    void c.jiraSyncManager.drainOnce().catch(() => undefined)
    res.json({ ok: true })
  })

  // POST /specs — Add Spec when the project source is Jira: create the issue in
  // Jira and materialize it locally. Keeps the generic local ticket-create path
  // untouched.
  router.post('/specs', async (req: Request, res: Response) => {
    const c = ctx(req)
    const { title, description, labels, priority, issueType } = req.body ?? {}
    if (!isNonEmptyString(title)) {
      res.status(400).json({ error: 'title is required' })
      return
    }
    const result = await c.jiraSyncManager.createSpec({
      title: title.trim(),
      description: isNonEmptyString(description) ? description : undefined,
      labels: Array.isArray(labels) ? labels.filter((l) => typeof l === 'string') : undefined,
      priority: isNonEmptyString(priority) ? priority : undefined,
      issueType: isNonEmptyString(issueType) ? issueType : undefined,
    })
    if (!result.ok) {
      res.status(result.status === 401 ? 401 : 400).json({ error: result.error })
      return
    }
    res.status(201).json({ localId: result.localId, jiraKey: result.jiraKey })
  })

  // POST /specs/:localId/move-to-status — manual transition to a NAMED raw Jira
  // status from the spec detail's status selector. Body: { status: string }.
  router.post('/specs/:localId/move-to-status', (req: Request, res: Response) => {
    const c = ctx(req)
    const localId = parseInt(req.params.localId as string, 10)
    if (Number.isNaN(localId)) {
      res.status(400).json({ error: 'Invalid spec id' })
      return
    }
    const status = req.body?.status
    if (!isNonEmptyString(status)) {
      res.status(400).json({ error: 'status is required' })
      return
    }
    const result = c.jiraSyncManager.moveSpecToStatus(localId, status.trim())
    if (!result.ok) {
      res.status(result.reason === 'no-link' ? 404 : 409).json({ error: result.reason })
      return
    }
    res.status(202).json({ ok: true })
  })

  // POST /specs/:localId/discard — "Move to <discard status>": transition the
  // linked issue to the configured discard status (+ optional reason comment)
  // instead of a destructive delete. Body: { comment?: string }.
  router.post('/specs/:localId/discard', (req: Request, res: Response) => {
    const c = ctx(req)
    const localId = parseInt(req.params.localId as string, 10)
    if (Number.isNaN(localId)) {
      res.status(400).json({ error: 'Invalid spec id' })
      return
    }
    const comment = isNonEmptyString(req.body?.comment) ? req.body.comment : null
    const result = c.jiraSyncManager.discardSpec(localId, comment)
    if (!result.ok) {
      const status = result.reason === 'no-link' ? 404 : 409
      res.status(status).json({ error: result.reason })
      return
    }
    res.status(202).json({ ok: true })
  })

  // GET /specs/:localId/details — read-only "Jira details" + "Development" payload
  // for the spec detail modal. Resilient: dev-status failures still return fields.
  router.get('/specs/:localId/details', async (req: Request, res: Response) => {
    const c = ctx(req)
    const localId = parseInt(req.params.localId as string, 10)
    if (Number.isNaN(localId)) {
      res.status(400).json({ error: 'Invalid spec id' })
      return
    }
    const result = await c.jiraSyncManager.getSpecDetails(localId)
    if (!result.ok) {
      const status = result.reason === 'no-link' ? 404 : result.reason === 'not-active' ? 409 : (result.status ?? 502)
      res.status(status).json({ error: result.reason })
      return
    }
    res.json(result.details)
  })

  // GET /links — the spec↔issue map (for the badge / diagnostics).
  router.get('/links', (req: Request, res: Response) => {
    res.json({ links: ctx(req).jiraSyncManager.listLinks() })
  })

  return router
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function sanitizeStatusMap(raw: unknown): Partial<Record<SpecLogicalState, string>> | null {
  if (!raw || typeof raw !== 'object') return null
  const states: SpecLogicalState[] = ['todo', 'in_progress', 'on_review', 'done', 'cancelled']
  const out: Partial<Record<SpecLogicalState, string>> = {}
  for (const s of states) {
    const v = (raw as Record<string, unknown>)[s]
    if (typeof v === 'string' && v.trim()) out[s] = v.trim()
  }
  return Object.keys(out).length > 0 ? out : null
}
