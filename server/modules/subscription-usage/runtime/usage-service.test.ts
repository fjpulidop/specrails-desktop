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
    f.advance(); f.service.refresh(undefined, true); await f.service.settled(); expect(f.installed).toHaveBeenCalledTimes(2)
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

it('does not query a detected CLI which is disabled or incompatible', async () => {
  const read = vi.fn(), context = vi.fn()
  const service = createUsageService({ installed: async () => true, eligible: async () => false, readers: { claude: { read, context }, codex: { read, context } } })
  service.refresh(); await service.settled()
  expect(read).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled()
  expect(service.snapshot().providers.every(p => p.installed === true && p.availability === 'unsupported-cli')).toBe(true)
})
