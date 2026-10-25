import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'
import { registerSpendingRoutes } from './project-router-spending'
import { recordInvocation } from './modules/accounting/runtime/ai-invocations'
import { createDailyBudgetGate, readCapStatuses } from './modules/execution/runtime/daily-budget-gate'
import { initDb, type DbInstance } from './db'
import { initDesktopDb, setDesktopSetting } from './desktop-db'
import type { ProjectContext } from './project-registry'
import type { ProjectRoutesDeps } from './project-router-helpers'

// CD5 HTTP surface: caps beyond the daily budget, the Budget panel read model and what-if.

const PROJECT_ID = 'proj-1'
let db: DbInstance
let desktopDb: DbInstance
let app: express.Express

beforeEach(() => {
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  const ctx = () => ({
    project: { id: PROJECT_ID, slug: 'proj', path: '/tmp/none', name: 'Proj' },
    db,
    budgetCaps: (at?: Date) => readCapStatuses({ db, projectId: PROJECT_ID }, at ?? new Date()),
  }) as unknown as ProjectContext
  const router = express.Router()
  registerSpendingRoutes({ router, registry: { desktopDb } as never, ctx, ticketPath: (_req: Request) => '/tmp/none.json' } as ProjectRoutesDeps)
  app = express()
  app.use(express.json())
  app.use('/api/projects', router)
})
afterEach(() => { db.close(); desktopDb.close() })

const spend = (cost: number, over: { provider?: string; model?: string; at?: Date; usage?: boolean } = {}) =>
  recordInvocation(db, {
    project_id: PROJECT_ID, provider: over.provider ?? 'claude', surface: 'loop', status: 'success',
    started_at: (over.at ?? new Date()).toISOString(), total_cost_usd: cost, model: over.model ?? 'sonnet',
    ...(over.usage === false ? {} : { tokens_in: 1_000_000, tokens_out: 0 }),
  })

describe('PATCH/GET /budget — weekly, monthly and per-run caps', () => {
  it('sets, reads back and clears each cap independently', async () => {
    const url = `/api/projects/${PROJECT_ID}/budget`
    expect((await request(app).patch(url).send({ weeklyBudgetUsd: 50, monthlyBudgetUsd: 200, runCapUsd: 5 })).status).toBe(200)
    expect((await request(app).get(url)).body).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: 50, monthlyBudgetUsd: 200, runCapUsd: 5 })
    await request(app).patch(url).send({ weeklyBudgetUsd: null })
    expect((await request(app).get(url)).body).toMatchObject({ weeklyBudgetUsd: null, monthlyBudgetUsd: 200, runCapUsd: 5 })
  })

  it('rejects a non-positive or non-numeric cap without writing anything', async () => {
    const url = `/api/projects/${PROJECT_ID}/budget`
    for (const bad of [0, -3, '5', true]) {
      const res = await request(app).patch(url).send({ monthlyBudgetUsd: bad, weeklyBudgetUsd: 9 })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_cap', field: 'monthlyBudgetUsd' })
    }
    expect((await request(app).get(url)).body.weeklyBudgetUsd).toBeNull()
  })

  it('a configured cap is enforced by the very gate the launch doors use', async () => {
    await request(app).patch(`/api/projects/${PROJECT_ID}/budget`).send({ monthlyBudgetUsd: 10 })
    spend(10.5)
    expect(createDailyBudgetGate({ db, projectId: PROJECT_ID })()).toMatchObject({ error: 'daily_budget_exceeded', period: 'month', budgetUsd: 10 })
  })
})

describe('GET /budget/caps', () => {
  it('returns the caps with spend, the provider split, the projection and the app-wide config', async () => {
    setDesktopSetting(desktopDb, 'desktop_monthly_budget_usd', '500')
    await request(app).patch(`/api/projects/${PROJECT_ID}/budget`).send({ weeklyBudgetUsd: 5 })
    spend(6)
    spend(1, { provider: 'codex', model: 'gpt-5.5' })
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/budget/caps`)
    expect(res.status).toBe(200)
    expect(res.body.config).toEqual({ day: null, week: 5, month: null, run: null })
    expect(res.body.appConfig).toEqual({ day: null, week: null, month: 500, run: null })
    expect(res.body.caps).toEqual([expect.objectContaining({ scope: 'project', period: 'week', budgetUsd: 5, spentUsd: 7, exhausted: true })])
    expect(res.body.spend.day.usd).toBe(7)
    expect(res.body.spend.day.byProvider.map((p: { provider: string }) => p.provider)).toEqual(['claude', 'codex'])
    expect(res.body.projection).toBeNull() // nothing before today: no honest extrapolation
  })
})

describe('GET /budget/what-if', () => {
  it('lists sources and targets, and prices a pair as an estimate', async () => {
    spend(2)
    const url = `/api/projects/${PROJECT_ID}/budget/what-if`
    const list = await request(app).get(url)
    expect(list.status).toBe(200)
    expect(list.body.result).toBeNull()
    expect(list.body.sources).toEqual([expect.objectContaining({ provider: 'claude', model: 'sonnet', priced: true })])
    const priced = await request(app).get(`${url}?from=claude:sonnet&to=claude:haiku&days=30`)
    expect(priced.body.result).toMatchObject({ estimateCurrentUsd: 2, estimateWhatIfUsd: 1, deltaUsd: -1, noPricing: null })
    const unknown = await request(app).get(`${url}?from=claude:sonnet&to=codex:nope`)
    expect(unknown.body.result).toMatchObject({ deltaUsd: null, noPricing: { side: 'to', model: 'nope' } })
  })

  it('rejects a malformed model reference', async () => {
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/budget/what-if?from=sonnet&to=claude:haiku`)
    expect(res.status).toBe(400)
  })
})
