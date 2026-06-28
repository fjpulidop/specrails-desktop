import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { useSharedWebSocket } from './useSharedWebSocket'

/**
 * Live per-rail execution metrics (elapsed start, steps, log lines) for the
 * dashboard, derived from the SAME WS emission source the Jobs view consumes —
 * no new server metric, no reinvention:
 *   - `loop.run_started`  → begin tracking a run (carries railIndex + projectId)
 *   - `event`/`loop_step` → step count = the event's `payload.index`
 *   - `log` (processId)   → +1 log line
 *   - `loop.run_completed`→ stop tracking (clears the metric when the rail's last
 *                            run ends — on success, stop, or cancel)
 *
 * Aggregated per railIndex (a rail may fan out into several per-ticket runs).
 * Elapsed is rendered by a self-ticking component from `startedAt`, so this hook
 * does NOT re-render every second.
 */
export interface RailExecMetric {
  startedAt: number
  steps: number
  lines: number
}

interface RunMetric { railIndex: number; startedAt: number; steps: number; lines: number }

interface WsLike {
  type?: string
  projectId?: string
  loopRunId?: string
  railIndex?: number | null
  jobId?: string
  event_type?: string
  payload?: string
  processId?: string
}

export function useRailExecutionMetrics(activeProjectId: string | null): Record<number, RailExecMetric> {
  const [runs, setRuns] = useState<Map<string, RunMetric>>(new Map())
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const projRef = useRef(activeProjectId)
  useEffect(() => { projRef.current = activeProjectId }, [activeProjectId])

  // Reset accumulated metrics on project switch.
  useEffect(() => { setRuns(new Map()) }, [activeProjectId])

  const handleMessage = useCallback((data: unknown) => {
    const m = data as WsLike
    if (!m || typeof m.type !== 'string') return

    if (m.type === 'loop.run_started') {
      if (m.projectId !== projRef.current || !m.loopRunId) return
      setRuns((prev) => {
        const next = new Map(prev)
        next.set(m.loopRunId!, { railIndex: m.railIndex ?? 0, startedAt: Date.now(), steps: 0, lines: 0 })
        return next
      })
      return
    }
    if (m.type === 'loop.run_completed') {
      // Clears the metric (success / stop / cancel all emit this).
      setRuns((prev) => { if (!m.loopRunId || !prev.has(m.loopRunId)) return prev; const n = new Map(prev); n.delete(m.loopRunId); return n })
      return
    }
    // Below: log/loop_step carry only the run id (no projectId) — we gate on the
    // run already being tracked (i.e. its run_started passed the project filter).
    if (m.type === 'event' && m.event_type === 'loop_step' && m.jobId) {
      setRuns((prev) => {
        const cur = prev.get(m.jobId!)
        if (!cur) return prev
        let index = cur.steps
        try { index = (JSON.parse(m.payload ?? '{}') as { index?: number }).index ?? cur.steps } catch { /* keep */ }
        const n = new Map(prev); n.set(m.jobId!, { ...cur, steps: index }); return n
      })
      return
    }
    if (m.type === 'log' && m.processId) {
      setRuns((prev) => {
        const cur = prev.get(m.processId!)
        if (!cur) return prev
        const n = new Map(prev); n.set(m.processId!, { ...cur, lines: cur.lines + 1 }); return n
      })
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('rail-exec-metrics', handleMessage)
    return () => unregisterHandler('rail-exec-metrics')
  }, [handleMessage, registerHandler, unregisterHandler])

  return useMemo(() => {
    const out: Record<number, RailExecMetric> = {}
    for (const r of runs.values()) {
      const e = out[r.railIndex]
      if (!e) out[r.railIndex] = { startedAt: r.startedAt, steps: r.steps, lines: r.lines }
      else { e.startedAt = Math.min(e.startedAt, r.startedAt); e.steps += r.steps; e.lines += r.lines }
    }
    return out
  }, [runs])
}
