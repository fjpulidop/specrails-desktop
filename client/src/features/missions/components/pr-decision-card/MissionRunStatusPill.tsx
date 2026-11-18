/**
 * The run-phase status pill of a PR decision card (running, paused, failed…),
 * with a live dot while the run is active.
 */
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'
import { LiveDot } from '../../../../components/ui/live-dot'
import type { MissionRunStatus } from './run-status'

const RUN_STATUS_TONE: Record<MissionRunStatus, string> = {
  running: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  paused: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  succeeded: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  stalled: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  cancelled: 'border-border/60 bg-surface/60 text-muted-foreground',
  unknown: 'border-border/60 bg-surface/60 text-muted-foreground',
  changes_requested: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  returned: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
}

export function MissionRunStatusPill({ status }: { status: MissionRunStatus }) {
  const { t } = useTranslation('agent')
  return (
    <span
      data-testid="mission-run-status"
      data-status={status}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-medium', RUN_STATUS_TONE[status])}
    >
      {(status === 'running' || status === 'paused')
        ? <LiveDot size="xs" tone={status === 'running' ? 'info' : 'warning'} pulsing={status === 'running'} aria-hidden />
        : <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {t(`runCard.status.${status}`)}
    </span>
  )
}
