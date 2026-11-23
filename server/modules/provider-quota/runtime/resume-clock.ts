/**
 * Wall-clock scheduling for limit resumes that never starts work while the
 * machine is asleep or in a dark wake.
 *
 * Node timers do not run while the machine sleeps; after a wake they fire
 * late, and during a dark wake (macOS Power Nap, maintenance wake) the process
 * may run for a few seconds with the lid closed. So a due resume is only
 * started once the process has been continuously awake for `settleMs`
 * (default 2 minutes): a heartbeat ticks every `heartbeatMs`, and a gap far
 * longer than the heartbeat means the machine slept, which restarts the
 * settle window. Short dark wakes never last long enough to pass it.
 *
 * The heartbeat only runs while something is scheduled.
 */
import type { QuotaTimers } from '../ports'

export const WAKE_SETTLE_MS = 120_000
export const HEARTBEAT_MS = 30_000

export interface ResumeClock {
  /** Run `fire` once at or after `at` (epoch ms), when the machine is settled awake. */
  schedule(at: number, fire: () => void): { cancel(): void }
  /** Entries still waiting (diagnostics, tests). */
  pending(): number
  dispose(): void
}

export function createResumeClock(timers: QuotaTimers, options: { settleMs?: number; heartbeatMs?: number } = {}): ResumeClock {
  const settleMs = options.settleMs ?? WAKE_SETTLE_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const entries = new Set<{ at: number; fire: () => void }>()
  let timer: { cancel(): void } | null = null
  let lastTick = timers.now()
  // The process starting counts as a wake: nothing fires in its first settle window.
  let awakeSince = timers.now()
  let disposed = false

  function arm(): void {
    timer?.cancel()
    timer = null
    if (disposed || entries.size === 0) return
    const now = timers.now()
    const nearest = Math.min(...[...entries].map((entry) => entry.at))
    const settled = awakeSince + settleMs
    // Wake no later than the heartbeat (sleep detection), the next due entry, or the end of the settle window.
    const delay = Math.max(50, Math.min(heartbeatMs, Math.max(nearest, settled) - now))
    timer = timers.setTimeout(tick, delay)
  }

  function tick(): void {
    timer = null
    const now = timers.now()
    // A gap far beyond the heartbeat means the process was suspended (sleep).
    if (now - lastTick > heartbeatMs * 3) awakeSince = now
    lastTick = now
    if (now - awakeSince >= settleMs) {
      for (const entry of [...entries]) {
        if (entry.at > now) continue
        entries.delete(entry)
        try { entry.fire() } catch (error) { console.error('[provider-quota] scheduled resume failed:', error) }
      }
    }
    arm()
  }

  return {
    schedule(at, fire) {
      const entry = { at, fire }
      entries.add(entry)
      if (!timer) lastTick = timers.now()
      arm()
      return { cancel: () => { entries.delete(entry); if (entries.size === 0) { timer?.cancel(); timer = null } } }
    },
    pending: () => entries.size,
    dispose() { disposed = true; entries.clear(); timer?.cancel(); timer = null },
  }
}
