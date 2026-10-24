import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createLoopRun, finishLoopRun } from '../../loops/runtime/loop-runs-store'
import { forecastFromSamples, getLaunchForecast } from './launch-forecast'
import { createDailyBudgetHeadroom } from './daily-budget-gate'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

let seq = 0
function loopRun(opts: { loopId?: string; ms: number; cost?: number; provider?: string | null; estimated?: boolean; projectId?: string }): string {
  const id = `run-${++seq}`
  createLoopRun(db, {
    id, projectId: opts.projectId ?? 'proj', loopId: opts.loopId ?? 'loop-a', loopName: 'L', iterationLimit: 1,
    provider: opts.provider === undefined ? 'claude' : opts.provider ?? undefined,
    startedAt: new Date(Date.now() - (1000 - seq) * 1000).toISOString(),
  } as Parameters<typeof createLoopRun>[1])
  finishLoopRun(db, id, { outcome: 'success', finishedAt: new Date().toISOString(), counters: { totalDurationMs: opts.ms, totalCostUsd: opts.cost ?? 0 } } as Parameters<typeof finishLoopRun>[2])
  if (opts.estimated) {
    db.prepare(`INSERT INTO ai_invocations (id, project_id, provider, surface, status, started_at, total_cost_usd, total_cost_usd_estimated, loop_run_id)
                VALUES (?, 'proj', 'claude', 'loop', 'completed', datetime('now'), ?, 1, ?)`).run(`inv-${id}`, opts.cost ?? 0, id)
  }
  return id
}

function job(opts: { command?: string; ms: number; cost?: number | null; provider?: string | null; estimated?: boolean }): void {
  db.prepare(`INSERT INTO jobs (id, command, status, duration_ms, started_at, total_cost_usd, total_cost_usd_estimated, provider)
              VALUES (?, ?, 'completed', ?, datetime('now', ?), ?, ?, ?)`)
    .run(`job-${++seq}`, opts.command ?? '/specrails:implement #1 --yes', opts.ms, `-${1000 - seq} seconds`, opts.cost ?? null, opts.estimated ? 1 : 0, opts.provider === undefined ? 'claude' : opts.provider)
}

describe('forecastFromSamples', () => {
  it('has no band below the sample floor, for time and for cost independently', () => {
    const four = [1, 2, 3, 4].map((n) => ({ ms: n * 60_000, costUsd: n }))
    expect(forecastFromSamples(four)).toMatchObject({ time: null, cost: null, minSamples: 5 })
    // Five runs, but only three carry a provider-reported cost: time yes, cost no.
    const mixed = [1, 2, 3, 4, 5].map((n) => ({ ms: n * 60_000, costUsd: n <= 3 ? n : null }))
    const forecast = forecastFromSamples(mixed)
    expect(forecast.time).toMatchObject({ sampleCount: 5 })
    expect(forecast.cost).toBeNull()
  })

  it('reports the interquartile band at cents precision', () => {
    const samples = [1.011, 2.02, 3.03, 4.04, 5.055, 6.06, 7.07, 8.08].map((cost, i) => ({ ms: (i + 1) * 60_000, costUsd: cost }))
    const forecast = forecastFromSamples(samples)
    expect(forecast.time).toMatchObject({ p25Ms: 120_000, p75Ms: 360_000, sampleCount: 8 })
    expect(forecast.cost).toEqual({ lowUsd: 2.02, highUsd: 6.06, sampleCount: 8 })
  })
})

describe('getLaunchForecast — loops', () => {
  it('reads the same samples as the "runs like this" band, narrowed to the provider', () => {
    for (let i = 1; i <= 5; i++) loopRun({ ms: i * 60_000, cost: i, provider: 'claude' })
    for (let i = 1; i <= 5; i++) loopRun({ ms: i * 600_000, cost: i * 10, provider: 'codex' })
    const claude = getLaunchForecast(db, 'proj', { loopId: 'loop-a', provider: 'claude' })
    expect(claude.time).toMatchObject({ p25Ms: 120_000, p75Ms: 240_000, sampleCount: 5 })
    expect(claude.cost).toEqual({ lowUsd: 2, highUsd: 4, sampleCount: 5 })
    const codex = getLaunchForecast(db, 'proj', { loopId: 'loop-a', provider: 'codex' })
    expect(codex.time).toMatchObject({ p25Ms: 1_200_000 })
    // No provider filter: every settled run of the loop.
    expect(getLaunchForecast(db, 'proj', { loopId: 'loop-a' }).time?.sampleCount).toBe(10)
  })

  it('says nothing for another provider, project or loop without enough history', () => {
    for (let i = 1; i <= 5; i++) loopRun({ ms: i * 60_000, cost: i })
    expect(getLaunchForecast(db, 'proj', { loopId: 'loop-a', provider: 'gemini' })).toMatchObject({ time: null, cost: null })
    expect(getLaunchForecast(db, 'other', { loopId: 'loop-a' })).toMatchObject({ time: null, cost: null })
    expect(getLaunchForecast(db, 'proj', { loopId: 'loop-b' })).toMatchObject({ time: null, cost: null })
  })

  it('never mixes estimated costs into the billed band (they still inform the time band)', () => {
    for (let i = 1; i <= 5; i++) loopRun({ ms: i * 60_000, cost: i, estimated: i > 2 })
    const forecast = getLaunchForecast(db, 'proj', { loopId: 'loop-a', provider: 'claude' })
    expect(forecast.time?.sampleCount).toBe(5)
    expect(forecast.cost).toBeNull() // only 2 provider-reported costs left
  })

  it('treats a run with no recorded cost as unknown, not as free', () => {
    for (let i = 1; i <= 5; i++) loopRun({ ms: i * 60_000, cost: 0 })
    const forecast = getLaunchForecast(db, 'proj', { loopId: 'loop-a' })
    expect(forecast.time).not.toBeNull()
    expect(forecast.cost).toBeNull()
  })
})

