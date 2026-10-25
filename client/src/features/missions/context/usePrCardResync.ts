import { useCallback, useEffect, useRef } from 'react'
import type { AgentMessage } from '../lib/agent-api'
import { derivePrCards } from '../components/agent-pr-pinning'

// ── Self-healing mission cards ───────────────────────────────────────────────
// The persisted card row is authoritative; the `agent_pr_decision` broadcast is
// only the fast path. A missed broadcast (socket half-open across sleep, a
// server restart mid-run, a race with a conversation load) must never leave a
// card at "building" until the person reloads. This hook re-reads the active
// conversation's cards on every signal that events may have been missed, and
// polls gently while a card is still unsettled.

/** Fallback poll while a card is building/running (paused when hidden). */
export const PR_CARD_POLL_MS = 25_000
/** Failure backoff ceiling for the fallback poll. */
export const PR_CARD_POLL_MAX_MS = 120_000
/** Coalescing window: bursts of signals (focus + visibility + reconnect) → one fetch. */
export const PR_CARD_RESYNC_MIN_GAP_MS = 2_000
/** Wall-clock heartbeat used to notice a system resume (timers freeze in sleep). */
export const PR_CARD_RESUME_TICK_MS = 15_000
/** A heartbeat gap this much longer than its tick means the machine slept. */
export const PR_CARD_RESUME_DRIFT_MS = 30_000

/** True while the active thread holds a card whose run has not settled yet. */
export function hasUnsettledPrCard(messages: readonly AgentMessage[]): boolean {
  for (const envelope of derivePrCards(messages).byMessageId.values()) {
    if (envelope.decision === 'building') return true
    if (envelope.decision !== 'superseded' && envelope.decision !== 'discarded' &&
      (envelope.phase === 'launched' || envelope.phase === 'running')) return true
  }
  return false
}

/**
 * A `rail.pr_state` broadcast names a delivery whose card in the active thread
 * still shows a different decision (same project): the card broadcast was
 * missed or never sent, so the cards should be re-read from the server.
 */
export function railStateDiffersFromCard(messages: readonly AgentMessage[], raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const msg = raw as { prDeliveryId?: unknown; decision?: unknown; projectId?: unknown }
  if (typeof msg.prDeliveryId !== 'string' || typeof msg.decision !== 'string') return false
  for (const envelope of derivePrCards(messages).byMessageId.values()) {
    if (envelope.prDeliveryId !== msg.prDeliveryId) continue
    if (typeof msg.projectId === 'string' && msg.projectId !== envelope.projectId) return false
    return envelope.decision !== msg.decision
  }
  return false
}

export interface PrCardResyncOptions {
  enabled: boolean
  /** Re-reads the active conversation; resolves false when the fetch failed. */
  resync: () => Promise<boolean>
  /** Poll while true (a card is building/running). */
  unsettled: boolean
}

/**
 * Returns a deduplicated `request()` trigger (in-flight coalescing + a minimum
 * gap) and wires the automatic triggers: visibility regain, window focus,
 * system resume and the unsettled-card fallback poll (with failure backoff).
 */
export function usePrCardResync({ enabled, resync, unsettled }: PrCardResyncOptions): () => void {
  const resyncRef = useRef(resync)
  resyncRef.current = resync
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const inFlightRef = useRef<Promise<void> | null>(null)
  const pendingRef = useRef(false)
  const lastRunRef = useRef(0)
  const failuresRef = useRef(0)
  const gapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const request = useCallback((): void => {
    if (!enabledRef.current || !mountedRef.current) return
    if (inFlightRef.current) { pendingRef.current = true; return }
    const wait = lastRunRef.current + PR_CARD_RESYNC_MIN_GAP_MS - Date.now()
    if (wait > 0) {
      if (!gapTimerRef.current) {
        gapTimerRef.current = setTimeout(() => { gapTimerRef.current = null; request() }, wait)
      }
      return
    }
    lastRunRef.current = Date.now()
    inFlightRef.current = resyncRef.current()
      .then((ok) => { failuresRef.current = ok ? 0 : failuresRef.current + 1 })
      .catch(() => { failuresRef.current += 1 })
      .finally(() => {
        inFlightRef.current = null
        if (pendingRef.current) { pendingRef.current = false; request() }
      })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (gapTimerRef.current) clearTimeout(gapTimerRef.current)
      gapTimerRef.current = null
    }
  }, [])

  // Visibility regain, window focus and system resume.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const onVisibility = (): void => { if (document.visibilityState === 'visible') request() }
    const onFocus = (): void => request()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    let lastTick = Date.now()
    const heartbeat = setInterval(() => {
      const now = Date.now()
      const slept = now - lastTick > PR_CARD_RESUME_TICK_MS + PR_CARD_RESUME_DRIFT_MS
      lastTick = now
      if (slept) request()
    }, PR_CARD_RESUME_TICK_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      clearInterval(heartbeat)
    }
  }, [enabled, request])

  // Fallback poll while a card is unsettled; stops once every card settles.
  useEffect(() => {
    if (!enabled || !unsettled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const schedule = (): void => {
      if (stopped) return
      // The delay reads the failure count AFTER the previous fetch settled.
      const delay = Math.min(PR_CARD_POLL_MS * 2 ** failuresRef.current, PR_CARD_POLL_MAX_MS)
      timer = setTimeout(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') request()
        void (inFlightRef.current ?? Promise.resolve()).then(schedule)
      }, delay)
    }
    schedule()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [enabled, unsettled, request])

  return request
}
