import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Globe, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openExternalUrl } from '../../../lib/tauri-shell'
import type { BackgroundProcess } from '../../../types'

/** The URL a one-click "open app" action uses on this computer. */
export function primaryAppUrl(process: BackgroundProcess): string | null {
  return process.appUrls?.local[0] ?? process.appUrls?.network[0] ?? null
}

/** Addresses a running app announced, each opening in the system browser.
 *  Network addresses are what a phone on the same Wi-Fi/VPN opens. */
export function BackgroundProcessAppLinks({ process }: { process: BackgroundProcess }) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const urls = process.appUrls
  if (!urls || (!urls.local.length && !urls.network.length)) return null
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(url) } catch { /* clipboard unavailable */ }
  }
  const row = (url: string) => <li key={url} className="flex min-w-0 items-center gap-1">
    <button type="button" onClick={() => void openExternalUrl(url)} title={t('backgroundProcess.appUrls.open', { url })}
      className="inline-flex min-w-0 items-center gap-1 rounded px-1 font-mono text-accent-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
      <span className="truncate">{url}</span><ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </button>
    <button type="button" onClick={() => void copy(url)} aria-label={t('backgroundProcess.appUrls.copy', { url })} title={t('backgroundProcess.appUrls.copy', { url })}
      className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
      {copied === url ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
    </button>
  </li>
  return <section data-testid="background-process-app-links" aria-label={t('backgroundProcess.appUrls.title')} className="grid gap-1.5 border-b border-border/50 px-4 py-3 text-xs">
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
      {urls.local.length > 0 && <>
        <span className="flex items-center gap-1.5 pt-0.5 text-muted-foreground"><Monitor className="h-3.5 w-3.5" aria-hidden />{t('backgroundProcess.appUrls.local')}</span>
        <ul className="grid min-w-0 gap-0.5">{urls.local.map(row)}</ul>
      </>}
      {urls.network.length > 0 && <>
        <span className="flex items-center gap-1.5 pt-0.5 text-muted-foreground"><Globe className="h-3.5 w-3.5" aria-hidden />{t('backgroundProcess.appUrls.network')}</span>
        <ul className="grid min-w-0 gap-0.5">{urls.network.map(row)}</ul>
      </>}
    </div>
    {urls.network.length === 0 && <p className="text-muted-foreground">{t('backgroundProcess.appUrls.localOnly')}</p>}
  </section>
}
