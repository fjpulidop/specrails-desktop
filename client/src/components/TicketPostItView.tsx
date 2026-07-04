import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Ticket, AlertTriangle, ArrowUp, ChevronUp, Plus } from 'lucide-react'
import { cn } from '../lib/utils'
import { TicketContextMenu } from './TicketContextMenu'
import { TicketStatusDot } from './TicketStatusIndicator'
import type { LocalTicket, TicketStatus, TicketPriority } from '../types'

// ─── Post-it color palettes per status ──────────────────────────────────────

interface PostItPalette {
  bg: string
  border: string
  shadow: string
  hoverShadow: string
  titleText: string
  metaText: string
  /** Subtle fold/corner accent */
  cornerBg: string
}

const STATUS_PALETTE: Record<TicketStatus, PostItPalette> = {
  draft: {
    bg: 'bg-accent-secondary/10',
    border: 'border-dashed border-accent-secondary/40',
    shadow: 'shadow-[0_2px_8px_rgba(0,0,0,0.05)]',
    hoverShadow: 'hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)]',
    titleText: 'text-accent-secondary',
    metaText: 'text-accent-secondary/60',
    cornerBg: 'bg-accent-secondary/20',
  },
  todo: {
    bg: 'bg-slate-700/40 aurora-light:bg-muted',
    border: 'border-slate-600/40 aurora-light:border-border',
    shadow: 'shadow-[0_2px_8px_rgba(100,116,139,0.15)]',
    hoverShadow: 'hover:shadow-[0_4px_20px_rgba(100,116,139,0.25)]',
    titleText: 'text-slate-200 aurora-light:text-foreground',
    metaText: 'text-slate-400 aurora-light:text-muted-foreground',
    cornerBg: 'bg-slate-600/30 aurora-light:bg-muted-foreground/20',
  },
  in_progress: {
    bg: 'bg-blue-900/35 aurora-light:bg-accent-info/10',
    border: 'border-blue-500/35 aurora-light:border-accent-info/30',
    shadow: 'shadow-[0_2px_8px_rgba(59,130,246,0.12)]',
    hoverShadow: 'hover:shadow-[0_4px_20px_rgba(59,130,246,0.25)]',
    titleText: 'text-blue-100 aurora-light:text-foreground',
    metaText: 'text-blue-300/70 aurora-light:text-accent-info',
    cornerBg: 'bg-blue-500/20 aurora-light:bg-accent-info/20',
  },
  on_review: {
    bg: 'bg-accent-warning/10',
    border: 'border-accent-warning/40',
    shadow: 'shadow-[0_2px_8px_rgba(0,0,0,0.08)]',
    hoverShadow: 'hover:shadow-[0_4px_20px_rgba(0,0,0,0.15)]',
    titleText: 'text-foreground',
    metaText: 'text-accent-warning',
    cornerBg: 'bg-accent-warning/20',
  },
  done: {
    bg: 'bg-emerald-900/30 aurora-light:bg-accent-success/10',
    border: 'border-emerald-500/30 aurora-light:border-accent-success/30',
    shadow: 'shadow-[0_2px_8px_rgba(16,185,129,0.1)]',
    hoverShadow: 'hover:shadow-[0_4px_20px_rgba(16,185,129,0.2)]',
    titleText: 'text-emerald-200/80 aurora-light:text-accent-success',
    metaText: 'text-emerald-400/60 aurora-light:text-accent-success/70',
    cornerBg: 'bg-emerald-500/15 aurora-light:bg-accent-success/20',
  },
  cancelled: {
    bg: 'bg-red-950/25 aurora-light:bg-destructive/10',
    border: 'border-red-800/25 aurora-light:border-destructive/30',
    shadow: 'shadow-[0_2px_8px_rgba(239,68,68,0.06)]',
    hoverShadow: 'hover:shadow-[0_4px_20px_rgba(239,68,68,0.12)]',
    titleText: 'text-red-300/50 aurora-light:text-destructive/70',
    metaText: 'text-red-400/40 aurora-light:text-destructive/60',
    cornerBg: 'bg-red-800/15 aurora-light:bg-destructive/20',
  },
}

// ─── Priority indicator ─────────────────────────────────────────────────────

const PRIORITY_INDICATOR: Record<TicketPriority, { icon: typeof AlertTriangle | null; className: string; label: string }> = {
  critical: { icon: AlertTriangle, className: 'text-red-400 aurora-light:text-destructive', label: 'Critical' },
  high: { icon: ArrowUp, className: 'text-orange-400 aurora-light:text-accent-warning', label: 'High' },
  medium: { icon: null, className: '', label: '' },
  low: { icon: ChevronUp, className: 'text-gray-500 rotate-180 aurora-light:text-muted-foreground', label: 'Low' },
}

// ─── Slight random rotations for paper feel ─────────────────────────────────

function getRotation(id: number): string {
  const rotations = ['-1.2deg', '0.8deg', '-0.5deg', '1.1deg', '-0.9deg', '0.3deg', '1.5deg', '-0.7deg']
  return rotations[id % rotations.length]
}

// ─── Component ──────────────────────────────────────────────────────────────

interface TicketPostItViewProps {
  tickets: LocalTicket[]
  isLoading: boolean
  error?: string | null
  onTicketClick: (ticket: LocalTicket) => void
  onDelete: (ticketId: number) => void
  onStatusChange: (ticketId: number, status: TicketStatus) => void
  onPriorityChange: (ticketId: number, priority: TicketPriority) => void
  onCreateClick?: () => void
}

