import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { Router } from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { initDesktopDb } from './desktop-db'
import { createRailsRouter } from './rails-router'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import { createLoop, publishLoop } from './loops-store'
import { getRails, getRail, setRailTickets, createRail, MAX_RAILS } from './rails-store'
import { createPrDelivery, getPrDelivery, type PrDecision } from './rail-pr-store'
import { resetProcessAdmissionForTests } from './process-admission'
import type { ProjectContext } from './project-registry'
import type { ProjectRoutesDeps } from './project-router-helpers'
import type { LoopGraph, LoopSpec } from './loop-graph'
import type { RunExecutionManifest, RepositoryDeliverySnapshot } from './multi-repo-execution-store'

const mocks = vi.hoisted(() => ({ isolated: vi.fn(), multi: vi.fn(), probe: vi.fn(), accept: vi.fn() }))
vi.mock('./worktree-manager', async (actual) => ({ ...await actual<typeof import('./worktree-manager')>(), repoIsolationStatus: mocks.probe }))
vi.mock('./rail-isolated-launch', async (actual) => ({ ...await actual<typeof import('./rail-isolated-launch')>(), launchIsolatedRail: mocks.isolated }))
vi.mock('./multi-repo-execution', async (actual) => ({ ...await actual<typeof import('./multi-repo-execution')>(), launchMultiRepositoryRail: mocks.multi }))
vi.mock('./accept-ladder', async (actual) => ({ ...await actual<typeof import('./accept-ladder')>(), resolveAcceptCapability: mocks.accept }))

let db: DbInstance, desktopDb: DbInstance, ctx: ProjectContext, app: express.Express
let specs: Map<number, LoopSpec>
const PRIMARY = 'primary-routing', API = 'routing-api'
const graph: LoopGraph = {
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }, { id: 'work', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Inspect and improve the repository' } }, { id: 'end', type: 'end', position: { x: 0, y: 2 } }],
  edges: [{ id: 'a', source: 'start', target: 'work' }, { id: 'b', source: 'work', target: 'end' }],
  config: { maxIterations: 2, timeoutMinutes: 5 },
}

beforeEach(() => {
  resetProcessAdmissionForTests()
  vi.stubEnv('SPECRAILS_LOOPS_SECTION', 'true'); vi.stubEnv('SPECRAILS_RAIL_WORKTREES', '1'); vi.stubEnv('SPECRAILS_RAIL_DELIVER_PR', '1')
  vi.stubEnv('SPECRAILS_DELIVERY_REVISIONS', 'true'); vi.stubEnv('SPECRAILS_REVIEW_PACKET', 'true')
  mocks.probe.mockReset().mockResolvedValue('ok')
  mocks.isolated.mockReset().mockResolvedValue(['isolated-run'])
  mocks.multi.mockReset().mockImplementation(async (input) => { input.onPrDeliveryCreated?.('standalone-group'); return ['standalone-run'] })
  mocks.accept.mockReset().mockResolvedValue({ target: 'create-pr', irreversible: false })
  db = initDb(':memory:'); desktopDb = initDesktopDb(':memory:')
  specs = new Map([[1, { id: 1, title: 'API feature', repositoryIds: [API] }], [2, { id: 2, title: 'Legacy app feature' }], [3, { id: 3, title: 'API follow-up', repositoryIds: [API] }]])
  ctx = {
    db, desktopDb,
    project: { id: 'routing', slug: 'routing-test', name: 'Routing', path: '/routing/app', db_path: ':memory:', provider: 'claude', providers: ['claude'], added_at: '', last_seen_at: '', primaryRepositoryId: PRIMARY, repositories: [
      { id: PRIMARY, projectId: 'routing', name: 'App', path: '/routing/app', isPrimary: true, kind: 'git', integrationBranch: 'main', addedAt: '' },
      { id: API, projectId: 'routing', name: 'API', path: '/routing/api', isPrimary: false, kind: 'git', integrationBranch: 'develop', addedAt: '' },
    ] },
    railJobs: new Map(), railLoopRuns: new Map(), broadcast: vi.fn(),
    queueManager: { enqueue: vi.fn() }, loopRunManager: { run: vi.fn().mockResolvedValue({ runId: 'primary-run', outcome: 'success' }), cancel: vi.fn() },
    getTicketSpec: (id: number) => specs.get(id), onLoopRunFinished: vi.fn(),
  } as unknown as ProjectContext
  createLoop(desktopDb, { id: 'standalone', name: 'Repository maintenance', graph }); publishLoop(desktopDb, 'standalone')
  app = express(); app.use(express.json()); app.use((req, _res, next) => { req.projectCtx = ctx; next() })
  app.use('/rails', createRailsRouter())
  const router = Router(); registerLoopRunRoutes({ router, ctx: () => ctx } as unknown as ProjectRoutesDeps); app.use('/api/projects', router)
})
afterEach(() => { db.close(); desktopDb.close(); resetProcessAdmissionForTests(); vi.unstubAllEnvs() })

