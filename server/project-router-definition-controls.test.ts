import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createLoopRun, claimDefinitionExecution, readDefinitionExecutionClaim } from './modules/loops/runtime/loop-runs-store'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'

const runtime = vi.hoisted(() => ({ probe: vi.fn(), settle: vi.fn(), fork: vi.fn() }))
vi.mock('./modules/delivery/runtime/definition-fork', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/definition-fork')>('./modules/delivery/runtime/definition-fork'), forkDefinitionRun: runtime.fork }))
vi.mock('./modules/loops/runtime/loop-definition-recovery', () => ({ probeDefinitionRun: runtime.probe }))
vi.mock('./modules/delivery/runtime/rail-isolated-launch', () => ({ reattachIsolatedSettlement: runtime.settle }))
let db: DbInstance
const begin = vi.fn(), finished = vi.fn(), resident = vi.fn(), cancel = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.SPECRAILS_LOOPS_SECTION
  db = initDb(':memory:')
  createLoopRun(db, { id: 'run', projectId: 'p', loopId: 'loop', loopName: 'Test', railIndex: null, ticketId: null, provider: 'claude', model: 'sonnet', iterationLimit: 1, startedAt: new Date().toISOString() })
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'paused', restart_reason = 'restart' WHERE id = 'run'").run()
  runtime.probe.mockResolvedValue({ status: 'paused', lease: null, pendingInterrupts: [], recoverableSteps: [{ attemptId: 'attempt', nodePath: 'node', scopeId: 'scope' }] })
  begin.mockImplementation(() => new Promise(() => {}))
  resident.mockReturnValue(false)
  cancel.mockResolvedValue(undefined)
})
afterEach(() => db.close())
function api(projectId = 'p') {
  const app = express(), router = express.Router()
  app.use(express.json())
  registerLoopRunRoutes({ router, ctx: () => ({ db, project: { id: projectId, path: '/repo' }, loopRunManager: { beginDefinitionResume: begin, isDefinitionRunActive: resident, cancelDefinition: cancel, isDisposed: () => false }, onLoopRunFinished: finished }) } as unknown as ProjectRoutesDeps)
  app.use('/api', router)
  return request(app)
}
const url = '/api/p/loop-runs/run/resume'
describe('definition resume admission', () => {
  it('acknowledges admission without waiting for the workflow to finish', async () => {
    expect((await api().post(url).send({ recover: ['attempt'] })).status).toBe(202)
    expect(begin).toHaveBeenCalledWith('run', { recover: ['attempt'] })
  })
  it('rejects foreign project runs before probing Core', async () => {
    expect((await api('other').post(url).send({})).status).toBe(404)
    expect(runtime.probe).not.toHaveBeenCalled()
  })
  it.each(['unavailable', 'live'])('preserves ownership when inspection is %s', async status => {
    claimDefinitionExecution(db, 'run', { owner: 'old', repositoryMounts: ['/repo'] })
    runtime.probe.mockResolvedValue({ status: status === 'live' ? 'running' : status, lease: status === 'live' ? { active: true } : null })
    expect((await api().post(url).send({})).status).toBe(status === 'live' ? 409 : 503)
    expect(readDefinitionExecutionClaim(db, 'run')?.owner).toBe('old')
    expect(begin).not.toHaveBeenCalled()
  })
  it('rejects node-path recovery and preserves the existing claim', async () => {
    claimDefinitionExecution(db, 'run', { owner: 'old', repositoryMounts: ['/repo'] })
    expect((await api().post(url).send({ recover: ['node'] })).status).toBe(400)
    expect(readDefinitionExecutionClaim(db, 'run')?.owner).toBe('old')
  })
  it('releases only an observed orphan after Core confirms an inactive lease', async () => {
    claimDefinitionExecution(db, 'run', { owner: 'old', repositoryMounts: ['/repo'] })
    expect((await api().post(url).send({})).status).toBe(202)
    expect(readDefinitionExecutionClaim(db, 'run')).toBeUndefined()
  })
  it('does not release a replacement claim acquired while probing', async () => {
    claimDefinitionExecution(db, 'run', { owner: 'old', repositoryMounts: ['/repo'] })
    runtime.probe.mockImplementation(async () => {
      db.prepare("UPDATE definition_execution_claims SET owner = 'new' WHERE run_id = 'run'").run()
      return { status: 'paused', lease: null, pendingInterrupts: [], recoverableSteps: [] }
    })
    begin.mockImplementation(() => { throw new Error('runtime_run_active') })
    expect((await api().post(url).send({})).status).toBe(409)
    expect(readDefinitionExecutionClaim(db, 'run')?.owner).toBe('new')
  })
  it('does not duplicate the original resident settlement callback', async () => {
    resident.mockReturnValue(true)
    begin.mockResolvedValue({ outcome: 'success' })
    expect((await api().post(url).send({})).status).toBe(202)
    expect(finished).not.toHaveBeenCalled()
    expect(runtime.settle).not.toHaveBeenCalled()
  })
  it('completes the standalone terminal callback after resumed execution', async () => {
    begin.mockResolvedValue({ outcome: 'success' })
    expect((await api().post(url).send({})).status).toBe(202)
    expect(finished).toHaveBeenCalledWith('run', 'success', undefined)
  })
})

