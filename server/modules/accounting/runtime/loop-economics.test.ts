import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express, { type Request } from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import {
  aggregateLoopEconomics, countLoopRounds, getLoopEconomics, isDelivered, listRecentDeliveries,
  requirementsFromSettleEvidence, summarizeInvocationCost, type LoopEconomicsDelivery, type LoopEconomicsDeliveryRow,
} from './loop-economics'
import { recordInvocation } from './ai-invocations'
import { registerSpendingRoutes } from '../../../project-router-spending'
import { mutateStore, type Ticket } from '../../specs/runtime/ticket-store'
import type { ProjectContext } from '../../../project-registry'
import type { ProjectRoutesDeps } from '../../../project-router-helpers'

const H = 3_600_000
const deliveryRow = (over: Partial<LoopEconomicsDeliveryRow>): LoopEconomicsDeliveryRow => ({
  id: 'd', loop_id: 'factory:implement', loop_name: 'Implement', decision: 'on_review', run_ids: '[]',
  implementation_outcome: 'succeeded', on_review_at: null, decided_at: null, merged_at: null, ...over,
})
const joined = (over: Partial<LoopEconomicsDelivery> & { row: LoopEconomicsDeliveryRow }): LoopEconomicsDelivery => ({
  cost: summarizeInvocationCost([]), rounds: null, escapedDefects: 0, ...over,
})

describe('isDelivered', () => {
  it('counts deliveries that reached review or beyond', () => {
    expect(isDelivered(deliveryRow({ decision: 'on_review' }))).toBe(true)
    expect(isDelivered(deliveryRow({ decision: 'merged' }))).toBe(true)
    expect(isDelivered(deliveryRow({ decision: 'superseded' }))).toBe(true)
    expect(isDelivered(deliveryRow({ decision: 'discarded', on_review_at: '2026-10-01T00:00:00Z' }))).toBe(true)
    // Legacy discard of a succeeded implementation was reviewable.
    expect(isDelivered(deliveryRow({ decision: 'discarded', implementation_outcome: 'succeeded' }))).toBe(true)
  })
  it('excludes never-reviewable rows', () => {
    expect(isDelivered(deliveryRow({ decision: 'building', implementation_outcome: 'running' }))).toBe(false)
    expect(isDelivered(deliveryRow({ decision: 'implementation_failed', implementation_outcome: 'failed' }))).toBe(false)
    expect(isDelivered(deliveryRow({ decision: 'discarded', implementation_outcome: 'failed' }))).toBe(false)
    expect(isDelivered(deliveryRow({ decision: 'no_changes' }))).toBe(false)
  })
})

describe('summarizeInvocationCost', () => {
  it('splits authoritative from estimated and keeps unknown cost null', () => {
    expect(summarizeInvocationCost([
      { total_cost_usd: 2, total_cost_usd_estimated: 0 },
      { total_cost_usd: 0.5, total_cost_usd_estimated: 1 },
      { total_cost_usd: null, total_cost_usd_estimated: 0 },
    ])).toEqual({ invocations: 3, pricedInvocations: 2, unpricedInvocations: 1, costUsd: 2.5, authoritativeUsd: 2, estimatedUsd: 0.5 })
    expect(summarizeInvocationCost([{ total_cost_usd: null, total_cost_usd_estimated: 0 }]).costUsd).toBeNull()
    expect(summarizeInvocationCost([]).costUsd).toBeNull()
  })
})

describe('countLoopRounds', () => {
  it('counts reviewer and fixer steps, ignoring stall retries', () => {
    expect(countLoopRounds([
      { node_id: 'architect', attempt: null }, { node_id: 'reviewer', attempt: null }, { node_id: 'fixer', attempt: null },
      { node_id: 'fixer', attempt: 2 }, { node_id: 'Reviewer', attempt: null }, { node_id: 'review-policy', attempt: null },
      { node_id: null, attempt: null },
    ])).toEqual({ review: 2, fixer: 1 })
  })
  it('returns null (unknown) when no step was recorded', () => {
    expect(countLoopRounds([])).toBeNull()
  })
})

