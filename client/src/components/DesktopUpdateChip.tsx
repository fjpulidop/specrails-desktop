import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { DownloadCloud } from 'lucide-react'
import { DesktopUpdateToast, desktopUpdateOffer, useDesktopUpdateOffer } from '../hooks/useDesktopUpdateNotifier'

/**
 * The discreet update offer in the status bar: a small chip once an update was
 * found and the app sat idle (see `useDesktopUpdateNotifier`). A click opens
 * the update card above it; Escape or a click elsewhere closes it. The card
 * stays mounted while hidden, so a running download keeps its progress.
 */
export function DesktopUpdateChip() {
  const { t } = useTranslation('commands')
  const update = useDesktopUpdateOffer()
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ right: 16, bottom: 32 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!update) setOpen(false) }, [update])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  if (!update) return null
  const toggle = () => {
    if (!open) {
      const bounds = trigger.current?.getBoundingClientRect()
      if (bounds) setPosition({ right: Math.max(12, window.innerWidth - bounds.right), bottom: window.innerHeight - bounds.top + 6 })
    }
    setOpen(!open)
  }
  return <>
    <button ref={trigger} type="button" data-testid="desktop-update-chip" aria-label={t('update.chip.label', { version: update.version })}
      aria-expanded={open} aria-controls={panelId} onClick={toggle}
      className="flex h-6 items-center gap-1.5 rounded px-2 text-label text-accent-primary hover:bg-muted focus-visible:outline focus-visible:outline-ring">
      <DownloadCloud className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('update.chip.text')}</span>
    </button>
    {createPortal(
      <div ref={panel} id={panelId} hidden={!open} role="region" aria-label={t('update.title.available')} data-testid="desktop-update-card"
        className="fixed z-50 w-[min(340px,calc(100vw-24px))] rounded-xl border border-border bg-card p-3 shadow-3"
        style={position}>
        <DesktopUpdateToast update={update} onClose={() => setOpen(false)} onDismiss={() => desktopUpdateOffer.set(null)} />
      </div>,
      document.body,
    )}
  </>
}
