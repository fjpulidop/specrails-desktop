import { createContext, useContext, useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { deriveFrameActivity } from '../lib/frame-activity'
import type { EventRow } from '../types'

/**
 * Live per-rail execution metrics (elapsed start, steps, log lines) derived from
 * the SAME WS emission stream the Jobs view consumes — no new server metric:
 *   - loop.run_started  → begin tracking (railIndex + projectId)
 *   - event/loop_step   → steps = the event's payload.index
 *   - log (processId)   → +1 log line
 *   - loop.run_completed→ stop tracking (clears on success / stop / cancel)
 *
 * App-LEVEL provider (mounted above the route outlet) so the metrics survive
 * page navigation (Dashboard ⇄ Jobs) and keep accumulating even while the
 * dashboard is unmounted — the WS handler is never torn down on a page switch.
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

const RailMetricsContext = createContext<Record<number, RailExecMetric>>({})

/** Per-rail live execution metrics keyed by railIndex (or {} when none). */
export function useRailMetrics(): Record<number, RailExecMetric> {
  return useContext(RailMetricsContext)
}

export function RailMetricsProvider({ activeProjectId, children }: { activeProjectId: string | null; children: React.ReactNode }) {
  const [runs, setRuns] = useState<Map<string, RunMetric>>(new Map())
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const projRef = useRef(activeProjectId)
  useEffect(() => { projRef.current = activeProjectId }, [activeProjectId])

  // Reset on project switch, then SEED from the server so live metrics survive a
  // page refresh (the WS stream can't replay run_started/log/loop_step that already
  // fired). GET /rails carries active loop runs with their startedAt + step/line
  // counts; live WS updates take over from there.
  useEffect(() => {
    setRuns(new Map())
    if (!activeProjectId) return
    let cancelled = false
    fetch(`/api/projects/${activeProjectId}/rails`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { activeLoopRuns?: Record<string, { loopRunId?: string; startedAt?: string; steps?: number; lines?: number }> } | null) => {
        if (cancelled || !data?.activeLoopRuns) return
        const seeded = new Map<string, RunMetric>()
        for (const [idxStr, run] of Object.entries(data.activeLoopRuns)) {
          if (!run?.loopRunId) continue
          seeded.set(run.loopRunId, {
            railIndex: Number(idxStr),
            startedAt: run.startedAt ? new Date(run.startedAt).getTime() : Date.now(),
            steps: run.steps ?? 0,
            lines: run.lines ?? 0,
          })
        }
        if (seeded.size === 0) return
        setRuns((prev) => {
          const next = new Map(prev)
          for (const [id, m] of seeded) if (!next.has(id)) next.set(id, m) // never clobber a live entry
          return next
        })
      })
      .catch(() => { /* best-effort seed */ })
    return () => { cancelled = true }
  }, [activeProjectId])

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
      setRuns((prev) => { if (!m.loopRunId || !prev.has(m.loopRunId)) return prev; const n = new Map(prev); n.delete(m.loopRunId); return n })
      return
    }
    // A LEGACY rail job (implement/batch/ultracode via the QueueManager — e.g. an
    // MCP launch with a bare `mode`, or an ultracode rail) emits rail.job_started,
    // NOT loop.run_started. Track it the same way (keyed by jobId) so its live
    // elapsed/steps/lines render on the rail card exactly like a loop launch — the
    // event/log handlers below already key off jobId/processId.
    if (m.type === 'rail.job_started') {
      if (m.projectId !== projRef.current || !m.jobId || m.railIndex == null) return
      setRuns((prev) => {
        const next = new Map(prev)
        next.set(m.jobId!, { railIndex: m.railIndex!, startedAt: Date.now(), steps: 0, lines: 0 })
        return next
      })
      return
    }
    if (m.type === 'rail.job_completed' || m.type === 'rail.job_stopped') {
      setRuns((prev) => { if (!m.jobId || !prev.has(m.jobId)) return prev; const n = new Map(prev); n.delete(m.jobId!); return n })
      return
    }
    // event/log carry only the run id — gate on the run being tracked (its
    // run_started already passed the project filter). Steps = activity steps from
    // the SAME deriveFrameActivity the Job panel uses (a frame may be several
    // parallel tool_use blocks), so the rail's "pasos" matches the job exactly.
    if (m.type === 'event' && m.event_type && m.jobId) {
      const act = deriveFrameActivity({ event_type: m.event_type, payload: m.payload ?? '' } as EventRow)
      if (!act.step) return
      setRuns((prev) => {
        const cur = prev.get(m.jobId!)
        if (!cur) return prev
        const n = new Map(prev); n.set(m.jobId!, { ...cur, steps: cur.steps + (act.stepCount ?? 1) }); return n
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

  const value = useMemo(() => {
    const out: Record<number, RailExecMetric> = {}
    for (const r of runs.values()) {
      const e = out[r.railIndex]
      if (!e) out[r.railIndex] = { startedAt: r.startedAt, steps: r.steps, lines: r.lines }
      else { e.startedAt = Math.min(e.startedAt, r.startedAt); e.steps += r.steps; e.lines += r.lines }
    }
    return out
  }, [runs])

  return <RailMetricsContext.Provider value={value}>{children}</RailMetricsContext.Provider>
}
