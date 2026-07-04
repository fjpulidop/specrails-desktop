import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Ticket, GripVertical, AlertTriangle, Plus } from 'lucide-react'
import { cn } from '../lib/utils'
import { TicketContextMenu } from './TicketContextMenu'
import { TicketStatusDot } from './TicketStatusIndicator'
import type { LocalTicket, TicketStatus, TicketPriority } from '../types'

// ─── Column configuration ───────────────────────────────────────────────────

interface ColumnConfig {
  status: TicketStatus
  /** i18n key (specs namespace) for the column header label. */
  titleKey: string
  headerClass: string
  /** i18n key (specs namespace) for the empty-column text. */
  emptyKey: string
  columnBg: string
}

const COLUMNS: ColumnConfig[] = [
  {
    status: 'todo',
    titleKey: 'status.todo',
    headerClass: 'text-muted-foreground border-b-border',
    emptyKey: 'gridView.emptyTodo',
    columnBg: 'bg-muted/20',
  },
  {
    status: 'in_progress',
    titleKey: 'status.inProgress',
    headerClass: 'text-accent-info border-b-accent-info/40',
    emptyKey: 'gridView.emptyInProgress',
    columnBg: 'bg-accent-info/5',
  },
  {
    status: 'done',
    titleKey: 'status.done',
    headerClass: 'text-accent-success border-b-accent-success/40',
    emptyKey: 'gridView.emptyDone',
    columnBg: 'bg-accent-success/5',
  },
]

// ─── Priority badge (semantic tokens → adapts to every theme) ────────────────

const PRIORITY_STYLES: Record<TicketPriority, { className: string }> = {
  critical: { className: 'bg-destructive/15 text-destructive border-destructive/30' },
  high: { className: 'bg-accent-warning/15 text-accent-warning border-accent-warning/30' },
  medium: { className: '' },
  low: { className: 'bg-muted text-muted-foreground border-border' },
}

// ─── Sortable kanban card ───────────────────────────────────────────────────

interface KanbanCardProps {
  ticket: LocalTicket
  onClick: () => void
  isDragOverlay?: boolean
}

function SortableKanbanCard({
  ticket,
  onClick,
  onDelete,
  onStatusChange,
  onPriorityChange,
}: {
  ticket: LocalTicket
  onClick: () => void
  onDelete: (ticketId: number) => void
  onStatusChange: (ticketId: number, status: TicketStatus) => void
  onPriorityChange: (ticketId: number, priority: TicketPriority) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `ticket-${ticket.id}` })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <TicketContextMenu
      ticket={ticket}
      onDelete={onDelete}
      onStatusChange={onStatusChange}
      onPriorityChange={onPriorityChange}
    >
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          isDragging && 'opacity-30',
        )}
      >
        <KanbanCard
          ticket={ticket}
          onClick={onClick}
          dragHandleProps={{ ...attributes, ...listeners }}
        />
      </div>
    </TicketContextMenu>
  )
}

