import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { recordInvocation } from './ai-invocations'
import { clampDays, computeWhatIf, hasPricing, listPricedModels } from './what-if'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

const NOW = new Date('2026-10-25T12:00:00.000Z')
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const usage = { tokens_in: 1_000_000, tokens_out: 200_000, tokens_cache_read: 0, tokens_cache_create: 0 }

function record(over: { provider?: string; model: string | null; at: string; cost?: number | null; usage?: Partial<typeof usage> }) {
  recordInvocation(db, {
    project_id: 'p1', provider: over.provider ?? 'claude', surface: 'loop', status: 'success', started_at: over.at,
    model: over.model, total_cost_usd: over.cost === undefined ? 1 : over.cost, ...usage, ...over.usage,
  })
}

describe('what-if pricing', () => {
  it('lists the models seen in the window with their rate-card status, newest window only', () => {
    record({ model: 'sonnet', at: day(2), cost: 3 })
    record({ model: 'sonnet', at: day(40), cost: 100 }) // outside 30 days
    record({ provider: 'local', model: 'qwen3-coder', at: day(1), cost: null })
    const overview = computeWhatIf(db, 'p1', 30, null, NOW)
    expect(overview.result).toBeNull()
    expect(overview.sources).toEqual([
      expect.objectContaining({ provider: 'claude', model: 'sonnet', invocations: 1, recordedUsd: 3, priced: true }),
      expect.objectContaining({ provider: 'local', model: 'qwen3-coder', invocations: 1, recordedUsd: null, priced: false }),
    ])
    expect(overview.targets.length).toBe(listPricedModels().length)
  })

  it('re-prices recorded tokens on the other model; both sides are estimates and the delta is their difference', () => {
    record({ model: 'sonnet', at: day(3) })
    record({ model: 'sonnet', at: day(5) })
    const { result } = computeWhatIf(db, 'p1', 30, { from: { provider: 'claude', model: 'sonnet' }, to: { provider: 'claude', model: 'haiku' } }, NOW)
    // sonnet 2.00/10.00 per 1M: 1M in + 0.2M out = 2 + 2 = 4 per run; haiku 1/5: 1 + 1 = 2 per run.
    expect(result).toMatchObject({ invocations: 2, repriced: 2, skipped: 0, estimateCurrentUsd: 8, estimateWhatIfUsd: 4, deltaUsd: -4, noPricing: null })
    expect(result?.tokens).toEqual({ in: 2_000_000, out: 400_000, cacheRead: 0, cacheCreate: 0 })
    expect(result?.recordedUsd).toBe(2) // recorded cost is reported apart, never part of the delta
  })

  it('says there is no pricing instead of guessing', () => {
    record({ model: 'sonnet', at: day(1) })
    record({ provider: 'local', model: 'qwen3-coder', at: day(1), cost: null })
    const toUnknown = computeWhatIf(db, 'p1', 30, { from: { provider: 'claude', model: 'sonnet' }, to: { provider: 'codex', model: 'gpt-9-imaginary' } }, NOW).result
    expect(toUnknown).toMatchObject({ estimateWhatIfUsd: null, deltaUsd: null, noPricing: { side: 'to', provider: 'codex', model: 'gpt-9-imaginary' } })
    const fromUnknown = computeWhatIf(db, 'p1', 30, { from: { provider: 'local', model: 'qwen3-coder' }, to: { provider: 'claude', model: 'haiku' } }, NOW).result
    expect(fromUnknown).toMatchObject({ estimateCurrentUsd: null, deltaUsd: null, noPricing: { side: 'from', model: 'qwen3-coder' } })
    expect(hasPricing({ provider: 'claude', model: 'claude-sonnet-5-5' })).toBe(true)
    expect(hasPricing({ provider: 'local', model: 'x' })).toBe(false)
  })

  it('skips invocations without token usage and keeps other projects out', () => {
    record({ model: 'sonnet', at: day(1) })
    record({ model: 'sonnet', at: day(1), usage: { tokens_in: 0, tokens_out: 0 } })
    recordInvocation(db, { project_id: 'other', provider: 'claude', surface: 'loop', status: 'success', started_at: day(1), model: 'sonnet', total_cost_usd: 50, ...usage })
    const { result } = computeWhatIf(db, 'p1', 30, { from: { provider: 'claude', model: 'sonnet' }, to: { provider: 'claude', model: 'haiku' } }, NOW)
    expect(result).toMatchObject({ invocations: 2, repriced: 1, skipped: 1, estimateCurrentUsd: 4, estimateWhatIfUsd: 2 })
  })

  it('applies a long-context tier per invocation, not on the sum', () => {
    const big = { tokens_in: 250_000, tokens_out: 0 }
    const small = { tokens_in: 100_000, tokens_out: 0 }
    record({ provider: 'gemini', model: 'gemini-2.5-pro', at: day(1), usage: big })
    record({ provider: 'gemini', model: 'gemini-2.5-pro', at: day(1), usage: small })
    const { result } = computeWhatIf(db, 'p1', 30, { from: { provider: 'gemini', model: 'gemini-2.5-pro' }, to: { provider: 'gemini', model: 'gemini-2.5-flash' } }, NOW)
    // 250k at the >200k tier (2.50/1M = 0.625) + 100k at 1.25/1M (0.125) = 0.75; summing first (350k) would give 0.875 -> tier on the sum is wrong.
    expect(result?.estimateCurrentUsd).toBe(0.75)
  })

  it('clamps the window', () => {
    expect(clampDays('7')).toBe(7)
    expect(clampDays('0')).toBe(30)
    expect(clampDays('abc')).toBe(30)
    expect(clampDays('9999')).toBe(365)
  })
})