export function TicketPostItView({
  tickets,
  isLoading,
  error,
  onTicketClick,
  onDelete,
  onStatusChange,
  onPriorityChange,
  onCreateClick,
}: TicketPostItViewProps) {
  const { t } = useTranslation('specs')
  const sorted = useMemo(() => {
    const order: Record<TicketStatus, number> = { in_progress: 0, on_review: 1, draft: 2, todo: 3, done: 4, cancelled: 5 }
    return [...tickets].sort((a, b) => order[a.status] - order[b.status])
  }, [tickets])

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-28 rounded-lg border border-border/30 bg-card/30 animate-pulse"
          />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 aurora-light:border-destructive/30 bg-red-500/10 aurora-light:bg-destructive/10 p-6 text-center space-y-1.5">
        <AlertTriangle className="w-6 h-6 text-red-400 aurora-light:text-destructive mx-auto" />
        <p className="text-sm font-medium text-red-400 aurora-light:text-destructive">{t('errors.loadFailed')}</p>
        <p className="text-xs text-red-400/70 aurora-light:text-destructive/80">{error}</p>
      </div>
    )
  }

  if (tickets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-card/50 p-8 text-center space-y-3">
        <Ticket className="w-8 h-8 text-muted-foreground/30 mx-auto" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{t('emptyState.noTickets')}</p>
          <p className="text-xs text-muted-foreground/60">
            {t('emptyState.noTicketsHint')}
          </p>
        </div>
        {onCreateClick && (
          <button
            type="button"
            onClick={onCreateClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent/60 text-foreground hover:bg-accent transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('emptyState.createFirst')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {sorted.map((ticket) => (
        <TicketContextMenu
          key={ticket.id}
          ticket={ticket}
          onDelete={onDelete}
          onStatusChange={onStatusChange}
          onPriorityChange={onPriorityChange}
        >
          <PostItCard
            ticket={ticket}
            onClick={() => onTicketClick(ticket)}
          />
        </TicketContextMenu>
      ))}
    </div>
  )
}

// ─── PostItCard ─────────────────────────────────────────────────────────────

interface PostItCardProps {
  ticket: LocalTicket
  onClick: () => void
}

function PostItCard({ ticket, onClick }: PostItCardProps) {
  const { t } = useTranslation('specs')
  const palette = STATUS_PALETTE[ticket.status]
  const priority = ticket.priority ? PRIORITY_INDICATOR[ticket.priority] : null
  const rotation = getRotation(ticket.id)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative w-full text-left rounded-lg p-3 min-h-[100px]',
        'border backdrop-blur-sm',
        palette.bg,
        palette.border,
        palette.shadow,
        palette.hoverShadow,
        'transition-all duration-200 ease-out',
        'hover:scale-[1.03] hover:-translate-y-0.5',
        'active:scale-[0.98]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
        ticket.status === 'cancelled' && 'opacity-60',
      )}
      style={{ transform: `rotate(${rotation})` }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'rotate(0deg) scale(1.03) translateY(-2px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = `rotate(${rotation})`
      }}
    >
      {/* Corner fold effect */}
      <div
        className={cn('absolute top-0 right-0 w-5 h-5 rounded-bl-lg', palette.cornerBg)}
        aria-hidden
      />

      {/* Priority indicator (or Draft / On-review pill) */}
      {ticket.status === 'draft' ? (
        <div className="absolute top-1.5 left-2 inline-flex items-center rounded px-1 py-0.5 text-[8px] font-semibold border border-accent-secondary/60 text-accent-secondary bg-accent-secondary/10">
          {t('common:status.draft')}
        </div>
      ) : ticket.status === 'on_review' ? (
        <div
          className="absolute top-1.5 left-2 inline-flex items-center rounded px-1 py-0.5 text-[8px] font-semibold border border-accent-warning/60 text-accent-warning bg-accent-warning/10"
          title={t('status.onReviewHint')}
          data-testid={`on-review-pill-postit-${ticket.id}`}
        >
          {t('common:status.onReview')}
        </div>
      ) : priority?.icon ? (
        <div className="absolute top-1.5 left-2">
          <priority.icon className={cn('w-3 h-3', priority.className)} />
        </div>
      ) : null}

      {/* Epic / child badges */}
      {ticket.is_epic && (
        <div
          className="absolute top-1.5 right-7 inline-flex items-center rounded px-1 py-0.5 text-[8px] font-semibold border border-accent-highlight/60 text-accent-highlight bg-accent-highlight/10"
          data-testid={`epic-badge-postit-${ticket.id}`}
        >
          E
        </div>
      )}
      {ticket.parent_epic_id != null && (
        <div
          className="absolute top-1.5 right-7 inline-flex items-center rounded px-1 py-0.5 text-[8px] font-semibold border border-accent-secondary/40 text-accent-secondary"
          data-testid={`epic-child-pill-postit-${ticket.id}`}
        >
          ↑
        </div>
      )}

      {/* Title */}
      <p
        className={cn(
          'text-xs font-medium leading-snug line-clamp-3 mt-1',
          palette.titleText,
          ticket.status === 'done' && 'line-through decoration-emerald-500/40 aurora-light:decoration-accent-success/50',
        )}
      >
        {ticket.title}
      </p>

      {/* Bottom row: ticket ID + status dot */}
      <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between">
        <span className={cn('text-[9px] font-mono', palette.metaText)}>
          #{ticket.id}
        </span>
        <TicketStatusDot status={ticket.status} />
      </div>
    </button>
  )
}
