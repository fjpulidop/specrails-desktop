import { BuilderHalo } from '../../builder/components/project-builder/BuilderHalo'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@radix-ui/react-dialog'
import { UsageProviderIcon } from './UsageProviderIcon'
import { SubscriptionUsageSection } from './SubscriptionUsageSection'
import { useSubscriptionUsage } from '../lib/useSubscriptionUsage'
import { formatSpendPercent } from './EnterpriseSpendMeter'
import { useProviderQuotas } from '../../provider-quota/lib/useProviderQuota'
import { formatResetTime } from '../../provider-quota/lib/format-reset'
import { busiestMeter, providerName, usageMeters, type UsageMeter } from '../lib/usage-meter'

/** The one meter the status bar shows: the most-loaded provider; named and coloured only at amber, red or a refusal. */
function UsageMeterReading({ meter }: { meter: UsageMeter }) {
  const { i18n } = useTranslation('subscriptionUsage')
  const { t: tQuota } = useTranslation('providerQuota')
  const name = providerName(meter.providerId)
  if (meter.level === 'rejected') {
    const until = meter.rejectedUntil ? formatResetTime(meter.rejectedUntil, i18n.language) : null
    return <span data-testid="usage-limit-reached" data-level="rejected" className="flex items-center gap-1.5 text-destructive"><UsageProviderIcon provider={meter.providerId} className="h-3.5 w-3.5 shrink-0" /><span>{name}</span><span>{until ? tQuota('statusBar.rejectedUntil', { time: until }) : tQuota('statusBar.rejected')}</span></span>
  }
  const percent = meter.percent ?? 0
  const loud = meter.level !== 'ok'
  const tone = meter.level === 'critical' ? 'text-destructive' : meter.level === 'warning' ? 'text-accent-warning' : ''
  const fill = meter.level === 'critical' ? 'bg-destructive' : meter.level === 'warning' ? 'bg-accent-warning' : 'bg-muted-foreground'
  return <span data-testid="usage-meter-reading" data-provider={meter.providerId} data-level={meter.level} className={`flex items-center gap-1.5 ${tone}`}>
    <UsageProviderIcon provider={meter.providerId} className="h-3.5 w-3.5 shrink-0" />
    {loud && <span>{name}</span>}
    <span className="num">{meter.spend ? formatSpendPercent(percent, i18n.language) : `${Math.round(percent)}%`}</span>
    <span aria-hidden="true" data-testid="usage-meter" className="relative h-[3px] w-6 overflow-hidden rounded-full bg-muted"><span className={`absolute inset-y-0 left-0 rounded-full ${fill}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></span>
  </span>
}

/**
 * Status-bar usage: ONE meter for the most-loaded provider (nothing at all
 * without a reading). Hover, focus or click opens every provider's windows;
 * `details` (today's spend) renders at the end of that popover.
 */
export function SubscriptionUsageFooter({ details }: { details?: ReactNode } = {}) {
  const { t } = useTranslation('subscriptionUsage')
  const { snapshot, busy, refresh } = useSubscriptionUsage()
  const quotas = useProviderQuotas()
  const meter = busiestMeter(usageMeters(snapshot, quotas))
  const refreshing = busy || !!snapshot?.providers.some(provider => provider.refreshState === 'refreshing')
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ right: 16, bottom: 32 })
  const trigger = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const opened = useRef(false)
  const cancelClose = () => { clearTimeout(closeTimer.current) }
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const changeOpen = (value: boolean) => {
    cancelClose()
    if (value && !opened.current) {
      const bounds = trigger.current?.getBoundingClientRect()
      if (bounds) setPosition({ right: Math.max(12, window.innerWidth - bounds.right), bottom: window.innerHeight - bounds.top + 6 })
      void refresh()
    }
    opened.current = value
    setOpen(value)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      if (document.activeElement === trigger.current || document.activeElement?.closest('[data-usage-menu]')) return
      changeOpen(false)
    }, 180)
  }
  if (!meter) return null
  const label = meter.level === 'rejected'
    ? t('statusBar.rejectedLabel', { provider: providerName(meter.providerId) })
    : t('statusBar.label', { provider: providerName(meter.providerId), percent: Math.round(meter.percent ?? 0) })
  return <Dialog.Root open={open} onOpenChange={changeOpen} modal={false}>
    <Dialog.Trigger asChild>
      <button ref={trigger} type="button" aria-label={label} className="flex h-6 items-center gap-1.5 rounded px-2 text-xs hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring" onPointerEnter={event => { if (event.pointerType === 'mouse') changeOpen(true) }} onPointerLeave={scheduleClose} onFocus={() => changeOpen(true)} onBlur={scheduleClose} onClick={event => { event.preventDefault(); changeOpen(true) }}>
        <UsageMeterReading meter={meter} />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content aria-busy={refreshing} data-usage-menu className="font-sans fixed z-50 w-[min(320px,calc(100vw-24px))] max-h-[calc(100dvh-48px)] rounded-xl border border-border bg-card p-2 shadow-xl outline-none" style={position} onPointerEnter={cancelClose} onPointerLeave={scheduleClose} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) scheduleClose() }} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
        <Dialog.Title className="sr-only">{t('title')}</Dialog.Title>
        <Dialog.Description className="sr-only">{t('subtitle')}</Dialog.Description>
        <BuilderHalo active={refreshing} radius="0.75rem" inset={0} fadeInMs={450} fadeOutMs={800} />
        <div className="max-h-[calc(100dvh-64px)] overflow-y-auto"><SubscriptionUsageSection expanded menu />{details}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
