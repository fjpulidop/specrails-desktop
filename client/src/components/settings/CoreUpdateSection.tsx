import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, CheckCircle2, Loader2 } from 'lucide-react'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'

interface CoreUpdateStatus {
  available: boolean
  currentVersion: string | null
  bundledVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  updating: boolean
  lastCheckedAt: number | null
  runtimeVersion?: string | null
  runtimeSource?: 'override' | 'managed' | 'bundled' | 'local' | 'global' | null
  frameworkVersion?: string | null
  runtimeError?: string | null
  pendingVersion?: string | null
  migrationError?: string | null
}

type ProgressPhase = 'downloading' | 'materializing' | 'done' | 'error' | null

/**
 * App-global specrails-core update channel. Detects a newer published core
 * (npm latest > installed `framework/current`) and applies it WITHOUT restarting
 * the app — the swap re-points every project workspace at the new framework.
 * Mirrors the other GlobalSettings sections; progress streams over the shared
 * WebSocket (`core_update.progress`, no projectId).
 */
export function CoreUpdateSection() {
  const { t } = useTranslation('settings')
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [status, setStatus] = useState<CoreUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState<ProgressPhase>(null)
  const [loadError, setLoadError] = useState(false)
  const requestGeneration = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<CoreUpdateStatus | null> => {
    const generation = ++requestGeneration.current
    try {
      const res = await fetch('/api/core-update/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as CoreUpdateStatus
      if (generation !== requestGeneration.current) return null
      setStatus(data)
      setLoadError(false)
      if (!data.updating) setPhase(null)
      return data
    } catch {
      if (generation === requestGeneration.current) setLoadError(true)
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { requestGeneration.current++; window.removeEventListener('focus', focus) }
  }, [refresh])

  // Stream update progress (app-level message — reaches every handler).
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    const handler = (raw: unknown): void => {
      const msg = raw as Record<string, unknown>
      if (msg.type === 'framework.updated') { void refreshRef.current(); return }
      if (msg.type !== 'core_update.progress') return
      const p = msg.phase as ProgressPhase
      setPhase(p)
      if (p === 'done') {
        toast.success(t('coreUpdate.toastDone', { version: String(msg.version ?? '') }))
        void refreshRef.current()
        if (resetTimer.current) clearTimeout(resetTimer.current)
        resetTimer.current = setTimeout(() => setPhase(null), 2500)
      } else if (p === 'error') {
        toast.error(t('coreUpdate.toastError', { message: String(msg.message ?? '') }))
        void refreshRef.current()
        if (resetTimer.current) clearTimeout(resetTimer.current)
        resetTimer.current = setTimeout(() => setPhase(null), 4000)
      }
    }
    registerHandler('core-update', handler)
    return () => {
      unregisterHandler('core-update')
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [registerHandler, unregisterHandler, t])

  const onCheck = useCallback(async (): Promise<void> => {
    const generation = ++requestGeneration.current
    setChecking(true)
    try {
      const res = await fetch('/api/core-update/check', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as CoreUpdateStatus
      if (generation !== requestGeneration.current) return
      setStatus(data)
      if (!data.updateAvailable) toast.success(t('coreUpdate.toastUpToDate'))
    } catch (err) {
      toast.error(t('coreUpdate.toastCheckFailed', { message: (err as Error).message }))
    } finally {
      setChecking(false)
    }
  }, [t])

  // Recover from a missed completion event or a reconnect during installation.
  const busy = phase === 'downloading' || phase === 'materializing' || Boolean(status?.updating)
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => { void refresh() }, 1500)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const onUpdate = useCallback(async (): Promise<void> => {
    setPhase('downloading')
    try {
      const res = await fetch('/api/core-update/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (res.status !== 202) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(body.message ?? `HTTP ${res.status}`)
      }
      // Success/failure arrives over WS (core_update.progress).
    } catch (err) {
      setPhase(null)
      toast.error(t('coreUpdate.toastError', { message: (err as Error).message }))
    }
  }, [t])

  if (!status) {
    if (loadError) return <button type="button" onClick={() => { void refresh() }} className="text-xs text-destructive">{t('coreUpdate.loadFailed')}</button>
    return <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
  }

  const current = status.currentVersion ?? '—'
  const target = status.pendingVersion ?? status.latestVersion

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('coreUpdate.heading')}
      </h3>
      <div className="rounded-md border border-border p-3 space-y-3">
        {!status.available ? (
          <p className="text-[11px] text-muted-foreground">{t('coreUpdate.unavailable')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-foreground">
                  {t('coreUpdate.installed')}{' '}
                  <span className="font-semibold tabular-nums">{current}</span>
                </p>
                {status.runtimeVersion && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('coreUpdate.runtime', { version: status.runtimeVersion })}
                    {status.runtimeSource ? ` · ${t(`coreUpdate.sources.${status.runtimeSource}`)}` : ''}
                  </p>
                )}
                {status.bundledVersion && status.bundledVersion !== status.runtimeVersion && (
                  <p className="text-[10px] text-muted-foreground">{t('coreUpdate.bundled', { version: status.bundledVersion })}</p>
                )}
                <p className="text-[10px] text-muted-foreground/70 truncate">
                  {status.updateAvailable && status.latestVersion
                    ? t('coreUpdate.updateAvailable', { version: status.latestVersion })
                    : status.lastCheckedAt
                      ? t('coreUpdate.upToDate')
                      : t('coreUpdate.neverChecked')}
                </p>
              </div>
              {status.updateAvailable && target ? (
                <button
                  type="button"
                  onClick={onUpdate}
                  disabled={busy}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-accent-primary/45 bg-accent-primary/15 px-3 text-[11px] font-semibold text-accent-primary disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {busy
                    ? t(phase === 'materializing' ? 'coreUpdate.materializing' : 'coreUpdate.downloading')
                    : status.pendingVersion ? t('coreUpdate.repair', { version: target }) : t('coreUpdate.update', { version: target })}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCheck}
                  disabled={checking || busy}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {checking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : phase === 'done' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-accent-success" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {checking ? t('coreUpdate.checking') : t('coreUpdate.check')}
                </button>
              )}
            </div>
            {status.runtimeError && <p role="alert" className="text-xs text-destructive">{status.runtimeError}</p>}
            {status.migrationError && <p role="alert" className="text-xs text-destructive">{status.migrationError}</p>}
            {loadError && <button type="button" className="text-xs text-destructive" onClick={() => { void refresh() }}>{t('coreUpdate.loadFailed')}</button>}
            <p className="text-[10px] text-muted-foreground/70">{t('coreUpdate.affectsAll')}</p>
          </>
        )}
      </div>
    </div>
  )
}
