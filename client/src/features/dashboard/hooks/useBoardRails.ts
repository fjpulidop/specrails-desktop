/**
 * The Dashboard's board projection: rails, the spec drag order and per-rail
 * worktree progress, cached per project in localStorage and reloaded on project
 * switch. The spec-to-rail assignment belongs to the server: every move the
 * person makes here is written through (`PUT /rails/:i/tickets`), and
 * `useRailServerSync` adopts the server's assignment on load. Also strips
 * finished specs off the rails.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { getApiBase } from '../../../lib/api'
import type { RailState } from '../../rails/components/RailsBoard'
import type { RailWorktreeMap } from '../../rails/lib/worktree-progress'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import { INITIAL_RAILS, loadRails, loadSpecOrder, sameTicketIds, saveRails, saveSpecOrder, serverRailIndex, ticketHasContinuablePr } from '../lib/board-rails'

export type RailsUpdater = (updater: (prev: RailState[]) => RailState[]) => void
export type SpecOrderUpdater = (updater: (prev: number[] | null) => number[] | null) => void

export function useBoardRails(activeProjectId: string | null) {
  const [specOrderIds, setSpecOrderIds] = useState<number[] | null>(() => loadSpecOrder(activeProjectId))
  const [rails, setRails] = useState<RailState[]>(() => loadRails(activeProjectId) ?? INITIAL_RAILS)
  // Per-rail worktree merge-back progress (parallel/isolated launches). railIndex → ticketId → state.
  const [railWorktrees, setRailWorktrees] = useState<RailWorktreeMap>({})

  // Reset spec order and rails when active project changes
  useEffect(() => {
    setSpecOrderIds(loadSpecOrder(activeProjectId))
    setRails(loadRails(activeProjectId) ?? INITIAL_RAILS)
    setRailWorktrees({})
  }, [activeProjectId])

  // Persist-aware spec order updater
  const updateSpecOrder: SpecOrderUpdater = useCallback((updater) => {
    setSpecOrderIds((prev) => {
      const next = updater(prev)
      saveSpecOrder(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  const railsRef = useRef(rails)
  railsRef.current = rails

  // Rails whose spec assignment the person changed here and the server has not been told yet.
  const dirtyRailIdsRef = useRef(new Set<string>())
  // Writes in flight per server railIndex: their echo (rail.updated) must not undo a newer local move.
  const pendingWritesRef = useRef(new Map<number, number>())
  const writeChainsRef = useRef(new Map<number, Promise<void>>())
  const [writeTick, setWriteTick] = useState(0)
  useEffect(() => { dirtyRailIdsRef.current.clear() }, [activeProjectId])

  // The person's own changes: cached locally and written through to the server.
  const updateRails: RailsUpdater = useCallback((updater) => {
    setRails((prev) => {
      const next = updater(prev)
      const before = new Map(prev.map((r) => [r.id, r.ticketIds]))
      for (const r of next) {
        const was = before.get(r.id)
        if (was && !sameTicketIds(was, r.ticketIds)) dirtyRailIdsRef.current.add(r.id)
      }
      saveRails(activeProjectId, next)
      return next
    })
    setWriteTick((n) => n + 1)
  }, [activeProjectId])

  // What the server (or another client) already decided: cached locally, never written back.
  const syncRails: RailsUpdater = useCallback((updater) => {
    setRails((prev) => {
      const next = updater(prev)
      if (next !== prev) saveRails(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  // Write each changed idle rail's assignment through, one write per rail at a
  // time, always sending the rail's latest specs. A running rail's specs are the
  // launch's (its launch already wrote them); the server owns them until it settles.
  useEffect(() => {
    if (!activeProjectId || dirtyRailIdsRef.current.size === 0) return
    const projectBase = getApiBase()
    for (const railId of [...dirtyRailIdsRef.current]) {
      dirtyRailIdsRef.current.delete(railId)
      const rail = railsRef.current.find((r) => r.id === railId)
      if (!rail || rail.status === 'running') continue
      const railIndex = serverRailIndex(railsRef.current, railId)
      if (railIndex < 0) continue
      const pending = pendingWritesRef.current
      pending.set(railIndex, (pending.get(railIndex) ?? 0) + 1)
      const previous = writeChainsRef.current.get(railIndex) ?? Promise.resolve()
      const write = previous.then(async () => {
        const latest = railsRef.current.find((r) => r.id === railId)
        if (!latest || latest.status === 'running') return
        try {
          await fetch(`${projectBase}/rails/${railIndex}/tickets`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticketIds: latest.ticketIds }),
          })
        } catch { /* the local cache keeps the move; the next move or launch writes it again */ }
      }).finally(() => {
        const left = (pending.get(railIndex) ?? 1) - 1
        if (left > 0) pending.set(railIndex, left)
        else pending.delete(railIndex)
      })
      writeChainsRef.current.set(railIndex, write)
    }
  }, [activeProjectId, rails, writeTick])

  const isTicketWritePending = useCallback((railIndex: number) => (pendingWritesRef.current.get(railIndex) ?? 0) > 0, [])

  return { rails, setRails, railsRef, updateRails, syncRails, isTicketWritePending, specOrderIds, updateSpecOrder, railWorktrees, setRailWorktrees }
}

/**
 * Auto-remove done / blocked on-review tickets from rails.
 * When ticket status changes to 'done' (via WS ticket_updated, re-fetch, etc.),
 * strip those tickets from rails so they appear in Done Specs instead.
 * 'on_review' is stripped only while there is no real PR head to continue.
 * Once a draft/published PR exists, keeping the ticket on a rail is the
 * intentional "add another commit to this PR" flow.
 */
export function useStripFinishedRailTickets(opts: {
  tickets: LocalTicket[]
  activeProjectId: string | null
  rails: RailState[]
  setRails: Dispatch<SetStateAction<RailState[]>>
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
  railPrDecisionsHydrated: boolean
}) {
  const { tickets, activeProjectId, rails, setRails, railPrDecisions, railPrDecisionsHydrated } = opts
  useEffect(() => {
    const doneIds = new Set(
      tickets
        .filter((t) => (
          t.status === 'done' ||
          (railPrDecisionsHydrated && t.status === 'on_review' && !ticketHasContinuablePr(t.id, railPrDecisions, tickets))
        ))
        .map((t) => t.id),
    )
    if (doneIds.size === 0) return
    setRails((prev) => {
      const next = prev.map((r) => {
        const filtered = r.ticketIds.filter((id) => !doneIds.has(id))
        if (filtered.length === r.ticketIds.length) return r
        return { ...r, ticketIds: filtered }
      })
      if (next.every((r, i) => r === prev[i])) return prev // no change
      saveRails(activeProjectId, next)
      return next
    })
    // `rails` is a dep so a reconcile ADOPTION that re-introduces a done ticket
    // is stripped too (the updater returns `prev` identity when nothing changes,
    // so this cannot loop). `setRails` is the stable state setter.
  }, [tickets, activeProjectId, rails, setRails, railPrDecisions, railPrDecisionsHydrated])
}
