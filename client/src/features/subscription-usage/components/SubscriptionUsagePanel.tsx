import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import { useSubscriptionUsage } from '../lib/useSubscriptionUsage'
import type { ProviderUsage, UsageWindow } from '../lib/types'
import { EnterpriseSpendMeter } from './EnterpriseSpendMeter'
export function useUsageClock() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState !== 'hidden') setNow(Date.now()) }, 60_000); return () => clearInterval(timer) }, [])
  return now
}
export function isStale(provider: ProviderUsage, now: number) {
  return provider.freshness === 'stale' || !!provider.observedAt && now - Date.parse(provider.observedAt) >= 300_000
    || provider.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now)
    || !!provider.spend?.resetsAt && Date.parse(provider.spend.resetsAt) <= now
}
export function usageLabel(window: UsageWindow, t: (key: string) => string) {
  const label = ['session', 'weekly', 'monthly'].includes(window.label) ? t(`windows.${window.label}`) : t('windows.window')
  return window.model ? `${window.model} · ${label}` : label
}
export function usageIssue(provider: ProviderUsage) {
  if (provider.installed === false) return 'cli-missing'
  return provider.issue?.code ?? (provider.availability === 'available' ? '' : provider.availability)
}
export function SubscriptionUsagePanel({ selectedProvider, showDataDetails = false }: {
  selectedProvider?: 'claude' | 'codex'; showDataDetails?: boolean
}) {
  const { t, i18n } = useTranslation('subscriptionUsage')
  const { snapshot, busy, error, refresh } = useSubscriptionUsage()
  const now = useUsageClock()
  const rows = snapshot?.providers.filter(p => !selectedProvider || p.providerId === selectedProvider) ?? []
  const refreshing = busy || rows.some(p => p.refreshState === 'refreshing')
  const cooling = rows.length > 0 && rows.every(p => p.retryAt && Date.parse(p.retryAt) > now)
  const empty = snapshot?.providers.every(p => p.installed === false)
  const absolute = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(value))
  function relative(value: string) {
    const delta = (Date.parse(value) - now) / 60_000
    const unit = Math.abs(delta) >= 1440 ? 'day' : Math.abs(delta) >= 60 ? 'hour' : 'minute'
    return new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(Math.round(delta / (unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1)), unit)
  }
  return <section className="space-y-4" aria-label={t('title')}>
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('subtitle')}</p></div>
      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={t('refresh')} aria-busy={refreshing} disabled={refreshing || cooling} onClick={() => void refresh(selectedProvider)}>
        <RefreshCw className={cn('h-4 w-4', refreshing && 'motion-safe:animate-spin')} />
      </Button>
    </div>
    {!snapshot && <p className="text-sm text-muted-foreground">{t(error ? 'loadFailed' : 'loading')}</p>}
    {empty && <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">{t('empty')}</div>}
    {rows.map(provider => {
      const stale = isStale(provider, now), issue = usageIssue(provider)
      return <article key={provider.providerId} className="space-y-2 border-b border-border pb-4 last:border-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{provider.providerId === 'claude' ? 'Claude' : 'Codex'} {provider.plan && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{provider.spend ? t('spend.enterprise') : provider.plan}</span>}</h3>
          {provider.observedAt && <span className="text-[11px] text-muted-foreground" title={absolute(provider.observedAt)}>{stale ? t('stale') : t('updated', { time: relative(provider.observedAt) })}</span>}
        </div>
        {provider.spend && <EnterpriseSpendMeter spend={provider.spend} stale={stale} now={now} />}
        {provider.windows.map(window => <div key={window.id} className="space-y-1.5">
          <div className="flex flex-wrap justify-between gap-1 text-xs"><span className="text-muted-foreground">{usageLabel(window, t)}</span><span className="tabular-nums">{window.usedPercent === null ? t('unknown') : t('used', { value: window.usedPercent })}</span></div>
          {window.usedPercent !== null && <div role="progressbar" aria-label={`${provider.providerId} ${usageLabel(window, t)}`} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full', stale ? 'bg-muted-foreground/50' : window.usedPercent >= 90 ? 'bg-destructive' : window.usedPercent >= 80 ? 'bg-accent-warning' : 'bg-accent-primary')} style={{ width: `${window.usedPercent}%` }} />
          </div>}
          {<p className="text-[11px] text-muted-foreground" title={window.resetsAt ? absolute(window.resetsAt) : undefined}>{window.resetsAt ? Date.parse(window.resetsAt) <= now ? t('resetPassed') : t('resets', { time: relative(window.resetsAt) }) : t('resetUnknown')}</p>}
          {window.usedPercent === 100 && !stale && <p className="text-xs text-destructive">{t('limitReached')}</p>}
        </div>)}
        {issue && <p className="text-xs text-muted-foreground">{t(`issues.${issue}`, { defaultValue: t('issues.collection-failed') })}</p>}
        {provider.retryAt && Date.parse(provider.retryAt) > now && <p className="text-[11px] text-muted-foreground">{t('retry', { time: relative(provider.retryAt) })}</p>}
        {showDataDetails && provider.observedAt && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('dataDetails')}</summary><p className="mt-2">{t('observed', { time: absolute(provider.observedAt) })}</p>{provider.source && <p>{t('source', { source: provider.source })}</p>}</details>}
      </article>
    })}
    <p className="text-xs text-muted-foreground">{t('accountWide')}</p>
    <p className="sr-only" role="status" aria-live="polite">{refreshing ? t('refreshing') : error ? t('loadFailed') : snapshot ? t('ready') : ''}</p>
    {error && snapshot && <p className="text-xs text-muted-foreground">{t('loadFailed')}</p>}
  </section>
}
