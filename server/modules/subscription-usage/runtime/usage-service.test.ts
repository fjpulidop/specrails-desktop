import { describe, it, expect, vi } from 'vitest'
import { createUsageService } from './usage-service'
import type { UsageReadResult } from '../ports'
import { UsageError } from '../adapters/errors'
const result: UsageReadResult = { availability: 'available', windows: [{ id: 'weekly', label: 'weekly', scope: 'account', model: null, usedPercent: 23, durationMinutes: 10080, resetsAt: null }], plan: 'plus', source: 'app-server', identity: 'private-account-id' }
function fixture() {
  let clock = Date.parse('2030-01-01T00:00:00Z')
  const context = vi.fn().mockResolvedValue('account-a')
  const read = vi.fn().mockResolvedValue(result), installed = vi.fn().mockResolvedValue(true)
  const service = createUsageService({ installed, now: () => clock, readers: { claude: { context, read }, codex: { context, read } } })
  return { service, context, read, installed, advance: () => { clock += 120_000 } }
}
describe('machine subscription usage lifecycle', () => {
  it('does not probe on snapshot reads and omits private identities', async () => {
    const f = fixture(); f.service.snapshot(); expect(f.installed).not.toHaveBeenCalled()
    f.service.refresh(); await f.service.settled()
    expect(f.service.snapshot().providers.every(p => p.availability === 'available')).toBe(true)
    expect(JSON.stringify(f.service.snapshot())).not.toContain('private-account-id')
  })
  it('does not read credentials or spawn when both CLIs are missing', async () => {
    const f = fixture(); f.installed.mockResolvedValue(false)
    f.service.refresh(); await f.service.settled()
    expect(f.context).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
    expect(f.service.snapshot().providers).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: 'claude', installed: false, windows: [] }), expect.objectContaining({ providerId: 'codex', installed: false, windows: [] })]))
    // A missing CLI is retryable: automatic reads keep looking for it.
    f.advance(); f.service.refresh(undefined, true); await f.service.settled(); expect(f.installed).toHaveBeenCalledTimes(4)
    expect(f.service.snapshot().providers[0]!.issue).toEqual({ code: 'cli-missing', retryable: true })
    f.installed.mockResolvedValue(true); f.service.refresh(); await f.service.settled(); expect(f.read).toHaveBeenCalledTimes(2)
  })
  it('deduplicates in-flight work and honors minimum refresh interval', async () => {
    const f = fixture()
    let finish!: (value: UsageReadResult) => void
    f.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    f.service.refresh('codex'); f.service.refresh('codex')
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1))
    finish(result); await f.service.settled()
    expect(f.service.refresh('codex').scheduled).toBe(false)
  })
  it('drops replies when auth context changes in flight', async () => {
    const f = fixture(); f.context.mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    f.service.refresh('codex'); await f.service.settled()
    expect(f.service.snapshot().providers[1]).toMatchObject({ windows: [], issue: { code: 'account-changed' } })
  })
  it('retains same-account data on network failure and clears it on sign-out', async () => {
    const f = fixture(); f.service.refresh('codex'); await f.service.settled()
    const observed = f.service.snapshot().providers[1].observedAt
    f.advance(); f.read.mockRejectedValueOnce(new Error('secret response body'))
    f.service.refresh('codex'); await f.service.settled()
    expect(f.service.snapshot().providers[1]).toMatchObject({ freshness: 'stale', observedAt: observed, windows: result.windows })
    expect(JSON.stringify(f.service.snapshot())).not.toContain('secret response')
    f.advance(); f.read.mockRejectedValueOnce(new UsageError('signed-out'))
    f.service.refresh('codex'); await f.service.settled()
    expect(f.service.snapshot().providers[1]).toMatchObject({ windows: [], observedAt: null, availability: 'signed-out' })
  })
  it('invalidates prior account before a failing request for a new account', async () => {
    const f = fixture(); f.service.refresh('codex'); await f.service.settled()
    const generation = f.service.snapshot().providers[1].generation
    f.advance(); f.context.mockResolvedValue('other'); f.read.mockRejectedValueOnce(new Error('network'))
    f.service.refresh('codex'); await f.service.settled()
    expect(f.service.snapshot().providers[1].windows).toEqual([])
    expect(f.service.snapshot().providers[1].generation).not.toBe(generation)
  })
  it('provider errors settle independently and Retry-After is respected', async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new UsageError('rate-limited', true, 240_000))
    f.service.refresh(); await f.service.settled()
    expect(f.service.snapshot().providers.map(p => p.refreshState)).toEqual(['error', 'idle'])
    f.advance(); expect(f.service.refresh('claude').scheduled).toBe(false)
    expect(f.service.refresh('codex').scheduled).toBe(true); await f.service.settled()
  })
  it('aborts owned probes and refuses new work after disposal', async () => {
    const f = fixture()
    f.read.mockImplementation((signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new UsageError('aborted')), { once: true })))
    f.service.refresh('codex'); await vi.waitFor(() => expect(f.read).toHaveBeenCalled())
    await f.service.dispose(); expect(f.service.refresh().scheduled).toBe(false)
  })
})

