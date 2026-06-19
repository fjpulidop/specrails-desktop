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

  const refresh = useCallback(async (): Promise<CoreUpdateStatus | null> => {
    try {
      const res = await fetch('/api/core-update/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as CoreUpdateStatus
      setStatus(data)
      return data
    } catch {
      setStatus((prev) => prev ?? null)
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Stream update progress (app-level message — reaches every handler).
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    const handler = (raw: unknown): void => {
      const msg = raw as Record<string, unknown>
      if (msg.type !== 'core_update.progress') return
      const p = msg.phase as ProgressPhase
      setPhase(p)
      if (p === 'done') {
        toast.success(t('coreUpdate.toastDone', { version: String(msg.version ?? '') }))
        void refreshRef.current()
        setTimeout(() => setPhase(null), 2500)
      } else if (p === 'error') {
        toast.error(t('coreUpdate.toastError', { message: String(msg.message ?? '') }))
        void refreshRef.current()
        setTimeout(() => setPhase(null), 4000)
      }
    }
    registerHandler('core-update', handler)
    return () => unregisterHandler('core-update')
  }, [registerHandler, unregisterHandler, t])

  const onCheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const res = await fetch('/api/core-update/check', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as CoreUpdateStatus
      setStatus(data)
      if (!data.updateAvailable) toast.success(t('coreUpdate.toastUpToDate'))
    } catch (err) {
      toast.error(t('coreUpdate.toastCheckFailed', { message: (err as Error).message }))
    } finally {
      setChecking(false)
    }
  }, [t])

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
    return <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
  }

  const busy = phase === 'downloading' || phase === 'materializing' || status.updating
  const current = status.currentVersion ?? '—'

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
                <p className="text-[10px] text-muted-foreground/70 truncate">
                  {status.updateAvailable && status.latestVersion
                    ? t('coreUpdate.updateAvailable', { version: status.latestVersion })
                    : status.lastCheckedAt
                      ? t('coreUpdate.upToDate')
                      : t('coreUpdate.neverChecked')}
                </p>
              </div>
              {status.updateAvailable && status.latestVersion ? (
                <button
                  type="button"
                  onClick={onUpdate}
                  disabled={busy}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-accent-primary/45 bg-accent-primary/15 px-3 text-[11px] font-semibold text-accent-primary disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {busy
                    ? t(phase === 'materializing' ? 'coreUpdate.materializing' : 'coreUpdate.downloading')
                    : t('coreUpdate.update', { version: status.latestVersion })}
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
            <p className="text-[10px] text-muted-foreground/70">{t('coreUpdate.affectsAll')}</p>
          </>
        )}
      </div>
    </div>
  )
}
