import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { API_ORIGIN } from '../../../lib/origin'
import { ApiResponseError, requestJson } from '../../../lib/api-response'
import type { FailureDiagnosis, RemedyHandlers } from '../lib/failure-diagnosis'

type Remedy = 'continue-to-review' | 'retry-with-browser'

/**
 * The two remedies of a run that stopped with approved tasks unticked
 * (`POST /loop-runs/:id/remedy`): continue to review with what is left as
 * checks by hand, or restart the developer with the browser and install
 * guidance. Both continue the same run as a linked fork, keeping the work done.
 * Offered only for an `incomplete_tasks` diagnosis of a definition run.
 */
export function useIncompleteTasksRemedies(projectId: string | null | undefined, runId: string | null | undefined, diagnosis: FailureDiagnosis | null, onForked?: (loopRunId: string) => void): RemedyHandlers {
  const { t } = useTranslation('recovery')
  const [busy, setBusy] = useState<Remedy | null>(null)
  const [done, setDone] = useState(false)
  const scope = `${projectId ?? ''}:${runId ?? ''}`
  const current = useRef(scope)
  useEffect(() => { current.current = scope; setBusy(null); setDone(false) }, [scope])
  if (!projectId || !runId || diagnosis?.kind !== 'incomplete_tasks') return {}
  const apply = async (remedy: Remedy) => {
    if (busy) return
    const owner = scope
    setBusy(remedy)
    try {
      const body = await requestJson<{ loopRunId?: string; resumed?: boolean; resumeDetail?: string } | null>(
        `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/remedy`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remedy }) },
      )
      if (current.current !== owner) return
      setDone(true)
      toast.success(t(remedy === 'continue-to-review' ? 'remedyResult.continued' : 'remedyResult.retried'))
      if (body?.resumed === false) notifyError(t('remedyResult.notResumed'), { detail: body.resumeDetail ?? null })
      if (body?.loopRunId) onForked?.(body.loopRunId)
    } catch (error) {
      if (current.current !== owner) return
      const detail = error instanceof ApiResponseError ? ((error.body ?? {}) as { detail?: string; error?: string }).detail ?? ((error.body ?? {}) as { error?: string }).error : error instanceof Error ? error.message : null
      notifyError(t('remedyResult.failed'), { detail: detail ?? null, retry: () => void apply(remedy) })
    } finally {
      if (current.current === owner) setBusy(null)
    }
  }
  return {
    'continue-to-review': { run: () => void apply('continue-to-review'), busy: busy === 'continue-to-review', disabled: done || (busy !== null && busy !== 'continue-to-review') },
    'retry-with-browser': { run: () => void apply('retry-with-browser'), busy: busy === 'retry-with-browser', disabled: done || (busy !== null && busy !== 'retry-with-browser') },
  }
}
