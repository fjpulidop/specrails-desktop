import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { AnalyticsPeriod } from '../../../types'

interface PeriodSelectorProps {
  period: AnalyticsPeriod
  from: string
  to: string
  onChange: (period: AnalyticsPeriod, from?: string, to?: string) => void
}

const PRESETS: { value: AnalyticsPeriod; labelKey: string }[] = [
  { value: '7d', labelKey: 'periods.d7' },
  { value: '30d', labelKey: 'periods.d30' },
  { value: '90d', labelKey: 'periods.d90' },
  { value: 'all', labelKey: 'periods.all' },
  { value: 'custom', labelKey: 'periods.custom' },
]

export function PeriodSelector({ period, from, to, onChange }: PeriodSelectorProps) {
  const { t } = useTranslation('analytics')
  function handlePreset(value: AnalyticsPeriod) {
    if (value === 'custom') {
      // Switch to custom without triggering fetch yet — wait for both dates
      onChange('custom', from, to)
    } else {
      onChange(value)
    }
  }

  function handleFromChange(newFrom: string) {
    if (newFrom && to) {
      onChange('custom', newFrom, to)
    } else {
      // Partial — update internal state via onChange with no trigger
      onChange('custom', newFrom, to)
    }
  }

  function handleToChange(newTo: string) {
    if (from && newTo) {
      onChange('custom', from, newTo)
    } else {
      onChange('custom', from, newTo)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            onClick={() => handlePreset(preset.value)}
            className={cn(
              'h-7 px-3 rounded-md text-xs font-medium transition-colors',
              period === preset.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {t(preset.labelKey)}
          </button>
        ))}
      </div>

      {period === 'custom' && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => handleFromChange(e.target.value)}
            aria-label={t('periods.startDate')}
            className="h-7 px-2 rounded-md text-xs bg-card border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-xs text-muted-foreground">{t('periods.to')}</span>
          <input
            type="date"
            value={to}
            onChange={(e) => handleToChange(e.target.value)}
            aria-label={t('periods.endDate')}
            className="h-7 px-2 rounded-md text-xs bg-card border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}
    </div>
  )
}
