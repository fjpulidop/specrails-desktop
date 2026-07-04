import { useMemo } from 'react'
import { useDesktop } from './useDesktop'
import { useAgentRefActions } from './useAgentRefActions'

/**
 * Click layer for ticket refs inside job LOG lines (LogViewer + the loop-step
 * explorer). Thin ticket-only binding over the shared `useAgentRefActions`
 * verify-then-open flow (lazy fetch against the owning project, subtle
 * not-found toast, `openTicketDetailInProject` cross-project switch).
 *
 * `projectId` is the ONE optional scope prop: mission-mode `JobDetailModal`
 * threads its explicit project; the board `JobDetailPage` omits it and the
 * active project applies. `undefined` return ⇒ no resolvable project ⇒ the
 * caller renders refs as plain text (never a dead affordance).
 */
export function useLogTicketActions(projectId?: string): ((ticketId: number) => void) | undefined {
  const { activeProjectId } = useDesktop()
  const { openRef } = useAgentRefActions()
  const effectiveProjectId = projectId ?? activeProjectId ?? undefined
  return useMemo(
    () =>
      effectiveProjectId
        ? (ticketId: number) => {
            void openRef(effectiveProjectId, { kind: 'ticket', ticketId })
          }
        : undefined,
    [effectiveProjectId, openRef],
  )
}
