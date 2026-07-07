import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link2, ArrowRight, Crown, Trash2, MessageSquare, AlertTriangle } from 'lucide-react'
import { Badge } from './ui/badge'
import { MoveToRailPopover } from './MoveToRailPopover'
import { useMinimizedChats } from '../context/MinimizedChatsContext'
import { useDesktop } from '../hooks/useDesktop'
import { parseAcceptanceCriteria } from './explore-spec/acceptance-criteria'
import { canRefineTicket } from '../lib/ticket-refine'
import { genPendingSpecId } from '../lib/pending-spec-id'
import type { LocalTicket, TicketPriority } from '../types'
import type { RailState } from './RailsBoard'

const PRIORITY_VARIANT: Record<TicketPriority, 'destructive' | 'default' | 'warning' | 'outline'> = {
  critical: 'destructive',
  high: 'default',
  medium: 'warning',
  low: 'outline',
}

interface TicketPostitCardProps {
  ticket: LocalTicket
  rails: RailState[]
  onClick: (ticket: LocalTicket) => void
  onMoveToRail: (ticketId: number, railId: string) => void
  /** Number of children when this ticket is an épica (drives the crown badge). */
  epicChildrenCount?: number
  /** Resolved épica title when this ticket is a child of an épica. */
  parentEpicTitle?: string | null
  /** Click handler for the parent-epic chip (opens the parent spec modal). */
  onOpenParentEpic?: (parentEpicId: number) => void
  contractRefining?: boolean
  /** Allows an on_review ticket to be sent to a rail to continue its open PR. */
  allowOnReviewRailMove?: boolean
  jiggleMode?: boolean
  /** Fires after a sustained press on the card body — used to enter jiggle / delete mode. */
  onLongPress?: () => void
  onDelete?: (ticket: LocalTicket) => void
}

const LONG_PRESS_MS = 700

/**
 * Square-ish postit card variant of `SpecCard`. Renders the ticket's id,
 * title (up to 2 lines), priority pill, dependency indicator, and the
 * `short_summary` field when present. A `Move to Rail` button at the
 * bottom opens a popover listing the project's rails.
 *
 * Used by `SpecsBoard` in the `postit` tier (wide left panel).
 */
