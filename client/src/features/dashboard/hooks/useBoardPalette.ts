/**
 * The board's ⌘K palette surface (`board`): Launch on rail, Move to status and
 * Open review. Every action calls the handlers the buttons call, so the same
 * gates apply. Also exposes the spec launch blocker the bulk bar reuses.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useRegisterPaletteSurface } from '../../../lib/palette-bridge'
import { jiraApi } from '../../integrations/lib/jira-api'
import { MANUAL_STATUS_TARGETS, STATUS_LABEL_KEY, isJiraBackedTicket, moveJiraSpecToStatus } from '../../specs/lib/ticket-status-moves'
import type { RailState } from '../../rails/components/RailsBoard'
import type { LocalTicket, RailPrStateSnapshot, TicketStatus } from '../../../types'
import type { useTickets } from '../../specs/hooks/useTickets'
import { ticketHasContinuablePr } from '../lib/board-rails'

export function useBoardPalette(args: {
  rails: RailState[]
  tickets: LocalTicket[]
  jiraConnected: boolean
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
  railPrDecisionsHydrated: boolean
  handleToggle: (railId: string) => Promise<void>
  handleMoveTicketToRail: (ticketId: number, railId: string, opts?: { quiet?: boolean }) => boolean
  updateTicketStatus: ReturnType<typeof useTickets>['updateTicketStatus']
}) {
  const { rails, tickets, jiraConnected, railPrDecisions, railPrDecisionsHydrated, handleToggle, handleMoveTicketToRail, updateTicketStatus } = args
  const { t } = useTranslation('dashboard')
  const { t: tTickets } = useTranslation('tickets')
  const { t: tJira } = useTranslation('jira')
  // ⌘K board actions (Launch on rail, Move to, Open review). Every action calls
  // the handlers the buttons call: the rail's own launch gates (handleToggle ->
  // freestyle / target-PR confirms, review WIP, on-review freeze), the board's
  // status move (with Undo) and the Jira-backed workflow move.
  const pendingPaletteLaunch = useRef<{ ticketId: number; railId: string } | null>(null)
  useEffect(() => {
    const pending = pendingPaletteLaunch.current
    if (!pending) return
    const rail = rails.find((r) => r.id === pending.railId)
    if (rail?.ticketIds.includes(pending.ticketId)) {
      pendingPaletteLaunch.current = null
      void handleToggle(pending.railId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rails])
  const paletteLaunchBlocker = (ticketId: number): string | null => {
    const ticket = tickets.find((tk) => tk.id === ticketId)
    if (!ticket) return t('toasts.onReviewNotLaunchable')
    if (ticket.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(ticketId, railPrDecisions, tickets))) return t('toasts.onReviewNotLaunchable')
    return null
  }
  useRegisterPaletteSurface('board', {
    specs: () => tickets.filter((tk) => tk.status !== 'done' && tk.status !== 'cancelled').map((tk) => ({ id: tk.id, title: tk.title, status: tk.status })),
    rails: (ticketId) => rails.map((r) => ({ id: r.id, label: r.label, running: r.status === 'running', hasSpec: r.ticketIds.includes(ticketId) })),
    launchBlocker: paletteLaunchBlocker,
    launchOnRail: (ticketId, railId) => {
      if (paletteLaunchBlocker(ticketId) !== null) return
      const rail = rails.find((r) => r.id === railId)
      if (!rail) return
      if (rail.ticketIds.includes(ticketId)) { void handleToggle(railId); return }
      pendingPaletteLaunch.current = { ticketId, railId }
      setTimeout(() => { if (pendingPaletteLaunch.current?.ticketId === ticketId) pendingPaletteLaunch.current = null }, 3000)
      handleMoveTicketToRail(ticketId, railId)
    },
    statusOptions: async (ticketId) => {
      const ticket = tickets.find((tk) => tk.id === ticketId)
      if (!ticket) return []
      if (isJiraBackedTicket(ticket, jiraConnected)) {
        const { statuses } = await jiraApi.listStatuses()
        return statuses.map((s) => ({ id: s.name, label: s.name, current: s.name === (ticket.jira_status ?? '') }))
      }
      const targets = MANUAL_STATUS_TARGETS.includes(ticket.status) ? MANUAL_STATUS_TARGETS : [ticket.status, ...MANUAL_STATUS_TARGETS]
      return targets.map((st) => ({ id: st, label: tTickets(STATUS_LABEL_KEY[st]), current: st === ticket.status }))
    },
    moveStatus: (ticketId, optionId) => {
      const ticket = tickets.find((tk) => tk.id === ticketId)
      if (!ticket) return
      if (isJiraBackedTicket(ticket, jiraConnected)) void moveJiraSpecToStatus(ticketId, optionId, tJira)
      else void updateTicketStatus(ticketId, optionId as TicketStatus)
    },
    reviewPath: (ticketId) => {
      const ticket = tickets.find((tk) => tk.id === ticketId)
      if (!ticket || ticket.status !== 'on_review') return null
      for (const d of railPrDecisions.values()) {
        if (d.ticketIds.includes(ticketId)) return `/review/${encodeURIComponent(d.prDeliveryId)}`
      }
      return null
    },
  })

  return { paletteLaunchBlocker }
}
