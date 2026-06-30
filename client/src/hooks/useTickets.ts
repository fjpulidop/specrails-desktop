import { useState, useEffect, useRef, useCallback, useLayoutEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getApiBase } from '../lib/api'
import { useSharedWebSocket } from './useSharedWebSocket'
import { useDesktop } from './useDesktop'
import { isSpecGenInFlight } from '../lib/spec-gen-suppression'
import type { LocalTicket } from '../types'

// Re-export for backward compat
export type { LocalTicket }

// ─── Types ────────────────────────────────────────────────────────────────────

interface TicketWsMessage {
  type: 'ticket_created' | 'ticket_updated' | 'ticket_deleted' | 'explore.contract_refine_started' | 'explore.contract_refine_failed' | 'mcp.activity'
  projectId?: string
  /** mcp.activity: the project an external-MCP action touched (no top-level projectId so it isn't filtered). */
  affectedProjectId?: string
  ticket?: LocalTicket
  ticketId?: number
  timestamp?: string
}

const GLOW_DURATION_MS = 3000
const CONTRACT_LAYER_MARKER = '\n\n---\n\n## Contract Layer\n\n'

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
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

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

  const fetchTickets = useCallback(async (signal?: AbortSignal): Promise<LocalTicket[]> => {
    const base = getApiBase()
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

  const refetch = useCallback(() => {
    if (!activeProjectIdRef.current) return
    setLoading(true)
    setError(null)

    fetchTickets()
      .then((fetched) => {
        const oldIds = knownIdsRef.current
        const newIds = new Set<number>()

        for (const t of fetched) {
          if (oldIds.size > 0 && !oldIds.has(t.id)) {
            newIds.add(t.id)
          }
        }

        knownIdsRef.current = new Set(fetched.map((t) => t.id))
        // Non-destructive merge: reuse existing ticket object references for
        // rows that are byte-identical so React doesn't re-render unchanged
        // cards (and returns the SAME array when nothing changed at all). This
        // keeps a background refetch — e.g. the Jira poll — from flickering the
        // whole board.
        setTickets((prev) => reconcileTickets(prev, fetched))

        if (newIds.size > 0 && oldIds.size > 0) {
          setNewTicketIds(newIds)
          toast.success(t('toasts.newTicketsAdded', { count: newIds.size }))
          setTimeout(() => setNewTicketIds(new Set()), GLOW_DURATION_MS)
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError((err as Error).message)
      })
      .finally(() => setLoading(false))
  }, [fetchTickets, t])

  useEffect(() => {
    if (!activeProjectId) {
      setTickets([])
      setError(null)
      knownIdsRef.current = new Set()
      setNewTicketIds(new Set())
      setContractRefiningIds(new Set())
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setNewTicketIds(new Set())
    setContractRefiningIds(new Set())

    const controller = new AbortController()

    fetchTickets(controller.signal)
      .then((fetched) => {
        if (cancelled) return
        knownIdsRef.current = new Set(fetched.map((t) => t.id))
        setTickets(fetched)
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError((err as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [activeProjectId, fetchTickets])

  // ── WebSocket handler ─────────────────────────────────────────────────────

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as TicketWsMessage
    if (!msg || typeof msg.type !== 'string') return

    const currentProjectId = activeProjectIdRef.current
    if ((msg as { projectId?: string }).projectId && (msg as { projectId?: string }).projectId !== currentProjectId) return

    switch (msg.type) {
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
          toast.success(t('toasts.newTicket', { title: ticket.title }))
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
    const res = await fetch(`${getApiBase()}/tickets/${ticketId}`, { method: 'DELETE' })
    if (res.ok) refetch()
    return res.ok
  }, [refetch])

  const updateTicketStatus = useCallback(
    async (ticketId: number, status: LocalTicket['status']): Promise<boolean> => {
      const res = await fetch(`${getApiBase()}/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (res.ok) refetch()
      return res.ok
    },
    [refetch]
  )

  const updateTicketPriority = useCallback(
    async (ticketId: number, priority: LocalTicket['priority']): Promise<boolean> => {
      const res = await fetch(`${getApiBase()}/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      })
      if (res.ok) refetch()
      return res.ok
    },
    [refetch]
  )

  const createTicket = useCallback(
    async (ticket: { title: string; description?: string; status?: LocalTicket['status']; priority?: LocalTicket['priority']; labels?: string[] }): Promise<boolean> => {
      const res = await fetch(`${getApiBase()}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ticket),
      })
      if (res.ok) refetch()
      return res.ok
    },
    [refetch]
  )

  const updateTicket = useCallback(
    async (ticketId: number, fields: Partial<Pick<LocalTicket, 'title' | 'description' | 'status' | 'priority' | 'labels' | 'prerequisites'>>): Promise<boolean> => {
      const res = await fetch(`${getApiBase()}/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (res.ok) refetch()
      return res.ok
    },
    [refetch]
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
