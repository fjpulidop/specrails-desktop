import { useState, useEffect, useRef, useCallback, useLayoutEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_ORIGIN } from '../lib/origin'
import { useSharedWebSocket } from './useSharedWebSocket'
import { useDesktop } from './useDesktop'
import { isSpecGenInFlight } from '../lib/spec-gen-suppression'
import type { LocalTicket } from '../types'

// Re-export for backward compat
export type { LocalTicket }

// ─── Types ────────────────────────────────────────────────────────────────────

interface TicketWsMessage {
  type: 'ticket_created' | 'ticket_updated' | 'ticket_deleted' | 'explore.contract_refine_started' | 'explore.contract_refine_failed' | 'mcp.activity' | 'desktop.project_recovered'
  projectId?: string
  /** mcp.activity: the project an external-MCP action touched (no top-level projectId so it isn't filtered). */
  affectedProjectId?: string
  ticket?: LocalTicket
  ticketId?: number
  timestamp?: string
}

const GLOW_DURATION_MS = 3000
const CONTRACT_LAYER_MARKER = '\n\n---\n\n## Contract Layer\n\n'

function ticketsApiBase(projectId: string): string {
  return `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
}

/** Cheap deep-equality for two tickets (both come from the same API shape). */
function ticketsEqual(a: LocalTicket, b: LocalTicket): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge a freshly-fetched ticket list into the current one WITHOUT churning
 * object references for unchanged rows. Reuses each previous ticket object when
 * its content is byte-identical, and returns the SAME `prev` array reference
 * when nothing changed at all — so React skips re-rendering the board entirely.
 * Order and membership follow `fetched` (authoritative).
 */
export function reconcileTickets(prev: LocalTicket[], fetched: LocalTicket[]): LocalTicket[] {
  const prevById = new Map(prev.map((t) => [t.id, t]))
  const merged = fetched.map((f) => {
    const p = prevById.get(f.id)
    return p && ticketsEqual(p, f) ? p : f
  })
  const sameAsPrev = merged.length === prev.length && merged.every((m, i) => m === prev[i])
  return sameAsPrev ? prev : merged
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTickets() {
  const { t } = useTranslation('tickets')
  const { activeProjectId } = useDesktop()
  const [tickets, setTickets] = useState<LocalTicket[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTicketIds, setNewTicketIds] = useState<Set<number>>(new Set())
  const [contractRefiningIds, setContractRefiningIds] = useState<Set<number>>(new Set())

  const activeProjectIdRef = useRef(activeProjectId)
  activeProjectIdRef.current = activeProjectId
  const requestGenerationRef = useRef(0)
  const activeFetchControllerRef = useRef<AbortController | null>(null)

  // Track known ticket IDs so we can detect net-new additions on full refresh
  const knownIdsRef = useRef<Set<number>>(new Set())

  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  // M21: the shared WS handler registry is keyed by string id. The old fixed id
  // 'tickets' meant the THREE simultaneously-mounted useTickets() instances
  // (TicketDetailModalProvider, useCompareUrlSync, DashboardPage) clobbered and
  // deleted each other's registration — silently killing live ticket updates on
  // the board. A per-instance id lets them coexist.
  const handlerId = useId()

  // ── Fetch tickets from API ────────────────────────────────────────────────

  const fetchTickets = useCallback(async (projectId: string, signal?: AbortSignal): Promise<LocalTicket[]> => {
    const base = ticketsApiBase(projectId)
    // `cache: 'no-store'` is REQUIRED: the API sends a weak ETag and the webview
    // (WKWebView/Tauri) would otherwise serve a stale cached /tickets response —
    // tickets created out-of-band (e.g. via the MCP) never appeared until a full
    // app restart. Live data must always hit the server.
    const res = await fetch(`${base}/tickets`, { signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`Failed to fetch tickets: ${res.status}`)
    const data = (await res.json()) as { tickets: LocalTicket[] } | LocalTicket[]
    return Array.isArray(data) ? data : data.tickets ?? []
  }, [])

  // ── Initial load + project switch ─────────────────────────────────────────

  const loadTickets = useCallback(async (
    ownerProjectId: string,
    mode: 'replace' | 'merge',
  ): Promise<void> => {
    const generation = ++requestGenerationRef.current
    activeFetchControllerRef.current?.abort()
    const controller = new AbortController()
    activeFetchControllerRef.current = controller
    if (activeProjectIdRef.current === ownerProjectId) {
      setLoading(true)
      setError(null)
    }

    try {
      const fetched = await fetchTickets(ownerProjectId, controller.signal)
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current ||
        activeProjectIdRef.current !== ownerProjectId
      ) return

      const oldIds = knownIdsRef.current
      const newIds = new Set<number>()
      if (mode === 'merge') {
        for (const ticket of fetched) {
          if (oldIds.size > 0 && !oldIds.has(ticket.id)) newIds.add(ticket.id)
        }
      }
      knownIdsRef.current = new Set(fetched.map((ticket) => ticket.id))
      if (mode === 'replace') {
        setTickets(fetched)
      } else {
        // Reuse unchanged row references so a background refresh does not churn
        // every ticket card.
        setTickets((prev) => reconcileTickets(prev, fetched))
      }

      if (newIds.size > 0 && oldIds.size > 0) {
        setNewTicketIds(newIds)
        toast.success(t('toasts.newTicketsAdded', { count: newIds.size }), { id: `tickets-added-${ownerProjectId}` })
        setTimeout(() => {
          if (activeProjectIdRef.current !== ownerProjectId) return
          setNewTicketIds((prev) => {
            const next = new Set(prev)
            for (const id of newIds) next.delete(id)
            return next
          })
        }, GLOW_DURATION_MS)
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current ||
        activeProjectIdRef.current !== ownerProjectId
      ) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation === requestGenerationRef.current) {
        if (activeFetchControllerRef.current === controller) activeFetchControllerRef.current = null
        if (activeProjectIdRef.current === ownerProjectId) setLoading(false)
      }
    }
  }, [fetchTickets, t])

  const refetch = useCallback(async (): Promise<void> => {
    if (!activeProjectId) return
    await loadTickets(activeProjectId, 'merge')
  }, [activeProjectId, loadTickets])

  useEffect(() => {
    requestGenerationRef.current += 1
    activeFetchControllerRef.current?.abort()
    activeFetchControllerRef.current = null
    setTickets([])
    setLoading(false)
    setError(null)
    knownIdsRef.current = new Set()
    setNewTicketIds(new Set())
    setContractRefiningIds(new Set())

    if (!activeProjectId) {
      return
    }

    void loadTickets(activeProjectId, 'replace')

    return () => {
      requestGenerationRef.current += 1
      activeFetchControllerRef.current?.abort()
      activeFetchControllerRef.current = null
    }
  }, [activeProjectId, loadTickets])

  // ── WebSocket handler ─────────────────────────────────────────────────────

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as TicketWsMessage
    if (!msg || typeof msg.type !== 'string') return

    const currentProjectId = activeProjectIdRef.current
    if ((msg as { projectId?: string }).projectId && (msg as { projectId?: string }).projectId !== currentProjectId) return

    switch (msg.type) {
      case 'desktop.project_recovered': {
        if (msg.projectId === currentProjectId) refetch()
        break
      }
      case 'mcp.activity': {
        // An external MCP client mutated something. The event is app-level (no
        // top-level projectId, so it isn't filtered above); refetch when it
        // touched the active project so the board reflects it live regardless of
        // which specific event the action emitted.
        if (msg.affectedProjectId && msg.affectedProjectId === currentProjectId) {
          refetch()
        }
        break
      }

      case 'ticket_created': {
        if (!msg.ticket) break
        const ticket = msg.ticket
        setTickets((prev) => {
          if (prev.some((t) => t.id === ticket.id)) return prev
          return [...prev, ticket]
        })
        knownIdsRef.current.add(ticket.id)
        setNewTicketIds((prev) => new Set([...prev, ticket.id]))
        if (!isSpecGenInFlight(currentProjectId)) {
          // Stable id so the several live useTickets instances (dashboard, ticket
          // modal context, …) collapse to ONE toast instead of one each.
          toast.success(t('toasts.newTicket', { title: ticket.title }), { id: `new-ticket-${ticket.id}` })
        }
        setTimeout(() => {
          setNewTicketIds((prev) => {
            const next = new Set(prev)
            next.delete(ticket.id)
            return next
          })
        }, GLOW_DURATION_MS)
        break
      }

      case 'ticket_updated': {
        if (!msg.ticket) break
        if (msg.ticket.id === 0) {
          refetch()
          break
        }
        const updated = msg.ticket
        setTickets((prev) =>
          prev.map((t) => (t.id === updated.id ? updated : t))
        )
        if (typeof updated.description === 'string' && updated.description.includes(CONTRACT_LAYER_MARKER)) {
          setContractRefiningIds((prev) => {
            if (!prev.has(updated.id)) return prev
            const next = new Set(prev)
            next.delete(updated.id)
            return next
          })
        }
        break
      }

      case 'ticket_deleted': {
        if (msg.ticketId == null) break
        const deletedId = msg.ticketId
        setTickets((prev) => prev.filter((t) => t.id !== deletedId))
        knownIdsRef.current.delete(deletedId)
        break
      }

      case 'explore.contract_refine_started': {
        if (msg.ticketId == null) break
        setContractRefiningIds((prev) => new Set([...prev, msg.ticketId!]))
        break
      }

      case 'explore.contract_refine_failed': {
        if (msg.ticketId == null) break
        const ticketId = msg.ticketId
        setContractRefiningIds((prev) => {
          if (!prev.has(ticketId)) return prev
          const next = new Set(prev)
          next.delete(ticketId)
          return next
        })
        break
      }
    }
  }, [refetch, t])

  useLayoutEffect(() => {
    registerHandler(`tickets-${handlerId}`, handleMessage)
    return () => unregisterHandler(`tickets-${handlerId}`)
  }, [handleMessage, registerHandler, unregisterHandler, handlerId])

  // B26: ticket_* events arriving while the socket was down are lost, leaving the
  // board stale until the next manual action. Refetch on every (re)connect after
  // the first, so a server restart / network blip self-heals.
  const prevConnRef = useRef(connectionStatus)
  useEffect(() => {
    if (prevConnRef.current !== 'connected' && connectionStatus === 'connected') {
      if (activeProjectIdRef.current) refetch()
    }
    prevConnRef.current = connectionStatus
  }, [connectionStatus, refetch])

  // ── CRUD mutations ────────────────────────────────────────────────────────

  const deleteTicket = useCallback(async (ticketId: number): Promise<boolean> => {
    const ownerProjectId = activeProjectId
    if (!ownerProjectId) return false
    try {
      const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}`, { method: 'DELETE' })
      if (res.ok && activeProjectIdRef.current === ownerProjectId) {
        await loadTickets(ownerProjectId, 'merge')
      }
      return res.ok
    } catch {
      return false
    }
  }, [activeProjectId, loadTickets])

  const updateTicketStatus = useCallback(
    async (ticketId: number, status: LocalTicket['status']): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      try {
        const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        })
        if (res.ok && activeProjectIdRef.current === ownerProjectId) {
          await loadTickets(ownerProjectId, 'merge')
        }
        return res.ok
      } catch {
        return false
      }
    },
    [activeProjectId, loadTickets]
  )

  const updateTicketPriority = useCallback(
    async (ticketId: number, priority: LocalTicket['priority']): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      try {
        const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority }),
        })
        if (res.ok && activeProjectIdRef.current === ownerProjectId) {
          await loadTickets(ownerProjectId, 'merge')
        }
        return res.ok
      } catch {
        return false
      }
    },
    [activeProjectId, loadTickets]
  )

  const createTicket = useCallback(
    async (ticket: { title: string; description?: string; status?: LocalTicket['status']; priority?: LocalTicket['priority']; labels?: string[]; repositoryIds?: string[] }): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      try {
        const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ticket),
        })
        if (res.ok && activeProjectIdRef.current === ownerProjectId) {
          await loadTickets(ownerProjectId, 'merge')
        }
        return res.ok
      } catch {
        return false
      }
    },
    [activeProjectId, loadTickets]
  )

  const updateTicket = useCallback(
    async (ticketId: number, fields: Partial<Pick<LocalTicket, 'title' | 'description' | 'status' | 'priority' | 'labels' | 'prerequisites' | 'repositoryIds'>>): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      try {
        const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        })
        if (res.ok && activeProjectIdRef.current === ownerProjectId) {
          await loadTickets(ownerProjectId, 'merge')
        }
        return res.ok
      } catch {
        return false
      }
    },
    [activeProjectId, loadTickets]
  )

  return {
    tickets,
    loading,
    isLoading: loading,
    error,
    newTicketIds,
    contractRefiningIds,
    refetch,
    refresh: refetch,
    deleteTicket,
    updateTicketStatus,
    updateTicketPriority,
    createTicket,
    updateTicket,
  }
}
