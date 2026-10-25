import { useState, useEffect, useRef, useCallback, useLayoutEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_ORIGIN } from '../../../lib/origin'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { useDesktop } from '../../../hooks/useDesktop'
import { TRASH_RETENTION_DAYS, useUndo } from '../../../hooks/useUndo'
import { readProjectCache, writeProjectCache } from '../../../hooks/useProjectCache'
import { isSpecGenInFlight } from '../lib/spec-gen-suppression'
import type { LocalTicket } from '../../../types'

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
const TICKETS_CACHE_NAMESPACE = 'tickets'
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

/** Options of the per-item mutations when a bulk operation drives them. */
export interface ItemOpts {
  /** Receives the item's undo instead of the item pushing its own toast. */
  collect?: (undo: () => Promise<void>) => void
  /** false = skip the post-mutation refetch (the bulk runner refetches once). */
  refresh?: boolean
}

export interface BulkResult {
  ok: number[]
  failed: number[]
  /** A grouped Undo was offered for what succeeded. */
  undoable: boolean
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTickets() {
  const { t } = useTranslation('tickets')
  const { t: tUndo } = useTranslation('undo')
  const { pushUndo } = useUndo()
  const { activeProjectId } = useDesktop()
  // Seed from the per-project cache so a remount / project switch shows the
  // last known board instantly while the network revalidates.
  const [tickets, setTickets] = useState<LocalTicket[]>(
    () => readProjectCache<LocalTicket[]>(activeProjectId, TICKETS_CACHE_NAMESPACE) ?? [],
  )
  const ticketsOwnerRef = useRef<string | null>(activeProjectId)
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
        // Reconcile against any cached rows so a revalidation does not churn
        // references (prev is [] on a cold load, so this equals a plain replace).
        setTickets((prev) => reconcileTickets(prev, fetched))
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

  // Persist the live list per project. Declared BEFORE the switch effect so on a
  // project change it still sees the previous owner and skips (no cross-project write).
  useEffect(() => {
    if (activeProjectId && ticketsOwnerRef.current === activeProjectId) {
      writeProjectCache(activeProjectId, TICKETS_CACHE_NAMESPACE, tickets)
    }
  }, [tickets, activeProjectId])

  useEffect(() => {
    requestGenerationRef.current += 1
    activeFetchControllerRef.current?.abort()
    activeFetchControllerRef.current = null
    const cached = readProjectCache<LocalTicket[]>(activeProjectId, TICKETS_CACHE_NAMESPACE) ?? []
    ticketsOwnerRef.current = activeProjectId
    setTickets(cached)
    setLoading(false)
    setError(null)
    knownIdsRef.current = new Set(cached.map((ticket) => ticket.id))
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

  // Reversible edits (delete, status move, labels) apply at once and offer Undo
  // instead of asking first. Undo addresses its own project explicitly, so a
  // project switch can never redirect it.
  const ticketsRef = useRef(tickets)
  ticketsRef.current = tickets

  const patchTicketIn = useCallback(async (projectId: string, ticketId: number, fields: Record<string, unknown>, refresh = true): Promise<boolean> => {
    const res = await fetch(`${ticketsApiBase(projectId)}/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (res.ok && refresh && activeProjectIdRef.current === projectId) await loadTickets(projectId, 'merge')
    return res.ok
  }, [loadTickets])

  const deleteTicket = useCallback(async (ticketId: number, opts?: ItemOpts): Promise<boolean> => {
    const ownerProjectId = activeProjectId
    if (!ownerProjectId) return false
    const title = ticketsRef.current.find((tk) => tk.id === ticketId)?.title ?? `#${ticketId}`
    try {
      const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}`, { method: 'DELETE' })
      if (res.ok && opts?.refresh !== false && activeProjectIdRef.current === ownerProjectId) {
        await loadTickets(ownerProjectId, 'merge')
      }
      if (res.ok) {
        const restore = async () => {
          const back = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}/restore`, { method: 'POST' })
          if (!back.ok) throw new Error(`restore failed: ${back.status}`)
        }
        if (opts?.collect) opts.collect(restore)
        else {
          pushUndo({
            projectId: ownerProjectId,
            label: tUndo('specDeleted', { title }),
            recoverableDays: TRASH_RETENTION_DAYS,
            undo: async () => {
              await restore()
              if (activeProjectIdRef.current === ownerProjectId) await loadTickets(ownerProjectId, 'merge')
            },
          })
        }
      }
      return res.ok
    } catch {
      return false
    }
  }, [activeProjectId, loadTickets, pushUndo, tUndo])

