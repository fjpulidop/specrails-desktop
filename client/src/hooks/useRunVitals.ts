import { useEffect, useId, useState } from 'react'
import { API_ORIGIN } from '../lib/origin'
import { useSharedWebSocket } from './useSharedWebSocket'

/**
 * Live vitals for one rail run's backing job row (safe-pr-review-flow run
 * chips). HONEST METRICS ONLY — every number is real:
 *  - the initial GET reads the authoritative jobs row (totals + started_at /
 *    finished_at / status),
 *  - `job.turn_done` carries the running SUM of completed turns' REAL usage
 *    (never an estimate) and replaces the totals wholesale,
 *  - `job.finalized` freezes the vitals at the final authoritative totals,
 *  - elapsed is wall-clock from the row's own timestamps (1s ticker while
 *    running; frozen once finished).
 * Nothing is extrapolated client-side.
 */
export interface RunVitals {
  /** Job status; null until the initial GET settles. */
  status: string | null
  /** True when the backing loop run is paused awaiting a human decision. */
  paused: boolean
  pausedReason: string | null
  /** True while the backing job is still executing (drives the ticker). */
  running: boolean
  /** REAL wall-clock ms (started_at → finished_at | now). Null until known. */
  elapsedMs: number | null
  /** Accumulated REAL cost (USD). Null until the row/turn totals carry one. */
  costUsd: number | null
  numTurns: number | null
  /** The initial GET settled (successfully or not). */
  loaded: boolean
}

interface JobRowSlice {
  status?: string | null
  started_at?: string | null
  finished_at?: string | null
  total_cost_usd?: number | null
  num_turns?: number | null
  loopPaused?: boolean
  loopPauseReason?: string | null
}

interface WireTotals {
  total_cost_usd?: number
  num_turns?: number
}

const isRunning = (status: string | null): boolean => status === 'running' || status === 'queued'

/** `4m12s` / `38s` / `1h 4m` — the run chip's compact elapsed format. */
export function formatRunElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m${String(secs % 60).padStart(2, '0')}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/** Graceful variant of useSharedWebSocket: trees without a provider (unit
 *  tests, storybook-style mounts) get null instead of a crash. The hook call
 *  itself is unconditional so the rules of hooks hold. */
function useSharedWebSocketOptional(): ReturnType<typeof useSharedWebSocket> | null {
  try {
    return useSharedWebSocket()
  } catch {
    return null
  }
}

const ts = (v: string | null | undefined): number | null => {
  if (!v) return null
  const n = new Date(v).getTime()
  return Number.isFinite(n) ? n : null
}

export function useRunVitals(projectId: string, runId: string, opts: { live: boolean }): RunVitals {
  const { live } = opts
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [finishedAt, setFinishedAt] = useState<number | null>(null)
  const [costUsd, setCostUsd] = useState<number | null>(null)
  const [numTurns, setNumTurns] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [pausedReason, setPausedReason] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Initial (and live→frozen flip) fetch of the authoritative jobs row. The
  // flip refetch matters for non-interactive runs that never emit
  // job.finalized — their final totals land on the row at settle.
  useEffect(() => {
    let cancelled = false
    fetch(`${API_ORIGIN}/api/projects/${projectId}/jobs/${runId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { job?: JobRowSlice } | null) => {
        if (cancelled) return
        const job = data?.job
        if (job) {
          setStatus(typeof job.status === 'string' ? job.status : null)
          setStartedAt(ts(job.started_at))
          setFinishedAt(ts(job.finished_at))
          if (typeof job.total_cost_usd === 'number') setCostUsd(job.total_cost_usd)
          if (typeof job.num_turns === 'number') setNumTurns(job.num_turns)
          setPaused(job.loopPaused === true)
          setPausedReason(typeof job.loopPauseReason === 'string' ? job.loopPauseReason : null)
        }
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [projectId, runId, live])

  const running = isRunning(status) && finishedAt === null

  // Live WS stream — only while the caller says the run may still be moving.
  const ws = useSharedWebSocketOptional()
  const uid = useId()
  useEffect(() => {
    if (!ws || !live) return
    const handlerId = `run-vitals-${runId}-${uid}`
    ws.registerHandler(handlerId, (data: unknown) => {
      const msg = data as { type?: string; jobId?: string; loopRunId?: string; status?: string; timestamp?: string; totals?: WireTotals; reason?: string }
      if (msg?.type === 'loop.run_paused' && msg.loopRunId === runId) {
        setPaused(true)
        setPausedReason(typeof msg.reason === 'string' ? msg.reason : null)
        setStatus('running')
        setFinishedAt(null)
        return
      }
      if ((msg?.type === 'loop.run_resumed' || msg?.type === 'loop.run_completed') && msg.loopRunId === runId) {
        setPaused(false)
        setPausedReason(null)
        return
      }
      if (msg?.jobId !== runId) return
      if (msg.type === 'job.turn_done') {
        // Running SUM of completed turns' REAL usage — adopt wholesale.
        if (typeof msg.totals?.total_cost_usd === 'number') setCostUsd(msg.totals.total_cost_usd)
        if (typeof msg.totals?.num_turns === 'number') setNumTurns(msg.totals.num_turns)
      } else if (msg.type === 'job.finalized') {
        // Final authoritative totals + terminal status → freeze.
        if (typeof msg.totals?.total_cost_usd === 'number') setCostUsd(msg.totals.total_cost_usd)
        if (typeof msg.totals?.num_turns === 'number') setNumTurns(msg.totals.num_turns)
        if (typeof msg.status === 'string') setStatus(msg.status)
        setPaused(false)
        setPausedReason(null)
        setFinishedAt(ts(msg.timestamp) ?? Date.now())
      }
    })
    return () => ws.unregisterHandler(handlerId)
  }, [ws, live, runId, uid])

  // 1s elapsed ticker — only while genuinely running (and the caller wants live).
  useEffect(() => {
    if (!live || !running || startedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, running, startedAt])

  const elapsedMs = startedAt === null ? null : Math.max(0, (finishedAt ?? now) - startedAt)

  return { status, paused, pausedReason, running, elapsedMs, costUsd, numTurns, loaded }
}
