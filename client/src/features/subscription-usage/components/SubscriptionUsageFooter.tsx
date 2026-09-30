import { BuilderHalo } from '../../builder/components/project-builder/BuilderHalo'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@radix-ui/react-dialog'
import { UsageProviderIcon } from './UsageProviderIcon'
import { SubscriptionUsageSection } from './SubscriptionUsageSection'
import { useSubscriptionUsage } from '../lib/useSubscriptionUsage'

export function SubscriptionUsageFooter() {
  const { t } = useTranslation('subscriptionUsage')
  const { snapshot, busy, refresh } = useSubscriptionUsage()
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
  return <Dialog.Root open={open} onOpenChange={changeOpen} modal={false}>
    <Dialog.Trigger asChild>
      <button ref={trigger} type="button" aria-label={t('shortTitle')} className="flex h-6 items-center gap-1.5 rounded px-2 text-xs hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring" onPointerEnter={event => { if (event.pointerType === 'mouse') changeOpen(true) }} onPointerLeave={scheduleClose} onFocus={() => changeOpen(true)} onBlur={scheduleClose} onClick={event => { event.preventDefault(); changeOpen(true) }}>
        
        {(!snapshot || snapshot.providers.every(provider => !provider.windows.length)) && <span className="text-muted-foreground">—</span>}
        <span className="flex items-center gap-3">{snapshot?.providers.filter(provider => provider.windows.length).map(provider => {
          const window = provider.windows.find(window => window.scope === 'account' && window.label === 'weekly')
            ?? provider.windows.find(window => window.scope === 'account')
            ?? provider.windows[0]
          return <span key={provider.providerId} className="flex items-center gap-1.5" title={provider.providerId === 'claude' ? 'Claude' : 'Codex'}><UsageProviderIcon provider={provider.providerId} className="h-3.5 w-3.5 shrink-0 text-white" /><span>{provider.providerId === 'claude' ? 'Claude' : 'Codex'}</span><span className="tabular-nums">{window.usedPercent === null ? '—' : `${window.usedPercent}%`}</span></span>
        })}</span>
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content aria-busy={refreshing} data-usage-menu className="font-sans fixed z-50 w-[min(320px,calc(100vw-24px))] max-h-[calc(100dvh-48px)] rounded-xl border border-border bg-card p-2 shadow-xl outline-none" style={position} onPointerEnter={cancelClose} onPointerLeave={scheduleClose} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) scheduleClose() }} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
        <Dialog.Title className="sr-only">{t('title')}</Dialog.Title>
        <Dialog.Description className="sr-only">{t('subtitle')}</Dialog.Description>
        <BuilderHalo active={refreshing} radius="0.75rem" inset={0} fadeInMs={450} fadeOutMs={800} />
        <div className="max-h-[calc(100dvh-64px)] overflow-y-auto"><SubscriptionUsageSection expanded menu /></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