  const updateTicketStatus = useCallback(
    async (ticketId: number, status: LocalTicket['status'], opts?: ItemOpts): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      const before = ticketsRef.current.find((tk) => tk.id === ticketId)
      try {
        const ok = await patchTicketIn(ownerProjectId, ticketId, { status }, opts?.refresh !== false)
        if (ok && before && before.status !== status) {
          const previous = before.status
          if (opts?.collect) {
            opts.collect(async () => {
              if (!(await patchTicketIn(ownerProjectId, ticketId, { status: previous }, false))) throw new Error('status undo failed')
            })
          } else {
            pushUndo({
              projectId: ownerProjectId,
              label: tUndo('statusMoved', { id: ticketId, status: t(`ticketStatus.${status}`) }),
              undo: async () => {
                if (!(await patchTicketIn(ownerProjectId, ticketId, { status: previous }))) throw new Error('status undo failed')
              },
            })
          }
        }
        return ok
      } catch {
        return false
      }
    },
    [activeProjectId, patchTicketIn, pushUndo, t, tUndo]
  )

  const updateTicketPriority = useCallback(
    async (ticketId: number, priority: LocalTicket['priority'], opts?: ItemOpts): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      const before = ticketsRef.current.find((tk) => tk.id === ticketId)
      try {
        const res = await fetch(`${ticketsApiBase(ownerProjectId)}/tickets/${ticketId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority }),
        })
        if (res.ok && opts?.refresh !== false && activeProjectIdRef.current === ownerProjectId) {
          await loadTickets(ownerProjectId, 'merge')
        }
        // A single priority edit keeps its old no-undo behaviour; inside a bulk
        // change the group undo restores each previous priority.
        if (res.ok && opts?.collect && before && before.priority !== priority) {
          const previous = before.priority
          opts.collect(async () => {
            if (!(await patchTicketIn(ownerProjectId, ticketId, { priority: previous }, false))) throw new Error('priority undo failed')
          })
        }
        return res.ok
      } catch {
        return false
      }
    },
    [activeProjectId, loadTickets, patchTicketIn]
  )

  const createTicket = useCallback(
    async (ticket: { title: string; description?: string; status?: LocalTicket['status']; priority?: LocalTicket['priority']; labels?: string[]; repositoryIds?: string[]; metadata?: { regressionOf?: string } }): Promise<boolean> => {
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
    async (ticketId: number, fields: Partial<Pick<LocalTicket, 'title' | 'description' | 'status' | 'priority' | 'labels' | 'prerequisites' | 'repositoryIds' | 'nonGoals'>> & { metadata?: { regressionOf?: string | null } }, opts?: ItemOpts): Promise<boolean> => {
      const ownerProjectId = activeProjectId
      if (!ownerProjectId) return false
      const before = ticketsRef.current.find((tk) => tk.id === ticketId)
      try {
        const ok = await patchTicketIn(ownerProjectId, ticketId, fields, opts?.refresh !== false)
        // A label change is undoable: restore the labels the spec had.
        if (ok && before && fields.labels !== undefined && JSON.stringify(fields.labels) !== JSON.stringify(before.labels)) {
          const previousLabels = before.labels ?? []
          if (opts?.collect) {
            opts.collect(async () => {
              if (!(await patchTicketIn(ownerProjectId, ticketId, { labels: previousLabels }, false))) throw new Error('labels undo failed')
            })
          } else {
            pushUndo({
              projectId: ownerProjectId,
              label: tUndo('labelsUpdated', { id: ticketId }),
              undo: async () => {
                if (!(await patchTicketIn(ownerProjectId, ticketId, { labels: previousLabels }))) throw new Error('labels undo failed')
              },
            })
          }
        }
        return ok
      } catch {
        return false
      }
    },
    [activeProjectId, patchTicketIn, pushUndo, tUndo]
  )

  // ── Bulk mutations (board multi-select) ─────────────────────────────────────
  // Every bulk change runs the SAME per-item handler above, one spec after the
  // other, collecting each item's undo instead of pushing its own toast. The
  // board refreshes once at the end and ONE grouped Undo reverses everything
  // that succeeded. Failed items are reported, never retried silently.
  const runBulk = useCallback(async (
    ids: readonly number[],
    undoLabel: (okCount: number) => string,
    item: (id: number, opts: ItemOpts) => Promise<boolean>,
    recoverableDays?: number,
  ): Promise<BulkResult> => {
    const ownerProjectId = activeProjectId
    const ok: number[] = []
    const failed: number[] = []
    if (!ownerProjectId) return { ok, failed: [...ids], undoable: false }
    const undos: (() => Promise<void>)[] = []
    for (const id of ids) {
      let done = false
      try {
        done = await item(id, { collect: (undo) => { undos.push(undo) }, refresh: false })
      } catch {
        done = false
      }
      if (done) ok.push(id)
      else failed.push(id)
    }
    if (activeProjectIdRef.current === ownerProjectId) await loadTickets(ownerProjectId, 'merge')
    if (undos.length > 0) {
      pushUndo({
        projectId: ownerProjectId,
        label: undoLabel(ok.length),
        recoverableDays,
        undo: async () => {
          let anyFailed = false
          for (const undo of [...undos].reverse()) {
            try { await undo() } catch { anyFailed = true }
          }
          if (activeProjectIdRef.current === ownerProjectId) await loadTickets(ownerProjectId, 'merge')
          if (anyFailed) throw new Error('bulk undo incomplete')
        },
      })
    }
    return { ok, failed, undoable: undos.length > 0 }
  }, [activeProjectId, loadTickets, pushUndo])

  const bulkDelete = useCallback(
    (ids: readonly number[]) => runBulk(ids, (n) => tUndo('bulkDeleted', { count: n }), (id, o) => deleteTicket(id, o), TRASH_RETENTION_DAYS),
    [runBulk, deleteTicket, tUndo],
  )

  const bulkUpdateStatus = useCallback(
    (ids: readonly number[], status: LocalTicket['status']) =>
      runBulk(ids, (n) => tUndo('bulkStatusMoved', { count: n, status: t(`ticketStatus.${status}`) }), (id, o) => updateTicketStatus(id, status, o)),
    [runBulk, updateTicketStatus, tUndo, t],
  )

  const bulkUpdatePriority = useCallback(
    (ids: readonly number[], priority: LocalTicket['priority']) =>
      runBulk(ids, (n) => tUndo('bulkPriorityChanged', { count: n }), (id, o) => updateTicketPriority(id, priority, o)),
    [runBulk, updateTicketPriority, tUndo],
  )

  /** Adds (and/or removes) labels on every spec; a spec the change would not alter counts as done. */
  const bulkUpdateLabels = useCallback(
    (ids: readonly number[], change: { add?: readonly string[]; remove?: readonly string[] }) =>
      runBulk(ids, (n) => tUndo('bulkLabelsUpdated', { count: n }), async (id, o) => {
        const current = ticketsRef.current.find((tk) => tk.id === id)?.labels ?? []
        const next = [...current.filter((l) => !(change.remove ?? []).includes(l))]
        for (const l of change.add ?? []) if (!next.includes(l)) next.push(l)
        if (JSON.stringify(next) === JSON.stringify(current)) return true
        return updateTicket(id, { labels: next }, o)
      }),
    [runBulk, updateTicket, tUndo],
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
    bulkDelete,
    bulkUpdateStatus,
    bulkUpdatePriority,
    bulkUpdateLabels,
  }
}
