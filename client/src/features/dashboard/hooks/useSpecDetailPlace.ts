/**
 * The Dashboard's spec detail modal as a place (`?spec=<id>`): resolves the
 * open ticket from the URL, claims the spec-modal host and follows the spec
 * generation tracker's "View" signal for the active project.
 */
import { useCallback, useEffect, useState } from 'react'
import { usePlaceParam } from '../../../hooks/usePlaceParam'
import { SPEC_PARAM } from '../../../lib/places'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'
import { useSpecGenTracker } from '../../specs/hooks/useSpecGenTracker'
import type { LocalTicket } from '../../../types'

export function useSpecDetailPlace(
  tickets: LocalTicket[],
  activeProjectId: string | null,
  refetch: () => unknown,
) {
  const { specToOpen, clearSpecToOpen } = useSpecGenTracker()
  // The spec detail modal is a place: `?spec=<id>` (Back closes it, a link reopens it).
  // The ticket object seeds a spec created a moment ago, before the list refetch lands.
  const specParam = usePlaceParam(SPEC_PARAM)
  const { claimSpecHost } = useTicketDetailModal()
  useEffect(() => claimSpecHost(), [claimSpecHost])
  const [detailSeed, setDetailSeed] = useState<LocalTicket | null>(null)
  const specId = specParam.value !== null && /^\d+$/.test(specParam.value) ? Number(specParam.value) : null
  const detailTicket = specId === null
    ? null
    : tickets.find((ticket) => ticket.id === specId) ?? (detailSeed?.id === specId ? detailSeed : null)
  const { open: openSpecParam, close: closeSpecParam } = specParam
  const setDetailTicket = useCallback((ticket: LocalTicket | null) => {
    if (ticket) {
      setDetailSeed(ticket)
      openSpecParam(String(ticket.id))
    } else closeSpecParam()
  }, [openSpecParam, closeSpecParam])

  // Open a spec when the tracker signals "View" was clicked for this project
  useEffect(() => {
    if (!specToOpen || specToOpen.projectId !== activeProjectId) return
    setDetailTicket(specToOpen.ticket)
    refetch()
    clearSpecToOpen()
  }, [specToOpen, activeProjectId, refetch, clearSpecToOpen])

  return { detailTicket, setDetailTicket }
}
