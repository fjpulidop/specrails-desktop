/**
 * Assigning a spec to a rail and taking it back (with Undo), shared by drag
 * and drop, the post-it "Move to Rail" popover, the detail modal, the ⌘K
 * palette and the bulk bar.
 */
import { useCallback, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { useUndo, UndoBlockedError } from '../../../hooks/useUndo'
import type { RailState } from '../../rails/components/RailsBoard'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import { restoreTicketToRail } from '../lib/dashboard-dnd'
import { ticketHasContinuablePr } from '../lib/board-rails'
import type { RailsUpdater, SpecOrderUpdater } from './useBoardRails'

export function useRailTicketMoves(args: {
  activeProjectId: string | null
  rails: RailState[]
  railsRef: MutableRefObject<RailState[]>
  tickets: LocalTicket[]
  specTickets: LocalTicket[]
  updateRails: RailsUpdater
  updateSpecOrder: SpecOrderUpdater
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
  railPrDecisionsHydrated: boolean
}) {
  const { activeProjectId, rails, railsRef, tickets, specTickets, updateRails, updateSpecOrder, railPrDecisions, railPrDecisionsHydrated } = args
  const { t } = useTranslation('dashboard')
  const { t: tUndo } = useTranslation('undo')
  const { pushUndo } = useUndo()

  // Shared assignment helper. Used both by the drag-and-drop ticket→rail
  // path (`handleDragEnd`) and by the `Move to Rail` popover on the
  // dashboard postit tier. Idempotent: re-assigning to the same rail is a
  // no-op; assigning to a different rail moves the ticket atomically.
  // `quiet` (a bulk move) skips the per-spec toasts; the caller reports one summary.
  const handleMoveTicketToRail = useCallback((ticketId: number, railId: string, opts?: { quiet?: boolean }): boolean => {
    const quiet = opts?.quiet === true
    const targetRail = rails.find((r) => r.id === railId)
    if (!targetRail) return false
    // On-review specs are frozen unless they already have a draft/published PR
    // head that a relaunch can continue.
    if (tickets.find((tk) => tk.id === ticketId)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(ticketId, railPrDecisions, tickets))) {
      if (!quiet) toast.info(t('toasts.onReviewCannotMoveToRail'))
      return false
    }
    if (targetRail.ticketIds.includes(ticketId)) {
      if (!quiet) toast.info(t('toasts.alreadyOnRail', { rail: targetRail.label }))
      return false
    }
    updateSpecOrder((prev) => (prev ?? specTickets.map((t) => t.id)).filter((id) => id !== ticketId))
    updateRails((prev) => prev.map((r) => {
      if (r.id === railId) {
        return { ...r, ticketIds: [...r.ticketIds.filter((id) => id !== ticketId), ticketId] }
      }
      if (r.ticketIds.includes(ticketId)) {
        return { ...r, ticketIds: r.ticketIds.filter((id) => id !== ticketId) }
      }
      return r
    }))
    if (!quiet) toast.success(t('toasts.movedToRail', { rail: targetRail.label }))
    return true
  }, [rails, tickets, specTickets, updateRails, updateSpecOrder, t, railPrDecisions, railPrDecisionsHydrated])

  // Reverse of `handleMoveTicketToRail`: remove a ticket from whatever rail
  // currently owns it and push it back to the spec list (appended to the
  // current spec order). No-op when the ticket isn't on any rail.
  const handleRemoveTicketFromRail = useCallback((ticketId: number) => {
    const sourceRail = rails.find((r) => r.ticketIds.includes(ticketId))
    if (!sourceRail) return
    if (sourceRail.status === 'running') {
      notifyError(t('toasts.railRunningStopFirst', { rail: sourceRail.label }))
      return
    }
    updateRails((prev) => prev.map((r) =>
      r.id === sourceRail.id ? { ...r, ticketIds: r.ticketIds.filter((id) => id !== ticketId) } : r,
    ))
    updateSpecOrder((prev) => {
      const current = prev ?? specTickets.map((t) => t.id)
      return current.includes(ticketId) ? current : [...current, ticketId]
    })
    const wasAt = sourceRail.ticketIds.indexOf(ticketId)
    const shown = pushUndo({
      projectId: activeProjectId,
      label: tUndo('removedFromRail', { id: ticketId, rail: sourceRail.label }),
      undo: () => {
        // The rail may have started since: a running rail never takes a spec back.
        const restored = restoreTicketToRail(railsRef.current, sourceRail.id, ticketId, wasAt)
        if (!restored.ok) {
          throw new UndoBlockedError(tUndo(restored.reason === 'rail_running' ? 'railRunning' : 'failed', { id: ticketId }))
        }
        updateRails((prev) => {
          const next = restoreTicketToRail(prev, sourceRail.id, ticketId, wasAt)
          return next.ok ? next.rails : prev
        })
        updateSpecOrder((prev) => (prev ?? specTickets.map((tk) => tk.id)).filter((id) => id !== ticketId))
      },
    })
    if (!shown) toast.success(t('toasts.removedFromRail', { rail: sourceRail.label }))
  }, [rails, specTickets, updateRails, updateSpecOrder, t, tUndo, pushUndo, activeProjectId])

  return { handleMoveTicketToRail, handleRemoveTicketFromRail }
}
