import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'
import { Ticket, Search, AlertTriangle, Plus } from 'lucide-react'
import { TicketContextMenu } from './TicketContextMenu'
import { TicketStatusDot, TicketStatusRow } from './TicketStatusIndicator'
import { getDateFnsLocale } from '../lib/i18n'
import type { LocalTicket, TicketStatus, TicketPriority } from '../types'

const PRIORITY_STYLES: Record<TicketPriority, { className: string }> = {
  critical: { className: 'bg-destructive/15 text-destructive border-destructive/30' },
  high: { className: 'bg-accent-warning/15 text-accent-warning border-accent-warning/30' },
  medium: { className: '' },
  low: { className: 'bg-muted text-muted-foreground border-border' },
}

const ALL_STATUSES: TicketStatus[] = ['draft', 'todo', 'in_progress', 'on_review', 'done', 'cancelled']

/** i18n keys (specs namespace) for the lowercase status labels of this view. */
const STATUS_LABEL_KEY: Record<TicketStatus, string> = {
  draft: 'listView.status.draft',
  todo: 'listView.status.todo',
  in_progress: 'listView.status.inProgress',
  on_review: 'listView.status.onReview',
  done: 'listView.status.done',
  cancelled: 'listView.status.cancelled',
}

type SortField = 'status' | 'priority' | 'updated_at'
type SortDir = 'asc' | 'desc'

const STATUS_ORDER: Record<TicketStatus, number> = { draft: -1, todo: 0, in_progress: 1, on_review: 2, done: 3, cancelled: 4 }
const PRIORITY_ORDER: Record<TicketPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function formatRelTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: getDateFnsLocale() })
  } catch {
    return dateStr
  }
}

const PAGE_SIZE = 20

interface TicketListViewProps {
  tickets: LocalTicket[]
  isLoading: boolean
  error?: string | null
  onTicketClick: (ticket: LocalTicket) => void
  onDelete: (ticketId: number) => void
  onStatusChange: (ticketId: number, status: TicketStatus) => void
  onPriorityChange: (ticketId: number, priority: TicketPriority) => void
  onCreateClick?: () => void
}

