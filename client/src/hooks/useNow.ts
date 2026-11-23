import { useEffect, useState } from 'react'

/**
 * One shared wall clock per interval size. Live elapsed labels across the app
 * (jobs, rails, subagents, background processes, terminals) subscribe here
 * instead of each running its own `setInterval`, so N live labels cost one
 * timer and tick together (one batched render per tick).
 */
interface Clock {
  listeners: Set<(now: number) => void>
  timer: ReturnType<typeof setInterval> | null
}

const clocks = new Map<number, Clock>()

/** Subscribe to the clock for `intervalMs`; the first subscriber starts it, the last stops it. */
export function subscribeNow(intervalMs: number, listener: (now: number) => void): () => void {
  let clock = clocks.get(intervalMs)
  if (!clock) {
    clock = { listeners: new Set(), timer: null }
    clocks.set(intervalMs, clock)
  }
  const current = clock
  current.listeners.add(listener)
  if (current.timer === null) {
    current.timer = setInterval(() => {
      const now = Date.now()
      for (const fn of [...current.listeners]) fn(now)
    }, intervalMs)
  }
  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size === 0 && current.timer !== null) {
      clearInterval(current.timer)
      current.timer = null
      clocks.delete(intervalMs)
    }
  }
}

/** Number of running shared clocks (tests and diagnostics). */
export function activeNowClocks(): number {
  return [...clocks.values()].filter(clock => clock.timer !== null).length
}

/**
 * `Date.now()`, re-read every `intervalMs` while `active`. When inactive the
 * value stays at its last reading and no timer runs; becoming active reads the
 * clock at once, then follows the shared tick.
 */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    return subscribeNow(intervalMs, setNow)
  }, [intervalMs, active])
  return now
}