function group(decision: PrDecision = 'on_review', repositoryIds = [PRIMARY, API]): { manifest: RunExecutionManifest; childIds: string[] } {
  createPrDelivery(db, { id: 'group', railIndex: 0, railKey: 'group-0', loopId: 'factory:implement', ticketIds: [1, 2], baseBranch: 'main', loopName: 'Shared feature', originSurface: 'agent-chat', specSnapshot: [{ ticketId: 1, title: 'Frozen spec', description: 'Frozen requirements', labels: [] }] })
  const manifest: RunExecutionManifest = {
    version: 1, groupId: 'group', projectId: 'routing', primaryRepositoryId: PRIMARY, artifactRepositoryId: PRIMARY,
    selectedRepositoryIds: repositoryIds,
    repositories: repositoryIds.map((repositoryId, index) => ({ repositoryId, name: index === 0 ? 'App' : 'API', sourcePath: `/frozen/${repositoryId}`, gitCommonDir: `/frozen/${repositoryId}/.git`, baseBranch: index === 0 ? 'main' : 'develop', integrationBranch: index === 0 ? 'main' : 'develop', baseSha: `${index}`.repeat(40), worktreePath: `/worktrees/${repositoryId}`, branch: `delivery/${repositoryId}`, worktreeId: `wt-${repositoryId}` })),
  }
  const childIds: string[] = []
  const repositories: RepositoryDeliverySnapshot[] = manifest.repositories.map((repo, index) => {
    const id = `child-${index}`; childIds.push(id)
    createPrDelivery(db, { id, parentDeliveryId: 'group', repositoryId: repo.repositoryId, repositoryPath: repo.sourcePath, railIndex: 0, railKey: `group-${index}`, ticketIds: [1, 2], baseBranch: repo.baseBranch, loopName: 'Shared feature', originSurface: 'agent-chat', specSnapshot: [{ ticketId: 1, title: `Frozen ${repo.name} spec`, description: 'Frozen requirements', labels: [] }] })
    db.prepare('UPDATE rail_pr_deliveries SET decision = ?, implementation_outcome = ?, delivery_outcome = ? WHERE id = ?').run(decision, 'succeeded', 'ready', id)
    return { repositoryId: repo.repositoryId, name: repo.name, path: repo.sourcePath, deliveryId: id, baseBranch: repo.baseBranch, branch: repo.branch, deliverySha: 'a'.repeat(40), decision, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', statusCode: 'ready_for_review', statusDetail: null, prUrl: `https://example.invalid/pr/${index + 1}`, prNumber: index + 1, worktreeIds: [repo.worktreeId], runIds: [`run-${index}`] }
  })
  db.prepare('UPDATE rail_pr_deliveries SET execution_manifest = ?, repository_deliveries = ?, decision = ?, implementation_outcome = ?, delivery_outcome = ? WHERE id = ?').run(JSON.stringify(manifest), JSON.stringify(repositories), decision, 'succeeded', 'ready', 'group')
  return { manifest, childIds }
}

describe('rail launch repository routing', () => {
  it('unions ticket scopes with legacy primary defaults and deduplicates before isolated launch', async () => {
    setRailTickets(db, 0, [1, 2, 3], 'batch-implement')
    const response = await request(app).post('/rails/0/launch').send({ mode: 'batch-implement' })
    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ isolated: true, loopRunIds: ['isolated-run'] })
    expect(mocks.isolated).toHaveBeenCalledWith(expect.objectContaining({ ticketIds: [1, 2, 3], repositoryIds: [API, PRIMARY], scope: 'all' }))
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(ctx.queueManager.enqueue).not.toHaveBeenCalled()
  })

  it('preserves the legacy primary default and allows extra repositories without dropping required targets', async () => {
    setRailTickets(db, 0, [2], 'implement')
    expect((await request(app).post('/rails/0/launch').send({})).status).toBe(202)
    expect(mocks.isolated).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: [PRIMARY] }))
    mocks.isolated.mockClear(); mocks.probe.mockClear()
    const omittedPrimary = await request(app).post('/rails/0/launch').send({ repositoryIds: [API] })
    expect(omittedPrimary.status).toBe(400); expect(omittedPrimary.body.error).toBe('repository_scope_incomplete')
    expect(mocks.isolated).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled()
    expect((await request(app).post('/rails/0/launch').send({ repositoryIds: [PRIMARY, API] })).status).toBe(202)
    expect(mocks.isolated).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: [PRIMARY, API] }))
    specs.set(2, { id: 2, title: 'API feature', repositoryIds: [API] })
    expect((await request(app).post('/rails/0/launch').send({ repositoryIds: [API] })).status).toBe(202)
    expect(mocks.isolated).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: [API] }))
  })

  it('rejects a subset of a cross-repository spec before spawning and defaults to its complete scope', async () => {
    specs.set(1, { id: 1, title: 'Shared API contract', repositoryIds: [PRIMARY, API] })
    setRailTickets(db, 0, [1], 'implement')
    const response = await request(app).post('/rails/0/launch').send({ repositoryIds: [API] })
    expect(response.status).toBe(400); expect(response.body.error).toBe('repository_scope_incomplete')
    expect(mocks.isolated).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled()
    expect(ctx.queueManager.enqueue).not.toHaveBeenCalled()
    expect((await request(app).post('/rails/0/launch').send({})).status).toBe(202)
    expect(mocks.isolated).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: [PRIMARY, API] }))
  })

  it.each([['foreign'], [], [API, API], null].map((repositoryIds) => ({ repositoryIds })))('rejects invalid explicit scope before Git probes or provider work: $repositoryIds', async ({ repositoryIds }) => {
    setRailTickets(db, 0, [1], 'implement')
    const response = await request(app).post('/rails/0/launch').send({ repositoryIds })
    expect(response.status).toBe(400)
    expect(mocks.isolated).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled()
    expect(ctx.queueManager.enqueue).not.toHaveBeenCalled()
  })

  it('rejects a stored foreign spec scope before any isolated allocation', async () => {
    specs.set(1, { id: 1, repositoryIds: ['foreign'] }); setRailTickets(db, 0, [1], 'implement')
    expect((await request(app).post('/rails/0/launch').send({})).status).toBe(400)
    expect(mocks.isolated).not.toHaveBeenCalled()
  })

  it.each(['revision', 'continuation'])('retains the frozen group scope for %s and rejects narrowing', async (kind) => {
    setRailTickets(db, 0, [1, 2], 'implement')
    group(kind === 'revision' ? 'on_review' : 'pr_draft')
    // Even if the live specs now need only API, the previous delivery still
    // owns both repositories and must continue with that immutable scope.
    specs.set(2, { id: 2, title: 'Edited after the original run', repositoryIds: [API] })
    const fields = kind === 'revision' ? { revisionOfDeliveryId: 'group', revisionNote: 'Adjust the shared API contract' } : {}
    const wrong = await request(app).post('/rails/0/launch').send({ ...fields, repositoryIds: [API] })
    expect(wrong.status).toBe(409); expect(wrong.body.error).toBe('delivery_repository_scope_changed')
    expect(mocks.isolated).not.toHaveBeenCalled()
    const accepted = await request(app).post('/rails/0/launch').send({ ...fields, repositoryIds: [API, PRIMARY] })
    expect(accepted.status).toBe(202)
    expect(mocks.isolated).toHaveBeenCalledWith(expect.objectContaining(kind === 'revision'
      ? { repositoryIds: [API, PRIMARY], revision: { ofDeliveryId: 'group', decision: 'on_review', note: 'Adjust the shared API contract' } }
      : { repositoryIds: [API, PRIMARY], repositoryContinuation: { deliveryId: 'group', decision: 'pr_draft' } }))
    expect(getPrDelivery(db, 'group')?.decision).toBe(kind === 'revision' ? 'on_review' : 'pr_draft')
  })

  it('fails closed when worktree isolation is disabled for secondary scope', async () => {
    setRailTickets(db, 0, [1], 'implement'); vi.stubEnv('SPECRAILS_RAIL_WORKTREES', '0')
    const response = await request(app).post('/rails/0/launch').send({})
    expect(response.status).toBe(409); expect(response.body.error).toBe('repository_isolation_required')
    expect(mocks.isolated).not.toHaveBeenCalled(); expect(ctx.loopRunManager.run).not.toHaveBeenCalled()
  })
})

