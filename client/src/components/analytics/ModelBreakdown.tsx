import { useTranslation } from 'react-i18next'
import type { SpendingResponse } from '../../types/spending'

interface Props {
  data: SpendingResponse | null
  loading: boolean
  /**
   * Selecting a model also reports the provider that produced it so the
   * dashboard can scope the filter to a single engine (a codex `gpt-5.5` and a
   * claude model of the same id are distinct (provider, model) keys). The
   * second arg is optional/back-compat — legacy callers ignore it.
   */
  onSelectModel: (model: string, provider?: string) => void
  activeModel: string | undefined
}

export function ModelBreakdown({ data, loading, onSelectModel, activeModel }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <div className="h-[220px] rounded-xl border border-border/40 bg-card/40 animate-pulse" />
  }
  if (!data) return null

  const total = data.byModel.reduce((acc, m) => acc + m.costUsd, 0)
  const top = data.byModel.slice(0, 5)

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{t('models.title')}</h2>
      {top.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground/70">{t('models.empty')}</div>
      ) : (
        <ul className="space-y-1.5">
          {top.map((m) => {
            const pct = total > 0 ? (m.costUsd / total) * 100 : 0
            const isActive = activeModel === m.model
            // A model is "estimated" when any portion of its cost came from the
            // server-side pricing-table fallback (codex/gemini). Prefix `~` so
            // the figure is not mistaken for an authoritative claude-native cost.
            const isEstimated = (m.estimatedCostUsd ?? 0) > 0
            return (
              <li key={`${m.provider ?? 'claude'}:${m.model}`}>
                <button
                  type="button"
                  onClick={() => onSelectModel(m.model, m.provider)}
                  className={`w-full text-left group rounded-md px-2 py-1.5 transition-colors ${
                    isActive ? 'bg-accent-highlight/10 ring-1 ring-accent-highlight/30' : 'hover:bg-accent/30'
                  }`}
                >
                  <div className="flex items-center justify-between text-[12px] mb-1 tabular-nums">
                    <span className="truncate font-medium">{m.model}</span>
                    <span
                      className="text-muted-foreground"
                      title={isEstimated ? t('models.estimatedTooltip') : undefined}
                    >
                      {isEstimated ? '~' : ''}${m.costUsd.toFixed(2)} · {m.count}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-background-deep overflow-hidden">
                    <div
                      className={`h-full ${isActive ? 'bg-accent-highlight' : 'bg-foreground/40 group-hover:bg-foreground/60'} transition-colors`}
                      style={{ width: `${pct}%` }}
                    />
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
