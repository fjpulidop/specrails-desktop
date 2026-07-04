import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_ORIGIN } from '../lib/origin'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import type { AgentRefTarget } from '../lib/agent-refs'

export interface AgentJobRef {
  projectId: string
  jobId: string
}

/**
 * Click layer for agent-chat reference chips. Lazy verification on click
 * (linkify is pattern-only — no per-message fetches): the ref is fetched from
 * its OWNING project (`API_ORIGIN` precedent — never `getApiBase()`, the
 * conversation's pinned project may differ from the active one); a miss shows
 * a subtle "not found / maybe deleted" toast instead of a dead modal.
 *
 * - Tickets → `openTicketDetailInProject` (board TicketDetailModal; switches
 *   the active project first when the pin differs — see the provider).
 * - Jobs/loop-runs (loop-run ids ARE job row ids) → `jobRef` state; the caller
 *   mounts the mission-mode `JobDetailModal` with the explicit `projectId`.
 */
export function useAgentRefActions() {
  const { t } = useTranslation('agent')
  const { openTicketDetailInProject } = useTicketDetailModal()
  const [jobRef, setJobRef] = useState<AgentJobRef | null>(null)

  const closeJobRef = useCallback(() => setJobRef(null), [])

  const openRef = useCallback(
    async (projectId: string, ref: AgentRefTarget): Promise<void> => {
      try {
        if (ref.kind === 'ticket') {
          const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ref.ticketId}`)
          if (!res.ok) {
            toast.info(t('refs.ticketNotFound', { id: ref.ticketId }))
            return
          }
          openTicketDetailInProject(projectId, ref.ticketId)
        } else {
          const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/jobs/${ref.jobId}`)
          if (!res.ok) {
            toast.info(t('refs.jobNotFound'))
            return
          }
          setJobRef({ projectId, jobId: ref.jobId })
        }
      } catch {
        toast.info(t('refs.lookupFailed'))
      }
    },
    [openTicketDetailInProject, t],
  )

  return { openRef, jobRef, closeJobRef }
}
