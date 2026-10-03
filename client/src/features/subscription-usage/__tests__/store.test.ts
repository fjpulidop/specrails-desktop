import { it, expect, vi, afterEach } from 'vitest'
import { createUsageStore } from '../lib/store'
import { isUsageSnapshot, type UsageSnapshot } from '../lib/types'
const snapshot: UsageSnapshot = { scope: 'machine', instanceId: 'test-server', revision: 1, providers: ['claude', 'codex'].map(id => ({ providerId: id as 'claude' | 'codex', installed: false, generation: 'g', availability: 'unavailable', windows: [], refreshState: 'idle', freshness: 'unknown', plan: null, source: null, observedAt: null, attemptedAt: null, retryAt: null, issue: { code: 'cli-missing', retryable: false } })) }
afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) })
it('validates provider scope and rejects fabricated/invalid usage values', () => {
  expect(isUsageSnapshot(snapshot)).toBe(true)
  expect(isUsageSnapshot({ ...snapshot, providers: [{ ...snapshot.providers[0], providerId: 'cursor' }, snapshot.providers[1]] })).toBe(false)
  expect(isUsageSnapshot({ ...snapshot, providers: [snapshot.providers[0], snapshot.providers[0]] })).toBe(false)
})
it('accepts Enterprise spend snapshots and rejects invalid money or wrong account classification', () => {
  const spend = { kind: 'enterprise-on-demand', usedAmount: 20.78, limitAmount: 1000, limitStatus: 'limited', currency: 'USD', usedPercent: 2, resetsAt: '2030-02-01T00:00:00Z' }
  const value = { ...snapshot, providers: [{ ...snapshot.providers[0], availability: 'available', plan: 'enterprise', spend }, snapshot.providers[1]] }
  expect(isUsageSnapshot(value)).toBe(true)
  for (const patch of [{ usedAmount: -1 }, { limitAmount: Infinity }, { currency: 'dollars' }, { usedPercent: -1 }, { limitStatus: 'unlimited' }, { usedAmount: null, limitAmount: null }]) {
    expect(isUsageSnapshot({ ...value, providers: [{ ...value.providers[0], spend: { ...spend, ...patch } }, snapshot.providers[1]] })).toBe(false)
  }
  expect(isUsageSnapshot({ ...value, providers: [{ ...value.providers[0], plan: 'team' }, snapshot.providers[1]] })).toBe(false)
  expect(isUsageSnapshot({ ...value, providers: [{ ...value.providers[0], windows: [{ id: 'session', label: 'session', scope: 'account', model: null, usedPercent: 0, durationMinutes: 300, resetsAt: null }] }, snapshot.providers[1]] })).toBe(false)
})
it('shares a single demand loop, stops on hide/unmount and automatically refreshes on reopen', async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { snapshot, scheduled: false } : snapshot)))
  const store = createUsageStore(request), a = store.subscribe(vi.fn()), b = store.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2) // cached GET + initial automatic refresh, shared by both consumers
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(180_000); expect(request).toHaveBeenCalledTimes(2)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0); expect(request).toHaveBeenCalledTimes(4)
  a(); b(); await vi.advanceTimersByTimeAsync(180_000); expect(request).toHaveBeenCalledTimes(4)
})
it('rejects out-of-order snapshots without losing the current account generation', async () => {
  vi.useFakeTimers()
  const newer = { ...snapshot, revision: 3, providers: snapshot.providers.map(p => ({ ...p, generation: 'new' })) }
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(newer))).mockResolvedValueOnce(new Response(JSON.stringify({ snapshot: newer, scheduled: false }))).mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
  const store = createUsageStore(request), unsubscribe = store.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.getSnapshot().snapshot?.revision).toBe(3)
  expect(store.getSnapshot().snapshot?.providers[0].generation).toBe('new'); unsubscribe()
})
it('recovers a malformed response without reporting imaginary quotas', async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(new Response('{}'))
  const store = createUsageStore(request), unsubscribe = store.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toMatchObject({ snapshot: null, error: true }); unsubscribe()
})

it('accepts a fresh backend instance after restart even when its revision resets', async () => {
  vi.useFakeTimers()
  const newer = { ...snapshot, revision: 50 }
  const restarted = { ...snapshot, instanceId: 'restarted-server', revision: 0 }
  const request = vi.fn().mockImplementation(async (_url, init) => {
    const value = request.mock.calls.length <= 2 ? newer : restarted
    return new Response(JSON.stringify(init?.method === 'POST' ? { snapshot: value, scheduled: false } : value))
  })
  const store = createUsageStore(request), unsubscribe = store.subscribe(vi.fn())
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.getSnapshot().snapshot?.instanceId).toBe('restarted-server')
  expect(store.getSnapshot().snapshot?.revision).toBe(0); unsubscribe()
})
