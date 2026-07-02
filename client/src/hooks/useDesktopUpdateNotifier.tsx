import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { DownloadCloud, Cog, Check, AlertTriangle } from 'lucide-react'
import i18n from '../lib/i18n'

const DISMISSED_UPDATE_KEY = 'specrails-desktop:dismissedDesktopUpdateVersion'
const UPDATE_TOAST_ID = 'specrails-desktop-desktop-update'
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h — surface releases published mid-session

type UpdateToastState = 'available' | 'downloading' | 'installing' | 'ready' | 'error'

export type DesktopUpdate = Pick<Update, 'currentVersion' | 'version'> & {
  isMock?: boolean
  downloadAndInstall: (onEvent: (event: DownloadEvent) => void) => Promise<void>
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isMockUpdateEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return env?.VITE_MOCK_DESKTOP_UPDATE === 'true'
}

function mockUpdateVersion(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return env?.VITE_MOCK_DESKTOP_UPDATE_VERSION || '99.0.0-test'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createMockUpdate(): DesktopUpdate {
  return {
    currentVersion: '1.40.1',
    version: mockUpdateVersion(),
    isMock: true,
    async downloadAndInstall(onEvent) {
      const total = 18 * 1024 * 1024
      const chunks = 12

      onEvent({ event: 'Started', data: { contentLength: total } } as DownloadEvent)
      for (let i = 0; i < chunks; i += 1) {
        await delay(180)
        onEvent({ event: 'Progress', data: { chunkLength: Math.round(total / chunks) } } as DownloadEvent)
      }
      onEvent({ event: 'Finished' } as DownloadEvent)
    },
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return i18n.t('commands:update.units.kb', { value: Math.max(1, Math.round(bytes / 1024)) })
  return i18n.t('commands:update.units.mb', { value: (bytes / (1024 * 1024)).toFixed(1) })
}

function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_UPDATE_KEY)
  } catch {
    return null
  }
}

function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_UPDATE_KEY, version)
  } catch {
    // non-fatal; the current toast still dismisses
  }
  toast.dismiss(UPDATE_TOAST_ID)
}

// Per-state accent token (semantic theme tokens only — never brand-named).
// `error` keeps the primary accent for chrome and conveys failure via icon + copy,
// honouring the theme token contract (no destructive token in the allow-list).
function accentFor(state: UpdateToastState): string {
  switch (state) {
    case 'downloading':
      return 'var(--color-accent-info)'
    case 'ready':
      return 'var(--color-accent-success)'
    default:
      return 'var(--color-accent-primary)'
  }
}

function StateIcon({ state }: { state: UpdateToastState }) {
  const cls = 'h-[15px] w-[15px]'
  if (state === 'installing') return <Cog className={`${cls} u-spin`} aria-hidden />
  if (state === 'ready') return <Check className={`${cls} u-check`} aria-hidden />
  if (state === 'error') return <AlertTriangle className={cls} aria-hidden />
  return <DownloadCloud className={cls} aria-hidden />
}

/** Always-mounted progress track. Its inner fill/animation differs per state, but
 * the row itself never unmounts — keeping the card height invariant so sonner's
 * once-on-mount height measurement stays valid (no stacking jank / clipping). */
function ProgressTrack({
  state,
  progress,
}: {
  state: UpdateToastState
  progress: number | null
}) {
  const determinate = state === 'downloading' && progress != null
  const indeterminate = state === 'installing' || (state === 'downloading' && progress == null)
  const full = state === 'ready'

  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full border border-border/30 bg-background/70">
      {determinate && (
        <div
          className="relative h-full overflow-hidden rounded-full bg-[color:var(--u-accent)] transition-[width] duration-300 ease-out"
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={progress ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="u-shimmer" aria-hidden />
        </div>
      )}
      {indeterminate && <span className="u-indeterminate" aria-hidden />}
      {full && <div className="h-full w-full rounded-full bg-[color:var(--u-accent)]/80" aria-hidden />}
      {/* available / error → empty dim track (nothing rendered) */}
    </div>
  )
}

