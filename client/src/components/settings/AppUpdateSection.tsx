import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { RefreshCw, CheckCircle2, Loader2 } from 'lucide-react'
import { check } from '@tauri-apps/plugin-updater'
import { getVersion } from '@tauri-apps/api/app'
import {
  createMockUpdate,
  isMockUpdateEnabled,
  isTauriRuntime,
  showDesktopUpdateToast,
} from '../../hooks/useDesktopUpdateNotifier'

type CheckResult = 'up-to-date' | 'update-available' | null

/**
 * Manual "Check for updates" for Specrails Desktop itself. The automatic
 * notifier (useDesktopUpdateNotifier) already checks at launch + every 6h; this
 * is the explicit user action in Settings ▸ Updates. A found update opens the
 * SAME standard update card (download/install/restart), bypassing the
 * dismissed-version gate because the user asked. Mirrors CoreUpdateSection's
 * layout so the Updates pane reads as one family.
 */
export function AppUpdateSection() {
  const { t } = useTranslation('settings')
  const mockEnabled = isMockUpdateEnabled()
  const available = isTauriRuntime() || mockEnabled
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckResult>(null)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let alive = true
    getVersion()
      .then((v) => { if (alive) setCurrentVersion(v) })
      .catch(() => { /* keep null — the row shows an em dash */ })
    return () => { alive = false }
  }, [])

  const onCheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    setResult(null)
    try {
      const update = mockEnabled ? createMockUpdate() : await check()
      if (update) {
        setResult('update-available')
        setLatestVersion(update.version)
        showDesktopUpdateToast(update)
      } else {
        setResult('up-to-date')
        toast.success(t('appUpdate.toastUpToDate'))
      }
    } catch (err) {
      toast.error(t('appUpdate.toastCheckFailed', { message: (err as Error).message }))
    } finally {
      setChecking(false)
    }
  }, [mockEnabled, t])

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('appUpdate.heading')}
      </h3>
      <div className="rounded-md border border-border p-3 space-y-3">
        {!available ? (
          <p className="text-[11px] text-muted-foreground">{t('appUpdate.unavailable')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-foreground">
                  {t('appUpdate.installed')}{' '}
                  <span className="font-semibold tabular-nums">{currentVersion ?? '—'}</span>
                </p>
                <p className="text-[10px] text-muted-foreground/70 truncate">
                  {result === 'update-available' && latestVersion
                    ? t('appUpdate.updateAvailable', { version: latestVersion })
                    : result === 'up-to-date'
                      ? t('appUpdate.upToDate')
                      : t('appUpdate.autoHint')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onCheck()}
                disabled={checking}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : result === 'up-to-date' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-accent-success" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {checking ? t('appUpdate.checking') : t('appUpdate.check')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