it('retains same-account spending as stale and clears money on account changes and sign-out', async () => {
  const f = fixture()
  const spend = { kind: 'enterprise-on-demand' as const, usedAmount: 20.78, limitAmount: 1000, limitStatus: 'limited' as const, currency: 'USD', usedPercent: 2.078, resetsAt: '2030-02-01T00:00:00Z' }
  f.read.mockResolvedValue({ ...result, plan: 'enterprise', windows: [], spend })
  f.service.refresh('claude'); await f.service.settled()
  expect(f.service.snapshot().providers[0]).toMatchObject({ spend, windows: [], availability: 'available' })
  f.advance(); f.read.mockRejectedValueOnce(new Error('network failure'))
  f.service.refresh('claude'); await f.service.settled()
  expect(f.service.snapshot().providers[0]).toMatchObject({ spend, freshness: 'stale' })
  f.advance(); f.context.mockResolvedValue('account-b'); f.read.mockRejectedValueOnce(new Error('network failure'))
  f.service.refresh('claude'); await f.service.settled()
  expect(f.service.snapshot().providers[0]).toMatchObject({ spend: null, observedAt: null })
  f.advance(); f.service.refresh('claude'); await f.service.settled()
  expect(f.service.snapshot().providers[0].spend).toEqual(spend)
  f.advance(); f.read.mockRejectedValueOnce(new UsageError('signed-out'))
  f.service.refresh('claude'); await f.service.settled()
  expect(f.service.snapshot().providers[0]).toMatchObject({ spend: null, availability: 'signed-out' })
})