describe('aggregateLoopEconomics', () => {
  it('aggregates mixed authoritative / estimated / unknown cost without manufacturing zero', () => {
    const group = aggregateLoopEconomics([
      joined({ row: deliveryRow({ id: 'a', decision: 'merged', on_review_at: '2026-10-01T00:00:00Z', decided_at: '2026-10-01T01:00:00Z', merged_at: '2026-10-01T02:00:00Z' }),
        cost: summarizeInvocationCost([{ total_cost_usd: 2, total_cost_usd_estimated: 0 }]), rounds: { review: 2, fixer: 1 } }),
      joined({ row: deliveryRow({ id: 'b', decision: 'discarded', on_review_at: '2026-10-01T00:00:00Z' }),
        cost: summarizeInvocationCost([{ total_cost_usd: 1, total_cost_usd_estimated: 1 }, { total_cost_usd: null, total_cost_usd_estimated: 0 }]) }),
      joined({ row: deliveryRow({ id: 'c', decision: 'on_review', on_review_at: '2026-10-01T00:00:00Z' }),
        cost: summarizeInvocationCost([{ total_cost_usd: null, total_cost_usd_estimated: 0 }]) }),
      joined({ row: deliveryRow({ id: 'x', decision: 'implementation_failed', implementation_outcome: 'failed' }),
        cost: summarizeInvocationCost([{ total_cost_usd: 9, total_cost_usd_estimated: 0 }]) }),
    ], false)
    expect(group).toMatchObject({ hasData: true, delivered: 3, merged: 1, discarded: 1, onReview: 1, superseded: 0, discardRate: 0.333333 })
    expect(group.cost).toEqual({
      pricedDeliveries: 2, unpricedDeliveries: 1, incompleteDeliveries: 1,
      totalUsd: 3, authoritativeUsd: 2, estimatedUsd: 1, avgCostUsd: 1.5, estimatedShare: 0.333333,
    })
    expect(group.rounds).toEqual({ measuredDeliveries: 1, reviewRounds: 2, fixerRounds: 1, reviewPerDelivery: 2, fixerPerDelivery: 1 })
    expect(group.decisionTimes.toDecision).toMatchObject({ measured: 1, medianMs: H })
    expect(group.decisionTimes.toMerge).toMatchObject({ measured: 1, medianMs: 2 * H })
    expect(group.escapedDefects).toBeNull()
    expect(group.requirementsDemonstrated).toBeNull()
    expect(group.triageAccuracy).toBeNull()
  })

  it('reports no data (nulls) for an empty or never-reviewed group', () => {
    for (const group of [aggregateLoopEconomics([], true), aggregateLoopEconomics([joined({ row: deliveryRow({ decision: 'building', implementation_outcome: 'running' }) })], true)]) {
      expect(group.hasData).toBe(false)
      expect(group.delivered).toBe(0)
      expect(group.discardRate).toBeNull()
      expect(group.cost.avgCostUsd).toBeNull()
      expect(group.cost.estimatedShare).toBeNull()
      expect(group.rounds.reviewPerDelivery).toBeNull()
    }
  })

  it('counts escaped defects only when the project tracks them', () => {
    const items = [joined({ row: deliveryRow({ decision: 'merged' }), escapedDefects: 2 }), joined({ row: deliveryRow({ id: 'e', decision: 'merged' }) })]
    expect(aggregateLoopEconomics(items, true).escapedDefects).toBe(2)
    expect(aggregateLoopEconomics(items, false).escapedDefects).toBeNull()
  })

  it('keeps estimatedShare null when the priced total is zero', () => {
    const group = aggregateLoopEconomics([joined({ row: deliveryRow({}), cost: summarizeInvocationCost([{ total_cost_usd: 0, total_cost_usd_estimated: 0 }]) })], false)
    expect(group.cost.avgCostUsd).toBe(0)
    expect(group.cost.estimatedShare).toBeNull()
  })
})

function makeTicket(id: number, metadata: Ticket['metadata']): Ticket {
  const now = new Date().toISOString()
  return {
    id, title: `T${id}`, description: '', status: 'todo', priority: 'medium', labels: ['bug'], assignee: null,
    prerequisites: [], metadata, origin_conversation_id: null, is_epic: false, parent_epic_id: null,
    execution_order: null, short_summary: null, created_at: now, updated_at: now, created_by: 'test', source: 'manual',
  }
}

