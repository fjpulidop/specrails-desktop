import { useTranslation } from 'react-i18next'
import { Loader2, Pause, Play } from 'lucide-react'
import { Button } from '../../../../components/ui/button'
import { pauseControlOf } from '../../lib/pause-run'
import { useLiveRunPauseControl, useRunPauseActions } from '../../hooks/useRunPause'

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
  const { shown, busy, pause, resume } = useRunPauseActions({ jobId: job.id, projectId, control: pauseControlOf(job), onChanged })
  if (!shown) return null

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

/**
 * The same Pause / Pausing… / Paused by you + Resume for a surface that knows only
 * the run's id (the rail's Stop/Play toggle): it reads the control itself and
 * keeps it live. Compact (icon buttons sized like the rail toggle). Renders
 * nothing for runs that cannot pause.
 */
export function RunPauseIconControl({ jobId, projectId }: { jobId: string | null | undefined; projectId?: string | null }) {
  const { t } = useTranslation('jobs')
  const { control, refresh } = useLiveRunPauseControl(jobId, projectId)
  const { shown, busy, pause, resume } = useRunPauseActions({ jobId: jobId ?? '', projectId, control, onChanged: refresh })
  if (!jobId || !shown) return null

  if (shown === 'resume') {
    return (
      <span className="inline-flex items-center gap-1" data-testid="rail-paused-by-you">
        <span className="text-caption font-medium text-accent-warning" title={t('held.tooltip.pausedByYou')}>{t('held.label.pausedByYou')}</span>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-full text-accent-success hover:text-accent-success hover:bg-accent-success/10"
          disabled={busy} onClick={() => void resume()} title={t('modal.resumeRun')} aria-label={t('modal.resumeRun')} data-testid="rail-resume">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Play className="w-3.5 h-3.5 fill-current" aria-hidden />}
        </Button>
      </span>
    )
  }
  const pausing = shown === 'pausing'
  const label = pausing ? t('modal.pausing') : t('modal.pauseRun')
  return (
    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
      disabled={busy || pausing} aria-busy={pausing} onClick={() => void pause()}
      title={pausing ? `${label} ${t('modal.pausingTooltip')}` : `${label}. ${t('modal.pauseRunTooltip')}`} aria-label={label}
      data-testid={pausing ? 'rail-pausing' : 'rail-pause'}>
      {busy || pausing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Pause className="w-3.5 h-3.5 fill-current" aria-hidden />}
    </Button>
  )
}
