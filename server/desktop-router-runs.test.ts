// GET /api/runs: the app-wide run read model behind MCP `runs(list)` without a
// project. Live runs (with their hold) first, then history, newest first, paged
// with a keyset cursor; bounded per project, so 100 projects stay fast.
import { describe, it, expect, beforeAll } from 'vitest'
import express, { Router } from 'express'
import request from 'supertest'
import { initDb, createJob, type DbInstance } from './db'
import { addProject, initDesktopDb } from './desktop-db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { registerAnalyticsRoutes } from './desktop-router-analytics'
import type { ProjectRegistry } from './project-registry'

interface FakeContext { db: DbInstance; project: { id: string; slug: string; name: string; path: string }; restartPendingRunIds?: Set<string>; loopRunManager: Record<string, unknown> }

function project(id: string, extra: Partial<FakeContext> = {}): FakeContext {
  return {
    db: initDb(':memory:'),
    project: { id, slug: id, name: id, path: `/tmp/${id}` },
    loopRunManager: { isPaused: () => false, pendingInterrupts: () => [], budgetPause: () => null, limitPause: () => null },
    ...extra,
  }
}

function appOf(contexts: FakeContext[], registered = contexts.length) {
  const desktopDb = initDesktopDb(':memory:')
  for (let i = 0; i < registered; i++) addProject(desktopDb, { id: `reg-${i}`, slug: `reg-${i}`, name: `reg-${i}`, path: `/tmp/reg-${i}` })
  const registry = { desktopDb, listContexts: () => contexts } as unknown as ProjectRegistry
  const router = Router()
  registerAnalyticsRoutes(router, { registry })
  const app = express()
  app.use('/api', router)
  return app
}

const job = (ctx: FakeContext, id: string, startedAt: string, status: string) => {
  createJob(ctx.db, { id, command: `/specrails:implement #${id}`, started_at: startedAt, provider: 'claude' })
  if (status !== 'running') ctx.db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(status, startedAt, id)
}

type Listed = { id: string; projectId: string; status: string; hold?: { kind: string } }
const ids = (runs: Listed[]) => runs.map((run) => `${run.projectId}/${run.id}`)

describe('GET /api/runs (cross-project run read model)', () => {
  it('lists live runs (with their hold) before history, newest first, across projects', async () => {
    const a = project('a', { restartPendingRunIds: new Set(['a-held']) })
    const b = project('b')
    job(a, 'a-old', '2026-11-20T08:00:00.000Z', 'completed')
    job(b, 'b-new', '2026-11-21T09:00:00.000Z', 'failed')
    job(b, 'b-live', '2026-11-21T07:00:00.000Z', 'running')
    // A loop run the restart cut: its row stays running, its hold says why.
    createLoopRun(a.db, { id: 'a-held', projectId: 'a', loopId: 'factory:implement', loopName: 'Implement', railIndex: 0, ticketId: 1, provider: 'claude', model: 'haiku', reasoningEffort: null, iterationLimit: 1, startedAt: '2026-11-19T10:00:00.000Z' })
    createJob(a.db, { id: 'a-held', command: 'loop: Implement #1', started_at: '2026-11-19T10:00:00.000Z', provider: 'claude', owner: 'loop' })
    const res = await request(appOf([a, b])).get('/api/runs')
    expect(res.status).toBe(200)
    expect(ids(res.body.runs)).toEqual(['b/b-live', 'a/a-held', 'b/b-new', 'a/a-old'])
    const byId = Object.fromEntries((res.body.runs as Listed[]).map((run) => [run.id, run]))
    expect(byId['a-held'].hold).toMatchObject({ kind: 'restart' })
    expect(byId['b-live'].hold).toBeUndefined()
    expect(res.body.next).toBeNull()
    expect(res.body.projects).toEqual({ loaded: 2, notLoaded: 0, failed: [] })
  })

  it('pages with a keyset cursor that never repeats or skips a run, ties included', async () => {
    const contexts = ['a', 'b', 'c'].map((id) => project(id))
    // Same start time in every project: the tie is ordered by project, then run id.
    for (const ctx of contexts) for (let i = 0; i < 4; i++) job(ctx, `${ctx.project.id}${i}`, i < 2 ? '2026-11-21T10:00:00.000Z' : `2026-11-2${i}T10:00:00.000Z`, i === 3 ? 'running' : 'completed')
    const app = appOf(contexts)
    const seen: string[] = []
    let after: string | null = null
    for (let page = 0; page < 10; page++) {
      const res = await request(app).get(`/api/runs?limit=5${after ? `&after=${after}` : ''}`)
      seen.push(...ids(res.body.runs))
      after = res.body.next
      if (!after) break
    }
    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
    expect(seen.slice(0, 3)).toEqual(['a/a3', 'b/b3', 'c/c3'])
    expect((await request(app).get('/api/runs?after=not-a-cursor')).status).toBe(400)
  })

  it('narrows by status and start time; counts projects still loading; one failing project does not fail the list', async () => {
    const a = project('a')
    const broken = project('broken')
    job(a, 'ok', '2026-11-21T10:00:00.000Z', 'completed')
    job(a, 'bad', '2026-11-21T11:00:00.000Z', 'failed')
    job(a, 'old', '2026-10-01T11:00:00.000Z', 'failed')
    broken.db.close()
    const res = await request(appOf([a, broken], 5)).get('/api/runs?status=failed&from=2026-11-01T00:00:00.000Z')
    expect(ids(res.body.runs)).toEqual(['a/bad'])
    expect(res.body.projects).toEqual({ loaded: 2, notLoaded: 3, failed: ['broken'] })
  })

  describe('at 100 projects', () => {
    let app: ReturnType<typeof appOf>
    beforeAll(() => {
      const contexts: FakeContext[] = []
      for (let p = 0; p < 100; p++) {
        const ctx = project(`p${String(p).padStart(3, '0')}`)
        const insert = ctx.db.prepare("INSERT INTO jobs (id, command, started_at, finished_at, status) VALUES (?, ?, ?, ?, ?)")
        ctx.db.transaction(() => {
          for (let j = 0; j < 300; j++) {
            const at = new Date(Date.UTC(2026, 9, 1) + (j * 100 + p) * 60_000).toISOString()
            insert.run(`j${j}`, `/specrails:implement #${j}`, at, j % 50 === 0 ? null : at, j % 50 === 0 ? 'running' : j % 7 === 0 ? 'failed' : 'completed')
          }
        })()
        contexts.push(ctx)
      }
      app = appOf(contexts)
    })

    it('answers a page in well under 250 ms at p95 (first page and deep pages)', async () => {
      const times: number[] = []
      let after: string | null = null
      for (let i = 0; i < 30; i++) {
        const started = performance.now()
        const res = await request(app).get(`/api/runs?limit=25${after ? `&after=${after}` : ''}`)
        times.push(performance.now() - started)
        expect(res.body.runs).toHaveLength(25)
        after = i % 10 === 9 ? null : res.body.next
      }
      times.sort((x, y) => x - y)
      const p95 = times[Math.floor(times.length * 0.95) - 1]
      console.info(`[runs read model] 100 projects × 300 runs: p50 ${times[15].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`)
      expect(p95).toBeLessThan(250)
      // Live runs first: 6 per project are running.
      const first = await request(app).get('/api/runs?limit=25')
      expect((first.body.runs as Listed[]).every((run) => run.status === 'running')).toBe(true)
    })
  })
})
