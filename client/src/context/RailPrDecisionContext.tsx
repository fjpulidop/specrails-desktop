import { createContext, useContext, useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import type { RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../types'
import { coerceRailPrStateSnapshot } from '../lib/pr-delivery'

/**
 * Ask-first PR decisions per rail (safe-pr-review-flow), keyed by railIndex.
 *
 * App-LEVEL provider patterned on RailMetricsContext: registers ONE handler on
 * the shared WebSocket (`rail.pr_state`, project-filtered via ref), hydrates
 * from GET /rails `prDeliveries` on project switch, and exposes `act()` — the
 * single POST /rails/pr-decision caller both the dashboard rail row and any
 * other surface use. Actions apply the server's authoritative response
 * snapshot immediately, then later broadcasts/focus hydration converge the
 * same durable state (buttons disable while a request is in flight).
 *
 * Terminal decisions (`completed` / `merged` / `discarded`) surface a toast once (only when
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
  /** merge_local_blocked precondition (`wrong_branch` | `dirty`). */
  reason?: string
  base?: string
  /** Authoritative post-action state; applied immediately even if WS is lost. */
  snapshot?: RailPrStateSnapshot | null
  /** A concurrent surface currently owns the durable operation lease. */
  busy?: boolean
  operation?: RailPrDecisionAction | null
}

export interface RailPrCheckoutResult {
  status: number
  ok: boolean
  error?: string
  detail?: string
}

interface RailPrDecisionContextValue {
  /** Active (non-terminal) PR deliveries keyed by railIndex. */
  decisions: Map<number, RailPrStateSnapshot>
  /** True after the initial GET /rails seed for the active project has settled. */
  hydrated: boolean
  /** POST the decision action for the rail's active delivery. Never throws. */
  act: (railIndex: number, action: RailPrDecisionAction, expectedDecision: RailPrDecision) => Promise<RailPrActResult>
  /** Checkout the rail's delivered PR branch into the user's main repo. */
  checkout: (railIndex: number) => Promise<RailPrCheckoutResult>
}

const noopAct = async (): Promise<RailPrActResult> => ({ status: 0, ok: false, error: 'no_provider' })
const noopCheckout = async (): Promise<RailPrCheckoutResult> => ({ status: 0, ok: false, error: 'no_provider' })

const RailPrDecisionContext = createContext<RailPrDecisionContextValue>({ decisions: new Map(), hydrated: true, act: noopAct, checkout: noopCheckout })

/** Per-rail active PR decisions + the shared decision-action caller. */
export function useRailPrDecisions(): RailPrDecisionContextValue {
  return useContext(RailPrDecisionContext)
}

/** Shape of a GET /rails prDeliveries entry (server PrDeliverySnapshot — `id`,
 *  not `prDeliveryId`, plus extra durable columns the client ignores). */
interface ServerPrDeliverySnapshot {
  [key: string]: unknown
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
  return coerceRailPrStateSnapshot(raw, railIndex)
}

const TERMINAL_DECISIONS: ReadonlySet<RailPrDecision> = new Set(['merged', 'discarded', 'completed', 'superseded'])
const PR_OPERATIONS: ReadonlySet<string> = new Set([
  'create-pr', 'publish', 'discard', 'poll-merge', 'merge-local', 'dismiss', 'reopen', 'acknowledge-no-changes',
])

export function RailPrDecisionProvider({ activeProjectId, children }: { activeProjectId: string | null; children: React.ReactNode }) {
  const { t } = useTranslation('dashboard')
  const [decisions, setDecisions] = useState<Map<number, RailPrStateSnapshot>>(new Map())
  const [hydrated, setHydrated] = useState(false)
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const projRef = useRef(activeProjectId)
  useEffect(() => { projRef.current = activeProjectId }, [activeProjectId])
  // Synchronous mirror/source for snapshot arbitration and act(). Every map
  // replacement updates this ref before React state so back-to-back WS/HTTP
  // events validate against the latest accepted generation.
  const decisionsRef = useRef(decisions)
  // Mutation generation per rail. Hydration merges around rails that changed
  // while its GET was in flight, instead of dropping every other seeded card.
  const railVersionsRef = useRef<Map<number, number>>(new Map())
  const hydrateRequestRef = useRef(0)

  const applySnapshot = useCallback((snap: RailPrStateSnapshot, announceTerminal = true): void => {
    const currentMap = decisionsRef.current
    const current = currentMap.get(snap.railIndex)
    if (TERMINAL_DECISIONS.has(snap.decision)) {
      // A late terminal event from superseded generation A must never erase
      // active generation B merely because they share a rail index. Crucially,
      // an ignored terminal is not a rail mutation: versioning it would make an
      // in-flight hydration discard a valid generation B returned by the GET.
      if (!current || current.prDeliveryId !== snap.prDeliveryId) return
      if (announceTerminal) {
        if (snap.cleanupWarnings?.length) {
          toast.warning(t('railPr.cleanupIncomplete', { count: snap.cleanupWarnings.length }))
        } else if (snap.decision === 'merged') {
          toast.success(t('railPr.mergedToast'))
        } else if (snap.decision === 'discarded') {
          toast.info(t('railPr.discardedToast'))
        } else if (snap.decision === 'completed') {
          toast.success(t('railPr.completedToast'))
        }
      }
    }

    const next = new Map(currentMap)
    if (TERMINAL_DECISIONS.has(snap.decision)) {
      next.delete(snap.railIndex)
    } else {
      next.set(snap.railIndex, snap)
    }
    railVersionsRef.current.set(snap.railIndex, (railVersionsRef.current.get(snap.railIndex) ?? 0) + 1)
    decisionsRef.current = next
    setDecisions(next)
  }, [t])

  const hydrate = useCallback(async (projectId: string, markReady: boolean): Promise<void> => {
    const request = ++hydrateRequestRef.current
    const versionsAtStart = new Map(railVersionsRef.current)
    try {
      const response = await fetch(`/api/projects/${projectId}/rails`)
      if (!response.ok) return
      const data = await response.json() as { prDeliveries?: Record<string, ServerPrDeliverySnapshot> }
      if (request !== hydrateRequestRef.current || projRef.current !== projectId) return
      const seeded = new Map<number, RailPrStateSnapshot>()
      for (const [idxStr, raw] of Object.entries(data.prDeliveries ?? {})) {
        const snap = fromServerSnapshot(raw, Number(idxStr))
        if (snap && !TERMINAL_DECISIONS.has(snap.decision)) seeded.set(Number(idxStr), snap)
      }
      const current = decisionsRef.current
      const next = new Map(seeded)
      // Preserve only rails that changed after this GET began. An accepted
      // terminal event intentionally leaves no current entry and therefore
      // deletes a stale seeded row; ignored older-generation terminals never
      // advance the rail version and cannot erase a valid seed.
      for (const [railIndex, version] of railVersionsRef.current) {
        if (version === (versionsAtStart.get(railIndex) ?? 0)) continue
        const live = current.get(railIndex)
        if (live) next.set(railIndex, live)
        else next.delete(railIndex)
      }
      decisionsRef.current = next
      setDecisions(next)
    } catch {
      /* best-effort convergence */
    } finally {
      if (markReady && request === hydrateRequestRef.current && projRef.current === projectId) setHydrated(true)
    }
  }, [])

  // Reset on project switch, then SEED from the server so an active decision
  // survives a page refresh (the WS stream can't replay past broadcasts).
  // NOTE: raw /api/projects/<id>/rails, NOT getApiBase() — this provider is
  // app-level and mounted regardless of the active project (the documented
  // RailMetricsContext deviation).
  useEffect(() => {
    projRef.current = activeProjectId
    hydrateRequestRef.current++
    const empty = new Map<number, RailPrStateSnapshot>()
    decisionsRef.current = empty
    setDecisions(empty)
    setHydrated(false)
    railVersionsRef.current = new Map()
    if (!activeProjectId) {
      setHydrated(true)
      return
    }
    void hydrate(activeProjectId, true)
  }, [activeProjectId, hydrate])

  const handleMessage = useCallback((data: unknown) => {
    const m = data as { type?: string; projectId?: string; railIndex?: number; prDeliveryId?: string; decision?: RailPrDecision }
    if (!m || m.type !== 'rail.pr_state') return
    if (m.projectId !== projRef.current) return
    if (typeof m.railIndex !== 'number' || typeof m.prDeliveryId !== 'string' || !m.decision) return
    const snap = coerceRailPrStateSnapshot(m, m.railIndex)
    if (!snap) return
    applySnapshot(snap)
  }, [applySnapshot])

  useLayoutEffect(() => {
    registerHandler('rail-pr-decision', handleMessage)
    return () => unregisterHandler('rail-pr-decision')
  }, [handleMessage, registerHandler, unregisterHandler])

  useEffect(() => {
    const onFocus = () => {
      const projectId = projRef.current
      if (projectId) void hydrate(projectId, false)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hydrate])

  const previousConnectionRef = useRef(connectionStatus)
  useEffect(() => {
    const previous = previousConnectionRef.current
    previousConnectionRef.current = connectionStatus
    const projectId = projRef.current
    if (projectId && connectionStatus === 'connected' && previous !== 'connected') void hydrate(projectId, false)
  }, [connectionStatus, hydrate])

  // The ONE decision-action caller. This is not an optimistic write: the map
  // advances only from the server's authoritative response snapshot. A later
  // rail.pr_state broadcast is an idempotent convergence path.
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
      const body = (await res.json().catch(() => ({}))) as Omit<RailPrActResult, 'status' | 'snapshot'> & { snapshot?: unknown }
      const authoritative = coerceRailPrStateSnapshot(body.snapshot)
      if (authoritative && projRef.current === projectId) {
        applySnapshot(authoritative)
      }
      return {
        ...body,
        snapshot: authoritative,
        busy: res.status === 409 && body.error === 'operation_in_progress',
        operation: authoritative?.operation ?? (
          typeof body.operation === 'string' && PR_OPERATIONS.has(body.operation)
            ? body.operation as RailPrDecisionAction
            : null
        ),
        status: res.status,
        ok: res.ok && body.ok === true,
      }
    } catch (err) {
      return { status: 0, ok: false, error: 'network', detail: (err as Error).message }
    }
  }, [applySnapshot])

  const checkout = useCallback(async (railIndex: number): Promise<RailPrCheckoutResult> => {
    const snap = decisionsRef.current.get(railIndex)
    const projectId = projRef.current
    if (!snap || !projectId) return { status: 0, ok: false, error: 'no_delivery' }
    try {
      const res = await fetch(`/api/projects/${projectId}/rails/pr-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prDeliveryId: snap.prDeliveryId }),
      })
      const body = (await res.json().catch(() => ({}))) as Omit<RailPrCheckoutResult, 'status'>
      return { ...body, status: res.status, ok: res.ok && body.ok === true }
    } catch (err) {
      return { status: 0, ok: false, error: 'network', detail: (err as Error).message }
    }
  }, [])

  const value = useMemo(() => ({ decisions, hydrated, act, checkout }), [decisions, hydrated, act, checkout])

  return <RailPrDecisionContext.Provider value={value}>{children}</RailPrDecisionContext.Provider>
}
