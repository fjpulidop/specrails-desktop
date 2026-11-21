import { useTranslation } from 'react-i18next'
import type { SpendingResponse } from '../types/spending'
import { formatUsd } from '../lib/format'
import { Skeleton } from '../../../components/ui/skeleton'

interface Props {
  data: SpendingResponse | null
  loading: boolean
  onSelectTicket: (ticketId: number | null) => void
}

export function TopTicketsCrossSurface({ data, loading, onSelectTicket }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <Skeleton className="h-40" />
  }
  if (!data) return null
  const list = data.topTickets

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <h2 className="text-title mb-3">{t('topTickets.title')}</h2>
      {list.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">{t('topTickets.empty')}</div>
      ) : (
        <ul className="divide-y divide-border/30">
          {list.map((tk, i) => {
            const isUnattributed = tk.isUnattributed
            const label = isUnattributed
              ? t('topTickets.unattributed')
              : tk.ticketTitle
                ? `#${tk.ticketId} ${tk.ticketTitle}`
                : t('topTickets.deletedTicket', { id: tk.ticketId })
            const dim = !tk.ticketTitle && !isUnattributed ? 'text-muted-foreground' : ''
            const unpricedCount = tk.unpricedCount ?? 0
            const costUnavailable = tk.totalRuns > 0 && unpricedCount === tk.totalRuns
            const costPartiallyUnavailable = unpricedCount > 0 && !costUnavailable
            return (
              <li key={`${tk.ticketId ?? 'u'}-${i}`}>
                <button
                  type="button"
                  onClick={() => onSelectTicket(tk.ticketId)}
                  className={`w-full text-left flex items-center justify-between gap-3 py-2 px-1 hover:bg-accent/30 rounded transition-colors ${dim}`}
                  disabled={isUnattributed}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-body truncate">{label}</div>
                  </div>
                  <div className="text-right num">
                    <div
                      className="text-sm font-medium"
                      title={
                        costUnavailable
                          ? t('topTickets.costUnavailableTooltip')
                          : costPartiallyUnavailable
                            ? t('topTickets.costPartiallyUnavailableTooltip')
                            : undefined
                      }
                    >
                      {costUnavailable
                        ? t('topTickets.costUnavailable')
                        : formatUsd(tk.totalCostUsd)}
                      {costPartiallyUnavailable && (
                        <span className="sr-only"> ({t('topTickets.costPartiallyUnavailable', { count: unpricedCount })})</span>
                      )}
                      {costPartiallyUnavailable && <span aria-hidden className="ml-1 inline-block size-1.5 rounded-full bg-accent-warning align-middle" data-testid="top-ticket-partial" />}
                    </div>
                    <div className="text-caption text-muted-foreground" data-testid="top-ticket-runs">{t('runs', { count: tk.totalRuns })}</div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
