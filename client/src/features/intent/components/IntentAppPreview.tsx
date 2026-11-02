// ─── Intent app preview ─────────────────────────────────────────────────────────
// The app the Intent agent started in the worktree (`specrails_jobs
// background_start`, tagged with the Intent) as a split control in the Intent bar:
// a live dot + "Preview" opening the local address, and a menu with the
// network address (phones on the same Wi-Fi/VPN) and "Stop app". Mission apps
// open in the system browser, like their chips; nothing renders until an app
// of this Intent announced an address.
//
// The menu is portaled to the document (fixed, above the control): the strip
// panel that hosts the control scrolls (overflow-y: auto), so an in-panel
// absolute menu would be clipped or scroll-boxed. The strip tolerates portaled
// menus (a click inside one never closes the panel). Opening focuses the first
// item; Esc returns focus to the toggle, like the strip's own "+N" menu.

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Globe, Loader2, Monitor, Square } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { openExternalUrl } from '../../../lib/tauri-shell'
import type { BackgroundProcess } from '../../../types'
import { useBackgroundProcesses } from '../../background/context/BackgroundProcessesContext'
import type { IntentSession } from '../lib/intent-api'

import { notifyError } from '../../../lib/notify-error'
const LIVE = new Set<BackgroundProcess['status']>(['starting', 'running', 'stopping'])

/** Gap between the control and its menu, and the viewport edge it never crosses. */
const MENU_GAP = 4
const MENU_WIDTH = 256

const MENU_ITEM =
  'flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface focus:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'

/** The newest live process of this Intent that announced an address. */
export function flowPreviewApp(processes: readonly BackgroundProcess[], flow: Pick<IntentSession, 'id' | 'conversationId'>): BackgroundProcess | null {
  const candidates = processes.filter((process) => process.flowId === flow.id && process.chatId === flow.conversationId
    && LIVE.has(process.status) && ((process.appUrls?.local.length ?? 0) > 0 || (process.appUrls?.network.length ?? 0) > 0))
  return candidates.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}

/** Where the menu sits: above the control, left-aligned, kept inside the viewport. */
export function flowPreviewMenuPosition(anchor: Pick<DOMRect, 'left' | 'top'>, viewport: { width: number; height: number }): CSSProperties {
  const left = Math.max(MENU_GAP, Math.min(anchor.left, viewport.width - MENU_WIDTH - MENU_GAP))
  return { position: 'fixed', left, bottom: Math.max(MENU_GAP, viewport.height - anchor.top + MENU_GAP), width: MENU_WIDTH }
}

export function IntentAppPreview({ flow, compact }: { flow: IntentSession; compact: boolean }) {
  const { t } = useTranslation('agent')
  const { processes, kill } = useBackgroundProcesses()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const app = flowPreviewApp(processes, flow)

  // Esc (and a pick) close the menu and hand focus back to the toggle; a click elsewhere only closes it.
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) toggle.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const place = () => {
      if (root.current) setPosition(flowPreviewMenuPosition(root.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])

  // Opening lands on the first enabled item (a `menu` button that opens into silence says nothing to a screen reader).
  useEffect(() => {
    if (!open || !position) return
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => !!target && (!!root.current?.contains(target as Node) || !!menu.current?.contains(target as Node))
    const onPointer = (event: MouseEvent) => { if (!inside(event.target)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      if (event.key === 'Tab') { setOpen(false); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      if (!items.length) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length]?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` only reads refs
  }, [open])

  if (!app) return null
  const local = app.appUrls?.local[0] ?? null
  const network = app.appUrls?.network[0] ?? null
  const primary = local ?? network!
  const stopping = app.status === 'stopping'

  const stop = () => {
    close(true)
    void kill(app).catch((error: unknown) => notifyError(t('flow.preview.stopFailed'), { detail: error instanceof Error ? error.message : undefined }))
  }
  const pick = (url: string) => {
    close(true)
    void openExternalUrl(url)
  }

  const menuNode = open && (
    <div
      ref={menu}
      id={menuId}
      role="menu"
      aria-label={t('flow.preview.more')}
      data-testid="flow-preview-menu"
      style={position ?? { position: 'fixed', visibility: 'hidden' }}
      className="z-[70] overflow-hidden rounded-lg border border-border/60 bg-card p-1 text-label shadow-2"
    >
      {local && (
        <button type="button" role="menuitem" data-testid="flow-preview-local" onClick={() => pick(local)} className={MENU_ITEM}>
          <Monitor className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0"><span className="block text-foreground">{t('flow.preview.local')}</span><span className="block truncate font-mono text-label text-muted-foreground">{local}</span></span>
        </button>
      )}
      {network
        ? (
          <button type="button" role="menuitem" data-testid="flow-preview-network" onClick={() => pick(network)} className={MENU_ITEM}>
            <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0"><span className="block text-foreground">{t('flow.preview.network')}</span><span className="block truncate font-mono text-label text-muted-foreground">{network}</span></span>
          </button>
        )
        : <p className="px-2.5 py-1.5 text-label leading-4 text-muted-foreground" data-testid="flow-preview-local-only">{t('flow.preview.localOnly')}</p>}
      <div className="my-1 h-px bg-border/70" role="separator" />
      <button type="button" role="menuitem" data-testid="flow-preview-stop" onClick={stop} disabled={stopping}
        className={cn(MENU_ITEM, 'items-center text-destructive hover:bg-destructive/10 focus:bg-destructive/10 disabled:opacity-50')}>
        <Square className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('flow.preview.stop')}
      </button>
    </div>
  )

  return (
    <div ref={root} className="relative flex shrink-0 items-center" data-testid="flow-app-preview">
      {/* The LiveDot is the lamp; the control itself is a quiet hairline button like the rest of the strip. */}
      <div className="inline-flex h-7 items-center rounded-md border border-border/60 bg-surface/40">
        <button
          type="button"
          data-agent-interactive
          data-testid="flow-bar-preview"
          onClick={() => void openExternalUrl(primary)}
          disabled={stopping}
          title={t('flow.preview.openTitle', { url: primary })}
          aria-label={t('flow.preview.openTitle', { url: primary })}
          className="inline-flex h-full items-center gap-1.5 rounded-l-md pl-2 pr-1.5 text-label font-medium text-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {stopping
            ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
            : <span className="flow-app-dot inline-block h-1.5 w-1.5 rounded-full" data-testid="flow-app-dot" aria-hidden />}
          <span className={cn(compact && 'sr-only')}>{stopping ? t('flow.preview.stopping') : t('flow.preview.open')}</span>
        </button>
        <button
          ref={toggle}
          type="button"
          data-agent-interactive
          data-testid="flow-bar-preview-menu"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={t('flow.preview.more')}
          title={t('flow.preview.more')}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'inline-flex h-full items-center rounded-r-md border-l border-border/60 px-1 text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
            open && 'bg-surface text-foreground',
          )}
        >
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {menuNode && typeof document !== 'undefined' ? createPortal(menuNode, document.body) : null}
    </div>
  )
}
