import { Signal, SignalHigh, SignalLow, SignalMedium } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TicketPriority } from '../../../types'
import { cn } from '../../../lib/utils'

const ICON = {
  critical: Signal,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
} as const

/**
 * Spec priority as quiet text with a signal-bars icon. Low and medium carry no
 * lamp hue (amber stays caution-only); high and critical read as destructive
 * text without a fill, critical in semibold.
 */
export function PriorityBadge({ priority, className }: { priority: TicketPriority; className?: string }) {
  const { t } = useTranslation('specs')
  const Icon = ICON[priority]
  return (
    <span
      data-priority={priority}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 text-caption',
        priority === 'critical' && 'font-semibold text-destructive',
        priority === 'high' && 'text-destructive',
        (priority === 'medium' || priority === 'low') && 'text-muted-foreground',
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {t(`priority.${priority}`)}
    </span>
  )
}
