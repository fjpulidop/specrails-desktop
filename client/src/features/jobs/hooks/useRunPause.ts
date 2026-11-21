/**
 * The person's Pause / Resume of a running Core definition run, shared by every
 * surface that offers it: the run window (`RunPauseControl`, fed by its job row)
 * and the rail's Stop/Play toggle (`RunPauseIconControl`, which reads the control
 * itself through `useLiveRunPauseControl`).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { notifyError } from '../../../lib/notify-error'
import { readPauseControl, pauseRun, resumePausedRun, type PauseControl } from '../lib/pause-run'

/** WS frames after which a run's pause control may have changed. */
const PAUSE_CONTROL_EVENTS = new Set([
  'loop.pause_support', 'loop.pause_requested', 'loop.pause_request_ended',
  'loop.run_paused', 'loop.run_resumed', 'loop.run_started',
])

export function isPauseControlEvent(msg: unknown, runId: string): boolean {
  const m = msg as { type?: unknown; loopRunId?: unknown } | null
  return !!m && typeof m.type === 'string' && PAUSE_CONTROL_EVENTS.has(m.type) && m.loopRunId === runId
}

/**
 * Pause / Pausing… / Resume actions for one run, given its current control.
 * "Pausing…" shows from the accepted request until the control moves on (the run
 * parked, resumed or settled).
 */
export function useRunPauseActions({ jobId, projectId, control, onChanged }: {
  jobId: string
  projectId?: string | null
  control: PauseControl | null
  onChanged?(): void
}) {
  const { t } = useTranslation('jobs')
  const [requested, setRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (control !== 'pause') setRequested(false) }, [control])
  const shown: PauseControl | null = requested && control === 'pause' ? 'pausing' : control

  const pause = useCallback(async function pause(): Promise<void> {
    setBusy(true)
    try {
      const outcome = await pauseRun({ projectId, jobId })
      if (outcome.ok) {
        setRequested(true)
        toast.info(t('modal.toast.pauseRequested'), { description: t('modal.toast.pauseRequestedDescription') })
        onChanged?.()
      } else {
        notifyError(t('modal.toast.pauseFailed'), { detail: outcome.code === 'pause_unsupported' ? t('modal.toast.pauseUnsupported') : outcome.error, retry: outcome.code === 'pause_unsupported' ? undefined : () => void pause() })
      }
    } finally { setBusy(false) }
  }, [jobId, projectId, onChanged, t])

  const resume = useCallback(async function resume(): Promise<void> {
    setBusy(true)
    try {
      const outcome = await resumePausedRun({ projectId, jobId })
      if (outcome.ok) {
        toast.success(t('modal.toast.resumed'), { description: t('modal.toast.resumedDescription') })
        onChanged?.()
      } else notifyError(t('modal.toast.resumeFailed'), { detail: outcome.error, retry: () => void resume() })
    } finally { setBusy(false) }
  }, [jobId, projectId, onChanged, t])

  return { shown, busy, pause, resume }
}

/**
 * The live pause control of a run the caller has no job row for (the rail knows
 * only its active job id): `GET /loop-runs/:id/pause-control`, re-read on the WS
 * frames that change it. Null while unknown, for runs that cannot pause, and
 * whenever `jobId` is absent.
 */
export function useLiveRunPauseControl(jobId: string | null | undefined, projectId?: string | null) {
  const [control, setControl] = useState<PauseControl | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(() => {
    const mine = ++generation.current
    if (!jobId) { setControl(null); return }
    void readPauseControl({ projectId, jobId }).then((next) => { if (generation.current === mine) setControl(next) })
  }, [jobId, projectId])
  useEffect(() => { refresh() }, [refresh])
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const uid = useId()
  useEffect(() => {
    if (!jobId) return
    const id = `run-pause-control-${jobId}-${uid}`
    registerHandler(id, (data: unknown) => { if (isPauseControlEvent(data, jobId)) refresh() })
    return () => unregisterHandler(id)
  }, [jobId, uid, refresh, registerHandler, unregisterHandler])
  return { control, refresh }
}
