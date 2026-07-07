import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trash2, AlertTriangle } from 'lucide-react'
import { Badge } from './ui/badge'
import type { LocalTicket, TicketPriority } from '../types'

const PRIORITY_VARIANT: Record<TicketPriority, 'destructive' | 'default' | 'warning' | 'outline'> = {
  critical: 'destructive',
  high: 'default',
  medium: 'warning',
  low: 'outline',
}

const LONG_PRESS_MS = 700

interface SpecCardProps {
  ticket: LocalTicket
  onClick: (ticket: LocalTicket) => void
  dragDisabled?: boolean
  /** Allows an on_review ticket to be dragged back onto a rail to continue its open PR. */
  allowOnReviewDrag?: boolean
  contractRefining?: boolean
  /** Number of children when this ticket is an épica (drives the badge). */
  epicChildrenCount?: number
  /** Resolved épica title when this ticket is a child (drives the pill). */
  parentEpicTitle?: string | null
  /** Optional click handler for the parent-epic pill (opens the parent spec). */
  onOpenParentEpic?: (parentEpicId: number) => void
  /** Long-press / jiggle support — enter delete mode when user holds the card. */
  jiggleMode?: boolean
  onLongPress?: () => void
  onDelete?: (ticket: LocalTicket) => void
}

export function SpecCard({
  ticket,
  onClick,
  dragDisabled,
  allowOnReviewDrag = false,
  contractRefining = false,
  epicChildrenCount,
  parentEpicTitle,
  onOpenParentEpic,
  jiggleMode = false,
  onLongPress,
  onDelete,
}: SpecCardProps) {
  const { t } = useTranslation('specs')
  // On-review specs are frozen unless there is an open PR branch the rail can
  // continue by adding another commit.
  const dragFrozen = dragDisabled || jiggleMode || (ticket.status === 'on_review' && !allowOnReviewDrag)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: dragFrozen, // disable DnD while in jiggle mode / on review
  })

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const startLongPress = useCallback(() => {
    if (!onLongPress) return
    longPressFiredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true
      onLongPress()
      longPressTimerRef.current = null
    }, LONG_PRESS_MS)
  }, [onLongPress])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Don't start long press from inside child interactive elements (badges etc).
    if ((e.target as HTMLElement).closest('button')) return
    startLongPress()
  }, [startLongPress])

  const handlePointerUpOrLeave = useCallback(() => {
    clearLongPress()
  }, [clearLongPress])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (longPressFiredRef.current) {
      // Suppress the click that follows a successful long-press so the modal
      // doesn't open the moment we enter jiggle mode.
      e.stopPropagation()
      longPressFiredRef.current = false
      return
    }
    if (jiggleMode) {
      // While jiggling, clicks on the card body do nothing — the user must
      // use the delete button or click the background to exit.
      e.stopPropagation()
      return
    }
    onClick(ticket)
  }, [jiggleMode, onClick, ticket])

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete?.(ticket)
  }, [onDelete, ticket])

  // Per-ticket phase offset across the 400 ms jiggle keyframe so neighbours
  // wobble out of sync instead of all dancing in lockstep.
  const jigglePhaseMs = jiggleMode ? -((ticket.id * 73) % 400) : undefined

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    ...(jigglePhaseMs !== undefined ? { animationDelay: `${jigglePhaseMs}ms` } : {}),
  }

  const isDraft = ticket.status === 'draft'
  const isOnReview = ticket.status === 'on_review'
  const baseClass = 'relative flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-colors group touch-none'
  // No grab cursor when the card cannot actually be dragged.
  const cursorClass = jiggleMode || (isOnReview && !allowOnReviewDrag) ? '' : 'cursor-grab active:cursor-grabbing'
  const variantClass = isDraft
    ? 'border-dashed border-accent-secondary/50 bg-accent-secondary/10 hover:bg-accent-secondary/15 hover:border-accent-secondary/70'
    : isOnReview
      ? 'border-accent-warning/40 bg-accent-warning/5 hover:bg-accent-warning/10 hover:border-accent-warning/60'
      : contractRefining
        ? 'border-accent-highlight/70 bg-card/70 shadow-lg shadow-accent-highlight/20 animate-pulse'
        : 'border-border/40 bg-card/60 hover:bg-card/80 hover:border-border/60'
  const jiggleClass = jiggleMode ? 'animate-jiggle' : ''
  const cardClass = `${baseClass} ${cursorClass} ${variantClass} ${jiggleClass}`

  return (
    <div
      ref={setNodeRef}
      data-ticket-id={ticket.id}
      data-draft={isDraft || undefined}
      data-on-review={isOnReview || undefined}
      data-contract-refining={contractRefining || undefined}
      data-jiggle={jiggleMode || undefined}
      style={style}
      {...(!dragFrozen ? { ...attributes, ...listeners } : {})}
      className={cardClass}
      onClick={handleClick}
      // Capture phase so dnd-kit's bubble-phase onPointerDown (spread above
      // via `...listeners`) still fires and activates the drag.
      onPointerDownCapture={handlePointerDown}
      onPointerUp={handlePointerUpOrLeave}
      onPointerLeave={handlePointerUpOrLeave}
      onPointerCancel={handlePointerUpOrLeave}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && !jiggleMode && onClick(ticket)}
    >
      <span className="text-[10px] font-mono text-foreground shrink-0">#{ticket.id}</span>
      <span className="flex-1 text-sm truncate text-foreground">{ticket.title}</span>
      {ticket.is_epic ? (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 border-accent-highlight/60 text-accent-highlight bg-accent-highlight/10"
          data-testid={`epic-badge-${ticket.id}`}
        >
          {t('badges.epicWithCount', { count: epicChildrenCount ?? 0 })}
        </Badge>
      ) : null}
      {parentEpicTitle && ticket.parent_epic_id != null ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenParentEpic?.(ticket.parent_epic_id as number)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              onOpenParentEpic?.(ticket.parent_epic_id as number)
            }
          }}
          className="inline-flex items-center rounded-md border border-accent-secondary/40 text-accent-secondary bg-accent-secondary/5 hover:bg-accent-secondary/15 hover:border-accent-secondary/60 px-1.5 py-0.5 text-[9px] font-medium shrink-0 max-w-[12rem] truncate transition-colors cursor-pointer"
          title={t('badges.openParentEpicTitle', { id: ticket.parent_epic_id, title: parentEpicTitle })}
          data-testid={`epic-child-pill-${ticket.id}`}
        >
          ↑ #{ticket.parent_epic_id} {parentEpicTitle}
        </button>
      ) : null}
      {ticket.needs_review ? (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 gap-1 border-accent-warning/60 text-accent-warning bg-accent-warning/10"
          title={t('badges.needsReviewTitle')}
          data-testid={`needs-review-badge-${ticket.id}`}
        >
          <AlertTriangle className="w-2.5 h-2.5" aria-hidden />
          {t('badges.review')}
        </Badge>
      ) : null}
      {ticket.source === 'free-prompt' ? (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 uppercase border-accent-info/50 text-accent-info"
          title={t('badges.rawTitle')}
          data-testid={`raw-badge-${ticket.id}`}
        >
          {t('badges.raw')}
        </Badge>
      ) : null}
      {ticket.jira_key ? (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 font-mono border-accent-info/50 text-accent-info"
          title={ticket.jira_key}
          data-testid={`jira-badge-${ticket.id}`}
        >
          {ticket.jira_key}
        </Badge>
      ) : null}
      {isDraft ? (
        <Badge variant="outline" className="text-[9px] shrink-0 border-accent-secondary/60 text-accent-secondary">
          {t('common:status.draft')}
        </Badge>
      ) : isOnReview ? (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 border-accent-warning/60 text-accent-warning bg-accent-warning/10"
          title={t('status.onReviewHint')}
          data-testid={`on-review-badge-${ticket.id}`}
        >
          {t('common:status.onReview')}
        </Badge>
      ) : contractRefining ? (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 border-accent-highlight/70 text-accent-highlight bg-accent-highlight/10"
        >
          {t('badges.contract')}
        </Badge>
      ) : ticket.priority ? (
        <Badge variant={PRIORITY_VARIANT[ticket.priority]} className="text-[9px] shrink-0">
          {t(`priority.${ticket.priority}`)}
        </Badge>
      ) : null}

      {/* Jiggle-mode delete button */}
      {jiggleMode && onDelete && (
        <button
          type="button"
          onClick={handleDelete}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-red-500 text-white flex items-center justify-center shadow-md hover:bg-red-600 transition-colors z-10"
          title={t('card.deleteSpec', { id: ticket.id })}
          aria-label={t('card.deleteSpec', { id: ticket.id })}
          data-testid={`spec-card-delete-${ticket.id}`}
        >
          <Trash2 className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  )
}