describe('group review packets', () => {
  it('selects the repository child while returning the authoritative parent group snapshot and frozen path', async () => {
    const { manifest, childIds } = group()
    ctx.project.repositories![1].path = '/new/current/api'
    const response = await request(app).get('/rails/pr-deliveries/group/packet').query({ repositoryId: API })
    expect(response.status).toBe(200)
    expect(response.body.repositoryId).toBe(API)
    expect(response.body.packet.prDeliveryId).toBe(childIds[1])
    expect(response.body.packet.sections[0].title).toBe('Frozen API spec')
    expect(response.body.snapshot.id).toBe('group')
    expect(response.body.snapshot.executionManifest).toEqual(manifest)
    expect(response.body.snapshot.repositoryDeliveries).toHaveLength(2)
    expect(mocks.accept).toHaveBeenCalledWith(expect.objectContaining({ repoDir: `/frozen/${API}` }))
    const byChild = await request(app).get(`/rails/pr-deliveries/${childIds[1]}/packet`)
    expect(byChild.status).toBe(200); expect(byChild.body.snapshot.id).toBe('group')
  })

  it('rejects foreign selection and a child whose source path no longer matches its immutable manifest', async () => {
    const { childIds } = group()
    expect((await request(app).get('/rails/pr-deliveries/group/packet').query({ repositoryId: 'foreign' })).status).toBe(404)
    db.prepare('UPDATE rail_pr_deliveries SET repository_path = ? WHERE id = ?').run('/untrusted/other', childIds[1])
    const response = await request(app).get(`/rails/pr-deliveries/${childIds[1]}/packet`)
    expect(response.status).toBe(409)
    expect(mocks.accept).not.toHaveBeenCalled()
  })
})

