import { useTranslation } from 'react-i18next'
import { ChevronRight, Split } from 'lucide-react'
import type { LocalTicket, TicketPriority } from '../../../../types'

const PRIORITY_DOT: Record<TicketPriority, string> = {
  critical: 'bg-red-400',
  high: 'bg-orange-400',
  medium: 'bg-yellow-400',
  low: 'bg-slate-400',
}

export interface EpicChildrenSectionProps {
  epicId: number
  /** Full ticket list (caller filters to current project). */
  allTickets: LocalTicket[]
  /** Click a child row to open its detail modal. */
  onOpenChild: (ticketId: number) => void
}

/**
 * Renders the `Hijos (N)` section inside an épica's TicketDetailModal.
 * Sorted by `execution_order` ascending. Children with null order fall to
 * the end.
 */
export function EpicChildrenSection({ epicId, allTickets, onOpenChild }: EpicChildrenSectionProps) {
  const { t } = useTranslation('activity')
  const children = allTickets
    .filter((t) => t.parent_epic_id === epicId)
    .sort((a, b) => {
      const ao = a.execution_order ?? Number.POSITIVE_INFINITY
      const bo = b.execution_order ?? Number.POSITIVE_INFINITY
      if (ao !== bo) return ao - bo
      return a.id - b.id
    })

  if (children.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border/40 bg-muted/10 px-3 py-2 text-xs text-foreground/60"
        data-testid="epic-children-empty"
      >
        {t('epicChildren.empty')}
      </div>
    )
  }

  return (
    <div className="rounded-md border border-accent-highlight/40 bg-accent-highlight/5 px-3 py-2" data-testid="epic-children-section">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground mb-2">
        <Split className="w-3.5 h-3.5 text-accent-highlight" aria-hidden />
        <span>{t('epicChildren.header', { count: children.length })}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {children.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              onClick={() => onOpenChild(child.id)}
              className="w-full flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/30 transition-colors text-left"
              data-testid={`epic-child-row-${child.id}`}
            >
              <span className="text-[10px] text-foreground/50 tabular-nums w-6 flex-shrink-0">
                {child.execution_order ?? '–'}
              </span>
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  child.priority ? PRIORITY_DOT[child.priority] : 'bg-muted'
                }`}
                aria-hidden
              />
              <span className="flex-1 text-xs text-foreground truncate">{child.title}</span>
              <ChevronRight className="w-3.5 h-3.5 text-foreground/40 flex-shrink-0" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Child-side breadcrumb shown in the child ticket's modal, pointing back to
 * the épica.
 */
export interface EpicBreadcrumbProps {
  epic: LocalTicket
  childExecutionOrder: number | null
  totalChildren: number
  onOpenEpic: () => void
}

export function EpicBreadcrumb({ epic, childExecutionOrder, totalChildren, onOpenEpic }: EpicBreadcrumbProps) {
  const { t } = useTranslation('activity')
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-accent-secondary/30 bg-accent-secondary/10 px-3 py-1.5 text-xs"
      data-testid="epic-breadcrumb"
    >
      <button
        type="button"
        onClick={onOpenEpic}
        className="text-accent-secondary hover:underline font-medium"
      >
        ← {epic.title}
      </button>
      {childExecutionOrder != null && totalChildren > 0 && (
        <span className="text-foreground/60">
          {t('epicChildren.step', { order: childExecutionOrder, total: totalChildren })}
        </span>
      )}
    </div>
  )
}