export function DesktopUpdateToast({
  update,
  onClose,
}: {
  update: DesktopUpdate
  onClose?: () => void
}) {
  const { t } = useTranslation('commands')
  const [state, setState] = useState<UpdateToastState>('available')
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function installUpdate() {
    try {
      setState('downloading')
      setDownloaded(0)
      setTotal(null)
      setError(null)

      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          setTotal(event.data.contentLength ?? null)
          setDownloaded(0)
          return
        }
        if (event.event === 'Progress') {
          setDownloaded((prev) => prev + event.data.chunkLength)
          return
        }
        setState('installing')
      })

      setState('ready')
    } catch (err) {
      setError((err as Error).message || t('update.errors.installFailed'))
      setState('error')
    }
  }

  function handleRestart() {
    if (update.isMock) {
      toast.success(t('update.mockReady'), { duration: 2500 })
      toast.dismiss(UPDATE_TOAST_ID)
      onClose?.()
      return
    }
    // Use the Rust `restart_app` command (not plugin-process relaunch directly):
    // it terminates the sidecar and waits for port 4200 to free BEFORE restarting,
    // so the relaunched instance never hits a port conflict (no second restart).
    void invoke('restart_app').catch(() => {
      // Fallback for older hosts without the command registered.
      void relaunch()
    })
  }

  const progress = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null

  const accent = accentFor(state)
  const busy = state === 'downloading' || state === 'installing'

  const title =
    state === 'downloading'
      ? t('update.title.downloading')
      : state === 'installing'
        ? t('update.title.installing')
        : state === 'ready'
          ? t('update.title.ready')
          : state === 'error'
            ? t('update.title.error')
            : t('update.title.available')

  const description =
    state === 'available'
      ? t('update.desc.available')
      : state === 'downloading'
        ? progress == null
          ? t('update.desc.fetching', { size: formatBytes(downloaded) })
          : t('update.desc.progress', { percent: progress, downloaded: formatBytes(downloaded), total: formatBytes(total ?? 0) })
        : state === 'installing'
          ? t('update.desc.installing')
          : state === 'ready'
            ? t('update.desc.ready', { version: update.version })
            : (error && error.length <= 80 ? error : t('update.desc.errorFallback'))

  // Right-hand pill: version delta when idle, status word while working, hidden on error.
  const pill =
    state === 'available'
      ? `${update.currentVersion} → ${update.version}`
      : state === 'downloading'
        ? t('update.pill.downloading')
        : state === 'installing'
          ? t('update.pill.installing')
          : state === 'ready'
            ? t('update.pill.ready')
            : null

  return (
    <div
      className="u-update-card relative flex w-full flex-col gap-2 overflow-hidden"
      style={{ ['--u-accent' as string]: accent }}
      role={state === 'error' ? 'alert' : 'status'}
      aria-live={state === 'error' ? 'assertive' : 'polite'}
      data-state={state}
    >
      {/* Top accent hairline — static at rest, pulsing while working, flash on ready */}
      <span className="u-glow" aria-hidden />

      <div className="flex items-center gap-2.5">
        <span
          className="u-badge grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border/50 bg-background/60 text-[color:var(--u-accent)]"
          aria-hidden
        >
          <StateIcon state={state} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight text-foreground">
          {title}
        </span>
        {pill != null && (
          <span
            className="shrink-0 whitespace-nowrap rounded-md border border-border/40 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
            style={state !== 'available' ? { color: 'var(--u-accent)' } : undefined}
          >
            {pill}
          </span>
        )}
      </div>

      <p className="h-4 truncate text-[11px] leading-4 text-muted-foreground" data-testid="update-description">
        {description}
      </p>

      <ProgressTrack state={state} progress={progress} />

      <div className="flex items-center justify-end gap-1.5">
        {state === 'ready' ? (
          <>
            <button
              type="button"
              className="inline-grid h-7 min-w-[64px] place-items-center rounded-lg border border-[color:var(--u-accent)]/45 bg-[color:var(--u-accent)]/15 px-3 text-[11px] font-semibold leading-none text-foreground transition-colors hover:bg-[color:var(--u-accent)]/25"
              onClick={handleRestart}
            >
              {t('update.actions.restart')}
            </button>
            <button
              type="button"
              className="h-7 rounded-lg px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={() => {
                toast.dismiss(UPDATE_TOAST_ID)
                onClose?.()
              }}
            >
              {t('update.actions.later')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="inline-grid h-7 min-w-[64px] place-items-center rounded-lg border border-[color:var(--u-accent)]/45 bg-[color:var(--u-accent)]/15 px-3 text-[11px] font-semibold leading-none text-foreground transition-colors hover:bg-[color:var(--u-accent)]/25 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => void installUpdate()}
            >
              {state === 'installing' ? t('update.actions.installing') : state === 'error' ? t('update.actions.tryAgain') : t('update.actions.update')}
            </button>
            <button
              type="button"
              className="h-7 rounded-lg px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
              onClick={() => {
                dismissVersion(update.version)
                onClose?.()
              }}
            >
              {t('update.actions.dismiss')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Surface the standard update card for an already-checked update. Used by the
 *  Settings ▸ Updates manual check — an explicit user action, so it bypasses the
 *  dismissed-version gate (the fixed toast id keeps it idempotent). */
export function showDesktopUpdateToast(update: DesktopUpdate): void {
  toast.custom(() => <DesktopUpdateToast update={update} />, {
    id: UPDATE_TOAST_ID,
    duration: Infinity,
    dismissible: false,
    unstyled: true,
    closeButton: false,
  })
}

export function useDesktopUpdateNotifier() {
  useEffect(() => {
    const useMockUpdate = isMockUpdateEnabled()
    if (!useMockUpdate && !isTauriRuntime()) return

    let cancelled = false
    const shown = { current: false }

    async function checkForUpdate() {
      if (cancelled || shown.current) return
      try {
        const update = useMockUpdate ? createMockUpdate() : await check()
        if (cancelled || !update || readDismissedVersion() === update.version) return
        shown.current = true
        toast.custom(() => <DesktopUpdateToast update={update} onClose={() => { shown.current = false }} />, {
          id: UPDATE_TOAST_ID,
          duration: Infinity,
          dismissible: false,
          unstyled: true,
          closeButton: false,
          onDismiss: () => { shown.current = false },
          onAutoClose: () => { shown.current = false },
        })
      } catch (err) {
        console.warn('[desktop-update] update check failed:', err)
        // leave shown=false so the next interval tick retries
      }
    }

    void checkForUpdate()
    // Periodic re-check: recovers from a transient failure at launch and surfaces
    // releases published while the app stays open. The fixed toast id + the
    // dismissed-version gate keep this idempotent; `shown` avoids disrupting an
    // in-progress download.
    const interval = setInterval(() => void checkForUpdate(), RECHECK_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])
}
