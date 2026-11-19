import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { API_ORIGIN } from '../../../lib/origin'
import { ApiResponseError, requestJson } from '../../../lib/api-response'
import type { FailureDiagnosis, RemedyHandlers } from '../lib/failure-diagnosis'

type Remedy = 'continue' | 'continue-to-review' | 'copy-env-files'

interface ContinueResponse { loopRunId?: string; mode?: 'fork' | 'resume'; fromStep?: string | null; resumed?: boolean; resumeDetail?: string; envFilesCopied?: string[] }

/**
 * Continue a failed or stopped definition run (`POST /loop-runs/:id/remedy`):
 * the server keeps the work, goes on from the step that failed or stopped and
 * sends the cause's guidance. `continue-to-review` (unfinished tasks only)
 * hands the remaining checks to a person. `copy-env-files` (offered by the
 * server for a missing `.env`) turns the project's env-file copy on, copies
 * the files into the run and continues. Offered only for a definition run
 * that nothing continued yet (`enabled`).
 */
export function useContinueRemedies(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  diagnosis: FailureDiagnosis | null,
  options: { enabled: boolean; onContinued?: (loopRunId: string) => void },
): RemedyHandlers {
  const { t } = useTranslation('recovery')
  const { t: tRuntime } = useTranslation('agentRuntime')
  const [busy, setBusy] = useState<Remedy | null>(null)
  const [done, setDone] = useState(false)
  const scope = `${projectId ?? ''}:${runId ?? ''}`
  const current = useRef(scope)
  useEffect(() => { current.current = scope; setBusy(null); setDone(false) }, [scope])
  if (!projectId || !runId || !options.enabled) return {}
  const apply = async (remedy: Remedy) => {
    if (busy) return
    const owner = scope
    setBusy(remedy)
    try {
      const body = await requestJson<ContinueResponse | null>(
        `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/remedy`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remedy }) },
      )
      if (current.current !== owner) return
      setDone(true)
      const step = body?.fromStep ? tRuntime(`roles.${body.fromStep}`, { defaultValue: body.fromStep }) : null
      const copied = remedy === 'copy-env-files' ? body?.envFilesCopied ?? [] : []
      toast.success(remedy === 'continue-to-review' ? t('remedyResult.continued')
        : copied.length ? t('remedyResult.envFilesCopied', { files: copied.join(', ') })
          : step ? t('remedyResult.continuingFrom', { step }) : t('remedyResult.continuing'))
      if (body?.resumed === false) notifyError(t('remedyResult.notResumed'), { detail: body.resumeDetail ?? null })
      if (body?.loopRunId && body.loopRunId !== runId) options.onContinued?.(body.loopRunId)
    } catch (error) {
      if (current.current !== owner) return
      const payload = error instanceof ApiResponseError ? (error.body ?? {}) as { detail?: string; error?: string } : {}
      if (payload.error === 'env_files_unavailable') { notifyError(t('remedyResult.envFilesUnavailable')); return }
      const detail = error instanceof ApiResponseError ? payload.detail ?? payload.error : error instanceof Error ? error.message : null
      notifyError(t('remedyResult.failed'), { detail: detail ?? null, retry: () => void apply(remedy) })
    } finally {
      if (current.current === owner) setBusy(null)
    }
  }
  const handler = (remedy: Remedy) => ({ run: () => void apply(remedy), busy: busy === remedy, disabled: done || (busy !== null && busy !== remedy) })
  return {
    continue: handler('continue'),
    ...(diagnosis?.kind === 'incomplete_tasks' ? { 'continue-to-review': handler('continue-to-review') } : {}),
    ...(diagnosis?.remedies.includes('copy-env-files') ? { 'copy-env-files': handler('copy-env-files') } : {}),
  }
}