describe('getLaunchForecast — factory modes and commands', () => {
  it('maps the built-in Implement/Freestyle loops to their slash-command jobs', () => {
    for (let i = 1; i <= 5; i++) job({ ms: i * 60_000, cost: i })
    for (let i = 1; i <= 5; i++) job({ command: '/specrails:freestyle #3 --yes', ms: i * 120_000, cost: i * 2 })
    expect(getLaunchForecast(db, 'proj', { loopId: 'factory:implement', provider: 'claude' }).time).toMatchObject({ p25Ms: 120_000 })
    expect(getLaunchForecast(db, 'proj', { loopId: 'factory:batch' }).time?.sampleCount).toBe(5)
    expect(getLaunchForecast(db, 'proj', { loopId: 'factory:freestyle' }).cost).toEqual({ lowUsd: 4, highUsd: 8, sampleCount: 5 })
    expect(getLaunchForecast(db, 'proj', { commandShape: '/specrails:implement' }).time?.sampleCount).toBe(5)
  })

  it('filters jobs by provider, ignores estimated costs and missing provider rows', () => {
    for (let i = 1; i <= 5; i++) job({ ms: i * 60_000, cost: i, provider: 'claude' })
    for (let i = 1; i <= 5; i++) job({ ms: i * 60_000, cost: i, provider: 'codex', estimated: true })
    for (let i = 1; i <= 5; i++) job({ ms: i * 60_000, cost: i, provider: null })
    const codex = getLaunchForecast(db, 'proj', { commandShape: '/specrails:implement', provider: 'codex' })
    expect(codex.time?.sampleCount).toBe(5)
    expect(codex.cost).toBeNull()
    expect(getLaunchForecast(db, 'proj', { commandShape: '/specrails:implement', provider: 'claude' }).cost?.sampleCount).toBe(5)
  })

  it('is empty without a target', () => {
    expect(getLaunchForecast(db, 'proj', {})).toMatchObject({ time: null, cost: null })
  })
})

describe('createDailyBudgetHeadroom', () => {
  const setProjectBudget = (usd: number) => db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', ?)`).run(String(usd))
  const spend = (usd: number) => db.prepare(`INSERT INTO ai_invocations (id, project_id, provider, surface, status, started_at, total_cost_usd)
    VALUES (?, 'proj', 'claude', 'loop', 'completed', ?, ?)`).run(`s-${++seq}`, new Date().toISOString(), usd)
  const at = () => new Date()

  it('is null when no budget is configured', () => {
    expect(createDailyBudgetHeadroom({ db, projectId: 'proj', now: at })()).toBeNull()
  })

  it('reports the project budget with today\'s spend', () => {
    setProjectBudget(10)
    spend(2.5)
    expect(createDailyBudgetHeadroom({ db, projectId: 'proj', now: at })()).toMatchObject({ scope: 'project', budgetUsd: 10, spentUsd: 2.5, exhausted: false })
  })

  it('picks the scope with the least money left and flags an exhausted budget', () => {
    setProjectBudget(10)
    spend(1)
    const desktop = () => ({ budget: 3, totalSpend: 2 })
    expect(createDailyBudgetHeadroom({ db, projectId: 'proj', desktop, now: at })()).toMatchObject({ scope: 'desktop', budgetUsd: 3, spentUsd: 2, exhausted: false })
    const spent = () => ({ budget: 3, totalSpend: 3 })
    expect(createDailyBudgetHeadroom({ db, projectId: 'proj', desktop: spent, now: at })()).toMatchObject({ scope: 'desktop', exhausted: true })
  })

  it('fails open when the budget cannot be read', () => {
    const broken = { prepare: () => { throw new Error('boom') } } as unknown as DbInstance
    expect(createDailyBudgetHeadroom({ db: broken, projectId: 'proj', now: at })()).toBeNull()
  })
})
