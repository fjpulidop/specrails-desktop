import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { fetchLiveBoard } from '../lib/live-board-api'
import type { LiveBoardSnapshot } from '../lib/live-board-model'

/** WS events that can move a card (any project: the board is app-wide). */
const NUDGE_TYPES = new Set([
  'rail.pr_state', 'rail.merge_preview', 'rail.job_started', 'rail.job_completed', 'rail.job_stopped',
  'job.stuck', 'job.finalized', 'job_started', 'queue', 'phase',
  'jira.outbox_changed', 'flow.state', 'agent_title', 'agent_pr_decision', 'runtime.continuation',
  'desktop.project_added', 'desktop.project_removed',
])
const NUDGE_DEBOUNCE_MS = 500
/** A burst of events (a run stepping, a queue draining) refreshes at most this often. */
const MIN_GAP_MS = 2_000
/** The inbox's own cadence: never poll faster. */
const POLL_MS = 60_000

function isNudge(message: unknown): boolean {
  const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined
  return typeof type === 'string' && (NUDGE_TYPES.has(type) || type.startsWith('loop.run_'))
}

function sameSnapshot(a: LiveBoardSnapshot | null, b: LiveBoardSnapshot): boolean {
  if (!a) return false
  try {
    // generatedAt always moves; the board only re-renders when what it shows changed.
    return JSON.stringify({ ...a, generatedAt: '' }) === JSON.stringify({ ...b, generatedAt: '' })
  } catch {
    return false
  }
}

export interface LiveBoardData {
  snapshot: LiveBoardSnapshot | null
  status: 'loading' | 'ready' | 'error'
  /** The last refresh failed while a board was already showing: it is out of date. */
  stale: boolean
  refresh: () => Promise<void>
}

/**
 * The board's read-model while it is shown (`active`): one request per
 * refresh, refetched on open, on app focus, every 60 s while visible and,
 * debounced, on the WebSocket events that move a card. Nothing runs while the
 * board is closed; nothing is cached across projects (the server reads each
 * project's own state on every call).
 */
export function useLiveBoardData(active: boolean): LiveBoardData {
  const ws = useContext(SharedWebSocketContext)
  const [snapshot, setSnapshot] = useState<LiveBoardSnapshot | null>(null)
  const [status, setStatus] = useState<LiveBoardData['status']>('loading')
  const [stale, setStale] = useState(false)
  const revision = useRef(0)
  const alive = useRef(true)
  const lastFetch = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const refresh = useCallback(async () => {
    const mine = ++revision.current
    lastFetch.current = Date.now()
    try {
      const next = await fetchLiveBoard()
      if (!alive.current || mine !== revision.current) return
      setSnapshot((previous) => (sameSnapshot(previous, next) ? previous : next))
      setStatus('ready')
      setStale(false)
    } catch {
      // Keep what we last knew: "error" when there is nothing to show, "stale" when the board on screen is old.
      if (alive.current && mine === revision.current) {
        setStatus((s) => (s === 'ready' ? s : 'error'))
        setStale(true)
      }
    }
  }, [])

  useEffect(() => { if (active) void refresh() }, [active, refresh])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const registerHandler = ws?.registerHandler
  const unregisterHandler = ws?.unregisterHandler
  useEffect(() => {
    if (!active || !registerHandler || !unregisterHandler) return
    registerHandler('live-board', (message) => {
      if (!isNudge(message)) return
      if (timer.current) clearTimeout(timer.current)
      const wait = Math.max(NUDGE_DEBOUNCE_MS, lastFetch.current + MIN_GAP_MS - Date.now())
      timer.current = setTimeout(() => { timer.current = null; void refresh() }, wait)
    })
    return () => {
      unregisterHandler('live-board')
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
    }
  }, [active, registerHandler, unregisterHandler, refresh])

  useEffect(() => {
    if (!active) return
    const visibleRefresh = (): void => { if (document.visibilityState !== 'hidden') void refresh() }
    const poll = setInterval(visibleRefresh, POLL_MS)
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      clearInterval(poll)
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
    }
  }, [active, refresh])

  // "Done today" is the local day: past midnight the board refetches so yesterday's column clears.
  useEffect(() => {
    if (!active) return
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    const wait = Math.min(midnight - now.getTime() + 1_000, 2 ** 31 - 1)
    const id = setTimeout(() => { void refresh() }, wait)
    return () => clearTimeout(id)
  }, [active, refresh, snapshot?.generatedAt])

  return { snapshot, status, stale, refresh }
}
