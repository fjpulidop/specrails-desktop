import { useTranslation } from 'react-i18next'
import { Split, ArrowUp } from 'lucide-react'
import type { LocalTicket, TicketPriority } from '../../../../types'

const PRIORITY_DOT: Record<TicketPriority, string> = {
  critical: 'bg-red-400',
  high: 'bg-orange-400',
  medium: 'bg-yellow-400',
  low: 'bg-slate-400',
}

function priorityDotClass(p: TicketPriority | null | undefined): string {
  if (!p) return 'bg-muted'
  return PRIORITY_DOT[p]
}

function sortChildren(children: LocalTicket[]): LocalTicket[] {
  return [...children].sort((a, b) => {
    const ao = a.execution_order ?? Number.POSITIVE_INFINITY
    const bo = b.execution_order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao - bo
    return a.id - b.id
  })
}

export interface EpicFamilySidebarProps {
  /** The ticket whose modal is currently open. */
  ticket: LocalTicket
  /** All tickets in the active project (used to resolve siblings + parent). */
  allTickets: LocalTicket[]
  /** Opens another ticket's modal. */
  onOpenTicket: (ticketId: number) => void
}

/**
 * Right-sidebar family list for SMASH-related tickets.
 *
 * - For an Epic: lists its Sub-Specs, sorted by `execution_order` ascending.
 * - For a Sub-Spec: lists the Epic in first row (always) followed by sibling
 *   Sub-Specs in execution order. The currently-open ticket is highlighted
 *   and non-clickable.
 *
 * Returns `null` when the ticket is neither an Epic nor a Sub-Spec — the
 * caller can render unconditionally without an empty wrapper.
 */
export function EpicFamilySidebar({ ticket, allTickets, onOpenTicket }: EpicFamilySidebarProps) {
  const { t } = useTranslation('activity')
  const isEpic = ticket.is_epic === true
  const isChild = ticket.parent_epic_id != null

  if (!isEpic && !isChild) return null

  // Epic view: just list children, no parent row.
  if (isEpic) {
    const children = sortChildren(allTickets.filter((t) => t.parent_epic_id === ticket.id))
    return (
      <FamilyList
        header={t('family.subSpecsHeader', { count: children.length })}
        rows={children}
        currentId={ticket.id}
        onOpenTicket={onOpenTicket}
        emptyMessage={t('family.emptySubSpecs')}
      />
    )
  }

  // Child view: parent in first row + siblings.
  const epic = allTickets.find((t) => t.id === ticket.parent_epic_id) ?? null
  const siblings = sortChildren(
    allTickets.filter((t) => t.parent_epic_id === ticket.parent_epic_id),
  )
  const rows: LocalTicket[] = epic ? [epic, ...siblings] : siblings
  return (
    <FamilyList
      header={t('family.familyHeader', { count: siblings.length })}
      rows={rows}
      currentId={ticket.id}
      onOpenTicket={onOpenTicket}
      emptyMessage={t('family.noSiblings')}
    />
  )
}

interface FamilyListProps {
  header: string
  rows: LocalTicket[]
  currentId: number
  onOpenTicket: (id: number) => void
  emptyMessage: string
}

function FamilyList({ header, rows, currentId, onOpenTicket, emptyMessage }: FamilyListProps) {
  const { t } = useTranslation('activity')
  return (
    <div data-testid="epic-family-sidebar">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Split className="w-3 h-3 text-accent-highlight" aria-hidden />
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {header}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[10px] text-foreground/50 italic">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => {
            const isCurrent = row.id === currentId
            const isEpicRow = row.is_epic === true
            const ariaLabel = isEpicRow
              ? t('family.openParentEpic', { title: row.title })
              : t('family.openSubSpec', { title: row.title })
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => { if (!isCurrent) onOpenTicket(row.id) }}
                  disabled={isCurrent}
                  aria-label={ariaLabel}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={[
                    'w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors',
                    isCurrent
                      ? 'bg-accent-highlight/15 cursor-default'
                      : 'hover:bg-muted/30 cursor-pointer',
                  ].join(' ')}
                  data-testid={`epic-family-row-${row.id}`}
                >
                  {isEpicRow ? (
                    <ArrowUp className="w-3 h-3 text-accent-highlight flex-shrink-0" aria-hidden />
                  ) : (
                    <span className="text-[9px] tabular-nums text-foreground/40 w-3 text-center flex-shrink-0">
                      {row.execution_order ?? '–'}
                    </span>
                  )}
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDotClass(row.priority)}`}
                    aria-hidden
                  />
                  <span
                    className={`text-[11px] truncate ${
                      isCurrent ? 'text-foreground font-medium' : 'text-foreground/80'
                    }`}
                    title={row.title}
                  >
                    {row.title}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
