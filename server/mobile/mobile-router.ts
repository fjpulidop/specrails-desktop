import { Router } from 'express'
import type { Request, Response } from 'express'
import { loadOrGenerateToken } from '../auth'
import { redact } from './mobile-redact'
import { createMobileAuthMiddleware, type MobileAuthedRequest } from './mobile-auth'
import { getAllowedProjects, isProjectAllowed } from './mobile-devices'
import type { DbInstance } from '../db'

// The gateway's authenticated REST surface: the `/v1/*` allow-list. Each route
// forwards, in-process, via a REAL loopback HTTP request to
// http://127.0.0.1:<desktopPort> with the master token injected server-side as
// `x-desktop-token` (it never leaves the box).
//
// Forwarding is PARAMETERISED: the internal path is rebuilt from Express route
// params (each a single URL segment — `..`/`/` can't appear), never from the raw
// request URL, so there is no path-traversal or SPA-catch-all bypass. Responses
// are deep-redacted before reaching the phone.

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/
const NUM_RE = /^\d{1,9}$/
const JOBID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CONV_ID_RE = /^[A-Za-z0-9-]{1,64}$/

export interface MobileRouterDeps {
  db: DbInstance
  desktopPort: number
  currentFingerprint: () => string
}

export function createMobileRouter(deps: MobileRouterDeps): Router {
  const router = Router()
  const internalBase = `http://127.0.0.1:${deps.desktopPort}`
  // Express 5 types a route param as `string | string[]`; coerce to a single
  // segment (an array — which path-to-regexp never produces here — collapses to
  // '' and fails the validators below).
  const seg = (v: unknown): string => (typeof v === 'string' ? v : '')

  // ─── Authenticated allow-list (/v1) ─────────────────────────────────────────
  const v1 = Router()
  v1.use(createMobileAuthMiddleware({ db: deps.db, currentFingerprint: deps.currentFingerprint }))

  // BUG-MOBILE-02: per-device project ACL. After auth resolves `req.mobileDevice`,
  // any `:pid`-scoped route is gated against the device's granted project set.
  // An unrestricted device (null grant ⇒ all projects, legacy default) passes
  // through; a scoped device gets 403 for any project it wasn't granted. The
  // bare `GET /v1/projects` list has no `:pid` and is unaffected.
  v1.use('/projects/:pid', (req, res, next) => {
    const pid = seg(req.params.pid)
    if (!PID_RE.test(pid)) {
      res.status(400).json({ error: 'Invalid parameter' })
      return
    }
    const device = (req as MobileAuthedRequest).mobileDevice
    if (!device) {
      // Auth middleware should have set this; defensive 401.
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const allowed = getAllowedProjects(deps.db, device.id)
    if (!isProjectAllowed(allowed, pid)) {
      res.status(403).json({ error: 'Forbidden: project not allowed' })
      return
    }
    next()
  })

  /** Forward to the internal desktop API with the master token injected; redact
   *  the JSON response. `internalPath` is built from validated params only. */
  async function forward(
    res: Response,
    method: string,
    internalPath: string,
    query: string,
    body?: unknown,
  ): Promise<void> {
    const url = internalBase + internalPath + (query ? `?${query}` : '')
    try {
      const init: RequestInit = {
        method,
        headers: {
          'x-desktop-token': loadOrGenerateToken(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }
      const upstream = await fetch(url, init)
      const text = await upstream.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        // Non-JSON upstream (should not happen on the allow-listed API) — never
        // forward raw bytes; collapse to a status echo.
        res.status(502).json({ error: 'Bad upstream response' })
        return
      }
      res.status(upstream.status).json(redact(json))
    } catch {
      res.status(502).json({ error: 'Server unreachable' })
    }
  }

  function rawQuery(req: Request): string {
    const i = req.originalUrl.indexOf('?')
    return i >= 0 ? req.originalUrl.slice(i + 1) : ''
  }

  /** 400 unless every (value, regex) pair matches. Guards param injection. */
  function validate(res: Response, ...pairs: Array<[string, RegExp]>): boolean {
    for (const [value, re] of pairs) {
      if (!re.test(value)) {
        res.status(400).json({ error: 'Invalid parameter' })
        return false
      }
    }
    return true
  }

  // —— Reads ——
  v1.get('/projects', (req, res) => {
    // Exact GET /api/projects is served by the desktop router (mounted at /api).
    void forward(res, 'GET', '/api/projects', '')
  })

  const projectReads: Array<[string, string]> = [
    ['/projects/:pid/tickets', '/tickets'],
    ['/projects/:pid/jobs', '/jobs'],
    ['/projects/:pid/queue', '/queue'],
    ['/projects/:pid/rails', '/rails'],
    ['/projects/:pid/activity', '/activity'],
    ['/projects/:pid/stats', '/stats'],
    ['/projects/:pid/state', '/state'],
    ['/projects/:pid/spending', '/spending'],
  ]
  for (const [gw, internal] of projectReads) {
    v1.get(gw, (req, res) => {
      const pid = seg(req.params.pid)
      if (!validate(res, [pid, PID_RE])) return
      void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}${internal}`, rawQuery(req))
    })
  }

  v1.get('/projects/:pid/tickets/:tid', (req, res) => {
    const pid = seg(req.params.pid), tid = seg(req.params.tid)
    if (!validate(res, [pid, PID_RE], [tid, NUM_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/tickets/${encodeURIComponent(tid)}`, '')
  })

  v1.get('/projects/:pid/jobs/:jid', (req, res) => {
    const pid = seg(req.params.pid), jid = seg(req.params.jid)
    if (!validate(res, [pid, PID_RE], [jid, JOBID_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/jobs/${encodeURIComponent(jid)}`, '')
  })

  // rails-as-loops reads: the global Loop catalog (for the mobile loop picker)
  // and per-project loop-run state (the running surface — a loop run has no jobId
  // so it can't be tailed via /jobs/:id). 404s downstream when Loops are disabled.
  v1.get('/loops', (_req, res) => { void forward(res, 'GET', '/api/loops', '') })
  v1.get('/loops/factory', (_req, res) => { void forward(res, 'GET', '/api/loops/factory', '') })
  v1.get('/projects/:pid/loop-runs/:id', (req, res) => {
    const pid = seg(req.params.pid), rid = seg(req.params.id)
    if (!validate(res, [pid, PID_RE], [rid, JOBID_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/loop-runs/${encodeURIComponent(rid)}`, '')
  })

  v1.get('/projects/:pid/tickets/:tid/spending-summary', (req, res) => {
    const pid = seg(req.params.pid), tid = seg(req.params.tid)
    if (!validate(res, [pid, PID_RE], [tid, NUM_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/tickets/${encodeURIComponent(tid)}/spending-summary`, '')
  })

  // —— Actions (bodies narrowed) ——
  v1.patch('/projects/:pid/tickets/:tid', (req, res) => {
    const pid = seg(req.params.pid), tid = seg(req.params.tid)
    if (!validate(res, [pid, PID_RE], [tid, NUM_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    if (typeof b.status === 'string') narrowed.status = b.status
    if (typeof b.priority === 'string') narrowed.priority = b.priority
    if (typeof b.title === 'string') narrowed.title = b.title
    void forward(res, 'PATCH', `/api/projects/${encodeURIComponent(pid)}/tickets/${encodeURIComponent(tid)}`, '', narrowed)
  })

  v1.delete('/projects/:pid/tickets/:tid', (req, res) => {
    const pid = seg(req.params.pid), tid = seg(req.params.tid)
    if (!validate(res, [pid, PID_RE], [tid, NUM_RE])) return
    void forward(res, 'DELETE', `/api/projects/${encodeURIComponent(pid)}/tickets/${encodeURIComponent(tid)}`, '')
  })

  v1.put('/projects/:pid/rails/:i/tickets', (req, res) => {
    const pid = seg(req.params.pid), i = seg(req.params.i)
    if (!validate(res, [pid, PID_RE], [i, NUM_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const ticketIds = Array.isArray(b.ticketIds) ? b.ticketIds.filter((n) => typeof n === 'number') : []
    void forward(res, 'PUT', `/api/projects/${encodeURIComponent(pid)}/rails/${encodeURIComponent(i)}/tickets`, '', { ticketIds })
  })

  v1.post('/projects/:pid/rails/:i/launch', (req, res) => {
    const pid = seg(req.params.pid), i = seg(req.params.i)
    if (!validate(res, [pid, PID_RE], [i, NUM_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    if (typeof b.mode === 'string') narrowed.mode = b.mode
    if (typeof b.profileName === 'string') narrowed.profileName = b.profileName
    if (typeof b.aiEngine === 'string') narrowed.aiEngine = b.aiEngine
    if (typeof b.model === 'string') narrowed.model = b.model // freestyle model
    // rails-as-loops: let a mobile client launch a chosen Loop (factory or custom).
    // Additive — the frozen bare-`mode` path is untouched (a v1 client sends no loopId).
    if (typeof b.loopId === 'string') narrowed.loopId = b.loopId
    if (b.reasoning_effort === 'low' || b.reasoning_effort === 'medium' || b.reasoning_effort === 'high') narrowed.reasoning_effort = b.reasoning_effort
    if (typeof b.interactive === 'boolean') narrowed.interactive = b.interactive
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/rails/${encodeURIComponent(i)}/launch`, '', narrowed)
  })

  v1.put('/projects/:pid/rails/:i/engine', (req, res) => {
    const pid = seg(req.params.pid), i = seg(req.params.i)
    if (!validate(res, [pid, PID_RE], [i, NUM_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    // aiEngine: a provider string, or null to clear the override.
    const aiEngine = typeof b.aiEngine === 'string' ? b.aiEngine : null
    void forward(res, 'PUT', `/api/projects/${encodeURIComponent(pid)}/rails/${encodeURIComponent(i)}/engine`, '', { aiEngine })
  })

  v1.put('/projects/:pid/rails/:i/name', (req, res) => {
    const pid = seg(req.params.pid), i = seg(req.params.i)
    if (!validate(res, [pid, PID_RE], [i, NUM_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    // name: the display label, or null to clear back to the default "Rail N".
    const name = typeof b.name === 'string' ? b.name : null
    void forward(res, 'PUT', `/api/projects/${encodeURIComponent(pid)}/rails/${encodeURIComponent(i)}/name`, '', { name })
  })

  v1.post('/projects/:pid/rails/:i/stop', (req, res) => {
    const pid = seg(req.params.pid), i = seg(req.params.i)
    if (!validate(res, [pid, PID_RE], [i, NUM_RE])) return
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/rails/${encodeURIComponent(i)}/stop`, '', {})
  })

  v1.delete('/projects/:pid/jobs/:jid', (req, res) => {
    const pid = seg(req.params.pid), jid = seg(req.params.jid)
    if (!validate(res, [pid, PID_RE], [jid, JOBID_RE])) return
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/jobs/${encodeURIComponent(jid)}/cancel`, '')
  })

  v1.post('/projects/:pid/queue/pause', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/queue/pause`, '', {})
  })
  v1.post('/projects/:pid/queue/resume', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/queue/resume`, '', {})
  })

  // —— Spec capture on the go ——
  v1.post('/projects/:pid/tickets/generate-spec', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    // The server's generate-spec expects `idea` — the app sends `prompt`.
    if (typeof b.prompt === 'string') narrowed.idea = b.prompt
    if (typeof b.model === 'string') narrowed.model = b.model
    if (typeof b.aiEngine === 'string') narrowed.aiEngine = b.aiEngine
    if (typeof b.contractRefine === 'boolean') narrowed.contractRefine = b.contractRefine
    // Forward the context scope so the server injects .specrails/local-tickets.json
    // (specrails:true) and dedups against existing specs — without this the AI has
    // no context and re-creates specs that already exist.
    const scope = narrowScope(b.contextScope)
    if (scope) narrowed.contextScope = scope
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/tickets/generate-spec`, '', narrowed)
  })

  v1.post('/projects/:pid/tickets/from-prompt', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    // The server's from-prompt expects `description` — the app sends `prompt`.
    if (typeof b.prompt === 'string') narrowed.description = b.prompt
    if (typeof b.title === 'string') narrowed.title = b.title
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/tickets/from-prompt`, '', narrowed)
  })

  // —— Model catalog (for the Quick/Explore model picker) ——
  v1.get('/projects/:pid/default-spec-model', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/default-spec-model`, rawQuery(req))
  })

  // —— Explore conversations (Add Spec → Explore: a conversational agent) ——
  function narrowScope(raw: unknown): Record<string, boolean> | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const r = raw as Record<string, unknown>
    const out: Record<string, boolean> = {}
    for (const k of ['specrails', 'openspec', 'full', 'mcp', 'contractRefine', 'userMcp']) {
      if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
    }
    return out
  }

  v1.post('/projects/:pid/chat/conversations', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    narrowed.kind = b.kind === 'explore' ? 'explore' : 'sidebar'
    if (typeof b.model === 'string') narrowed.model = b.model
    if (typeof b.aiEngine === 'string') narrowed.aiEngine = b.aiEngine
    const scope = narrowScope(b.contextScope)
    if (scope) narrowed.contextScope = scope
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/chat/conversations`, '', narrowed)
  })

  v1.get('/projects/:pid/chat/conversations/:cid', (req, res) => {
    const pid = seg(req.params.pid), cid = seg(req.params.cid)
    if (!validate(res, [pid, PID_RE], [cid, CONV_ID_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/chat/conversations/${encodeURIComponent(cid)}`, '')
  })

  v1.get('/projects/:pid/chat/conversations/:cid/spec-draft', (req, res) => {
    const pid = seg(req.params.pid), cid = seg(req.params.cid)
    if (!validate(res, [pid, PID_RE], [cid, CONV_ID_RE])) return
    void forward(res, 'GET', `/api/projects/${encodeURIComponent(pid)}/chat/conversations/${encodeURIComponent(cid)}/spec-draft`, '')
  })

  v1.post('/projects/:pid/chat/conversations/:cid/messages', (req, res) => {
    const pid = seg(req.params.pid), cid = seg(req.params.cid)
    if (!validate(res, [pid, PID_RE], [cid, CONV_ID_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    if (typeof b.text === 'string') narrowed.text = b.text
    narrowed.lightweight = b.lightweight === false ? false : true
    if (typeof b.maxTurns === 'number') narrowed.maxTurns = b.maxTurns
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/chat/conversations/${encodeURIComponent(cid)}/messages`, '', narrowed)
  })

  v1.delete('/projects/:pid/chat/conversations/:cid/messages/stream', (req, res) => {
    const pid = seg(req.params.pid), cid = seg(req.params.cid)
    if (!validate(res, [pid, PID_RE], [cid, CONV_ID_RE])) return
    void forward(res, 'DELETE', `/api/projects/${encodeURIComponent(pid)}/chat/conversations/${encodeURIComponent(cid)}/messages/stream`, '')
  })

  for (const action of ['minimize', 'restore']) {
    v1.post(`/projects/:pid/chat/conversations/:cid/${action}`, (req, res) => {
      const pid = seg(req.params.pid), cid = seg(req.params.cid)
      if (!validate(res, [pid, PID_RE], [cid, CONV_ID_RE])) return
      void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/chat/conversations/${encodeURIComponent(cid)}/${action}`, '', {})
    })
  }

  // —— Commit an Explore conversation to a ticket ——
  v1.post('/projects/:pid/tickets/from-draft', (req, res) => {
    const pid = seg(req.params.pid)
    if (!validate(res, [pid, PID_RE])) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const narrowed: Record<string, unknown> = {}
    if (typeof b.title === 'string') narrowed.title = b.title
    if (typeof b.conversationId === 'string') narrowed.conversationId = b.conversationId
    if (typeof b.description === 'string') narrowed.description = b.description
    if (typeof b.priority === 'string') narrowed.priority = b.priority
    if (Array.isArray(b.labels)) narrowed.labels = b.labels.filter((x) => typeof x === 'string')
    if (Array.isArray(b.acceptanceCriteria)) narrowed.acceptanceCriteria = b.acceptanceCriteria.filter((x) => typeof x === 'string')
    void forward(res, 'POST', `/api/projects/${encodeURIComponent(pid)}/tickets/from-draft`, '', narrowed)
  })

  router.use('/v1', v1)

  // Any unmatched gateway path → 404 JSON (NEVER falls through to a SPA handler;
  // the gateway serves JSON/WS only, no static client).
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
  })

  return router
}

/** The allow-list, exported for the CI drift test (asserts each entry resolves
 *  against a real internal route, and that no traversal param is accepted). */
export const MOBILE_ALLOWLIST: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/v1/projects' },
  { method: 'GET', path: '/v1/projects/:pid/tickets' },
  { method: 'GET', path: '/v1/projects/:pid/tickets/:tid' },
  { method: 'GET', path: '/v1/projects/:pid/jobs' },
  { method: 'GET', path: '/v1/projects/:pid/jobs/:jid' },
  { method: 'GET', path: '/v1/loops' },
  { method: 'GET', path: '/v1/loops/factory' },
  { method: 'GET', path: '/v1/projects/:pid/loop-runs/:id' },
  { method: 'GET', path: '/v1/projects/:pid/queue' },
  { method: 'GET', path: '/v1/projects/:pid/rails' },
  { method: 'GET', path: '/v1/projects/:pid/activity' },
  { method: 'GET', path: '/v1/projects/:pid/stats' },
  { method: 'GET', path: '/v1/projects/:pid/state' },
  { method: 'GET', path: '/v1/projects/:pid/spending' },
  { method: 'GET', path: '/v1/projects/:pid/tickets/:tid/spending-summary' },
  { method: 'PATCH', path: '/v1/projects/:pid/tickets/:tid' },
  { method: 'DELETE', path: '/v1/projects/:pid/tickets/:tid' },
  { method: 'PUT', path: '/v1/projects/:pid/rails/:i/tickets' },
  { method: 'POST', path: '/v1/projects/:pid/rails/:i/launch' },
  { method: 'PUT', path: '/v1/projects/:pid/rails/:i/engine' },
  { method: 'POST', path: '/v1/projects/:pid/rails/:i/stop' },
  { method: 'DELETE', path: '/v1/projects/:pid/jobs/:jid' },
  { method: 'POST', path: '/v1/projects/:pid/queue/pause' },
  { method: 'POST', path: '/v1/projects/:pid/queue/resume' },
  { method: 'POST', path: '/v1/projects/:pid/tickets/generate-spec' },
  { method: 'POST', path: '/v1/projects/:pid/tickets/from-prompt' },
  { method: 'GET', path: '/v1/projects/:pid/default-spec-model' },
  { method: 'POST', path: '/v1/projects/:pid/chat/conversations' },
  { method: 'GET', path: '/v1/projects/:pid/chat/conversations/:cid' },
  { method: 'GET', path: '/v1/projects/:pid/chat/conversations/:cid/spec-draft' },
  { method: 'POST', path: '/v1/projects/:pid/chat/conversations/:cid/messages' },
  { method: 'DELETE', path: '/v1/projects/:pid/chat/conversations/:cid/messages/stream' },
  { method: 'POST', path: '/v1/projects/:pid/chat/conversations/:cid/minimize' },
  { method: 'POST', path: '/v1/projects/:pid/chat/conversations/:cid/restore' },
  { method: 'POST', path: '/v1/projects/:pid/tickets/from-draft' },
]
