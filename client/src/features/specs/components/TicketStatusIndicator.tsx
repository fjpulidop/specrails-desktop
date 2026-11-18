import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { TicketStatus } from '../../../types'
import { LiveDot } from '../../../components/ui/live-dot'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { runStateLook, type RunState } from '../../../components/ui/run-state/run-state'

// ─── Config ───────────────────────────────────────────────────────────────────

interface StatusConfig {
  dotClass: string
  textClass: string
  /** i18n key (resolved with the `specs` namespace as default). */
  labelKey: string
  pulsing: boolean
}

/**
 * The workflow statuses that are run states (components/ui/run-state). Draft
 * and todo are board columns, not runs: they keep their own workflow dots.
 */
const STATUS_RUN_STATE: Partial<Record<TicketStatus, RunState>> = {
  in_progress: 'working',
  on_review: 'review',
  done: 'done',
  cancelled: 'stopped',
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
    dotClass: runStateLook('working').dot,
    textClass: 'text-foreground font-semibold',
    labelKey: 'status.inProgress',
    pulsing: true,
  },
  on_review: {
    dotClass: runStateLook('review').dot,
    textClass: runStateLook('review').text,
    labelKey: 'status.onReview',
    pulsing: false,
  },
  done: {
    dotClass: runStateLook('done').dot,
    textClass: runStateLook('done').text,
    labelKey: 'status.done',
    pulsing: false,
  },
  cancelled: {
    dotClass: runStateLook('stopped').dot,
    textClass: runStateLook('stopped').text,
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
  /** Set false to render the in-progress dot static (nothing is moving). */
  pulsing?: boolean
}

export function TicketStatusDot({ status, className, pulsing = true }: TicketStatusDotProps) {
  const { t } = useTranslation('specs')
  const cfg = STATUS_CONFIG[status]

  // A finished or cancelled spec shows its state's glyph (CheckCircle2 / CircleSlash).
  if (status === 'done' || status === 'cancelled') {
    return (
      <RunStateGlyph
        state={status === 'done' ? 'done' : 'stopped'}
        size="sm"
        className={className}
        label={t(cfg.labelKey)}
      />
    )
  }

  if (cfg.pulsing && pulsing) {
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
  const runState = STATUS_RUN_STATE[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-caption font-medium border',
        status === 'todo' && 'bg-muted border-border text-muted-foreground',
        runState && [runStateLook(runState).text, runStateLook(runState).border],
        className
      )}
    >
      <TicketStatusDot status={status} />
      {t(cfg.labelKey)}
    </span>
  )
}
