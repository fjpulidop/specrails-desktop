import { describe, expect, it } from 'vitest'
import { barLevel, barPercent, parseBudgetOverview, parseRefKey, parseWhatIf, periodSpentUsd, projectionPassesCap, refKey } from '../budget'

const spend = (usd: number, byProvider: unknown[] = []) => ({ startsAt: 'a', resetsAt: 'b', usd, estimatedUsd: 0, byProvider })
const overview = (over: Record<string, unknown> = {}) => ({
  spend: { day: spend(1), week: spend(5), month: spend(20) },
  projection: null, config: { day: null, week: 50, month: null, run: null }, appConfig: null, caps: [], ...over,
})

describe('bar level and fill (integer cents)', () => {
  it('is caution from 80 % and reached at the exact cent', () => {
    expect(barLevel(7.99, 10)).toBe('ok')
    expect(barLevel(8, 10)).toBe('caution')
    expect(barLevel(9.99, 10)).toBe('caution')
    expect(barLevel(10, 10)).toBe('reached')
    expect(barLevel(0.1 + 0.2, 0.3)).toBe('reached') // float drift must not hide a reached cap
  })
  it('has no level without a cap', () => {
    expect(barLevel(5, null)).toBeNull()
    expect(barLevel(5, 0)).toBeNull()
  })
  it('fills whole percent, never above 100', () => {
    expect(barPercent(2.5, 10)).toBe(25)
    expect(barPercent(1, 3)).toBe(33)
    expect(barPercent(30, 10)).toBe(100)
    expect(barPercent(1, null)).toBe(0)
  })
})

describe('projection against the monthly cap', () => {
  const projection = { trailingDays: 14, avgDailyUsd: 10, monthToDateUsd: 240, remainingDays: 6, projectedUsd: 300 }
  it('warns only when the estimate passes the cap', () => {
    expect(projectionPassesCap(projection, 299.99)).toBe(true)
    expect(projectionPassesCap(projection, 300)).toBe(false)
    expect(projectionPassesCap(projection, null)).toBe(false)
    expect(projectionPassesCap(null, 100)).toBe(false)
  })
})

describe('parseBudgetOverview', () => {
  it('reads a well-formed overview and keeps only valid caps', () => {
    const parsed = parseBudgetOverview(overview({
      caps: [
        { scope: 'project', period: 'week', budgetUsd: 50, spentUsd: 51, exhausted: true, resetsAt: 'x' },
        { scope: 'project', period: 'fortnight', budgetUsd: 50, spentUsd: 1, exhausted: false, resetsAt: 'x' },
        { scope: 'desktop', period: 'day', budgetUsd: 0, spentUsd: 1, exhausted: false, resetsAt: 'x' },
      ],
      projection: { estimate: true, trailingDays: 3, avgDailyUsd: 4, monthToDateUsd: 12, remainingDays: 6, projectedUsd: 36 },
    }))
    expect(parsed?.caps).toEqual([{ scope: 'project', period: 'week', budgetUsd: 50, spentUsd: 51, exhausted: true, resetsAt: 'x' }])
    expect(parsed?.projection).toMatchObject({ projectedUsd: 36 })
    expect(parsed?.config).toEqual({ day: null, week: 50, month: null, run: null })
  })
  it('rejects anything that is not an overview', () => {
    expect(parseBudgetOverview(null)).toBeNull()
    expect(parseBudgetOverview({})).toBeNull()
    expect(parseBudgetOverview(overview({ spend: { day: spend(1) } }))).toBeNull()
    expect(parseBudgetOverview(overview({ projection: { projectedUsd: 'x' } }))?.projection).toBeNull()
  })
  it('counts the gate\'s own spend for a capped period and the recorded sum otherwise', () => {
    const o = parseBudgetOverview(overview({ caps: [{ scope: 'project', period: 'week', budgetUsd: 50, spentUsd: 49.5, exhausted: false, resetsAt: 'x' }] }))!
    expect(periodSpentUsd(o, 'week', 'project')).toBe(49.5)
    expect(periodSpentUsd(o, 'week', 'desktop')).toBe(5)
    expect(periodSpentUsd(o, 'month', 'project')).toBe(20)
  })
})

describe('what-if parsing', () => {
  it('round-trips model refs, including ids that contain a colon', () => {
    expect(parseRefKey('claude:sonnet')).toEqual({ provider: 'claude', model: 'sonnet' })
    expect(parseRefKey('local:qwen3:30b')).toEqual({ provider: 'local', model: 'qwen3:30b' })
    expect(parseRefKey('nocolon')).toBeNull()
    expect(refKey({ provider: 'codex', model: 'gpt-5.5' })).toBe('codex:gpt-5.5')
  })
  it('keeps "no pricing" instead of a number', () => {
    const parsed = parseWhatIf({
      days: 30, sources: [{ provider: 'local', model: 'q', invocations: 3, recordedUsd: null, priced: false }], targets: [{ provider: 'claude', model: 'haiku' }],
      result: { from: { provider: 'local', model: 'q' }, to: { provider: 'claude', model: 'haiku' }, days: 30, invocations: 3, repriced: 0, skipped: 3, tokens: { in: 1, out: 2, cacheRead: 0, cacheCreate: 0 },
        recordedUsd: null, estimateCurrentUsd: null, estimateWhatIfUsd: null, deltaUsd: null, noPricing: { side: 'from', provider: 'local', model: 'q' } },
    })
    expect(parsed?.result).toMatchObject({ deltaUsd: null, noPricing: { side: 'from', model: 'q' } })
    expect(parsed?.sources[0]).toMatchObject({ priced: false, recordedUsd: null })
    expect(parseWhatIf({ days: 30 })).toBeNull()
  })
})
