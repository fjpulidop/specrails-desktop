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

/** Picking a resolution: one of the AI analysis' options (by id) or the person's own instruction. */
export interface ResolutionActions {
  /** Continue with an option the server reads from the stored analysis; `label` is what the toast says. */
  choose(optionId: string, label: string): void
  /** Continue with the person's own words. */
  instruct(text: string): void
  /** Continue as is (the "keep trying" choice when the analysis gave none). */
  keepGoing(label: string): void
  /** The option id (or `instruction` / `keep-going`) being sent. */
  busy: string | null
  /** The run continued: every choice is spent. */
  done: boolean
}

/**
 * `POST /loop-runs/:id/remedy` with `{ optionId }` or `{ instruction }`: the run continues with that
 * guidance, and the toast says which choice it took. Null when the surface cannot continue the run.
 */
export function useResolutionActions(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  options: { enabled: boolean; onContinued?: (loopRunId: string) => void },
): ResolutionActions | null {
  const { t } = useTranslation('recovery')
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const scope = `${projectId ?? ''}:${runId ?? ''}`
  const current = useRef(scope)
  useEffect(() => { current.current = scope; setBusy(null); setDone(false) }, [scope])
  if (!projectId || !runId || !options.enabled) return null
  const send = async (key: string, body: Record<string, unknown>, success: string) => {
    if (busy || done) return
    const owner = scope
    setBusy(key)
    try {
      const response = await requestJson<ContinueResponse | null>(
        `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/remedy`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (current.current !== owner) return
      setDone(true)
      toast.success(success)
      if (response?.resumed === false) notifyError(t('remedyResult.notResumed'), { detail: response.resumeDetail ?? null })
      if (response?.loopRunId && response.loopRunId !== runId) options.onContinued?.(response.loopRunId)
    } catch (error) {
      if (current.current !== owner) return
      const payload = error instanceof ApiResponseError ? (error.body ?? {}) as { detail?: string; error?: string } : {}
      const detail = error instanceof ApiResponseError ? payload.detail ?? payload.error : error instanceof Error ? error.message : null
      notifyError(t('remedyResult.failed'), { detail: detail ?? null, retry: () => void send(key, body, success) })
    } finally {
      if (current.current === owner) setBusy(null)
    }
  }
  return {
    choose: (optionId, label) => void send(optionId, { remedy: 'continue', optionId }, t('remedyResult.continuingWith', { label })),
    instruct: (text) => { const value = text.trim(); if (value) void send('instruction', { remedy: 'continue', instruction: value }, t('remedyResult.continuingWithInstruction')) },
    keepGoing: (label) => void send('keep-going', { remedy: 'continue' }, t('remedyResult.continuingWith', { label })),
    busy, done,
  }
}
