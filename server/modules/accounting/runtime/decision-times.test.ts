import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { aggregateDecisionTimes, getDecisionTimes, quantile, type DecisionTimeRow } from './decision-times'
import { registerSpendingRoutes } from '../../../project-router-spending'
import type { ProjectContext } from '../../../project-registry'
import type { ProjectRoutesDeps } from '../../../project-router-helpers'

const H = 3_600_000
const iso = (hours: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + hours * H).toISOString()
const row = (over: Partial<DecisionTimeRow>): DecisionTimeRow => ({
  loop_id: 'factory:implement', loop_name: 'Implement', decision: 'on_review',
  on_review_at: null, decided_at: null, merged_at: null, ...over,
})

describe('quantile', () => {
  it('returns null for no data and interpolates otherwise', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([7], 0.9)).toBe(7)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(3) // 2.5 rounded
    expect(quantile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90)
  })
})

describe('aggregateDecisionTimes', () => {
  it('measures median/p90 and keeps unknown and pending distinct from zero', () => {
    const result = aggregateDecisionTimes([
      row({ decision: 'merged', on_review_at: iso(0), decided_at: iso(1), merged_at: iso(5) }),
      row({ decision: 'pr_draft', on_review_at: iso(0), decided_at: iso(3) }),
      row({ decision: 'discarded', on_review_at: iso(0), decided_at: iso(2) }),
      row({ decision: 'on_review', on_review_at: iso(0) }), // awaiting decision
      row({ decision: 'merged' }), // legacy: reviewed + merged, no instants
      row({ decision: 'building' }), // never reviewable: excluded
      row({ decision: 'implementation_failed' }), // excluded
      row({ decision: 'completed', decided_at: iso(1) }), // acknowledged no-changes: never reviewable, excluded
      row({ decision: 'discarded', decided_at: iso(1) }), // discarded preparation failure: excluded
      row({ decision: 'merged', on_review_at: iso(5), decided_at: iso(4), merged_at: iso(6) }), // skew → unknown decision
    ])
    expect(result.deliveries).toBe(6)
    expect(result.toDecision).toEqual({ measured: 3, pending: 1, unknown: 2, medianMs: 2 * H, p90Ms: Math.round(2.8 * H) })
    // merged: 2 measured (5h, 1h); pending: pr_draft + on_review; unknown: legacy merged.
    expect(result.toMerge).toEqual({ measured: 2, pending: 2, unknown: 1, medianMs: 3 * H, p90Ms: Math.round(4.6 * H) })
  })

  it('returns null statistics (not zero) when nothing is measurable', () => {
    expect(aggregateDecisionTimes([])).toEqual({
      deliveries: 0,
      toDecision: { measured: 0, pending: 0, unknown: 0, medianMs: null, p90Ms: null },
      toMerge: { measured: 0, pending: 0, unknown: 0, medianMs: null, p90Ms: null },
    })
    const legacy = aggregateDecisionTimes([row({ decision: 'pr_ready' })])
    expect(legacy.toDecision).toMatchObject({ measured: 0, unknown: 1, medianMs: null })
    expect(legacy.toMerge).toMatchObject({ measured: 0, unknown: 1, medianMs: null })
  })
})

describe('getDecisionTimes + GET /analytics/decision-times', () => {
  let db: DbInstance
  let app: express.Express
  beforeEach(() => {
    db = initDb(':memory:')
    const insert = db.prepare(`INSERT INTO rail_pr_deliveries
      (id, rail_index, loop_id, rail_key, ticket_ids, base_branch, loop_name, decision, on_review_at, decided_at, merged_at, parent_delivery_id, created_at)
      VALUES (?, 0, ?, 'k', '[1]', 'main', ?, ?, ?, ?, ?, ?, ?)`)
    const now = Date.now()
    const recent = (hours: number) => new Date(now - 24 * H + hours * H).toISOString()
    insert.run('a', 'factory:implement', 'Implement', 'merged', recent(0), recent(1), recent(4), null, '2026-01-01 00:00:00')
    insert.run('b', 'factory:implement', 'Implement', 'discarded', recent(0), recent(3), null, null, '2026-01-01 00:00:00')
    insert.run('c', null, 'Quick', 'on_review', recent(2), null, null, null, '2026-01-01 00:00:00')
    // Repository child of a group: counted only through its parent.
    insert.run('child', 'factory:implement', 'Implement', 'merged', recent(0), recent(1), recent(2), 'a', '2026-01-01 00:00:00')
    // Outside the 7d window.
    insert.run('old', 'factory:implement', 'Implement', 'merged', new Date(now - 40 * 24 * H).toISOString(), null, null, null, '2026-01-01 00:00:00')

    const router = express.Router()
    registerSpendingRoutes({
      router, registry: {} as never,
      ctx: () => ({ project: { id: 'p', slug: 'p', path: '/tmp', name: 'P' }, db }) as unknown as ProjectContext,
      ticketPath: (_req: Request) => '/nonexistent/local-tickets.json',
    } as ProjectRoutesDeps)
    app = express()
    app.use('/api/projects', router)
  })
  afterEach(() => db.close())

  it('aggregates per project and per loop inside the window, excluding repository children', () => {
    const result = getDecisionTimes(db, { period: '7d' })
    expect(result.project.deliveries).toBe(3)
    expect(result.project.toDecision).toMatchObject({ measured: 2, pending: 1, unknown: 0, medianMs: 2 * H })
    expect(result.project.toMerge).toMatchObject({ measured: 1, pending: 1, unknown: 0, medianMs: 4 * H, p90Ms: 4 * H })
    expect(result.byLoop.map((loop) => [loop.loopId, loop.loopName, loop.deliveries])).toEqual([
      ['factory:implement', 'Implement', 2],
      [null, 'Quick', 1],
    ])
    expect(getDecisionTimes(db, { period: 'all' }).project.deliveries).toBe(4)
  })

  it('serves the documented shape and validates the period', async () => {
    const ok = await request(app).get('/api/projects/p/analytics/decision-times?period=7d')
    expect(ok.status).toBe(200)
    expect(Object.keys(ok.body).sort()).toEqual(['byLoop', 'from', 'period', 'project', 'to'])
    expect(ok.body.project.toDecision).toEqual(expect.objectContaining({ measured: 2, medianMs: 2 * H }))
    expect((await request(app).get('/api/projects/p/analytics/decision-times?period=bogus')).status).toBe(400)
    expect((await request(app).get('/api/projects/p/analytics/decision-times?period=custom')).status).toBe(400)
  })

  it('reports an empty project with null statistics', async () => {
    db.exec('DELETE FROM rail_pr_deliveries')
    const res = await request(app).get('/api/projects/p/analytics/decision-times')
    expect(res.body.project).toEqual({
      deliveries: 0,
      toDecision: { measured: 0, pending: 0, unknown: 0, medianMs: null, p90Ms: null },
      toMerge: { measured: 0, pending: 0, unknown: 0, medianMs: null, p90Ms: null },
    })
    expect(res.body.byLoop).toEqual([])
  })
})
