import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, X, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { formatElapsed } from '../lib/format-duration'
import type { BackgroundProcess } from '../types'

export type BackgroundProcessAccent = 'accent-primary' | 'accent-info' | 'accent-highlight'

const accentClass: Record<BackgroundProcessAccent, string> = {
  'accent-primary': 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  'accent-info': 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  'accent-highlight': 'border-accent-highlight/40 bg-accent-highlight/10 text-accent-highlight',
}

export function BackgroundProcessChip({
  process,
  accentVariant,
  onKill,
  onOpen,
}: {
  process: BackgroundProcess & { stopError?: string }
  accentVariant: BackgroundProcessAccent
  onKill: (process: BackgroundProcess) => Promise<void> | void
  onOpen: (process: BackgroundProcess) => void
}) {
  const { t } = useTranslation('agent')
  const elapsed = useBackgroundProcessElapsed(process)
  const terminal = isBackgroundProcessFinished(process)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const busy = stopping || process.status === 'stopping' && !process.stopError && !process.error
  const stopFailed = failed || !!process.stopError || process.status === 'stopping' && !!process.error
  const stop = async () => {
    if (busy || terminal) return
    setStopping(true); setFailed(false)
    try { await onKill(process) } catch { setFailed(true) }
    finally { setStopping(false) }
  }
  return (
    <TooltipProvider delayDuration={150}>
      <span data-testid="background-process-chip" className={`inline-flex max-w-full items-center rounded-lg border text-[11px] ${accentClass[accentVariant]}`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => onOpen(process)} aria-label={t('backgroundProcess.open', { command: process.command })}
              className="inline-flex min-w-0 max-w-[340px] items-center gap-1.5 rounded-l-lg px-2 py-1 transition-colors hover:bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
              <Terminal className="h-3 w-3 shrink-0" aria-hidden />
              <span className={`shrink-0 ${process.status === 'failed' ? 'text-destructive' : 'text-foreground/70'}`}>
                {t(`backgroundProcess.status.${busy ? 'stopping' : process.status}`)}
              </span>
              <span className="min-w-0 truncate font-medium">{process.command}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{elapsed}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('backgroundProcess.open', { command: process.command })} · {elapsed}</TooltipContent>
        </Tooltip>
        {stopFailed && <span role="alert" title={t('backgroundProcess.stopFailed')} className="flex shrink-0 items-center px-1 text-destructive"><AlertCircle className="h-3 w-3" aria-hidden /><span className="sr-only">{t('backgroundProcess.stopFailed')}</span></span>}
        {!terminal && <button type="button" disabled={busy} aria-label={t('backgroundProcess.stopCommand', { command: process.command })}
          title={t('backgroundProcess.stopCommand', { command: process.command })}
          onClick={event => { event.preventDefault(); event.stopPropagation(); void stop() }}
          className="mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
        </button>}
      </span>
    </TooltipProvider>
  )
}

export function isBackgroundProcessFinished(process: BackgroundProcess): boolean {
  return process.status === 'exited' || process.status === 'failed' || process.status === 'killed' || process.status === 'interrupted'
}

export function useBackgroundProcessElapsed(process: BackgroundProcess): string {
  const [now, setNow] = useState(Date.now())
  const finished = isBackgroundProcessFinished(process)
  useEffect(() => {
    setNow(Date.now())
    if (finished) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [finished, process.startedAt])
  return formatElapsed(Math.max(0, (process.endedAt ?? process.recoveredAt ?? now) - process.startedAt))
}
