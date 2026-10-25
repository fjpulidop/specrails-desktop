import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, CheckCircle2, Loader2 } from 'lucide-react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { UPDATE_CHANNEL_CHANGED_EVENT } from '../../../lib/app-updater'
import { Button } from '../../../components/ui/button'
import { SettingsCard } from './SettingsCard'

import { notifyError } from '../../../lib/notify-error'
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
  channel?: 'latest' | 'stable'
  resolvedDistTag?: 'latest' | 'stable' | null
  channelFallback?: boolean
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
    // A channel switch invalidates the cached target (it belonged to the other dist-tag).
    window.addEventListener(UPDATE_CHANNEL_CHANGED_EVENT, focus)
    return () => {
      requestGeneration.current++
      window.removeEventListener('focus', focus)
      window.removeEventListener(UPDATE_CHANNEL_CHANGED_EVENT, focus)
    }
  }, [refresh])

  // Stream update progress (app-level message — reaches every handler).
  const onUpdateRef = useRef<(() => Promise<void>) | null>(null)
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
        notifyError(t('coreUpdate.updateFailed'), { detail: msg.message ? String(msg.message) : undefined, retry: () => void onUpdateRef.current?.() })
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
      notifyError(t('coreUpdate.checkFailed'), { detail: err instanceof Error ? err.message : undefined, retry: () => void onCheck() })
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
      notifyError(t('coreUpdate.updateFailed'), { detail: err instanceof Error ? err.message : undefined, retry: () => void onUpdate() })
    }
  }, [t])
  onUpdateRef.current = onUpdate

  const loadErrorNotice = (
    <p role="alert" className="text-xs text-destructive">
      {t('coreUpdate.loadError')}{' '}
      <button
        type="button"
        onClick={() => { void refresh() }}
        className="rounded-sm font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('common:actions.retry')}
      </button>
    </p>
  )

  if (!status) {
    if (loadError) return loadErrorNotice
    return <div role="status" aria-busy="true" aria-label={t('common:states.loading')} className="h-20 bg-muted/30 rounded-lg motion-safe:animate-pulse" />
  }

  const current = status.currentVersion ?? '—'
  const target = status.pendingVersion ?? status.latestVersion

  return (
    <SettingsCard title={t('coreUpdate.heading')}>
        {!status.available ? (
          <p className="text-xs text-muted-foreground">{t('coreUpdate.unavailable')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-foreground">
                  {t('coreUpdate.installed')}{' '}
                  <span className="font-semibold tabular-nums">{current}</span>
                </p>
                {status.runtimeVersion && (
                  <p className="text-xs text-muted-foreground">
                    {t('coreUpdate.runtime', { version: status.runtimeVersion })}
                    {status.runtimeSource ? ` · ${t(`coreUpdate.sources.${status.runtimeSource}`)}` : ''}
                  </p>
                )}
                {status.bundledVersion && status.bundledVersion !== status.runtimeVersion && (
                  <p className="text-xs text-muted-foreground">{t('coreUpdate.bundled', { version: status.bundledVersion })}</p>
                )}
                {status.updateAvailable && status.latestVersion ? (
                  <p className="text-label text-accent-primary truncate">
                    {t('coreUpdate.updateAvailable', { version: status.latestVersion })}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground truncate">
                    {status.lastCheckedAt ? t('coreUpdate.upToDate') : t('coreUpdate.neverChecked')}
                  </p>
                )}
              </div>
              {status.updateAvailable && target ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onUpdate()}
                  disabled={busy}
                  className="h-7 shrink-0 gap-1.5 border-accent-primary/45 text-accent-primary hover:text-accent-primary"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
                  {busy
                    ? t(phase === 'materializing' ? 'coreUpdate.materializing' : 'coreUpdate.downloading')
                    : status.pendingVersion ? t('coreUpdate.repair', { version: target }) : t('coreUpdate.update', { version: target })}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onCheck()}
                  disabled={checking || busy}
                  className="h-7 shrink-0 gap-1.5"
                >
                  {checking ? (
                    <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                  ) : phase === 'done' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-accent-success" aria-hidden />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {checking ? t('coreUpdate.checking') : t('coreUpdate.check')}
                </Button>
              )}
            </div>
            {status.channel === 'stable' && status.channelFallback && (
              <p className="text-xs text-muted-foreground">{t('coreUpdate.stableFallback')}</p>
            )}
            {status.runtimeError && <p role="alert" className="text-xs text-destructive">{status.runtimeError}</p>}
            {status.migrationError && <p role="alert" className="text-xs text-destructive">{status.migrationError}</p>}
            {loadError && loadErrorNotice}
            <p className="text-xs text-muted-foreground">{t('coreUpdate.affectsAll')}</p>
          </>
        )}
    </SettingsCard>
  )
}
