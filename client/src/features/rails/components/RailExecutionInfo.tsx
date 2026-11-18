import { useTranslation } from 'react-i18next'
import { formatElapsed } from '../../../lib/format-duration'
import type { RailExecMetric } from '../context/RailMetricsContext'
import { useNow } from '../../../hooks/useNow'

/**
 * Compact live execution summary on a running rail card — elapsed · steps · log
 * lines — from the same WS stream the Jobs view uses, so you don't have to open
 * the log. Self-ticks the elapsed every second (only this small node re-renders).
 */
export function RailExecutionInfo({ metric }: { metric: RailExecMetric }) {
  const { t } = useTranslation('dashboard')
  const now = useNow(1000)
  return (
    <div className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground tabular-nums" data-testid="rail-exec-info">
      <span>{formatElapsed(now - metric.startedAt)}</span>
      <span aria-hidden>·</span>
      <span>{t('railControls.execSteps', { count: metric.steps })}</span>
      <span aria-hidden>·</span>
      <span>{t('railControls.execLines', { count: metric.lines })}</span>
    </div>
  )
}
