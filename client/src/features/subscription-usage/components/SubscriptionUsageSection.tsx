import { UsageProviderIcon } from './UsageProviderIcon'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronRight, RefreshCw, TerminalSquare } from 'lucide-react'
import { useSubscriptionUsage } from '../lib/useSubscriptionUsage'
import { isStale, usageIssue, usageLabel, useUsageClock } from './SubscriptionUsagePanel'
import { cn } from '../../../lib/utils'
export function SubscriptionUsageSection({ expanded, menu = false }: { expanded: boolean; menu?: boolean }) {
  const { t, i18n } = useTranslation('subscriptionUsage')
  const { snapshot, busy, error, refresh } = useSubscriptionUsage()
  const [open, setOpen] = useState(menu)
  const contentId = useId()
  const now = useUsageClock()
  const absolute = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(value))
  const duration = (value: string) => {
    let minutes = Math.max(1, Math.ceil((Date.parse(value) - now) / 60_000))
    const days = Math.floor(minutes / 1440)
    minutes %= 1440
    const hours = Math.floor(minutes / 60)
    minutes %= 60
    const parts: string[] = []
    const unit = (value: number, unit: 'day' | 'hour' | 'minute') => new Intl.NumberFormat(i18n.language, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
    if (days) parts.push(unit(days, 'day'))
    if (hours) parts.push(unit(hours, 'hour'))
    if (!days && minutes) parts.push(unit(minutes, 'minute'))
    return parts.join(' ')
  }
  const updated = (value: string) => {
    const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000))
    const unit = minutes >= 1440 ? 'day' : minutes >= 60 ? 'hour' : 'minute'
    return new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(-Math.floor(minutes / (unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1)), unit)
  }
  const empty = snapshot?.providers.every(p => p.installed === false)
  const refreshing = busy || snapshot?.providers.some(p => p.refreshState === 'refreshing')
  const cooling = snapshot?.providers.every(p => p.retryAt && Date.parse(p.retryAt) > now)
  const warning = snapshot?.providers.some(p => !isStale(p, now) && p.windows.some(w => w.usedPercent !== null && w.usedPercent >= 90))
  return <div className={cn('shrink-0 px-1.5 py-2', !menu && 'border-t border-border', expanded && 'space-y-1.5')} data-testid="subscription-usage-section">
    {expanded ? <>
      {!menu && <div className="flex items-center justify-end px-2">{!menu && <button type="button" aria-hidden={menu} tabIndex={menu ? -1 : 0} disabled={menu} aria-expanded={open} aria-controls={contentId} onClick={() => { setOpen(!open); if (!open) void refresh() }} className="flex min-h-8 flex-1 items-center gap-1.5 rounded-md text-left text-xs font-normal text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"><ChevronRight aria-hidden="true" className={cn('h-3 w-3 motion-safe:transition-transform', open && 'rotate-90', menu && 'hidden')} />{t('shortTitle')}</button>}
        <button type="button" aria-label={t('refresh')} aria-hidden={!open} tabIndex={open ? 0 : -1} aria-busy={!!refreshing} disabled={!open || !!refreshing || !!cooling} className={cn('flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring motion-safe:transition-opacity motion-safe:duration-200', open ? refreshing || cooling ? 'opacity-50' : 'opacity-100' : 'pointer-events-none opacity-0')} onClick={() => void refresh()}><RefreshCw className={cn('h-3 w-3', refreshing && 'motion-safe:animate-spin')} /></button>
      </div>}
      <div id={contentId} hidden={!open}>
      {!snapshot ? <p className="px-2 text-[11px] text-muted-foreground">{t(error ? 'loadFailed' : 'loading')}</p> : empty ? <div className="p-3 text-[11px] text-muted-foreground"><TerminalSquare className="mb-2 h-4 w-4" /><p>{t('empty')}</p></div> : <div className={cn(!menu && 'max-h-[36vh]', 'divide-y divide-border/40 overflow-y-auto')}>{snapshot.providers.map(provider => {
        const stale = isStale(provider, now)
        return <article key={provider.providerId} aria-label={provider.providerId === 'claude' ? 'Claude' : 'Codex'} className="w-full px-3 py-4 text-left">
          <span className="flex items-center gap-2 text-xs font-semibold"><span className="shrink-0 text-white"><UsageProviderIcon provider={provider.providerId} className="h-4 w-4" /></span>{provider.providerId === 'claude' ? 'Claude' : 'Codex'}{stale && <span className="ml-auto text-[10px] font-normal text-muted-foreground">{t('stale')}</span>}</span>
          {provider.observedAt && <p className="mt-1 text-[10px] text-muted-foreground" title={absolute(provider.observedAt)}>{t('updated', { time: updated(provider.observedAt) })}</p>}
          <div className="mt-2.5 space-y-2.5">{provider.windows.length ? provider.windows.map(w => <div key={w.id} className="space-y-1.5">
            <div className="flex justify-between gap-2 text-[10px]"><span className="truncate text-muted-foreground">{usageLabel(w, t)}</span><span className="shrink-0 font-medium tabular-nums">{w.usedPercent === null ? '—' : `${w.usedPercent}%`}</span></div>
            {w.usedPercent !== null && <div role="progressbar" aria-label={`${provider.providerId} ${usageLabel(w, t)}`} aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100} className="h-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', stale ? 'bg-muted-foreground/50' : w.usedPercent >= 90 ? 'bg-destructive' : w.usedPercent >= 80 ? 'bg-accent-warning' : 'bg-accent-primary')} style={{ width: `${w.usedPercent}%` }} /></div>}
            <p className="text-[10px] tabular-nums text-muted-foreground" title={w.resetsAt ? absolute(w.resetsAt) : undefined}>{w.resetsAt ? Date.parse(w.resetsAt) <= now ? t('resetPassed') : t('resetsIn', { time: duration(w.resetsAt) }) : t('resetUnknown')}</p>
          </div>) : <p className="text-[10px] leading-relaxed text-muted-foreground">{t(`issues.${usageIssue(provider)}`, { defaultValue: t('issues.unavailable') })}</p>}</div>
        </article>
      })}</div>}
      </div>
    </> : <div className="relative flex h-8 w-full items-center justify-center text-muted-foreground" aria-label={t('title')} title={t('title')}><Activity className="h-4 w-4" />{warning && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-destructive" />}</div>}
  </div>
}
