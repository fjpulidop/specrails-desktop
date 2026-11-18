import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { serializeDiagnosis } from './modules/recovery'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'

const order: string[] = []
const runtime = vi.hoisted(() => ({ probe: vi.fn(), fork: vi.fn(), prepare: vi.fn(), signal: vi.fn() }))
vi.mock('./modules/delivery/runtime/definition-fork', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/definition-fork')>('./modules/delivery/runtime/definition-fork'), forkDefinitionRun: runtime.fork }))
vi.mock('./modules/loops/runtime/loop-definition-recovery', () => ({ probeDefinitionRun: runtime.probe }))
vi.mock('./modules/delivery/runtime/incomplete-tasks-remedy', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/incomplete-tasks-remedy')>('./modules/delivery/runtime/incomplete-tasks-remedy'), prepareIncompleteTasksFork: runtime.prepare }))
vi.mock('./modules/agent-runtime/runtime/agent-runtime-controls-router', () => ({ signalDefinitionRun: runtime.signal }))

let db: DbInstance
const begin = vi.fn()
const TASK = '4.1 Manual visual review (desktop and narrow viewport, nearly full board, ghost on) not performed'
beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
  delete process.env.SPECRAILS_LOOPS_SECTION
  db = initDb(':memory:')
  for (const id of ['run', 'child']) {
    createLoopRun(db, { id, projectId: 'p', loopId: 'loop', loopName: 'Implement', railIndex: null, ticketId: null, provider: 'claude', model: 'sonnet', iterationLimit: 1, startedAt: new Date().toISOString() })
  }
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'completed', final_outcome = 'failed', failure_diagnosis = ? WHERE id = 'run'")
    .run(serializeDiagnosis({ kind: 'incomplete_tasks', confidence: 'high', phase: 'tasks', rounds: null, resetAt: null, detail: 'unfinished', resumablePhase: null, source: 'test', remedies: [], incompleteTasks: [TASK] } as never))
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'paused', restart_reason = 'fork' WHERE id = 'child'").run()
  runtime.probe.mockResolvedValue({ status: 'paused', resumable: true, lease: null, pendingInterrupts: [], recoverableSteps: [{ attemptId: 'attempt', nodePath: 'developer', scopeId: 'root' }] })
  runtime.prepare.mockReturnValue({ requestId: 'remedy-retry-with-browser-x', fromNodePath: 'developer', scopeId: 'root', visit: 2, state: { $vars: {} } })
  runtime.fork.mockResolvedValue({ loopRunId: 'child', forkOf: 'run', fromNodePath: 'developer', scopeId: 'root', visit: 2 })
  runtime.signal.mockImplementation(async () => { order.push('signal'); return { id: 's1', acceptedAt: new Date().toISOString() } })
  begin.mockImplementation(() => { order.push('resume'); return new Promise(() => {}) })
})
afterEach(() => db.close())

function api() {
  const app = express(), router = express.Router()
  app.use(express.json())
  registerLoopRunRoutes({ router, ctx: () => ({ db, project: { id: 'p', path: '/repo' }, loopRunManager: { beginDefinitionResume: begin, isDefinitionRunActive: () => false, cancelDefinition: vi.fn(), isDisposed: () => false }, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
  app.use('/api', router)
  return request(app)
}

describe('incomplete-tasks remedy route', () => {
  it('retry with the browser queues the browser guidance for the restarted developer before the fork resumes', async () => {
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'retry-with-browser' })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ loopRunId: 'child', remedy: 'retry-with-browser', guided: true })
    expect(runtime.signal).toHaveBeenCalledTimes(1)
    const [, runId, text, requestId] = runtime.signal.mock.calls[0]
    expect(runId).toBe('child')
    expect(text).toContain(TASK)
    expect(text).toContain('$SPECRAILS_BROWSE')
    expect(text).toContain('$PORT')
    expect(text).toMatch(/install it/i)
    expect(requestId).toBe('remedy-browser-child')
    expect(order).toEqual(['signal', 'resume'])
  })

  it('still resumes when the guidance cannot be queued, and says so', async () => {
    runtime.signal.mockRejectedValue(new Error('steering_unsupported'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'retry-with-browser' })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ guided: false })
    expect(begin).toHaveBeenCalled()
  })

  it('continue to review sends no instruction', async () => {
    runtime.prepare.mockReturnValue({ requestId: 'remedy-continue-to-review-x', fromNodePath: 'tasks', scopeId: 'root', visit: 2, state: { $vars: { humanChecks: [TASK] } } })
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue-to-review' })
    expect(result.status).toBe(201)
    expect(result.body.guided).toBeUndefined()
    expect(runtime.signal).not.toHaveBeenCalled()
  })
})
