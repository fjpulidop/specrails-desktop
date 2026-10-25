import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { openAddenda } from '../lib/spec-addenda-core'
import { specFlowLabel } from '../lib/spec-flow'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trash2, AlertTriangle, ArrowUp, Layers, Waves } from 'lucide-react'
import { Badge } from '../../../components/ui/badge'
import { SpecTriageChip } from './SpecTriageChip'
import type { LocalTicket } from '../../../types'
import { PriorityBadge } from './PriorityBadge'
import { SpecSelectCheckbox, SELECTED_CARD_CLASS, type CardSelection } from './SpecSelectCheckbox'
import { gestureOfClick } from '../lib/board-selection'

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
  /** Opens the mission conversation of an "In Flow" spec. */
  onOpenFlow?: (conversationId: string) => void
  /** Rendered inside a rail: a Flow spec there was handed off, so no "In Flow" label. */
  onRail?: boolean
  /** Multi-select state from the specs board (absent in a rail). */
  selection?: CardSelection
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
  onOpenFlow,
  onRail = false,
  selection,
}: SpecCardProps) {
  const { t } = useTranslation('specs')
  const openAddendaCount = openAddenda(ticket.addenda).length
  // Flow mode: the placeholder spec belongs to its Flow until the rail adopts
  // it — label it and keep it off the rails (no drag).
  const flowLabel = onRail ? null : specFlowLabel(ticket)
  // On-review specs are frozen unless there is an open PR branch the rail can
  // continue by adding another commit.
  const dragFrozen = dragDisabled || jiggleMode || !!flowLabel || (ticket.status === 'on_review' && !allowOnReviewDrag)
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
    // ⌘/Ctrl-click toggles the spec in the board selection, Shift-click extends a range.
    const gesture = selection && !jiggleMode ? gestureOfClick(e) : null
    if (selection && gesture) {
      e.preventDefault()
      e.stopPropagation()
      selection.onSelect(ticket, gesture)
      return
    }
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
  }, [jiggleMode, onClick, ticket, selection])

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
  const baseClass = 'relative flex items-center gap-2 px-3 py-(--density-card-y) rounded-lg border transition-colors group touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/60'
  // No grab cursor when the card cannot actually be dragged.
  const cursorClass = jiggleMode || (isOnReview && !allowOnReviewDrag) ? '' : 'cursor-grab active:cursor-grabbing'
  const variantClass = isDraft
    ? 'border-dashed border-accent-secondary/50 bg-accent-secondary/10 hover:bg-accent-secondary/15 hover:border-accent-secondary/70'
    : isOnReview
      ? 'border-border/40 bg-card/60 hover:bg-card/80 hover:border-border/60'
      : contractRefining
        ? 'border-accent-highlight/70 bg-card/70 ring-1 ring-accent-highlight/50'
        : 'border-border/40 bg-card/60 hover:bg-card/80 hover:border-border/60'
  const jiggleClass = jiggleMode ? 'motion-safe:animate-jiggle' : ''
  const cardClass = `${baseClass} ${cursorClass} ${selection?.selected ? SELECTED_CARD_CLASS : variantClass} ${jiggleClass}`

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
      role={selection ? 'option' : 'button'}
      aria-selected={selection ? selection.selected : undefined}
      tabIndex={0}
      // Enter opens the spec; other keys (Space to lift) reach dnd-kit's
      // keyboard sensor, which this explicit onKeyDown would otherwise shadow.
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!jiggleMode) onClick(ticket)
          return
        }
        if (!dragFrozen) listeners?.onKeyDown?.(e)
      }}
    >
      {selection && !jiggleMode && (
        <SpecSelectCheckbox
          ticket={ticket}
          selection={selection}
          className="absolute -left-2.5 top-1/2 z-10 -translate-y-1/2"
          onToggle={() => selection.onSelect(ticket, 'toggle')}
        />
      )}
      <span className="text-caption font-mono text-foreground shrink-0">#{ticket.id}</span>
      <span className="flex-1 text-sm truncate text-foreground">{ticket.title}</span>
      {ticket.is_epic ? (
        <Badge
          variant="outline"
          className="text-caption shrink-0 border-accent-highlight/60 text-accent-highlight bg-accent-highlight/10"
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
          className="inline-flex items-center gap-0.5 rounded-md border border-accent-secondary/40 text-accent-secondary bg-accent-secondary/5 hover:bg-accent-secondary/15 hover:border-accent-secondary/60 px-1.5 py-0.5 text-caption font-medium shrink-0 max-w-[12rem] truncate transition-colors cursor-pointer"
          title={t('badges.openParentEpicTitle', { id: ticket.parent_epic_id, title: parentEpicTitle })}
          data-testid={`epic-child-pill-${ticket.id}`}
        >
          <ArrowUp className="w-2.5 h-2.5 shrink-0" aria-hidden />
          <span className="truncate">#{ticket.parent_epic_id} {parentEpicTitle}</span>
        </button>
      ) : null}
      {flowLabel ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (flowLabel.conversationId) onOpenFlow?.(flowLabel.conversationId)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              if (flowLabel.conversationId) onOpenFlow?.(flowLabel.conversationId)
            }
          }}
          disabled={!flowLabel.conversationId || !onOpenFlow}
          data-flow-label={flowLabel.state}
          data-testid={`flow-badge-${ticket.id}`}
          title={t(flowLabel.state === 'paused' ? 'badges.inFlowPausedTitle' : 'badges.inFlowTitle')}
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-caption font-semibold transition-colors disabled:cursor-default ${
            flowLabel.state === 'paused'
              ? 'border-border/60 bg-surface/60 text-foreground/60 hover:border-foreground/30'
              : 'border-accent-info/50 bg-accent-info/10 text-accent-info hover:bg-accent-info/20'
          }`}
        >
          <Waves className="h-2.5 w-2.5" aria-hidden />
          {t(flowLabel.state === 'paused' ? 'badges.inFlowPaused' : 'badges.inFlow')}
        </button>
      ) : null}
      {ticket.needs_review ? (
        <Badge
          variant="outline"
          className="text-caption shrink-0 gap-1 border-accent-warning/60 text-accent-warning bg-accent-warning/10"
          title={t('badges.needsReviewTitle')}
          data-testid={`needs-review-badge-${ticket.id}`}
        >
          <AlertTriangle className="w-2.5 h-2.5" aria-hidden />
          {t('badges.review')}
        <span className="sr-only"> ({t('badges.needsReviewTitle')})</span></Badge>
      ) : null}
      {ticket.source === 'free-prompt' ? (
        <Badge
          variant="outline"
          className="text-caption shrink-0 border-accent-info/50 text-accent-info"
          title={t('badges.rawTitle')}
          data-testid={`raw-badge-${ticket.id}`}
        >
          {t('badges.raw')}
        <span className="sr-only"> ({t('badges.rawTitle')})</span></Badge>
      ) : null}
      {ticket.jira_key ? (
        <Badge
          variant="outline"
          className="text-caption shrink-0 font-mono border-accent-info/50 text-accent-info"
          title={ticket.jira_key}
          data-testid={`jira-badge-${ticket.id}`}
        >
          {ticket.jira_key}
        </Badge>
      ) : null}
      {openAddendaCount > 0 ? (
        <Badge
          variant="outline"
          className="text-caption shrink-0 border-accent-primary/50 text-accent-primary bg-accent-primary/10 gap-0.5"
          title={t('badges.addendaTitle', { count: openAddendaCount })}
          data-testid={`addenda-badge-${ticket.id}`}
        >
          <Layers className="h-2.5 w-2.5" />
          {openAddendaCount}
        <span className="sr-only"> ({t('badges.addendaTitle', { count: openAddendaCount })})</span></Badge>
      ) : null}
      {!jiggleMode && <SpecTriageChip ticket={ticket} />}
      {isDraft ? (
        <Badge variant="outline" className="text-caption shrink-0 border-accent-secondary/60 text-accent-secondary">
          {t('common:status.draft')}
        </Badge>
      ) : isOnReview ? (
        <Badge
          variant="review"
          className="text-caption shrink-0"
          title={t('status.onReviewHint')}
          data-testid={`on-review-badge-${ticket.id}`}
        >
          {t('common:status.onReview')}
        <span className="sr-only"> ({t('status.onReviewHint')})</span></Badge>
      ) : contractRefining ? (
        <Badge
          variant="outline"
          className="text-caption shrink-0 border-accent-highlight/70 text-accent-highlight bg-accent-highlight/10"
        >
          {t('badges.contract')}
        </Badge>
      ) : ticket.priority ? (
        <PriorityBadge priority={ticket.priority} />
      ) : null}

      {/* Jiggle-mode delete button */}
      {jiggleMode && onDelete && (
        <button
          type="button"
          onClick={handleDelete}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-md hover:bg-destructive/90 transition-colors z-10"
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