function KanbanCard({
  ticket,
  onClick,
  isDragOverlay,
  dragHandleProps,
}: KanbanCardProps & { dragHandleProps?: Record<string, unknown> }) {
  const { t } = useTranslation('specs')
  const priorityInfo = ticket.priority ? PRIORITY_STYLES[ticket.priority] : null
  const isDraft = ticket.status === 'draft'
  const isOnReview = ticket.status === 'on_review'

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-md p-2.5 group',
        'border border-border/30 bg-card/80 backdrop-blur-sm',
        'transition-all duration-150',
        'hover:border-border/50 hover:bg-card',
        'hover:shadow-[0_2px_12px_rgba(0,0,0,0.15)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
        isDragOverlay && 'shadow-xl border-accent-primary/40 rotate-[2deg] scale-105',
        ticket.status === 'cancelled' && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-1.5">
        {/* Drag handle */}
        {dragHandleProps && (
          <div
            {...dragHandleProps}
            className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="w-3 h-3" />
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Title */}
          <p
            className={cn(
              'text-xs font-medium leading-snug line-clamp-2',
              ticket.status === 'done'
                ? 'text-foreground/50 line-through decoration-emerald-500/40 aurora-light:decoration-accent-success/50'
                : ticket.status === 'cancelled'
                  ? 'text-foreground/40 line-through decoration-muted-foreground/40'
                  : 'text-foreground/80',
            )}
          >
            {ticket.title}
          </p>

          {/* Bottom row: ID, priority, labels */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] font-mono text-foreground">
              #{ticket.id}
            </span>

            {isDraft ? (
              <span className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium border border-accent-secondary/60 text-accent-secondary bg-accent-secondary/10">
                {t('common:status.draft')}
              </span>
            ) : isOnReview ? (
              <span
                className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium border border-accent-warning/60 text-accent-warning bg-accent-warning/10"
                title={t('status.onReviewHint')}
                data-testid={`on-review-pill-grid-${ticket.id}`}
              >
                {t('common:status.onReview')}
              </span>
            ) : priorityInfo && ticket.priority && ticket.priority !== 'medium' && (
              <span
                className={cn(
                  'inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium border',
                  priorityInfo.className,
                )}
              >
                {t(`priority.${ticket.priority}`)}
              </span>
            )}

            {ticket.is_epic && (
              <span
                className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium border border-accent-highlight/60 text-accent-highlight bg-accent-highlight/10"
                data-testid={`epic-badge-grid-${ticket.id}`}
              >
                {t('badges.epic')}
              </span>
            )}
            {ticket.parent_epic_id != null && (
              <span
                className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium border border-accent-secondary/40 text-accent-secondary"
                data-testid={`epic-child-pill-grid-${ticket.id}`}
              >
                {t('badges.subSpec')}
              </span>
            )}
            {ticket.jira_key && (
              <span
                className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-mono border border-accent-info/50 text-accent-info"
                title={ticket.jira_key}
                data-testid={`jira-badge-grid-${ticket.id}`}
              >
                {ticket.jira_key}
              </span>
            )}

            {(ticket.labels ?? []).slice(0, 2).map((label) => (
              <span
                key={label}
                className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium bg-accent/60 text-foreground/70 truncate max-w-[70px]"
              >
                {label}
              </span>
            ))}
            {(ticket.labels?.length ?? 0) > 2 && (
              <span className="text-[9px] text-muted-foreground">
                +{ticket.labels!.length - 2}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

// ─── Droppable column ───────────────────────────────────────────────────────

interface KanbanColumnProps {
  config: ColumnConfig
  tickets: LocalTicket[]
  onTicketClick: (ticket: LocalTicket) => void
  onDelete: (ticketId: number) => void
  onStatusChange: (ticketId: number, status: TicketStatus) => void
  onPriorityChange: (ticketId: number, priority: TicketPriority) => void
}

function KanbanColumn({
  config,
  tickets,
  onTicketClick,
  onDelete,
  onStatusChange,
  onPriorityChange,
}: KanbanColumnProps) {
  const { t } = useTranslation('specs')
  const sortableIds = tickets.map((t) => `ticket-${t.id}`)

  return (
    <div className={cn('flex flex-col rounded-lg min-h-[120px]', config.columnBg)}>
      {/* Column header */}
      <div
        className={cn(
          'flex items-center justify-between px-3 py-2 border-b-2',
          config.headerClass,
        )}
      >
        <div className="flex items-center gap-1.5">
          <TicketStatusDot status={config.status} />
          <span className="text-[10px] font-semibold uppercase tracking-wider">
            {t(config.titleKey)}
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/60">
          {tickets.length}
        </span>
      </div>

      {/* Cards */}
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="flex-1 p-2 space-y-1.5 min-h-[80px]">
          {tickets.length === 0 ? (
            <div className="flex items-center justify-center h-full min-h-[60px]">
              <p className="text-[10px] text-muted-foreground/40 italic">
                {t(config.emptyKey)}
              </p>
            </div>
          ) : (
            tickets.map((ticket) => (
              <SortableKanbanCard
                key={ticket.id}
                ticket={ticket}
                onClick={() => onTicketClick(ticket)}
                onDelete={onDelete}
                onStatusChange={onStatusChange}
                onPriorityChange={onPriorityChange}
              />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

interface TicketGridViewProps {
  tickets: LocalTicket[]
  isLoading: boolean
  error?: string | null
  onTicketClick: (ticket: LocalTicket) => void
  onDelete: (ticketId: number) => void
  onStatusChange: (ticketId: number, status: TicketStatus) => void
  onPriorityChange: (ticketId: number, priority: TicketPriority) => void
  onCreateClick?: () => void
}

export function TicketGridView({
  tickets,
  isLoading,
  error,
  onTicketClick,
  onDelete,
  onStatusChange,
  onPriorityChange,
  onCreateClick,
}: TicketGridViewProps) {
  const { t } = useTranslation('specs')
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  // Group tickets by status column (exclude cancelled from kanban columns)
  const columnTickets = useMemo(() => {
    const grouped: Record<TicketStatus, LocalTicket[]> = {
      draft: [],
      todo: [],
      in_progress: [],
      on_review: [],
      done: [],
      cancelled: [],
    }
    for (const ticket of tickets) {
      grouped[ticket.status].push(ticket)
    }
    // Sort within columns by priority. Drafts (priority=null) sort last.
    const priorityOrder: Record<TicketPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 }
    for (const status of Object.keys(grouped) as TicketStatus[]) {
      grouped[status].sort((a, b) => {
        const ap = a.priority === null ? Number.MAX_SAFE_INTEGER : priorityOrder[a.priority]
        const bp = b.priority === null ? Number.MAX_SAFE_INTEGER : priorityOrder[b.priority]
        return ap - bp
      })
    }
    // Drafts visually live in the Backlog (Todo) column per spec. On-review
    // specs live there too (work done, awaiting human PR review) — no extra
    // column; the On Review pill differentiates them.
    grouped.todo = [...grouped.draft, ...grouped.on_review, ...grouped.todo]
    grouped.draft = []
    grouped.on_review = []
    return grouped
  }, [tickets])

  const activeTicket = useMemo(() => {
    if (!activeId) return null
    const ticketId = Number(activeId.replace('ticket-', ''))
    return tickets.find((t) => t.id === ticketId) ?? null
  }, [activeId, tickets])

  // Find which column a sortable ID belongs to. Drafts and on-review specs
  // render inside the Todo column, so they resolve to 'todo' — otherwise a
  // drop next to one of them would PATCH the dragged ticket into a
  // pipeline-owned status.
  const findColumnForId = useCallback(
    (id: string): TicketStatus | null => {
      const ticketId = Number(String(id).replace('ticket-', ''))
      const ticket = tickets.find((t) => t.id === ticketId)
      if (!ticket) return null
      if (ticket.status === 'draft' || ticket.status === 'on_review') return 'todo'
      return ticket.status
    },
    [tickets],
  )

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const activeTicketId = Number(String(active.id).replace('ticket-', ''))
    const overStr = String(over.id)

    // Determine target column: check if dropped over another ticket card
    let targetStatus: TicketStatus | null = null
    if (overStr.startsWith('ticket-')) {
      targetStatus = findColumnForId(overStr)
    }

    if (!targetStatus) return

    const sourceStatus = findColumnForId(String(active.id))
    if (sourceStatus && sourceStatus !== targetStatus) {
      onStatusChange(activeTicketId, targetStatus)
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Status change is handled in handleDragEnd for simplicity.
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg bg-card/30 min-h-[150px] p-3 space-y-2">
            <div className="h-6 bg-muted/30 rounded-md animate-pulse" />
            <div className="h-16 bg-muted/20 rounded-md animate-pulse" />
            <div className="h-16 bg-muted/20 rounded-md animate-pulse" />
          </div>
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
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-3 gap-3">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            config={col}
            tickets={columnTickets[col.status]}
            onTicketClick={onTicketClick}
            onDelete={onDelete}
            onStatusChange={onStatusChange}
            onPriorityChange={onPriorityChange}
          />
        ))}
      </div>

      {/* Cancelled tickets row (if any) */}
      {columnTickets.cancelled.length > 0 && (
        <div className="mt-3 rounded-lg bg-red-950/10 aurora-light:bg-destructive/8 p-2">
          <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1 mb-1.5">
            {t('gridView.cancelledSection', { count: columnTickets.cancelled.length })}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {columnTickets.cancelled.map((ticket) => (
              <TicketContextMenu
                key={ticket.id}
                ticket={ticket}
                onDelete={onDelete}
                onStatusChange={onStatusChange}
                onPriorityChange={onPriorityChange}
              >
                <button
                  type="button"
                  onClick={() => onTicketClick(ticket)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border/20 bg-card/30 text-[10px] text-foreground/40 line-through hover:bg-card/50 transition-colors"
                >
                  <TicketStatusDot status="cancelled" />
                  #{ticket.id} {ticket.title}
                </button>
              </TicketContextMenu>
            ))}
          </div>
        </div>
      )}

      {/* Drag overlay */}
      <DragOverlay>
        {activeTicket ? (
          <KanbanCard
            ticket={activeTicket}
            onClick={() => {}}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
