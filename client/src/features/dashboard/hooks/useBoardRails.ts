/**
 * The Dashboard's client-local board projection: rails, the spec drag order
 * and per-rail worktree progress, persisted per project in localStorage and
 * reloaded on project switch. Also strips finished specs off the rails.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { RailState } from '../../rails/components/RailsBoard'
import type { RailWorktreeMap } from '../../rails/lib/worktree-progress'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import { INITIAL_RAILS, loadRails, loadSpecOrder, saveRails, saveSpecOrder, ticketHasContinuablePr } from '../lib/board-rails'

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

  // Persist-aware rails updater
  const updateRails: RailsUpdater = useCallback((updater) => {
    setRails((prev) => {
      const next = updater(prev)
      saveRails(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  return { rails, setRails, railsRef, updateRails, specOrderIds, updateSpecOrder, railWorktrees, setRailWorktrees }
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
