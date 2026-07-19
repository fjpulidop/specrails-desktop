import { useTranslation } from 'react-i18next'
import type { SpendingResponse } from '../../types/spending'
import { SURFACE_LABEL } from '../../types/spending'

interface Props {
  data: SpendingResponse | null
  loading: boolean
  onSelectTicket: (ticketId: number | null) => void
}

export function TopTicketsCrossSurface({ data, loading, onSelectTicket }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <div className="h-40 rounded-xl border border-border/40 bg-card/40 animate-pulse" />
  }
  if (!data) return null
  const list = data.topTickets

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{t('topTickets.title')}</h2>
      {list.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground/70">{t('topTickets.empty')}</div>
      ) : (
        <ul className="divide-y divide-border/30">
          {list.map((tk, i) => {
            const breakdown = (Object.entries(tk.bySurface) as Array<[string, { count: number; costUsd: number; unpricedCount?: number }]>)
              .filter(([, v]) => v.count > 0)
              .map(([s, v]) => t('topTickets.breakdownItem', { n: v.count, label: SURFACE_LABEL[s as keyof typeof SURFACE_LABEL].toLowerCase() }))
              .join(' + ')
            const isUnattributed = tk.isUnattributed
            const label = isUnattributed
              ? t('topTickets.unattributed')
              : tk.ticketTitle
                ? `#${tk.ticketId} ${tk.ticketTitle}`
                : t('topTickets.deletedTicket', { id: tk.ticketId })
            const dim = !tk.ticketTitle && !isUnattributed ? 'opacity-50' : ''
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
                    <div className="text-sm truncate">{label}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{breakdown || '—'}</div>
                  </div>
                  <div className="text-right tabular-nums">
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
                        : `$${tk.totalCostUsd.toFixed(2)}`}
                    </div>
                    {costPartiallyUnavailable && (
                      <div className="text-[10px] text-muted-foreground italic">
                        {t('topTickets.costPartiallyUnavailable', { count: unpricedCount })}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground">{t('runs', { count: tk.totalRuns })}</div>
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
