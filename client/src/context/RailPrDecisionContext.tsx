import { createContext, useContext, useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import type { RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../types'

/**
 * Ask-first PR decisions per rail (safe-pr-review-flow), keyed by railIndex.
 *
 * App-LEVEL provider patterned on RailMetricsContext: registers ONE handler on
 * the shared WebSocket (`rail.pr_state`, project-filtered via ref), hydrates
 * from GET /rails `prDeliveries` on project switch, and exposes `act()` — the
 * single POST /rails/pr-decision caller both the dashboard rail row and any
 * other surface use. State is NEVER written optimistically: every mutation
 * re-broadcasts the durable snapshot and this map reconciles to it (buttons
 * disable while a request is in flight).
 *
 * Terminal decisions (`merged` / `discarded`) surface a toast once (only when
 * the entry existed locally — dedupes replays) and REMOVE the entry, mirroring
 * the server's "active = non-terminal" hydration contract.
 */

/** Result of a POST /rails/pr-decision call, HTTP status + parsed body. */
export interface RailPrActResult {
  status: number
  ok: boolean
  decision?: string
  prUrl?: string | null
  prState?: string
  merged?: boolean
  error?: string
  detail?: string
  current?: string
}

interface RailPrDecisionContextValue {
  /** Active (non-terminal) PR deliveries keyed by railIndex. */
  decisions: Map<number, RailPrStateSnapshot>
  /** POST the decision action for the rail's active delivery. Never throws. */
  act: (railIndex: number, action: RailPrDecisionAction, expectedDecision: RailPrDecision) => Promise<RailPrActResult>
}

const noopAct = async (): Promise<RailPrActResult> => ({ status: 0, ok: false, error: 'no_provider' })

const RailPrDecisionContext = createContext<RailPrDecisionContextValue>({ decisions: new Map(), act: noopAct })

/** Per-rail active PR decisions + the shared decision-action caller. */
export function useRailPrDecisions(): RailPrDecisionContextValue {
  return useContext(RailPrDecisionContext)
}

/** Shape of a GET /rails prDeliveries entry (server PrDeliverySnapshot — `id`,
 *  not `prDeliveryId`, plus extra durable columns the client ignores). */
interface ServerPrDeliverySnapshot {
  id?: string
  railIndex?: number
  railKey?: string
  ticketIds?: number[]
  baseBranch?: string
  branch?: string | null
  prUrl?: string | null
  prNumber?: number | null
  prState?: RailPrStateSnapshot['prState']
  decision?: RailPrDecision
  runIds?: string[]
  originConversationId?: string | null
}

function fromServerSnapshot(raw: ServerPrDeliverySnapshot, railIndex: number): RailPrStateSnapshot | null {
  if (!raw?.id || !raw.decision) return null
  return {
    prDeliveryId: raw.id,
    railIndex: raw.railIndex ?? railIndex,
    railKey: raw.railKey ?? '',
    ticketIds: Array.isArray(raw.ticketIds) ? raw.ticketIds : [],
    baseBranch: raw.baseBranch ?? '',
    branch: raw.branch ?? null,
    prUrl: raw.prUrl ?? null,
    prNumber: raw.prNumber ?? null,
    prState: raw.prState ?? 'none',
    decision: raw.decision,
    runIds: Array.isArray(raw.runIds) ? raw.runIds : [],
    originConversationId: raw.originConversationId ?? null,
  }
}

const TERMINAL_DECISIONS: ReadonlySet<RailPrDecision> = new Set(['merged', 'discarded'])

export function RailPrDecisionProvider({ activeProjectId, children }: { activeProjectId: string | null; children: React.ReactNode }) {
  const { t } = useTranslation('dashboard')
  const [decisions, setDecisions] = useState<Map<number, RailPrStateSnapshot>>(new Map())
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const projRef = useRef(activeProjectId)
  useEffect(() => { projRef.current = activeProjectId }, [activeProjectId])
  // Mirror for act() so its callback never closes over a stale map.
  const decisionsRef = useRef(decisions)
  useEffect(() => { decisionsRef.current = decisions }, [decisions])
  // Rail indexes that received a live rail.pr_state AFTER the last reset — the
  // seed fetch must never clobber (or resurrect, post-terminal-removal) those.
  const liveSinceResetRef = useRef<Set<number>>(new Set())

  // Reset on project switch, then SEED from the server so an active decision
  // survives a page refresh (the WS stream can't replay past broadcasts).
  // NOTE: raw /api/projects/<id>/rails, NOT getApiBase() — this provider is
  // app-level and mounted regardless of the active project (the documented
  // RailMetricsContext deviation).
  useEffect(() => {
    setDecisions(new Map())
    liveSinceResetRef.current = new Set()
    if (!activeProjectId) return
    let cancelled = false
    fetch(`/api/projects/${activeProjectId}/rails`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { prDeliveries?: Record<string, ServerPrDeliverySnapshot> } | null) => {
        if (cancelled || !data?.prDeliveries) return
        const seeded = new Map<number, RailPrStateSnapshot>()
        for (const [idxStr, raw] of Object.entries(data.prDeliveries)) {
          const snap = fromServerSnapshot(raw, Number(idxStr))
          if (snap && !TERMINAL_DECISIONS.has(snap.decision)) seeded.set(Number(idxStr), snap)
        }
        if (seeded.size === 0) return
        setDecisions((prev) => {
          const next = new Map(prev)
          for (const [idx, snap] of seeded) {
            if (!liveSinceResetRef.current.has(idx)) next.set(idx, snap) // never clobber a live WS entry
          }
          return next
        })
      })
      .catch(() => { /* best-effort seed */ })
    return () => { cancelled = true }
  }, [activeProjectId])

  const handleMessage = useCallback((data: unknown) => {
    const m = data as { type?: string; projectId?: string; railIndex?: number; prDeliveryId?: string; decision?: RailPrDecision }
    if (!m || m.type !== 'rail.pr_state') return
    if (m.projectId !== projRef.current) return
    if (typeof m.railIndex !== 'number' || typeof m.prDeliveryId !== 'string' || !m.decision) return
    const msg = m as unknown as RailPrStateSnapshot & { projectId: string }
    const snap: RailPrStateSnapshot = {
      prDeliveryId: msg.prDeliveryId,
      railIndex: msg.railIndex,
      railKey: msg.railKey ?? '',
      ticketIds: Array.isArray(msg.ticketIds) ? msg.ticketIds : [],
      baseBranch: msg.baseBranch ?? '',
      branch: msg.branch ?? null,
      prUrl: msg.prUrl ?? null,
      prNumber: msg.prNumber ?? null,
      prState: msg.prState ?? 'none',
      decision: msg.decision,
      runIds: Array.isArray(msg.runIds) ? msg.runIds : [],
      originConversationId: msg.originConversationId ?? null,
    }
    liveSinceResetRef.current.add(snap.railIndex)

    if (TERMINAL_DECISIONS.has(snap.decision)) {
      setDecisions((prev) => {
        if (!prev.has(snap.railIndex)) return prev // never seen locally — nothing to surface or remove
        // Surface the terminal transition once, then drop the entry.
        if (snap.decision === 'merged') {
          toast.success(t('railPr.mergedToast'))
        } else {
          toast.info(t('railPr.discardedToast'))
        }
        const next = new Map(prev)
        next.delete(snap.railIndex)
        return next
      })
      return
    }
    setDecisions((prev) => {
      const next = new Map(prev)
      next.set(snap.railIndex, snap)
      return next
    })
  }, [t])

  useLayoutEffect(() => {
    registerHandler('rail-pr-decision', handleMessage)
    return () => unregisterHandler('rail-pr-decision')
  }, [handleMessage, registerHandler, unregisterHandler])

  // The ONE decision-action caller. No optimistic state: the response is
  // returned to the caller (for toasts / button state) and the map reconciles
  // to the server's rail.pr_state re-broadcast.
  const act = useCallback(async (railIndex: number, action: RailPrDecisionAction, expectedDecision: RailPrDecision): Promise<RailPrActResult> => {
    const snap = decisionsRef.current.get(railIndex)
    const projectId = projRef.current
    if (!snap || !projectId) return { status: 0, ok: false, error: 'no_delivery' }
    try {
      const res = await fetch(`/api/projects/${projectId}/rails/pr-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prDeliveryId: snap.prDeliveryId, action, expectedDecision }),
      })
      const body = (await res.json().catch(() => ({}))) as Omit<RailPrActResult, 'status'>
      return { ...body, status: res.status, ok: res.ok && body.ok === true }
    } catch (err) {
      return { status: 0, ok: false, error: 'network', detail: (err as Error).message }
    }
  }, [])

  const value = useMemo(() => ({ decisions, act }), [decisions, act])

  return <RailPrDecisionContext.Provider value={value}>{children}</RailPrDecisionContext.Provider>
}
