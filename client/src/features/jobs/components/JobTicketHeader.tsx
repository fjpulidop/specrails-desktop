import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'

// Clicking a (non-deleted) ticket chip opens the existing TicketDetailModal
// via TicketDetailModalContext, mounted at the App root. No new route.

export interface TicketRef {
  id: number
  title: string | null
}

interface JobTicketHeaderProps {
  tickets: TicketRef[]
  onTicketClick: (id: number) => void
}

const COMPACT_THRESHOLD = 4

export function JobTicketHeader({ tickets, onTicketClick }: JobTicketHeaderProps) {
  const { t } = useTranslation('jobs')
  const [expanded, setExpanded] = useState(false)

  if (tickets.length === 0) return null

  const isCompact = tickets.length >= COMPACT_THRESHOLD && !expanded
  const visible = isCompact ? tickets.slice(0, 1) : tickets
  const hiddenCount = tickets.length - visible.length

  return (
    <div className="rounded-xl border border-border/40 bg-card/40 px-4 py-3 space-y-1.5">
      {visible.map((t) => (
        <TicketRow key={t.id} ticket={t} onClick={() => onTicketClick(t.id)} />
      ))}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('ticketHeader.showMore', { count: hiddenCount })}
          <ChevronDown className="w-3 h-3" />
        </button>
      )}

      {expanded && tickets.length >= COMPACT_THRESHOLD && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('ticketHeader.showLess')}
          <ChevronUp className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

function TicketRow({ ticket, onClick }: { ticket: TicketRef; onClick: () => void }) {
  const { t } = useTranslation('jobs')
  const isDeleted = ticket.title == null
  const chipBase =
    'inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-mono tabular-nums shrink-0'

  if (isDeleted) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={cn(chipBase, 'text-muted-foreground bg-muted/20 select-none')}
          title={t('ticketHeader.deletedTooltip')}
        >
          {t('ticketHeader.deletedTicket', { id: ticket.id })}
        </span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 min-w-0 w-full text-left group"
      title={ticket.title ?? undefined}
    >
      <span
        className={cn(
          chipBase,
          'text-accent-primary bg-accent-primary/10 group-hover:bg-accent-primary/20 transition-colors',
        )}
      >
        #{ticket.id}
      </span>
      <span className="text-lg font-semibold text-foreground truncate group-hover:text-accent-primary transition-colors">
        {ticket.title}
      </span>
    </button>
  )
}
