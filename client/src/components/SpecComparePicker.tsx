import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Ticket as TicketIcon } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { TicketStatusDot } from './TicketStatusIndicator'
import { getDateFnsLocale } from '../lib/i18n'
import type { LocalTicket, TicketPriority } from '../types'

interface SpecComparePickerProps {
  tickets: LocalTicket[]
  /** Ticket ids already shown in either panel, excluded from the picker. */
  excludeIds: number[]
  /** Click-card callback — replaces the picker with a second modal on its side. */
  onSelect: (ticketId: number) => void
}

const PRIORITY_STYLES: Record<TicketPriority, string> = {
  critical: 'bg-red-500/15 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive border-red-500/30 aurora-light:border-destructive/30',
  high: 'bg-orange-500/15 aurora-light:bg-accent-warning/10 text-orange-400 aurora-light:text-accent-warning border-orange-500/30 aurora-light:border-accent-warning/30',
  medium: '',
  low: 'bg-gray-500/15 aurora-light:bg-muted text-gray-400 aurora-light:text-muted-foreground border-gray-500/30 aurora-light:border-border',
}

function formatRelTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: getDateFnsLocale() })
  } catch {
    return dateStr
  }
}

/**
 * Picker rendered on the non-origin side of `SplitViewShell`.
 *
 * NOTE (deferred from tasks.md 6.x): the design calls for the picker to mirror
 * the dashboard's *currently active* view component (list / grid / postit).
 * v1 ships with a single dedicated layout — same card aesthetic as
 * `TicketListView`/`TicketPostItView` but a focused picker UX (no DnD, no
 * status changes, no delete). Follow-up change will lift `viewMode` to a
 * context and add a `mode='picker'` prop to all four dashboard views.
 */
export function SpecComparePicker({ tickets, excludeIds, onSelect }: SpecComparePickerProps) {
  const { t } = useTranslation('tickets')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const exclude = new Set(excludeIds)
    // Any non-cancelled spec is comparable. The picker previously showed only
    // `todo` specs, which hid every Jira-backed spec whose board column maps to
    // in_progress/done/draft — so on a Jira-connected project the picker came
    // up empty. Cancelled specs are intent-closed, so they stay excluded.
    const comparable = tickets.filter((t) => t.status !== 'cancelled' && !exclude.has(t.id))
    if (!search.trim()) return comparable
    const q = search.toLowerCase()
    return comparable.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    )
  }, [tickets, excludeIds, search])

  return (
    <div
      data-testid="spec-compare-picker"
      className="h-full flex flex-col rounded-xl bg-card border border-border/40 shadow-2xl shadow-black/50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
        <TicketIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">{t('comparePicker.title')}</span>
        <span className="text-[10px] text-muted-foreground">{t('comparePicker.count', { n: filtered.length })}</span>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-border/20">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('comparePicker.searchPlaceholder')}
            className="w-full h-7 rounded border border-border bg-input pl-7 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground outline-none focus:border-accent-primary/60"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto" data-testid="spec-compare-picker-list">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 gap-2">
            <TicketIcon className="w-6 h-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {search.trim() ? t('comparePicker.noMatches') : t('comparePicker.empty')}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/10">
            {filtered.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  data-testid={`spec-compare-card-${tk.id}`}
                  onClick={() => onSelect(tk.id)}
                  className="w-full text-left px-4 py-2.5 hover:bg-accent/30 transition-colors flex items-start gap-2 group"
                >
                  <TicketStatusDot status={tk.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-muted-foreground">#{tk.id}</span>
                      {tk.priority && PRIORITY_STYLES[tk.priority] && (
                        <span
                          className={`inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium border ${PRIORITY_STYLES[tk.priority]}`}
                        >
                          {t(`priority.${tk.priority}`)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-foreground truncate group-hover:text-accent-primary transition-colors">
                      {tk.title || t('untitled')}
                    </p>
                    {tk.description && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground line-clamp-1">
                        {tk.description.slice(0, 120)}
                      </p>
                    )}
                    {tk.labels && tk.labels.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {tk.labels.slice(0, 3).map((label) => (
                          <span
                            key={label}
                            className="inline-flex items-center rounded px-1 py-0.5 text-[9px] bg-accent/40 text-foreground/60"
                          >
                            {label}
                          </span>
                        ))}
                        {tk.labels.length > 3 && (
                          <span className="text-[9px] text-muted-foreground">+{tk.labels.length - 3}</span>
                        )}
                      </div>
                    )}
                    <p className="mt-1 text-[9px] text-muted-foreground">
                      {t('meta.updatedAgo', { time: formatRelTime(tk.updated_at) })}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
