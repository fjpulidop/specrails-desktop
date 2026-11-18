/**
 * The spec detail modal of the board, kept in sync with the live tickets list
 * and remounted per spec when navigating the SMASH family.
 */
import { TicketDetailModal } from '../../specs/components/TicketDetailModal'
import type { RailState } from '../../rails/components/RailsBoard'
import type { LocalTicket } from '../../../types'
import type { useTickets } from '../../specs/hooks/useTickets'

export function BoardSpecDetailModal({
  detailTicket, setDetailTicket, tickets, allTicketLabels, updateTicket, deleteTicket, rails, handleMoveTicketToRail, handleRemoveTicketFromRail,
}: {
  detailTicket: LocalTicket
  setDetailTicket: (ticket: LocalTicket | null) => void
  tickets: LocalTicket[]
  allTicketLabels: string[]
  updateTicket: ReturnType<typeof useTickets>['updateTicket']
  deleteTicket: ReturnType<typeof useTickets>['deleteTicket']
  rails: RailState[]
  handleMoveTicketToRail: (ticketId: number, railId: string, opts?: { quiet?: boolean }) => boolean
  handleRemoveTicketFromRail: (ticketId: number) => void
}) {
  // Keep the modal's ticket in sync with the latest version from the
  // tickets list (so WS updates — e.g. is_epic=true after SMASH —
  // propagate without closing/reopening the modal).
  const fresh = tickets.find((t) => t.id === detailTicket.id) ?? detailTicket
  return (
    // key={ticket.id} forces a fresh mount when navigating across the
    // SMASH family (Epic ↔ Sub-Spec) so the modal's internal state
    // (title/desc/priority) is re-initialised from the new ticket.
    <TicketDetailModal
      key={fresh.id}
      ticket={fresh}
      allLabels={allTicketLabels}
      allTickets={tickets}
      onClose={() => setDetailTicket(null)}
      onOpenTicket={(id) => {
        const next = tickets.find((t) => t.id === id)
        if (next) setDetailTicket(next)
      }}
      onSave={updateTicket}
      onDelete={deleteTicket}
      rails={rails}
      onMoveToRail={handleMoveTicketToRail}
      onRemoveFromRail={handleRemoveTicketFromRail}
    />
  )
}
