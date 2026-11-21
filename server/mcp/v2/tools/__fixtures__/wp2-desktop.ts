import express from 'express'
import { initDb, type DbInstance } from '../../../../db'
import { getProject, listProjects } from '../../../../desktop-db'
import type { ProjectRegistry } from '../../../../project-registry'
import { registerInboxRoutes } from '../../../../modules/inbox/adapters/http'
import { registerLiveBoardRoutes } from '../../../../modules/live-board/adapters/http'
import type { CapStatus } from '../../../../modules/execution'
import { listenOnLoopback } from '../../../../__fixtures__/loopback-test-server'
import type { Harness } from '../../__fixtures__/harness'

/**
 * WP2 test desktop: the REAL inbox and live-board routes over real in-memory
 * project databases (one per harness project), on a loopback port the
 * harness context points at. Everything else is a recorded stub that a test
 * can answer with `on(method, path, handler)`.
 */

export interface RecordedCall { method: string; path: string; body: unknown }
type Handler = (req: express.Request, res: express.Response) => void

export interface FakeDesktop {
  port: number
  calls: RecordedCall[]
  dbs: Map<string, DbInstance>
  caps: CapStatus[]
  quota: unknown[]
  turns: unknown[]
  on(method: string, path: string | RegExp, handler: Handler | unknown): void
  close(): Promise<void>
}

export async function startDesktop(h: Harness): Promise<FakeDesktop> {
  const dbs = new Map<string, DbInstance>()
  const contexts = new Map(listProjects(h.db).map((row) => {
    const db = initDb(':memory:')
    dbs.set(row.id, db)
    return [row.id, { project: row, db, railLoopRuns: new Map(), restartPendingRunIds: new Set<string>(), budgetCaps: () => desktop.caps } as never]
  }))
  const registry = {
    desktopDb: h.db,
    listContexts: () => [...contexts.values()],
    listProjects: () => listProjects(h.db),
    getProjectRow: (id: string) => getProject(h.db, id),
    getContext: (id: string) => contexts.get(id),
    withSpendSnapshot: <T>(fn: () => T): T => fn(),
  } as unknown as ProjectRegistry
  h.ctx.registry = registry
  const stubs: Array<{ method: string; path: string | RegExp; handler: Handler }> = []
  const calls: RecordedCall[] = []
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { calls.push({ method: req.method, path: req.originalUrl.replace(/^\/api/, ''), body: req.method === 'GET' ? null : req.body }); next() })
  app.use((req, res, next) => {
    const stub = stubs.find((candidate) => candidate.method === req.method && (typeof candidate.path === 'string' ? candidate.path === req.originalUrl.replace(/^\/api/, '') : candidate.path.test(req.originalUrl.replace(/^\/api/, ''))))
    if (stub) { stub.handler(req, res); return }
    next()
  })
  const router = express.Router()
  registerInboxRoutes(router, registry)
  registerLiveBoardRoutes(router, registry)
  router.get('/provider-quota', (_req, res) => { res.json({ providers: desktop.quota }) })
  router.get('/agent/active-turns', (_req, res) => { res.json({ turns: desktop.turns, sessions: [] }) })
  app.use('/api', router)
  app.use((req, res) => { res.status(404).json({ error: `no stub for ${req.method} ${req.originalUrl}` }) })
  const fixture = await listenOnLoopback(app)
  h.ctx.desktopPort = fixture.port
  const desktop: FakeDesktop = {
    port: fixture.port, calls, dbs, caps: [], quota: [], turns: [],
    on(method, path, handler) {
      stubs.unshift({ method, path, handler: typeof handler === 'function' ? handler as Handler : (_req, res) => { res.json(handler) } })
    },
    close: fixture.close,
  }
  return desktop
}

/** `count` harness projects: p1…pN, slugs proj-1…proj-N. */
export function manyProjects(count: number): Array<{ id: string; slug: string; name: string; path: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, slug: `proj-${index + 1}`, name: `Project ${index + 1}`, path: `/tmp/v2-wp2-proj-${index + 1}` }))
}
