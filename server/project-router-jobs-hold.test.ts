// A loop run that stopped without settling keeps its job row `running` (it still
// owns its tickets and worktree). GET /jobs and GET /jobs/:id say why with `hold`,
// so no surface shows it as running — including right after a restart, before
// startup recovery reconciled the row.
import { describe, it, expect, beforeEach } from 'vitest'
import express, { Router } from 'express'
import request from 'supertest'
import { initDb, createJob, type DbInstance } from './db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { registerJobsRoutes } from './project-router-jobs'
import type { ProjectRoutesDeps } from './project-router-helpers'

let db: DbInstance

function app(extra: Record<string, unknown> = {}) {
  const server = express()
  server.use(express.json())
  const router = Router()
  const ctx = () => ({
    db,
    project: { id: 'p1', slug: 's1', path: '/repo', provider: 'claude', providers: ['claude'] },
    queueManager: { getJobs: () => [], phasesForCommand: () => [], getInteractiveSettleMode: () => null },
    loopRunManager: { isPaused: () => false, pendingInterrupts: () => [], pausedReason: () => null, budgetPause: () => null, limitPause: () => null, isInteractiveJob: () => false },
    ...extra,
  })
  registerJobsRoutes({ router, ctx, ticketPath: () => undefined } as unknown as ProjectRoutesDeps)
  server.use('/api/projects', router)
  return server
}

function loopJob(id: string) {
  createLoopRun(db, { id, projectId: 'p1', loopId: 'factory:implement', loopName: 'Implement', railIndex: 0, ticketId: 15, provider: 'claude', model: 'haiku', reasoningEffort: null, iterationLimit: 1, startedAt: '2026-11-19T14:35:16.238Z' })
  createJob(db, { id, command: 'loop: Implement #15', started_at: '2026-11-19T14:35:16.238Z', provider: 'claude', owner: 'loop' })
}

beforeEach(() => { db = initDb(':memory:') })

describe('job hold on the job endpoints', () => {
  it('a run the restart paused is listed and detailed with its restart hold; a working one has none', async () => {
    loopJob('held'); loopJob('working')
    db.prepare("UPDATE loop_runs SET status='paused', restart_reason='restart', runtime_status_json=? WHERE id='held'")
      .run(JSON.stringify({ coreStatus: 'running', status: 'interrupted', pendingInterrupts: [], recoverableSteps: [{ attemptId: 'a1', nodePath: 'developer', scopeId: 'root' }] }))
    const list = await request(app()).get('/api/projects/p1/jobs')
    expect(list.status).toBe(200)
    const byId = Object.fromEntries((list.body.jobs as Array<{ id: string; status: string; hold?: { kind: string; step: string } }>).map((job) => [job.id, job]))
    expect(byId.held.status).toBe('running')
    expect(byId.held.hold).toMatchObject({ kind: 'restart', step: 'developer' })
    expect(byId.working.hold).toBeUndefined()
    const detail = await request(app()).get('/api/projects/p1/jobs/held')
    expect(detail.body.job.hold).toMatchObject({ kind: 'restart', step: 'developer' })
    expect(detail.body.job.loopPaused).toBe(true)
  })

  it('on boot, before recovery reconciles it, a run that was running reads as paused by the restart at once', async () => {
    loopJob('booting')
    const pending = new Set(['booting'])
    const booting = await request(app({ restartPendingRunIds: pending })).get('/api/projects/p1/jobs')
    expect(booting.body.jobs[0].hold).toMatchObject({ kind: 'restart' })
    expect((await request(app({ restartPendingRunIds: pending })).get('/api/projects/p1/jobs/booting')).body.job.loopPaused).toBe(true)
    pending.clear()
    expect((await request(app({ restartPendingRunIds: pending })).get('/api/projects/p1/jobs')).body.jobs[0].hold).toBeUndefined()
  })

  it('a live question pause reads as the question', async () => {
    loopJob('asked')
    db.prepare("UPDATE loop_runs SET status='paused' WHERE id='asked'").run()
    const manager = { isPaused: () => true, pendingInterrupts: () => [{ id: 'q', nodePath: 'architect', kind: 'question' }], pausedReason: () => 'Which cache?', budgetPause: () => null, limitPause: () => null, isInteractiveJob: () => false }
    const res = await request(app({ loopRunManager: manager })).get('/api/projects/p1/jobs/asked')
    expect(res.body.job.hold).toMatchObject({ kind: 'question' })
  })
})
