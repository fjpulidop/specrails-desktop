import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { RefreshCw, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { SettingsCard } from './SettingsCard'
import { checkAppUpdate, isStableChannelUnavailable } from '../../../lib/app-updater'
import { getVersion } from '@tauri-apps/api/app'
import {
  createMockUpdate,
  isMockUpdateEnabled,
  isTauriRuntime,
  showDesktopUpdateToast,
} from '../../../hooks/useDesktopUpdateNotifier'

import { notifyError } from '../../../lib/notify-error'
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
      const update = mockEnabled ? createMockUpdate() : await checkAppUpdate()
      if (update) {
        setResult('update-available')
        setLatestVersion(update.version)
        showDesktopUpdateToast(update)
      } else {
        setResult('up-to-date')
        toast.success(t('appUpdate.toastUpToDate'))
      }
    } catch (err) {
      if (isStableChannelUnavailable(err)) notifyError(t('appUpdate.stableUnavailable'))
      else notifyError(t('appUpdate.toastCheckFailed'), { detail: err instanceof Error ? err.message : String(err), retry: () => void onCheck() })
    } finally {
      setChecking(false)
    }
  }, [mockEnabled, t])

  return (
    <SettingsCard title={t('appUpdate.heading')}>
        {!available ? (
          <p className="text-xs text-muted-foreground">{t('appUpdate.unavailable')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-foreground">
                  {t('appUpdate.installed')}{' '}
                  <span className="font-semibold tabular-nums">{currentVersion ?? '—'}</span>
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {result === 'update-available' && latestVersion
                    ? t('appUpdate.updateAvailable', { version: latestVersion })
                    : result === 'up-to-date'
                      ? t('appUpdate.upToDate')
                      : t('appUpdate.autoHint')}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onCheck()}
                disabled={checking}
                className="h-7 shrink-0 gap-1.5"
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                ) : result === 'up-to-date' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-accent-success" aria-hidden />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
                {checking ? t('appUpdate.checking') : t('appUpdate.check')}
              </Button>
            </div>
          </>
        )}
    </SettingsCard>
  )
}
