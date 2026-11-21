import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { resumeRailRun } from '../lib/milestone-launch'

/**
 * Resume, from a milestone rail row, a run the person paused: the run's own
 * resume route, with the same toasts as the chain controls. The row flips back
 * to working on the server's next `blueprint.milestone_progress` broadcast.
 */
export function useResumeRailRun(projectId: string | null | undefined): (runId: string) => Promise<void> {
  const { t } = useTranslation('builder')
  return useCallback(async (runId: string) => {
    if (!projectId) return
    const r = await resumeRailRun(projectId, runId)
    if (r.ok) toast.success(t('milestoneProgress.rail.resumed'))
    else notifyError(t('milestoneProgress.rail.resumeFailed'), { detail: r.detail ?? r.error, retry: () => { void resumeRailRun(projectId, runId) } })
  }, [projectId, t])
}
