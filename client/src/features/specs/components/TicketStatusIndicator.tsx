import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { TicketStatus } from '../../../types'
import { LiveDot } from '../../../components/ui/live-dot'

// ─── Config ───────────────────────────────────────────────────────────────────

interface StatusConfig {
  dotClass: string
  textClass: string
  /** i18n key (resolved with the `specs` namespace as default). */
  labelKey: string
  pulsing: boolean
}

const STATUS_CONFIG: Record<TicketStatus, StatusConfig> = {
  draft: {
    dotClass: 'bg-accent-secondary/60',
    textClass: 'text-accent-secondary',
    labelKey: 'common:status.draft',
    pulsing: false,
  },
  todo: {
    dotClass: 'bg-muted-foreground/70',
    textClass: 'text-muted-foreground',
    labelKey: 'status.todo',
    pulsing: false,
  },
  in_progress: {
    dotClass: 'bg-accent-info',
    textClass: 'text-foreground font-semibold',
    labelKey: 'status.inProgress',
    pulsing: true,
  },
  on_review: {
    dotClass: 'bg-accent-review',
    textClass: 'text-accent-review',
    labelKey: 'status.onReview',
    pulsing: false,
  },
  done: {
    dotClass: 'text-accent-success',
    textClass: 'text-accent-success',
    labelKey: 'status.done',
    pulsing: false,
  },
  cancelled: {
    dotClass: 'text-destructive/70',
    textClass: 'text-muted-foreground',
    labelKey: 'status.cancelled',
    pulsing: false,
  },
}

// ─── TicketStatusDot ──────────────────────────────────────────────────────────

/**
 * Small animated dot or icon representing ticket status.
 * Used inline within list rows, cards, and post-its.
 */
export interface TicketStatusDotProps {
  status: TicketStatus
  className?: string
}

export function TicketStatusDot({ status, className }: TicketStatusDotProps) {
  const { t } = useTranslation('specs')
  const cfg = STATUS_CONFIG[status]

  if (status === 'done') {
    return (
      <Check
        className={cn('w-3.5 h-3.5 shrink-0', cfg.dotClass, className)}
        aria-label={t('status.done')}
      />
    )
  }

  if (status === 'cancelled') {
    return (
      <X
        className={cn('w-3.5 h-3.5 shrink-0', cfg.dotClass, className)}
        aria-label={t('status.cancelled')}
      />
    )
  }

  if (cfg.pulsing) {
    return (
      <LiveDot
        size="md"
        dotClassName={cfg.dotClass}
        className={className}
        aria-label={t('status.inProgress')}
      />
    )
  }

  return (
    <span
      className={cn('inline-flex rounded-full h-2.5 w-2.5 shrink-0', cfg.dotClass, className)}
      aria-label={t(cfg.labelKey)}
    />
  )
}

// ─── TicketStatusBadge ────────────────────────────────────────────────────────

/**
 * Pill badge with dot/icon + label text.
 * Suitable for detail views, modals, and prominent status display.
 */
export interface TicketStatusBadgeProps {
  status: TicketStatus
  className?: string
}

export function TicketStatusBadge({ status, className }: TicketStatusBadgeProps) {
  const { t } = useTranslation('specs')
  const cfg = STATUS_CONFIG[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-caption font-medium border',
        status === 'todo' && 'bg-muted border-border text-muted-foreground',
        status === 'in_progress' && 'bg-accent-info/10 border-accent-info/30 text-accent-info',
        status === 'on_review' && 'bg-accent-review/10 border-accent-review/30 text-accent-review',
        status === 'done' && 'bg-accent-success/10 border-accent-success/30 text-accent-success',
        status === 'cancelled' && 'bg-destructive/10 border-destructive/30 text-destructive',
        className
      )}
    >
      <TicketStatusDot status={status} />
      {t(cfg.labelKey)}
    </span>
  )
}
