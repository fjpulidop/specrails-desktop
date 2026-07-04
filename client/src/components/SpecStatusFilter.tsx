import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import type { TicketStatus } from '../types'
import { TicketStatusDot } from './TicketStatusIndicator'
import {
  ACTIVE_STATUSES,
  TICKET_STATUS_ORDER,
  type SpecStatusFilterValue,
} from '../lib/spec-status-filter'

interface SpecStatusFilterProps {
  /** Current selection. */
  value: SpecStatusFilterValue
  onChange: (v: SpecStatusFilterValue) => void
  /** Live per-status counts (after the label/epic/sprint filters). */
  counts: Record<TicketStatus, number>
  className?: string
}

/**
 * Per-chip visual identity. Colors mirror the existing status pills
 * (`TicketStatusIndicator` STATUS_CONFIG / TicketStatusBadge) exactly so the
 * selector reads with the same visual language as the cards it filters.
 */
const CHIP_ACTIVE_CLASSES: Record<SpecStatusFilterValue, string> = {
  active: 'bg-accent-primary/15 border-accent-primary/40 text-accent-primary',
  all: 'bg-muted/50 border-border text-foreground',
  draft: 'bg-accent-secondary/15 border-accent-secondary/40 text-accent-secondary',
  todo: 'bg-slate-500/15 border-slate-500/40 text-slate-400 aurora-light:bg-muted aurora-light:border-border aurora-light:text-muted-foreground',
  in_progress:
    'bg-blue-500/15 border-blue-500/40 text-blue-400 aurora-light:bg-accent-info/10 aurora-light:border-accent-info/30 aurora-light:text-accent-info',
  on_review: 'bg-accent-warning/15 border-accent-warning/40 text-accent-warning',
  done: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 aurora-light:bg-accent-success/10 aurora-light:border-accent-success/30 aurora-light:text-accent-success',
  cancelled:
    'bg-red-500/10 border-red-500/30 text-red-400/80 aurora-light:bg-destructive/10 aurora-light:border-destructive/30 aurora-light:text-destructive/70',
}

/** i18n label per chip — statuses reuse the exact pill labels. */
const CHIP_LABEL_KEYS: Record<SpecStatusFilterValue, string> = {
  active: 'statusFilter.active',
  all: 'statusFilter.all',
  draft: 'common:status.draft',
  todo: 'status.todo',
  in_progress: 'status.inProgress',
  on_review: 'status.onReview',
  done: 'status.done',
  cancelled: 'status.cancelled',
}

interface ChipProps {
  value: SpecStatusFilterValue
  selected: boolean
  count: number
  onClick: () => void
  label: string
}

function Chip({ value, selected, count, onClick, label }: ChipProps) {
  const isStatus = value !== 'active' && value !== 'all'
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      data-testid={`specs-status-chip-${value}`}
      title={label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 h-6 text-[11px] font-medium whitespace-nowrap shrink-0 transition-all',
        selected
          ? CHIP_ACTIVE_CLASSES[value]
          : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40',
        // Empty statuses stay visible (full-state visibility is the point)
        // but recede so the populated ones carry the eye.
        !selected && count === 0 && 'opacity-40',
      )}
    >
      {isStatus && <TicketStatusDot status={value as TicketStatus} className="w-2 h-2" />}
      <span>{label}</span>
      <span
        className={cn(
          'text-[10px] tabular-nums rounded-full px-1 min-w-[16px] text-center',
          selected ? 'bg-background/40' : 'bg-muted/30 opacity-70',
        )}
        data-testid={`specs-status-count-${value}`}
      >
        {count}
      </span>
    </button>
  )
}

/**
 * Premium status selector for the SpecsBoard header. Replaces the old
 * ToDo/Done tab pair: two smart buckets (Active — the default view — and All)
 * plus one chip per TicketStatus, every one with a live count and the status'
 * own pill color. Overflows gracefully (horizontal scroll, hidden scrollbar)
 * when the board is narrow.
 */
export function SpecStatusFilter({ value, onChange, counts, className }: SpecStatusFilterProps) {
  const { t } = useTranslation('specs')

  const activeCount = TICKET_STATUS_ORDER.filter((s) => ACTIVE_STATUSES.has(s)).reduce(
    (sum, s) => sum + counts[s],
    0,
  )
  const allCount = TICKET_STATUS_ORDER.reduce((sum, s) => sum + counts[s], 0)
  const countFor = (v: SpecStatusFilterValue): number =>
    v === 'active' ? activeCount : v === 'all' ? allCount : counts[v]

  return (
    <div
      role="tablist"
      aria-label={t('statusFilter.ariaLabel')}
      data-testid="specs-status-filter"
      className={cn(
        'flex items-center gap-1 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {(['active', 'all'] as const).map((v) => (
        <Chip
          key={v}
          value={v}
          selected={value === v}
          count={countFor(v)}
          onClick={() => onChange(v)}
          label={t(CHIP_LABEL_KEYS[v])}
        />
      ))}

      <div className="h-4 w-px bg-border/50 shrink-0 mx-0.5" aria-hidden />

      {TICKET_STATUS_ORDER.map((s) => (
        <Chip
          key={s}
          value={s}
          selected={value === s}
          count={countFor(s)}
          onClick={() => onChange(s)}
          label={t(CHIP_LABEL_KEYS[s])}
        />
      ))}
    </div>
  )
}