it('does not query a detected CLI which is disabled or incompatible', async () => {
  const read = vi.fn(), context = vi.fn()
  const service = createUsageService({ installed: async () => true, eligible: async () => false, readers: { claude: { read, context }, codex: { read, context } } })
  service.refresh(); await service.settled()
  expect(read).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled()
  expect(service.snapshot().providers.every(p => p.installed === true && p.availability === 'unsupported-cli')).toBe(true)
})
describe('provider billing', () => {
  it('resolves billing: waits for the first read it starts, never for longer than its bound', async () => {
    const f = fixture()
    expect(f.service.billing('claude', {})).toEqual({ billing: 'unknown', plan: null })
    await f.service.settled()
    await expect(f.service.resolveBilling('codex', 1_000, {})).resolves.toEqual({ billing: 'plan', plan: 'plus' })
    await expect(f.service.resolveBilling('claude', 1_000, { ANTHROPIC_API_KEY: 'test' })).resolves.toEqual({ billing: 'api', plan: null })
    const slow = fixture(); slow.read.mockReturnValue(new Promise(() => {}))
    await expect(slow.service.resolveBilling('codex', 10, {})).resolves.toEqual({ billing: 'unknown', plan: null })
    expect(slow.service.billing('gemini', {})).toEqual({ billing: 'unknown', plan: null })
  })
  it('merges run-observed windows into an available row only, newer than the reader, without probing', async () => {
    const onChange = vi.fn()
    let clock = Date.parse('2030-01-01T00:00:00Z')
    const read = vi.fn().mockResolvedValue({ ...result, windows: [{ id: 'five_hour', label: 'session', scope: 'account', model: null, usedPercent: 20, durationMinutes: 300, resetsAt: null }] })
    const service = createUsageService({ installed: vi.fn().mockResolvedValue(true), now: () => clock, onChange, readers: { claude: { context: vi.fn().mockResolvedValue('a'), read }, codex: { context: vi.fn().mockResolvedValue('a'), read } } })
    // Not observed yet: a report never signs an account in.
    service.observe('claude', [{ id: 'five_hour', usedPercent: 90, resetsAt: '2030-01-01T05:00:00.000Z', windowMinutes: 300 }], '2030-01-01T00:00:00.000Z')
    expect(onChange).not.toHaveBeenCalled()
    service.refresh('claude'); await service.settled()
    const before = service.snapshot().revision
    clock += 1000
    service.observe('claude', [{ id: 'five_hour', usedPercent: 90, resetsAt: '2030-01-01T05:00:00.000Z', windowMinutes: 300 }, { id: 'seven_day_opus', usedPercent: 40, resetsAt: null, windowMinutes: 10080 }], new Date(clock).toISOString())
    const row = service.snapshot().providers.find(p => p.providerId === 'claude')!
    expect(row.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', usedPercent: 90, resetsAt: '2030-01-01T05:00:00.000Z' }),
      expect.objectContaining({ id: 'seven_day_opus', scope: 'model', model: 'opus', usedPercent: 40, label: 'weekly' }),
    ])
    expect(service.snapshot().revision).toBeGreaterThan(before)
    expect(onChange).toHaveBeenCalledTimes(1)
    // An older report changes nothing.
    service.observe('claude', [{ id: 'five_hour', usedPercent: 10, resetsAt: null, windowMinutes: 300 }], '2029-12-31T00:00:00.000Z')
    expect(service.snapshot().providers.find(p => p.providerId === 'claude')!.windows[0]!.usedPercent).toBe(90)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('a run report for a provider marked "not detected" re-reads it once, so Settings and the status bar agree', async () => {
    let clock = Date.parse('2030-01-01T00:00:00Z')
    const installed = vi.fn().mockResolvedValue(false)
    const read = vi.fn().mockResolvedValue(result)
    const service = createUsageService({ installed, now: () => clock, readers: { claude: { context: vi.fn().mockResolvedValue('a'), read }, codex: { context: vi.fn().mockResolvedValue('a'), read } } })
    service.refresh('claude'); await service.settled()
    expect(service.snapshot().providers[0]).toMatchObject({ installed: false, issue: { code: 'cli-missing' } })
    // The CLI is found now (a turn just used it).
    installed.mockResolvedValue(true)
    const report = [{ id: 'weekly', usedPercent: 49, resetsAt: null, windowMinutes: 10080 }]
    service.observe('claude', report, new Date(clock).toISOString())
    // Throttled: a re-read happened less than a minute ago.
    expect(read).not.toHaveBeenCalled()
    clock += 61_000
    service.observe('claude', report, new Date(clock).toISOString())
    await service.settled()
    expect(read).toHaveBeenCalledTimes(1)
    expect(service.snapshot().providers[0]).toMatchObject({ installed: true, availability: 'available', issue: null })
    // Once available, further reports merge without probing.
    clock += 1000
    service.observe('claude', report, new Date(clock).toISOString())
    expect(read).toHaveBeenCalledTimes(1)
  })
})
