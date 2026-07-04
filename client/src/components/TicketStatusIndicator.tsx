import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import type { TicketStatus } from '../types'

// ─── Config ───────────────────────────────────────────────────────────────────

interface StatusConfig {
  dotClass: string
  textClass: string
  borderClass: string
  /** i18n key (resolved with the `specs` namespace as default). */
  labelKey: string
  pulsing: boolean
}

const STATUS_CONFIG: Record<TicketStatus, StatusConfig> = {
  draft: {
    dotClass: 'bg-accent-secondary/60',
    textClass: 'text-accent-secondary',
    borderClass: 'border-l-[3px] border-dashed border-accent-secondary/50 pl-3',
    labelKey: 'common:status.draft',
    pulsing: false,
  },
  todo: {
    dotClass: 'bg-slate-500/70',
    textClass: 'text-muted-foreground',
    borderClass: 'border-l-[3px] border-dashed border-slate-500/40 pl-3',
    labelKey: 'status.todo',
    pulsing: false,
  },
  in_progress: {
    dotClass: 'bg-blue-400 aurora-light:bg-accent-info',
    textClass: 'text-foreground font-semibold',
    borderClass: 'border-l-[3px] border-solid border-blue-500 pl-3',
    labelKey: 'status.inProgress',
    pulsing: true,
  },
  on_review: {
    dotClass: 'bg-accent-warning/80',
    textClass: 'text-accent-warning',
    borderClass: 'border-l-[3px] border-solid border-accent-warning/60 pl-3',
    labelKey: 'status.onReview',
    pulsing: false,
  },
  done: {
    dotClass: 'text-emerald-400 aurora-light:text-accent-success',
    textClass: 'text-emerald-400/80 aurora-light:text-accent-success',
    borderClass: 'border-l-[3px] border-solid border-emerald-500 pl-3',
    labelKey: 'status.done',
    pulsing: false,
  },
  cancelled: {
    dotClass: 'text-red-400/60 aurora-light:text-destructive/70',
    textClass: 'text-muted-foreground/50',
    borderClass: 'pl-3',
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
      <span
        className={cn('relative flex shrink-0 h-2.5 w-2.5', className)}
        aria-label={t('status.inProgress')}
      >
        <span
          className={cn(
            'animate-ping absolute inline-flex h-full w-full rounded-full opacity-60',
            cfg.dotClass
          )}
        />
        <span
          className={cn(
            'relative inline-flex rounded-full h-2.5 w-2.5',
            cfg.dotClass
          )}
        />
      </span>
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
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border',
        status === 'todo' && 'bg-slate-500/10 border-slate-500/30 text-slate-400 aurora-light:bg-muted aurora-light:border-border aurora-light:text-muted-foreground',
        status === 'in_progress' && 'bg-blue-500/10 border-blue-500/30 text-blue-400 aurora-light:bg-accent-info/10 aurora-light:border-accent-info/30 aurora-light:text-accent-info',
        status === 'on_review' && 'bg-accent-warning/10 border-accent-warning/30 text-accent-warning',
        status === 'done' && 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 aurora-light:bg-accent-success/10 aurora-light:border-accent-success/30 aurora-light:text-accent-success',
        status === 'cancelled' && 'bg-red-500/10 border-red-500/30 text-red-400/60 aurora-light:bg-destructive/10 aurora-light:border-destructive/30 aurora-light:text-destructive/70',
        className
      )}
    >
      <TicketStatusDot status={status} />
      {t(cfg.labelKey)}
    </span>
  )
}

// ─── TicketStatusRow ──────────────────────────────────────────────────────────

/**
 * Wrapper div that applies the left-border visual treatment based on status.
 * Wrap list rows, grid cards, or post-its with this to get consistent
 * status styling across all view modes. Accepts any HTMLDivElement attributes,
 * so it can be used as a clickable row (role="button", tabIndex, onClick).
 *
 * @example
 * <TicketStatusRow status="in_progress" role="button" tabIndex={0} onClick={open}>
 *   <TicketTitle>My ticket</TicketTitle>
 * </TicketStatusRow>
 */
export interface TicketStatusRowProps extends React.HTMLAttributes<HTMLDivElement> {
  status: TicketStatus
}

export function TicketStatusRow({ status, className, children, ...props }: TicketStatusRowProps) {
  const cfg = STATUS_CONFIG[status]

  return (
    <div
      className={cn(cfg.borderClass, className)}
      data-ticket-status={status}
      {...props}
    >
      {children}
    </div>
  )
}
