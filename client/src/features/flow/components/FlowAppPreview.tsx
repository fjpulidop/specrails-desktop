// ─── Flow app preview ─────────────────────────────────────────────────────────
// The app the Flow agent started in the worktree (`specrails_jobs
// background_start`, tagged with the Flow) as a split control in the Flow bar:
// a live dot + "Preview" opening the local address, and a menu with the
// network address (phones on the same Wi-Fi/VPN) and "Stop app". Mission apps
// open in the system browser, like their chips; nothing renders until an app
// of this Flow announced an address.

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Globe, Loader2, Monitor, Square } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { openExternalUrl } from '../../../lib/tauri-shell'
import type { BackgroundProcess } from '../../../types'
import { useBackgroundProcesses } from '../../background/context/BackgroundProcessesContext'
import type { Flow } from '../lib/flow-api'

import { notifyError } from '../../../lib/notify-error'
const LIVE = new Set<BackgroundProcess['status']>(['starting', 'running', 'stopping'])

/** The newest live process of this Flow that announced an address. */
export function flowPreviewApp(processes: readonly BackgroundProcess[], flow: Pick<Flow, 'id' | 'conversationId'>): BackgroundProcess | null {
  const candidates = processes.filter((process) => process.flowId === flow.id && process.chatId === flow.conversationId
    && LIVE.has(process.status) && ((process.appUrls?.local.length ?? 0) > 0 || (process.appUrls?.network.length ?? 0) > 0))
  return candidates.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}

export function FlowAppPreview({ flow, compact }: { flow: Flow; compact: boolean }) {
  const { t } = useTranslation('agent')
  const { processes, kill } = useBackgroundProcesses()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const app = flowPreviewApp(processes, flow)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      if (!items.length) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length]?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!app) return null
  const local = app.appUrls?.local[0] ?? null
  const network = app.appUrls?.network[0] ?? null
  const primary = local ?? network!
  const stopping = app.status === 'stopping'

  const stop = () => {
    setOpen(false)
    void kill(app).catch((error: unknown) => notifyError(t('flow.preview.stopFailed'), { detail: error instanceof Error ? error.message : undefined }))
  }

  return (
    <div ref={root} className="relative flex shrink-0 items-center" data-testid="flow-app-preview">
      <div className="inline-flex h-7 items-center rounded-md border border-accent-success/35 bg-accent-success/[0.08]">
        <button
          type="button"
          data-agent-interactive
          data-testid="flow-bar-preview"
          onClick={() => void openExternalUrl(primary)}
          disabled={stopping}
          title={t('flow.preview.openTitle', { url: primary })}
          aria-label={t('flow.preview.openTitle', { url: primary })}
          className="inline-flex h-full items-center gap-1.5 rounded-l-md pl-2 pr-1.5 text-label font-medium text-foreground/85 transition-colors hover:bg-accent-success/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-success disabled:cursor-not-allowed disabled:opacity-60"
        >
          {stopping
            ? <Loader2 className="h-3 w-3 animate-spin text-foreground/60" aria-hidden />
            : <span className="flow-app-dot inline-block h-1.5 w-1.5 rounded-full" data-testid="flow-app-dot" aria-hidden />}
          <span className={cn(compact && 'sr-only')}>{stopping ? t('flow.preview.stopping') : t('flow.preview.open')}</span>
        </button>
        <button
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
            'inline-flex h-full items-center rounded-r-md border-l border-accent-success/25 px-1 text-foreground/60 transition-colors hover:bg-accent-success/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-success',
            open && 'bg-accent-success/15 text-foreground',
          )}
        >
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('flow.preview.more')}
          className="absolute bottom-full right-0 z-30 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-card p-1 text-xs shadow-lg"
        >
          {local && (
            <button type="button" role="menuitem" data-testid="flow-preview-local" onClick={() => { setOpen(false); void openExternalUrl(local) }}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              <Monitor className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0"><span className="block text-foreground">{t('flow.preview.local')}</span><span className="block truncate font-mono text-label text-muted-foreground">{local}</span></span>
            </button>
          )}
          {network
            ? (
              <button type="button" role="menuitem" data-testid="flow-preview-network" onClick={() => { setOpen(false); void openExternalUrl(network) }}
                className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0"><span className="block text-foreground">{t('flow.preview.network')}</span><span className="block truncate font-mono text-label text-muted-foreground">{network}</span></span>
              </button>
            )
            : <p className="px-2.5 py-1.5 text-label leading-4 text-muted-foreground" data-testid="flow-preview-local-only">{t('flow.preview.localOnly')}</p>}
          <div className="my-1 h-px bg-border/70" role="separator" />
          <button type="button" role="menuitem" data-testid="flow-preview-stop" onClick={stop} disabled={stopping}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:outline-none disabled:opacity-50">
            <Square className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('flow.preview.stop')}
          </button>
        </div>
      )}
    </div>
  )
}