describe('getLoopEconomics + GET /analytics/loop-economics', () => {
  let db: DbInstance
  let app: express.Express
  let tmpDir: string
  let ticketStorePath: string
  const recent = (hours: number) => new Date(Date.now() - 24 * H + hours * H).toISOString()

  function invocation(id: string, runId: string, cost: number | null, estimated = false) {
    recordInvocation(db, {
      id, project_id: 'p', provider: 'claude', surface: 'loop', surface_ref_id: runId, loop_run_id: runId,
      model: 'm', status: 'success', started_at: recent(0), total_cost_usd: cost, total_cost_usd_estimated: estimated,
    } as never)
  }
  function step(runId: string, seq: number, nodeId: string, extra: Record<string, unknown> = {}) {
    db.prepare(`INSERT INTO events (job_id, seq, event_type, payload) VALUES (?, ?, 'loop_step', ?)`)
      .run(runId, seq, JSON.stringify({ index: seq, kind: 'core', title: nodeId, nodeId, iteration: 1, ...extra }))
  }

  beforeEach(() => {
    db = initDb(':memory:')
    db.pragma('foreign_keys = OFF')
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-economics-'))
    ticketStorePath = path.join(tmpDir, 'local-tickets.json')
    const insert = db.prepare(`INSERT INTO rail_pr_deliveries
      (id, rail_index, loop_id, rail_key, ticket_ids, base_branch, loop_name, decision, run_ids, implementation_outcome, on_review_at, decided_at, merged_at, parent_delivery_id, created_at)
      VALUES (?, (SELECT COUNT(*) FROM rail_pr_deliveries), ?, 'k', '[1]', 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run('a', 'factory:implement', 'Implement', 'merged', '["run-a"]', 'succeeded', recent(0), recent(1), recent(3), null, recent(0))
    insert.run('b', 'factory:implement', 'Implement', 'discarded', '["run-b"]', 'succeeded', recent(0), recent(2), null, null, recent(0))
    insert.run('f', 'factory:implement', 'Implement', 'implementation_failed', '["run-f"]', 'failed', null, null, null, null, recent(0))
    insert.run('q', 'factory:sdd-quick', 'SDD Quick', 'on_review', '[]', 'succeeded', recent(2), null, null, null, recent(2))
    insert.run('child', 'factory:implement', 'Implement', 'merged', '["run-a"]', 'succeeded', recent(0), recent(1), recent(2), 'a', recent(0))
    invocation('i1', 'run-a', 2)
    invocation('i2', 'run-b', 1, true)
    invocation('i3', 'run-f', 5)
    step('run-a', 1, 'developer'); step('run-a', 2, 'reviewer'); step('run-a', 3, 'fixer'); step('run-a', 4, 'reviewer')
    step('run-b', 1, 'developer'); step('run-b', 2, 'reviewer')

    const router = express.Router()
    registerSpendingRoutes({
      router, registry: {} as never,
      ctx: () => ({ project: { id: 'p', slug: 'p', path: tmpDir, name: 'P' }, db }) as unknown as ProjectContext,
      ticketPath: (_req: Request) => ticketStorePath,
    } as ProjectRoutesDeps)
    app = express()
    app.use('/api/projects', router)
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('aggregates per loop and lists known loops without data', () => {
    const result = getLoopEconomics(db, { period: '7d' }, {
      regressionLinks: [{ ticketId: 7, deliveryId: 'child' }, { ticketId: 8, deliveryId: 'unknown-delivery' }],
      knownLoops: [{ id: 'factory:implement', name: 'Implement' }, { id: 'factory:freestyle', name: 'Freestyle' }],
    })
    expect(result.sources).toEqual({ escapedDefects: 'tracked', requirementsDemonstrated: 'unavailable', triageAccuracy: 'unavailable' })
    expect(result.byLoop.map((loop) => [loop.loopId, loop.hasData, loop.delivered])).toEqual([
      ['factory:implement', true, 2],
      ['factory:sdd-quick', true, 1],
      ['factory:freestyle', false, 0],
    ])
    const implement = result.byLoop[0]
    expect(implement).toMatchObject({ merged: 1, discarded: 1, discardRate: 0.5, escapedDefects: 1 })
    expect(implement.cost).toMatchObject({ pricedDeliveries: 2, totalUsd: 3, authoritativeUsd: 2, estimatedUsd: 1, avgCostUsd: 1.5 })
    expect(implement.rounds).toMatchObject({ measuredDeliveries: 2, reviewPerDelivery: 1.5, fixerPerDelivery: 0.5 })
    const quick = result.byLoop[1]
    expect(quick.cost).toMatchObject({ pricedDeliveries: 0, unpricedDeliveries: 1, avgCostUsd: null })
    expect(quick.rounds.reviewPerDelivery).toBeNull()
    expect(quick.escapedDefects).toBe(0)
    expect(result.byLoop[2]).toMatchObject({ escapedDefects: 0, cost: { avgCostUsd: null }, discardRate: null })
    expect(result.project).toMatchObject({ delivered: 3, merged: 1, discarded: 1, escapedDefects: 1 })
  })

  it('fills requirements demonstrated from the settle evidence spec traces', () => {
    const evidence = (requirements: number, demonstrated: number) => JSON.stringify({ units: [{ specTrace: { requirements, demonstrated: Array.from({ length: demonstrated }, (_, i) => ({ id: `c/r${i}` })) } }] })
    db.prepare(`UPDATE rail_pr_deliveries SET settle_evidence = ? WHERE id = 'a'`).run(evidence(4, 3))
    db.prepare(`UPDATE rail_pr_deliveries SET settle_evidence = ? WHERE id = 'b'`).run(evidence(2, 0))
    const result = getLoopEconomics(db, { period: '7d' })
    expect(result.sources.requirementsDemonstrated).toBe('measured')
    expect(result.byLoop[0].requirementsDemonstrated).toEqual({ demonstrated: 3, total: 6, deliveries: 2 })
    expect(result.byLoop[1].requirementsDemonstrated).toBeNull()
    expect(result.project.requirementsDemonstrated).toEqual({ demonstrated: 3, total: 6, deliveries: 2 })
  })

  it('serves the documented shape, reads regression links from tickets and validates the period', async () => {
    let res = await request(app).get('/api/projects/p/analytics/loop-economics?period=7d')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['byLoop', 'from', 'period', 'project', 'sources', 'to'])
    expect(res.body.sources.escapedDefects).toBe('untracked')
    expect(res.body.project.escapedDefects).toBeNull()

    mutateStore(ticketStorePath, (store) => {
      store.tickets['1'] = makeTicket(1, { regressionOf: 'a' })
      store.tickets['2'] = makeTicket(2, {})
      store.next_id = 3
    })
    res = await request(app).get('/api/projects/p/analytics/loop-economics?period=7d')
    expect(res.body.sources.escapedDefects).toBe('tracked')
    expect(res.body.byLoop.find((loop: { loopId: string }) => loop.loopId === 'factory:implement').escapedDefects).toBe(1)

    expect((await request(app).get('/api/projects/p/analytics/loop-economics?period=bogus')).status).toBe(400)
    expect((await request(app).get('/api/projects/p/analytics/loop-economics?period=custom')).status).toBe(400)
  })

  it('reports an empty project as no data', async () => {
    db.exec('DELETE FROM rail_pr_deliveries')
    const res = await request(app).get('/api/projects/p/analytics/loop-economics')
    expect(res.body.byLoop).toEqual([])
    expect(res.body.project).toMatchObject({ hasData: false, delivered: 0, discardRate: null, cost: { avgCostUsd: null } })
  })

  it('lists recent delivered deliveries for the regression picker', async () => {
    const ids = listRecentDeliveries(db).map((d) => d.id)
    expect(ids[0]).toBe('q') // newest review first; failed builds and children excluded
    expect([...ids].sort()).toEqual(['a', 'b', 'q'])
    const res = await request(app).get('/api/projects/p/analytics/loop-economics/deliveries?limit=1')
    expect(res.status).toBe(200)
    expect(res.body.deliveries).toEqual([{ id: 'q', loopId: 'factory:sdd-quick', loopName: 'SDD Quick', decision: 'on_review', ticketIds: [1], createdAt: expect.any(String) }])
  })
})

describe('requirementsFromSettleEvidence', () => {
  it('sums unit traces and keeps unknown null', () => {
    expect(requirementsFromSettleEvidence(null)).toBeNull()
    expect(requirementsFromSettleEvidence('{"units":[{"runId":"r"}]}')).toBeNull()
    expect(requirementsFromSettleEvidence('{"specTrace": broken')).toBeNull()
    expect(requirementsFromSettleEvidence(JSON.stringify({ units: [{ specTrace: { requirements: 3, demonstrated: [{}, {}] } }, { specTrace: { requirements: 'x', demonstrated: [{}] } }, { specTrace: { demonstrated: 'no' } }] }))).toEqual({ demonstrated: 3, total: 4 })
  })
})