describe('standalone secondary and multi-repository runs', () => {
  it('rejects a shell command bound to an unselected repository before starting work', async () => {
    const shellGraph = structuredClone(graph)
    shellGraph.nodes[1] = { ...shellGraph.nodes[1], type: 'shell', data: { command: 'git status --short', repositoryId: API } }
    createLoop(desktopDb, { id: 'api-shell', name: 'API check', graph: shellGraph }); publishLoop(desktopDb, 'api-shell')
    const rejected = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'api-shell', repositoryIds: [PRIMARY] })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toContain('outside this launch')
    expect(ctx.loopRunManager.run).not.toHaveBeenCalled(); expect(mocks.multi).not.toHaveBeenCalled()
    expect(ctx.railLoopRuns.size).toBe(0); expect(getRails(db)).toHaveLength(3)
    const accepted = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'api-shell', repositoryIds: [API] })
    expect(accepted.status).toBe(202)
    expect(mocks.multi).toHaveBeenCalledWith(expect.objectContaining({ repositoryIds: [API], loopGraph: shellGraph }))
  })

  it('keeps legacy primary standalone execution free of rails and synthetic specs', async () => {
    const response = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone' })
    expect(response.status).toBe(202)
    expect(ctx.loopRunManager.run).toHaveBeenCalledWith(expect.objectContaining({ railIndex: null, ticketId: null, spec: undefined }))
    expect(mocks.multi).not.toHaveBeenCalled(); expect(getRails(db)).toHaveLength(3)
  })

  it.each([[API], [PRIMARY, API]].map((repositoryIds) => ({ repositoryIds })))('reserves an empty rail and dispatches exact standalone scope: $repositoryIds', async ({ repositoryIds }) => {
    let release!: () => void
    let entered!: () => void
    const admitted = new Promise<void>((resolve) => { entered = resolve })
    mocks.multi.mockImplementationOnce(async (input) => { entered(); await new Promise<void>((resolve) => { release = resolve }); input.onPrDeliveryCreated('standalone-group'); return ['standalone-run'] })
    const pending = request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone', repositoryIds }).then((response) => response)
    await admitted
    expect([...ctx.railLoopRuns.values()]).toMatchObject([{ railIndex: 0, ticketIds: [] }])
    expect(mocks.multi).toHaveBeenCalledWith(expect.objectContaining({ railIndex: 0, ticketIds: [], repositoryIds, scope: 'all' }))
    expect(getRail(db, 0).ticketIds).toEqual([])
    release()
    const response = await pending
    expect(response.status).toBe(202); expect(response.body).toMatchObject({ isolated: true, loopRunId: 'standalone-run', railIndex: 0, prDeliveryId: 'standalone-group' })
    expect(ctx.railLoopRuns.size).toBe(0)
    expect(ctx.loopRunManager.run).not.toHaveBeenCalled()
  })

  it('creates and broadcasts a visible empty rail when all existing rails are occupied', async () => {
    for (let i = 0; i < 3; i++) setRailTickets(db, i, [i + 1], 'implement')
    const response = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone', repositoryIds: [API] })
    expect(response.status).toBe(202); expect(response.body.railIndex).toBe(3)
    expect(getRail(db, 3).ticketIds).toEqual([])
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rail.updated', projectId: 'routing', railIndex: 3, ticketIds: [], name: 'Repository maintenance' }))
    expect(db.prepare('SELECT COUNT(*) AS n FROM rails').get()).toEqual({ n: 3 })
  })

  it('removes only a newly allocated empty rail on preparation failure and releases its reservation', async () => {
    for (let i = 0; i < 3; i++) setRailTickets(db, i, [i + 1], 'implement')
    mocks.multi.mockRejectedValueOnce(new Error('Repository unavailable'))
    const response = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone', repositoryIds: [API] })
    expect(response.status).toBe(409); expect(response.body.error).toBe('repository_launch_failed')
    expect(getRails(db)).toHaveLength(3); expect(ctx.railLoopRuns.size).toBe(0)
    expect(ctx.broadcast).not.toHaveBeenCalled()
    expect(getRails(db).flatMap((rail) => rail.ticketIds)).toEqual([1, 2, 3])
  })

  it('keeps an allocated rail when a failed launch left a durable delivery requiring review', async () => {
    for (let i = 0; i < 3; i++) setRailTickets(db, i, [i + 1], 'implement')
    mocks.multi.mockImplementationOnce(async (input) => {
      createPrDelivery(db, { id: 'preserved', railIndex: input.railIndex, railKey: 'preserved', ticketIds: [], baseBranch: 'main', loopName: 'Recovery', originSurface: 'dashboard' })
      throw new Error('Interrupted after preservation')
    })
    const response = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone', repositoryIds: [API] })
    expect(response.status).toBe(409); expect(getRails(db)).toHaveLength(4)
    expect(getPrDelivery(db, 'preserved')).toBeDefined(); expect(ctx.railLoopRuns.size).toBe(0)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rail.updated', railIndex: 3 }))
  })

  it('rejects foreign scope before reserving a rail or starting any work', async () => {
    const response = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone', repositoryIds: ['foreign'] })
    expect(response.status).toBe(400); expect(ctx.railLoopRuns.size).toBe(0)
    expect(mocks.multi).not.toHaveBeenCalled(); expect(ctx.loopRunManager.run).not.toHaveBeenCalled()
    expect(getRails(db)).toHaveLength(3)
  })

  it('does not exceed the rail cap or reuse a reserved rail', async () => {
    while (getRails(db).length < MAX_RAILS) createRail(db)
    for (const rail of getRails(db)) ctx.railLoopRuns.set(`reserved-${rail.railIndex}`, { railIndex: rail.railIndex, ticketIds: [] })
    const response = await request(app).post('/api/projects/routing/loop-runs').send({ loopId: 'standalone', repositoryIds: [API] })
    expect(response.status).toBe(409); expect(response.body.error).toBe('no_available_rail')
    expect(mocks.multi).not.toHaveBeenCalled(); expect(getRails(db)).toHaveLength(MAX_RAILS)
  })
})
