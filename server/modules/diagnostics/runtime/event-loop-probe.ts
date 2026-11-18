/**
 * Event-loop stall probe for the local server.
 *
 * One unref'd 1 s timer measures how late it fires (a coarse stall signal that
 * costs nothing while the app is idle). While the loop is busy (event-loop
 * utilization over the last tick above `busyUtilization`) it also arms
 * `monitorEventLoopDelay` for an exact maximum delay; after `quietTicksToDisarm`
 * idle ticks the histogram is disabled again, so an idle server pays only that
 * one timer per second.
 *
 * A stall at or above `thresholdMs` is recorded with the request whose
 * synchronous part blocked the loop, when one did: `operationTiming()` measures
 * how long each HTTP handler chain ran before yielding (two `performance.now()`
 * calls per request) and reports the slow ones to the probe.
 */
import { monitorEventLoopDelay, performance, type EventLoopUtilization, type ELDHistogram } from 'node:perf_hooks'
import type { NextFunction, Request, Response } from 'express'
import { appendStall, DEFAULT_STALL_THRESHOLD_MS, operationLabel, type StallRecord, type StallSnapshot } from '../domain'

export interface EventLoopProbeOptions {
  thresholdMs?: number
  tickMs?: number
  busyUtilization?: number
  quietTicksToDisarm?: number
  resolutionMs?: number
  /** Minimum time between two stall log lines (more stalls are counted, not logged). */
  logIntervalMs?: number
  log?: (line: string) => void
  /** Wall clock for records. */
  now?: () => number
  /** Event-loop utilization since the previous call (0..1); defaults to `performance.eventLoopUtilization`. */
  utilization?: () => number | null
}

export interface EventLoopProbe {
  start(): void
  stop(): void
  /** A request's synchronous handler time; slow ones become the stall's operation. */
  noteOperation(label: string, syncMs: number): void
  snapshot(): StallSnapshot
  /** Exposed for tests: run one measurement as if the timer fired at `monotonicNow`. */
  tick(monotonicNow?: number): void
}

export function createEventLoopProbe(options: EventLoopProbeOptions = {}): EventLoopProbe {
  const thresholdMs = options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
  const tickMs = options.tickMs ?? 1000
  const busy = options.busyUtilization ?? 0.05
  const quietTicksToDisarm = options.quietTicksToDisarm ?? 10
  const resolutionMs = options.resolutionMs ?? 20
  const logIntervalMs = options.logIntervalMs ?? 10_000
  const log = options.log ?? ((line: string) => console.warn(line))
  const now = options.now ?? Date.now

  let stalls: StallRecord[] = []
  let total = 0
  let longestMs = 0
  const sinceMs = now()
  let timer: NodeJS.Timeout | null = null
  let histogram: ELDHistogram | null = null
  let quietTicks = 0
  let lastElu: EventLoopUtilization | null = null
  const readUtilization = options.utilization ?? (() => {
    const elu = performance.eventLoopUtilization(lastElu ?? undefined)
    lastElu = performance.eventLoopUtilization()
    return Number.isFinite(elu.utilization) ? elu.utilization : null
  })
  let lastTickAt = performance.now()
  let expectedAt = lastTickAt + tickMs
  let slowOp: { label: string; durationMs: number; endedAt: number } | null = null
  let lastLogAt = -Infinity
  let unlogged = 0

  const arm = () => {
    if (histogram) return
    histogram = monitorEventLoopDelay({ resolution: resolutionMs })
    histogram.enable()
  }
  const disarm = () => {
    histogram?.disable()
    histogram = null
  }

  function tick(monotonicNow = performance.now()) {
    const drift = Math.max(0, monotonicNow - expectedAt)
    let delay = drift
    if (histogram) {
      // The histogram records whole sampling intervals; the delay is what exceeds one.
      const maxMs = histogram.max / 1e6 - resolutionMs
      if (Number.isFinite(maxMs)) delay = Math.max(delay, maxMs)
      histogram.reset()
    }
    const utilization = readUtilization()
    if ((utilization ?? 0) >= busy || drift >= thresholdMs) { quietTicks = 0; arm() }
    else if (++quietTicks >= quietTicksToDisarm) disarm()

    if (delay >= thresholdMs) {
      // A slow handler that ended inside this window is the stall's cause.
      const operation = slowOp && slowOp.endedAt >= lastTickAt - resolutionMs ? slowOp.label : null
      const stall: StallRecord = { atMs: now(), durationMs: Math.round(delay), operation, utilization: utilization === null ? null : Math.round(utilization * 1000) / 1000 }
      stalls = appendStall(stalls, stall)
      total++
      longestMs = Math.max(longestMs, stall.durationMs)
      if (monotonicNow - lastLogAt >= logIntervalMs) {
        const extra = unlogged ? ` (+${unlogged} more since the last report)` : ''
        log(`[event-loop] stall of ${stall.durationMs} ms${operation ? ` during ${operation}` : ''}${extra}`)
        lastLogAt = monotonicNow
        unlogged = 0
      } else {
        unlogged++
      }
    }
    slowOp = null
    lastTickAt = monotonicNow
    expectedAt = monotonicNow + tickMs
  }

  const schedule = () => {
    timer = setTimeout(() => {
      tick()
      if (timer) schedule()
    }, tickMs)
    timer.unref?.()
  }

  return {
    start() {
      if (timer) return
      lastElu = performance.eventLoopUtilization()
      lastTickAt = performance.now()
      expectedAt = lastTickAt + tickMs
      schedule()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      disarm()
    },
    noteOperation(label, syncMs) {
      if (syncMs < thresholdMs / 2) return
      if (!slowOp || syncMs >= slowOp.durationMs) slowOp = { label, durationMs: syncMs, endedAt: performance.now() }
    },
    snapshot() {
      return { thresholdMs, sampling: histogram !== null, sinceMs, total, longestMs, recent: [...stalls].reverse() }
    },
    tick,
  }
}

/** Express middleware: report how long each request's handlers ran before yielding. */
export function operationTiming(probe: Pick<EventLoopProbe, 'noteOperation'>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const started = performance.now()
    try {
      next()
    } finally {
      const syncMs = performance.now() - started
      // Cheap path: only slow requests are labelled.
      if (syncMs >= 50) probe.noteOperation(operationLabel(req.method, req.originalUrl || req.url), syncMs)
    }
  }
}