export function TicketPostitCard({
  ticket,
  rails,
  onClick,
  onMoveToRail,
  epicChildrenCount,
  parentEpicTitle,
  onOpenParentEpic,
  contractRefining = false,
  allowOnReviewRailMove = false,
  jiggleMode = false,
  onLongPress,
  onDelete,
}: TicketPostitCardProps) {
  const { t } = useTranslation('specs')
  // On-review specs are frozen unless there is an open PR branch the rail can
  // continue by adding another commit.
  const dragFrozen = jiggleMode || (ticket.status === 'on_review' && !allowOnReviewRailMove)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: dragFrozen,
  })

  const [popoverAnchor, setPopoverAnchor] = useState<DOMRect | null>(null)
  const moveButtonRef = useRef<HTMLButtonElement>(null)
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
    // Ignore presses that originated inside child interactive controls
    // (Move-to-Rail button, parent-epic chip, delete chip…).
    if ((e.target as HTMLElement).closest('button')) return
    startLongPress()
  }, [startLongPress])

  const handlePointerUpOrLeave = useCallback(() => {
    clearLongPress()
  }, [clearLongPress])

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (longPressFiredRef.current) {
      // Suppress the click that follows a long-press so the modal doesn't
      // open the moment we enter jiggle mode.
      e.stopPropagation()
      longPressFiredRef.current = false
      return
    }
    if (jiggleMode) return
    onClick(ticket)
  }, [jiggleMode, onClick, ticket])

  const handleMoveClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!moveButtonRef.current) return
    setPopoverAnchor(moveButtonRef.current.getBoundingClientRect())
  }, [])

  const isDraft = ticket.status === 'draft'
  const isOnReview = ticket.status === 'on_review'
  const isEpic = ticket.is_epic === true
  const isChildOfEpic = ticket.parent_epic_id != null
  const hasDependencies = (ticket.prerequisites?.length ?? 0) > 0
  const summary = ticket.short_summary && ticket.short_summary.trim().length > 0 ? ticket.short_summary : null

  // Inline "Continue Editing" — same path as the ticket detail modal. The
  // affordance is hidden for non-editable statuses (done, cancelled, etc.)
  // to keep the postit clean.
  const { triggerResume } = useMinimizedChats()
  const { activeProjectId } = useDesktop()
  const canContinueEditing = canRefineTicket(ticket) && Boolean(activeProjectId)

  const handleContinueEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeProjectId) return
    const { body, criteria } = parseAcceptanceCriteria(ticket.description ?? '')
    triggerResume({
      kind: 'explore-spec',
      projectId: activeProjectId,
      label: ticket.title || t('card.ticketFallbackLabel', { id: ticket.id }),
      restoreRoute: '/',
      params: {
        initialIdea: '',
        // A real, filesystem-safe id (NOT '') so attachment uploads + "From a
        // website" capture work in edit mode (empty 400s capture).
        pendingSpecId: genPendingSpecId(),
        initialAttachmentIds: [],
        resumeConversationId: ticket.origin_conversation_id ?? undefined,
        editTicket: {
          id: ticket.id,
          title: ticket.title,
          description: body,
          labels: ticket.labels ?? [],
          priority: ticket.priority ?? 'medium',
          acceptanceCriteria: criteria,
          // Drives publish-vs-update on commit: a draft PUBLISHES (flips to a
          // real spec), a live spec PATCHes in place. See ExploreSpecShell.
          status: ticket.status,
        },
      },
    })
  }, [activeProjectId, ticket, triggerResume, t])

  // Stable per-ticket jiggle phase offset (0..−399 ms over the 400 ms
  // animation) so each card wobbles out of phase with its neighbours
  // instead of all dancing in lockstep.
  const jigglePhaseMs = jiggleMode ? -((ticket.id * 73) % 400) : undefined

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    ...(jigglePhaseMs !== undefined ? { animationDelay: `${jigglePhaseMs}ms` } : {}),
  }

  const tone = isDraft
    ? 'bg-accent-secondary/10 border-accent-secondary/40'
    : isOnReview
      ? 'bg-accent-warning/5 border-accent-warning/40'
      : contractRefining
        ? 'bg-card/70 border-accent-highlight/70 shadow-lg shadow-accent-highlight/20 animate-pulse'
        : isEpic
          ? 'bg-card/80 border-accent-highlight/40'
          : 'bg-card/80 border-border/40'

  return (
    <>
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        style={style}
        onClick={handleCardClick}
        // Use the capture phase so dnd-kit's bubble-phase onPointerDown
        // (spread via `...listeners`) still fires and starts the drag.
        onPointerDownCapture={handlePointerDown}
        onPointerUp={handlePointerUpOrLeave}
        onPointerLeave={handlePointerUpOrLeave}
        onPointerCancel={handlePointerUpOrLeave}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleCardClick(e as unknown as React.MouseEvent)
          }
        }}
        data-ticket-id={ticket.id}
        data-tier="postit"
        className={`group relative flex flex-col gap-2 rounded-xl border ${tone} backdrop-blur p-3 cursor-pointer transition-[transform,box-shadow,border-color] duration-150 ease-out hover:border-accent-info/40 hover:shadow-md hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/60 min-h-[180px] ${jiggleMode ? 'animate-jiggle' : ''} ${contractRefining ? 'ring-1 ring-accent-info/30' : ''}`}
      >
        {/* Header: id + parent-epic chip (left) · priority pills (right) */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">#{ticket.id}</span>
            {isChildOfEpic && parentEpicTitle && ticket.parent_epic_id != null && (
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
                disabled={!onOpenParentEpic}
                title={t('badges.openParentEpicTitle', { id: ticket.parent_epic_id, title: parentEpicTitle })}
                data-testid={`postit-epic-child-pill-${ticket.id}`}
                className="inline-flex items-center gap-1 rounded-md border border-accent-secondary/40 text-accent-secondary bg-accent-secondary/5 hover:bg-accent-secondary/15 hover:border-accent-secondary/60 disabled:hover:bg-accent-secondary/5 disabled:hover:border-accent-secondary/40 disabled:cursor-default px-1.5 py-0.5 text-[10px] font-medium max-w-[160px] truncate transition-colors"
              >
                <Crown className="w-2.5 h-2.5 shrink-0" aria-hidden />
                <span className="truncate">↑ #{ticket.parent_epic_id} {parentEpicTitle}</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {ticket.needs_review && (
              <Badge
                variant="outline"
                className="h-4 gap-1 px-1.5 text-[9px] uppercase border-accent-warning/60 text-accent-warning bg-accent-warning/10"
                title={t('badges.needsReviewTitle')}
                data-testid={`needs-review-badge-${ticket.id}`}
              >
                <AlertTriangle className="w-2.5 h-2.5" aria-hidden />
                {t('badges.review')}
              </Badge>
            )}
            {isEpic && (
              <Badge variant="outline" className="h-4 gap-1 px-1.5 text-[9px] border-accent-highlight/40 text-accent-highlight">
                <Crown className="w-2.5 h-2.5" aria-hidden />
                {epicChildrenCount
                  ? t('badges.epicWithCount', { count: epicChildrenCount })
                  : t('badges.epic')}
              </Badge>
            )}
            {ticket.source === 'free-prompt' && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] uppercase border-accent-info/50 text-accent-info"
                title={t('badges.rawTitle')}
                data-testid={`raw-badge-${ticket.id}`}
              >
                {t('badges.raw')}
              </Badge>
            )}
            {ticket.jira_key && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] font-mono border-accent-info/50 text-accent-info"
                title={ticket.jira_key}
                data-testid={`jira-badge-${ticket.id}`}
              >
                {ticket.jira_key}
              </Badge>
            )}
            {ticket.priority && !isDraft && !isOnReview && (
              <Badge variant={PRIORITY_VARIANT[ticket.priority]} className="h-4 px-1.5 text-[9px] uppercase">
                {t(`priority.${ticket.priority}`)}
              </Badge>
            )}
            {isDraft && (
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase border-accent-secondary/50 text-accent-secondary">
                {t('common:status.draft')}
              </Badge>
            )}
            {isOnReview && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] uppercase border-accent-warning/60 text-accent-warning bg-accent-warning/10"
                title={t('status.onReviewHint')}
                data-testid={`on-review-badge-postit-${ticket.id}`}
              >
                {t('common:status.onReview')}
              </Badge>
            )}
          </div>
        </div>

        {/* Title — up to 2 lines */}
        <h3 className="text-sm font-medium leading-snug line-clamp-2 text-foreground">
          {ticket.title}
        </h3>

        {/* Summary (if present) */}
        {summary && (
          <p
            data-testid="postit-short-summary"
            className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3 italic"
          >
            {summary}
          </p>
        )}

        {/* Dependency indicator only — parent-epic chip moved up to the header. */}
        {hasDependencies && (
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-1">
              <Link2 className="w-2.5 h-2.5" aria-hidden />
              {t('card.dependsOn', { count: ticket.prerequisites!.length })}
            </span>
          </div>
        )}

        {/* Spacer pushes the Move-to-Rail button to the bottom */}
        <div className="flex-1" />

        {/* Footer actions: Continue Editing (when editable) · Move to Rail */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/30">
          <div className="flex items-center gap-1">
            {canContinueEditing && (
              <button
                type="button"
                onClick={handleContinueEditing}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid="postit-continue-editing"
                title={t('card.continueEditingTitle')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-accent-primary/90 hover:bg-accent-primary/10 hover:text-accent-primary transition-colors"
              >
                <MessageSquare className="w-2.5 h-2.5" aria-hidden />
                {t('card.continueEditing')}
              </button>
            )}
            {/* On-review specs can return to a rail only when an open PR branch
                is available for continuation. */}
            {(!isOnReview || allowOnReviewRailMove) && (
              <button
                ref={moveButtonRef}
                type="button"
                onClick={handleMoveClick}
                data-testid="move-to-rail-button"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-accent-info/90 hover:bg-accent-info/10 hover:text-accent-info transition-colors"
              >
                {t('card.moveToRail')}
                <ArrowRight className="w-2.5 h-2.5" aria-hidden />
              </button>
            )}
          </div>
          {jiggleMode && onDelete && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(ticket) }}
              className="p-1 rounded-md text-destructive/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
              aria-label={t('card.deleteTicket', { id: ticket.id })}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {popoverAnchor && (
        <MoveToRailPopover
          rails={rails}
          anchorRect={popoverAnchor}
          onMoveToRail={(railId) => onMoveToRail(ticket.id, railId)}
          onClose={() => setPopoverAnchor(null)}
        />
      )}
    </>
  )
}
