import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../../../components/ui/button'
import { notifyError } from '../../../../lib/notify-error'
import { pauseControlOf, pauseRun, resumePausedRun } from '../../lib/pause-run'

interface RunPauseControlProps {
  job: { id: string; status?: string; pauseControl?: unknown }
  /** Explicit project scope (mission mode); null → the active project. */
  projectId?: string | null
  /** Re-read the job row after an action (the WS refetch still applies). */
  onChanged?(): void
}

/**
 * Pause / Pausing… / Resume of a running Core definition run, the primary control
 * of the run window while the run's Core can pause (the surface's Stop stays next
 * to it as the secondary action). Pause takes effect at the next step boundary:
 * "Pausing…" stays until the run parks there. Renders nothing for runs that cannot
 * pause (legacy engine, interactive sessions, an older Core, a run held on
 * something else).
 */
export function RunPauseControl({ job, projectId, onChanged }: RunPauseControlProps) {
  const { t } = useTranslation('jobs')
  const control = pauseControlOf(job)
  const [requested, setRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  // The row moved on (paused, resumed, settled): the local "Pausing…" gives way to it.
  useEffect(() => { if (control !== 'pause') setRequested(false) }, [control])
  if (!control) return null
  const shown = requested && control === 'pause' ? 'pausing' : control

  async function pause() {
    setBusy(true)
    try {
      const outcome = await pauseRun({ projectId, jobId: job.id })
      if (outcome.ok) {
        setRequested(true)
        toast.info(t('modal.toast.pauseRequested'), { description: t('modal.toast.pauseRequestedDescription') })
        onChanged?.()
      } else {
        notifyError(t('modal.toast.pauseFailed'), { detail: outcome.code === 'pause_unsupported' ? t('modal.toast.pauseUnsupported') : outcome.error, retry: outcome.code === 'pause_unsupported' ? undefined : () => void pause() })
      }
    } finally { setBusy(false) }
  }

  async function resume() {
    setBusy(true)
    try {
      const outcome = await resumePausedRun({ projectId, jobId: job.id })
      if (outcome.ok) {
        toast.success(t('modal.toast.resumed'), { description: t('modal.toast.resumedDescription') })
        onChanged?.()
      } else notifyError(t('modal.toast.resumeFailed'), { detail: outcome.error, retry: () => void resume() })
    } finally { setBusy(false) }
  }

  if (shown === 'resume') {
    return (
      <Button size="sm" className="h-7" disabled={busy} onClick={() => void resume()} data-testid="run-resume">
        {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden /> : <Play className="w-3.5 h-3.5 mr-1.5 fill-current" aria-hidden />}
        {t('modal.resumeRun')}
      </Button>
    )
  }
  const pausing = shown === 'pausing'
  return (
    <Button size="sm" variant="outline" className="h-7" disabled={busy || pausing} aria-busy={pausing} onClick={() => void pause()}
      title={pausing ? t('modal.pausingTooltip') : t('modal.pauseRunTooltip')} data-testid={pausing ? 'run-pausing' : 'run-pause'}>
      {busy || pausing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden /> : <Pause className="w-3.5 h-3.5 mr-1.5 fill-current" aria-hidden />}
      {pausing ? t('modal.pausing') : t('modal.pauseRun')}
    </Button>
  )
}
