import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { EnterpriseSpend } from '../lib/types'

export function formatSpendPercent(value: number, language: string): string {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100)
}

export function EnterpriseSpendMeter({ spend, stale, now, compact = false }: {
  spend: EnterpriseSpend; stale: boolean; now: number; compact?: boolean
}) {
  const { t, i18n } = useTranslation('subscriptionUsage')
  const money = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: spend.currency }).format(value)
  const summary = spend.limitStatus === 'limited'
    ? t('spend.amounts', { used: money(spend.usedAmount), limit: money(spend.limitAmount) })
    : t('spend.consumed', { used: money(spend.usedAmount) })
  const percent = spend.usedPercent
  const reset = spend.resetsAt ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(spend.resetsAt)) : null
  return <div className={cn('space-y-1.5', compact ? 'text-[10px]' : 'text-xs')}>
    <div className="flex flex-wrap items-center justify-between gap-1 text-muted-foreground">
      <span>{t('spend.monthly')}</span>
      {percent !== null && <span className="font-medium tabular-nums text-foreground">{formatSpendPercent(percent, i18n.language)}</span>}
    </div>
    <p className="font-medium tabular-nums text-foreground">{summary}</p>
    {percent !== null && <div role="progressbar" aria-label={t('spend.progress')} aria-valuenow={Math.min(100, percent)} aria-valuemin={0} aria-valuemax={100} aria-valuetext={summary} className={cn('overflow-hidden rounded-full bg-muted', compact ? 'h-1' : 'h-1.5')}>
      <div className={cn('h-full rounded-full', stale ? 'bg-muted-foreground/50' : percent >= 90 ? 'bg-destructive' : percent >= 80 ? 'bg-accent-warning' : 'bg-accent-primary')} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>}
    {spend.limitStatus !== 'limited' && <p className="text-muted-foreground">{t(spend.limitStatus === 'unlimited' ? 'spend.unlimited' : 'spend.limitUnknown')}</p>}
    <p className="tabular-nums text-muted-foreground">{spend.resetsAt && Date.parse(spend.resetsAt) <= now ? t('resetPassed') : reset ? t('spend.resets', { time: reset }) : t('resetUnknown')}</p>
    {!stale && (percent !== null && percent >= 100 || spend.limitAmount === 0) && <p className="text-destructive">{t('limitReached')}</p>}
  </div>
}