export function TicketListView({
  tickets,
  isLoading,
  error,
  onTicketClick,
  onDelete,
  onStatusChange,
  onPriorityChange,
  onCreateClick,
}: TicketListViewProps) {
  const { t } = useTranslation('specs')
  const [statusFilter, setStatusFilter] = useState<TicketStatus | null>(null)
  const [labelFilter, setLabelFilter] = useState<string | null>(null)
  // Separate input value (immediate) from filter value (debounced 300ms)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<SortField>('status')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE)

  const rowsRef = useRef<HTMLDivElement>(null)

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const allLabels = useMemo(() => {
    const set = new Set<string>()
    for (const t of tickets) {
      for (const l of t.labels) set.add(l)
    }
    return Array.from(set).sort()
  }, [tickets])

  const filteredAndSorted = useMemo(() => {
    let result = tickets

    if (statusFilter) {
      result = result.filter((t) => t.status === statusFilter)
    }
    if (labelFilter) {
      result = result.filter((t) => t.labels.includes(labelFilter))
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      )
    }

    const sorted = [...result]
    sorted.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'status':
          cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
          break
        case 'priority': {
          const ap = a.priority === null ? Number.MAX_SAFE_INTEGER : PRIORITY_ORDER[a.priority]
          const bp = b.priority === null ? Number.MAX_SAFE_INTEGER : PRIORITY_ORDER[b.priority]
          cmp = ap - bp
          break
        }
        case 'updated_at':
          cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return sorted
  }, [tickets, statusFilter, labelFilter, searchQuery, sortField, sortDir])

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function sortIndicator(field: SortField) {
    if (sortField !== field) return ''
    return sortDir === 'asc' ? ' ↑' : ' ↓'
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = Array.from(
      rowsRef.current?.querySelectorAll('[data-ticket-row]') ?? []
    ) as HTMLElement[]
    if (rows.length === 0) return
    const idx = rows.findIndex((el) => el === document.activeElement)
    e.preventDefault()
    if (e.key === 'ArrowDown') {
      rows[Math.min(idx + 1, rows.length - 1)]?.focus()
    } else {
      rows[Math.max(idx - 1, 0)]?.focus()
    }
  }

  function clearFilters() {
    setStatusFilter(null)
    setLabelFilter(null)
    setSearchInput('')
    setSearchQuery('')
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 bg-muted/30 rounded-md animate-pulse" />
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
    <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-2">
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              statusFilter === null
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            {t('listView.filterAll', { count: tickets.length })}
          </button>
          {ALL_STATUSES.map((s) => {
            const count = tickets.filter((t) => t.status === s).length
            if (count === 0) return null
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {t('listView.statusWithCount', { status: t(STATUS_LABEL_KEY[s]), count })}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          {allLabels.length > 0 && (
            <select
              value={labelFilter ?? ''}
              onChange={(e) => setLabelFilter(e.target.value || null)}
              className="h-6 rounded border border-border bg-input px-1.5 text-[10px] text-foreground"
            >
              <option value="">{t('listView.allLabels')}</option>
              {allLabels.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('listView.searchPlaceholder')}
              className="h-6 w-32 rounded border border-border bg-input pl-5 pr-1.5 text-[10px] text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <button type="button" onClick={() => toggleSort('status')} className="w-20 text-left hover:text-foreground transition-colors">
          {t('listView.columns.status')}{sortIndicator('status')}
        </button>
        <span className="flex-1 min-w-0">{t('listView.columns.title')}</span>
        <button type="button" onClick={() => toggleSort('priority')} className="w-14 text-right hover:text-foreground transition-colors">
          {t('listView.columns.priority')}{sortIndicator('priority')}
        </button>
        <span className="w-24 text-right hidden sm:block">{t('listView.columns.labels')}</span>
        <button type="button" onClick={() => toggleSort('updated_at')} className="w-20 text-right hover:text-foreground transition-colors">
          {t('listView.columns.updated')}{sortIndicator('updated_at')}
        </button>
      </div>

      {/* Filtered empty state */}
      {filteredAndSorted.length === 0 ? (
        <div className="py-6 text-center space-y-1.5">
          <p className="text-xs text-muted-foreground">{t('listView.noMatch')}</p>
          <button
            type="button"
            onClick={clearFilters}
            className="text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors underline underline-offset-2"
          >
            {t('listView.clearFilters')}
          </button>
        </div>
      ) : (
        <>
          {/* Ticket rows */}
          <div
            ref={rowsRef}
            className="space-y-0.5"
            onKeyDown={handleListKeyDown}
          >
            {filteredAndSorted.slice(0, displayLimit).map((ticket) => {
              const priorityInfo = ticket.priority ? PRIORITY_STYLES[ticket.priority] : null
              const isDone = ticket.status === 'done'
              const isCancelled = ticket.status === 'cancelled'
              const isDraft = ticket.status === 'draft'
              const isOnReview = ticket.status === 'on_review'

              return (
                <TicketContextMenu
                  key={ticket.id}
                  ticket={ticket}
                  onDelete={onDelete}
                  onStatusChange={onStatusChange}
                  onPriorityChange={onPriorityChange}
                >
                  <TicketStatusRow
                    status={ticket.status}
                    role="button"
                    tabIndex={0}
                    data-ticket-row=""
                    className="flex items-center gap-3 pr-3 py-2 rounded-md transition-colors cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => onTicketClick(ticket)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onTicketClick(ticket) }}
                  >
                    {/* Status indicator */}
                    <div className="w-20 flex items-center gap-1.5 shrink-0">
                      <TicketStatusDot status={ticket.status} />
                      <span className={`text-[10px] ${isCancelled ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}>
                        {t(STATUS_LABEL_KEY[ticket.status])}
                      </span>
                    </div>

                    {/* Title */}
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                      <span className={`text-xs truncate ${
                        isCancelled
                          ? 'text-foreground/40 line-through decoration-muted-foreground/40'
                          : isDone
                            ? 'text-foreground/50'
                            : 'text-foreground/80'
                      }`}>
                        {ticket.title}
                      </span>
                      {ticket.is_epic && (
                        <span
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border border-accent-highlight/60 text-accent-highlight bg-accent-highlight/10 shrink-0"
                          data-testid={`epic-badge-list-${ticket.id}`}
                        >
                          {t('badges.epic')}
                        </span>
                      )}
                      {ticket.parent_epic_id != null && (
                        <span
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border border-accent-secondary/40 text-accent-secondary shrink-0"
                          data-testid={`epic-child-pill-list-${ticket.id}`}
                        >
                          {t('badges.subSpec')}
                        </span>
                      )}
                      {ticket.jira_key && (
                        <span
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-mono border border-accent-info/50 text-accent-info shrink-0"
                          title={ticket.jira_key}
                          data-testid={`jira-badge-list-${ticket.id}`}
                        >
                          {ticket.jira_key}
                        </span>
                      )}
                    </div>

                    {/* Priority / Draft / On-review pill */}
                    <div className="w-14 text-right shrink-0">
                      {isDraft ? (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border border-accent-secondary/60 text-accent-secondary bg-accent-secondary/10">
                          {t('common:status.draft')}
                        </span>
                      ) : isOnReview ? (
                        <span
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border border-accent-warning/60 text-accent-warning bg-accent-warning/10"
                          title={t('status.onReviewHint')}
                          data-testid={`on-review-pill-list-${ticket.id}`}
                        >
                          {t('common:status.onReview')}
                        </span>
                      ) : priorityInfo && ticket.priority && ticket.priority !== 'medium' && (
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border ${priorityInfo.className}`}>
                          {t(`priority.${ticket.priority}`)}
                        </span>
                      )}
                    </div>

                    {/* Labels */}
                    <div className="w-24 text-right hidden sm:flex justify-end gap-0.5 overflow-hidden shrink-0">
                      {(ticket.labels ?? []).slice(0, 2).map((label) => (
                        <span
                          key={label}
                          className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium bg-accent/60 text-foreground/70 truncate max-w-[80px]"
                        >
                          {label}
                        </span>
                      ))}
                      {(ticket.labels?.length ?? 0) > 2 && (
                        <span className="text-[9px] text-muted-foreground">+{ticket.labels!.length - 2}</span>
                      )}
                    </div>

                    {/* Updated */}
                    <span className="w-20 text-right text-[10px] text-muted-foreground shrink-0">
                      {formatRelTime(ticket.updated_at)}
                    </span>
                  </TicketStatusRow>
                </TicketContextMenu>
              )
            })}
          </div>

          {/* Load more */}
          {filteredAndSorted.length > displayLimit && (
            <div className="pt-1 text-center">
              <button
                type="button"
                onClick={() => setDisplayLimit((prev) => prev + PAGE_SIZE)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded hover:bg-accent/50"
              >
                {t('listView.loadMore', { count: filteredAndSorted.length - displayLimit })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
