/**
 * Contract Refine WS tracker.
 *
 * Listens for the server-side `explore.contract_refine_failed` event and
 * `ticket_updated` events that carry a Contract Layer, surfacing them as
 * sonner toasts. Mounted at DesktopApp level so toasts work regardless of which
 * page the user is on.
 *
 * Minimal v1: error toast with a Retry action that POSTs the refine
 * endpoint, plus a brief success toast. No "pending" toast — the commit
 * itself is already user-visible on the SpecsBoard.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import { useSharedWebSocket } from './useSharedWebSocket'
import { API_ORIGIN } from '../lib/origin'
import { providerSupportsStructuredActions } from '../lib/provider-capabilities'
import type { LocalTicket } from '../types'

const CONTRACT_LAYER_MARKER = '\n\n---\n\n## Contract Layer\n\n'

function toastIdFor(ticketId: number | string): string {
  return `contract-refine:${ticketId}`
}

async function fireRetry(projectId: string, ticketId: number): Promise<void> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ticketId}/contract-refine`, {
      method: 'POST',
    })
    if (res.ok) {
      toast.loading(i18n.t('activity:contractRefine.refining'), { id: toastIdFor(ticketId) })
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string }
      toast.error(
        body.error
          ? i18n.t('activity:contractRefine.retryRejectedWithError', { error: body.error })
          : i18n.t('activity:contractRefine.retryRejected'),
        { id: toastIdFor(ticketId) },
      )
    }
  } catch (err) {
    toast.error(i18n.t('activity:contractRefine.retryFailed', { message: (err as Error).message }), { id: toastIdFor(ticketId) })
  }
}

export function ContractRefineTrackerProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // Track per-ticket project id so retry knows which project to call.
  const projectByTicketRef = useRef<Map<number, string>>(new Map())

  const handleFailed = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (!msg || msg.type !== 'explore.contract_refine_failed') return
    const ticketId = msg.ticketId as number | undefined
    const projectId = msg.projectId as string | undefined
    const provider = typeof msg.provider === 'string' ? msg.provider : undefined
    const reason = (msg.reason as string | undefined) ?? 'unknown'
    if (typeof ticketId !== 'number' || !projectId) return
    projectByTicketRef.current.set(ticketId, projectId)
    const retryAction = providerSupportsStructuredActions(provider)
      ? {
          label: i18n.t('common:actions.retry'),
          onClick: () => void fireRetry(projectId, ticketId),
        }
      : undefined
    toast.error(i18n.t('activity:contractRefine.skipped'), {
      id: toastIdFor(ticketId),
      description: i18n.t('activity:contractRefine.reason', { reason }),
      ...(retryAction ? { action: retryAction } : {}),
      duration: 15_000,
    })
  }, [])

  const handleTicketUpdated = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (!msg || msg.type !== 'ticket_updated') return
    const ticket = msg.ticket as LocalTicket | undefined
    if (!ticket) return
    // If the updated description carries a Contract Layer, dismiss any error
    // toast for this ticket and show a brief success confirmation.
    if (typeof ticket.description === 'string' && ticket.description.includes(CONTRACT_LAYER_MARKER)) {
      toast.success(i18n.t('activity:contractRefine.added', { title: ticket.title || `#${ticket.id}` }), {
        id: toastIdFor(ticket.id),
        duration: 3_500,
      })
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('_contract_refine_failed', handleFailed)
    registerHandler('_contract_refine_ticket_updated', handleTicketUpdated)
    return () => {
      unregisterHandler('_contract_refine_failed')
      unregisterHandler('_contract_refine_ticket_updated')
    }
  }, [registerHandler, unregisterHandler, handleFailed, handleTicketUpdated])

  // No exposed value; this is a side-effect-only provider.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => projectByTicketRef.current.clear(), [])

  return <>{children}</>
}
