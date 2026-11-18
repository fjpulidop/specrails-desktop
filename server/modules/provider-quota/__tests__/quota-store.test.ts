import { describe, expect, it, vi } from 'vitest'
import { createQuotaStore } from '../runtime/quota-store'
import type { QuotaTimers, UsageFeed } from '../ports'
import type { RateLimitReport } from '../domain'

const T0 = Date.parse('2026-11-18T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function fakeTimers(start = T0) {
  let now = start
  const pending: Array<{ at: number; fn: () => void; live: boolean }> = []
  const timers: QuotaTimers = {
    now: () => now,
    setTimeout: (fn, ms) => { const entry = { at: now + ms, fn, live: true }; pending.push(entry); return { cancel: () => { entry.live = false } } },
  }
  const advance = (ms: number) => {
    now += ms
    for (const entry of pending.filter((item) => item.live && item.at <= now).sort((a, b) => a.at - b.at)) { entry.live = false; entry.fn() }
  }
  return { timers, advance }
}

const rejected: RateLimitReport = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: iso(T0 + 3_600_000), utilization: 1, windows: { five_hour: { utilization: 1, resetsAt: iso(T0 + 3_600_000), windowMinutes: 300 } }, overage: null }

describe('quota store', () => {
  it('announces changes (coalesced), persists refusals only, and lifts them at the reset', () => {
    const { timers, advance } = fakeTimers()
    const saved: string[] = []
    const onChange = vi.fn()
    const store = createQuotaStore({ timers, persistence: { load: () => undefined, save: (value) => saved.push(value) }, onChange })
    store.observe('claude', rejected, 'session')
    store.observe('claude', rejected, 'session')
    advance(300)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(store.view('claude')).toMatchObject({ level: 'rejected', rejectedUntil: iso(T0 + 3_600_000) })
    expect(store.resumeAt('claude')).toBe(iso(T0 + 3_600_000))
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0]!)).toEqual({ version: 1, providers: { claude: { rejected: { five_hour: iso(T0 + 3_600_000) }, observedAt: iso(T0) } } })
    // The reset passes: the refusal lifts by itself and is announced.
    advance(3_600_100)
    advance(300)
    expect(store.view('claude').level).not.toBe('rejected')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(JSON.parse(saved.at(-1)!).providers).toEqual({})
    store.dispose()
  })

  it('restores refusals that outlive a restart and forgets those that expired meanwhile', () => {
    const { timers } = fakeTimers()
    const persisted = JSON.stringify({ version: 1, providers: { claude: { rejected: { five_hour: iso(T0 + 60_000) }, observedAt: iso(T0 - 1) }, codex: { rejected: { 'codex:primary': iso(T0 - 1) }, observedAt: iso(T0 - 2) }, 'BAD ID': { rejected: {} } } })
    const store = createQuotaStore({ timers, persistence: { load: () => persisted, save: () => {} } })
    expect(store.view('claude')).toMatchObject({ level: 'rejected', rejectedUntil: iso(T0 + 60_000) })
    expect(store.view('codex').level).not.toBe('rejected')
    expect(store.views().map((view) => view.providerId)).toEqual(['claude', 'codex'])
    store.dispose()
  })

  it('feeds run-observed windows to the subscription rows and reads their windows back', () => {
    const { timers } = fakeTimers()
    const observe = vi.fn()
    const usage: UsageFeed = {
      snapshot: () => ({ providers: [{ providerId: 'codex', availability: 'available', observedAt: iso(T0), windows: [{ id: 'codex:primary', usedPercent: 85, resetsAt: iso(T0 + 1000), durationMinutes: 300 }] }] }),
      observe,
    }
    const store = createQuotaStore({ timers, usage })
    store.observe('claude', { ...rejected, status: 'allowed', utilization: 0.4, windows: { five_hour: { utilization: 0.4, resetsAt: iso(T0 + 3_600_000) } } }, 'runtime')
    expect(observe).toHaveBeenCalledWith('claude', [expect.objectContaining({ id: 'five_hour', usedPercent: 40 })], iso(T0))
    expect(store.view('codex')).toMatchObject({ level: 'warning', usedPercent: 85 })
    store.dispose()
  })

  it('ignores invalid provider ids and stops after dispose', () => {
    const { timers } = fakeTimers()
    const store = createQuotaStore({ timers })
    store.observe('Not A Provider', rejected, 'session')
    store.dispose()
    store.observe('claude', rejected, 'session')
    expect(store.views().every((view) => view.level === 'unknown')).toBe(true)
  })
})