describe('definition cancellation admission', () => {
  it('settles an inactive standalone cancellation through Core terminal replay', async () => {
    runtime.probe.mockResolvedValue({ status: 'cancelled', lease: null })
    begin.mockResolvedValue({ outcome: 'stopped' })
    const result = await api().post('/api/p/loop-runs/run/cancel').send({})
    expect(result.status).toBe(202)
    expect(cancel).toHaveBeenCalledWith('run', 'desktop-cancel:run')
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith('run', 'stopped'))
  })
  it('keeps the resident execution as the sole settlement owner', async () => {
    resident.mockReturnValue(true)
    expect((await api().post('/api/p/loop-runs/run/cancel').send({ requestId: 'cancel-1' })).status).toBe(202)
    expect(begin).not.toHaveBeenCalled()
    expect(runtime.probe).not.toHaveBeenCalled()
    expect(finished).not.toHaveBeenCalled()
  })
  it('does not acknowledge a rejected Core cancellation', async () => {
    cancel.mockRejectedValue(new Error('Control unavailable'))
    expect((await api().post('/api/p/loop-runs/run/cancel').send({})).status).toBe(409)
    expect(begin).not.toHaveBeenCalled()
  })
  it('rejects foreign runs and invalid request identities before control effects', async () => {
    expect((await api('other').post('/api/p/loop-runs/run/cancel').send({})).status).toBe(404)
    expect((await api().post('/api/p/loop-runs/run/cancel').send({ requestId: '../other' })).status).toBe(400)
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('definition fork admission', () => {
  const endpoint = '/api/p/loop-runs/run/fork'
  const body = { requestId: 'fork-1', fromNodePath: 'reviews/read', scopeId: 'right', visit: 2 }
  it('returns the linked child after durable adoption with exact scoped controls', async () => {
    runtime.fork.mockResolvedValue({ loopRunId: 'child', forkOf: 'run', fromNodePath: 'reviews/read', scopeId: 'right', visit: 2 })
    const result = await api().post(endpoint).send(body)
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ loopRunId: 'child', forkOf: 'run', scopeId: 'right' })
    expect(runtime.fork).toHaveBeenCalledWith(expect.anything(), 'run', body)
  })
  it('rejects foreign project runs and malformed controls before creating a fork', async () => {
    expect((await api('other').post(endpoint).send(body)).status).toBe(404)
    expect((await api().post(endpoint).send({ ...body, visit: 0 })).status).toBe(400)
    expect(runtime.fork).not.toHaveBeenCalled()
  })
  it('reports retained inspection failures without pretending a child was created', async () => {
    runtime.fork.mockRejectedValue(new Error('runtime_status_unavailable'))
    const result = await api().post(endpoint).send(body)
    expect(result.status).toBe(503)
    expect(result.body).not.toHaveProperty('loopRunId')
  })
})
