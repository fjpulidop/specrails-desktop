import { describe, expect, it, vi } from 'vitest'
import { createResumeClock } from '../runtime/resume-clock'
import type { QuotaTimers } from '../ports'

function fakeTimers(start = 1_000_000) {
  let now = start
  let pending: Array<{ at: number; fn: () => void; live: boolean }> = []
  const timers: QuotaTimers = {
    now: () => now,
    setTimeout: (fn, ms) => { const entry = { at: now + ms, fn, live: true }; pending.push(entry); return { cancel: () => { entry.live = false } } },
  }
  /** Run timers in order up to `ms` later, one step at a time (like a live process). */
  const run = (ms: number) => {
    const end = now + ms
    for (;;) {
      pending = pending.filter((entry) => entry.live)
      const next = pending.sort((a, b) => a.at - b.at)[0]
      if (!next || next.at > end) break
      now = Math.max(now, next.at); next.live = false; next.fn()
    }
    now = end
  }
  /** The process was suspended for `ms` (sleep): no timer ran meanwhile. */
  const sleep = (ms: number) => { now += ms }
  return { timers, run, sleep, live: () => pending.filter((entry) => entry.live).length }
}

const SETTLE = 120_000

describe('resume clock', () => {
  it('fires at the reset once the machine has been awake for the settle window', () => {
    const { timers, run } = fakeTimers()
    const clock = createResumeClock(timers, { settleMs: SETTLE, heartbeatMs: 30_000 })
    const fire = vi.fn()
    clock.schedule(timers.now() + 10_000, fire)
    // Due after 10 s, but the process only just started: it waits out the settle window.
    run(60_000)
    expect(fire).not.toHaveBeenCalled()
    run(SETTLE)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(clock.pending()).toBe(0)
  })

  it('never starts work right after a sleep or during a short dark wake', () => {
    const { timers, run, sleep } = fakeTimers()
    const clock = createResumeClock(timers, { settleMs: SETTLE, heartbeatMs: 30_000 })
    run(SETTLE + 1)
    const fire = vi.fn()
    clock.schedule(timers.now() + 60 * 60_000, fire)
    // The lid closes; the reset passes while asleep.
    sleep(3 * 60 * 60_000)
    // A dark wake: the overdue heartbeat runs, sees the gap, and holds off.
    run(30_000)
    expect(fire).not.toHaveBeenCalled()
    sleep(60 * 60_000)
    run(30_000)
    expect(fire).not.toHaveBeenCalled()
    // Real wake: settled awake for the window → it fires.
    run(SETTLE + 30_000)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('cancels a scheduled resume and stops its heartbeat when nothing is left', () => {
    const { timers, run, live } = fakeTimers()
    const clock = createResumeClock(timers, { settleMs: 0, heartbeatMs: 30_000 })
    const fire = vi.fn()
    const handle = clock.schedule(timers.now() + 1_000, fire)
    handle.cancel()
    expect(live()).toBe(0)
    run(60_000)
    expect(fire).not.toHaveBeenCalled()
    clock.dispose()
  })
})
