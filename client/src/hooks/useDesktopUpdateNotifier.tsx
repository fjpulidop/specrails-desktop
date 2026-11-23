import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'
import { checkAppUpdate } from '../lib/app-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { DownloadCloud, Cog, Check, AlertTriangle, Hourglass } from 'lucide-react'
import i18n from '../lib/i18n'
import { fetchActiveWork, noteUpdateRestart, type ActiveWork } from '../lib/continuity-api'
import { whenIdle } from '../lib/startup-queue'

const DISMISSED_UPDATE_KEY = 'specrails-desktop:dismissedDesktopUpdateVersion'
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h — surface releases published mid-session
/** "Install when nothing is running": how often the card re-checks for active work. */
export const IDLE_POLL_MS = 5_000

/** `busy`: ready, but a restart would interrupt running work; `waiting`: restarts as soon as nothing runs. */
type UpdateToastState = 'available' | 'downloading' | 'installing' | 'ready' | 'busy' | 'waiting' | 'error'

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
    // non-fatal; the offer still goes away for this session
  }
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
    case 'busy':
    case 'waiting':
      return 'var(--color-accent-warning)'
    default:
      return 'var(--color-accent-primary)'
  }
}

function StateIcon({ state }: { state: UpdateToastState }) {
  const cls = 'h-[15px] w-[15px]'
  if (state === 'installing') return <Cog className={`${cls} u-spin`} aria-hidden />
  if (state === 'ready') return <Check className={`${cls} u-check`} aria-hidden />
  if (state === 'waiting') return <Hourglass className={cls} aria-hidden />
  if (state === 'busy') return <AlertTriangle className={cls} aria-hidden />
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
  const indeterminate = state === 'installing' || state === 'waiting' || (state === 'downloading' && progress == null)
  const full = state === 'ready' || state === 'busy'

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

function describeWork(t: (key: string, options?: Record<string, unknown>) => string, work: ActiveWork | null, state: 'busy' | 'waiting'): string {
  const missions = work?.missions ?? 0
  const runs = work?.runs ?? 0
  const parts = [
    ...(missions > 0 ? [t('update.work.missions', { count: missions })] : []),
    ...(runs > 0 ? [t('update.work.runs', { count: runs })] : []),
  ]
  const what = parts.join(' · ') || t('update.work.something')
  return state === 'waiting' ? t('update.desc.waiting', { what }) : t('update.desc.busy', { what })
}

export function DesktopUpdateToast({
  update,
  onClose,
  onDismiss,
}: {
  update: DesktopUpdate
  /** Hide the card for now (Later, or after a mock restart). */
  onClose?: () => void
  /** This version was dismissed: the offer goes away for good. */
  onDismiss?: () => void
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

  const [work, setWork] = useState<ActiveWork | null>(null)

  async function restartNow() {
    if (update.isMock) {
      toast.success(t('update.mockReady'), { duration: 2500 })
      onDismiss?.()
      onClose?.()
      return
    }
    // Interrupted mission turns are offered back after the restart as "update".
    await noteUpdateRestart()
    // Use the Rust `restart_app` command (not plugin-process relaunch directly):
    // it terminates the sidecar and waits for port 4200 to free BEFORE restarting,
    // so the relaunched instance never hits a port conflict (no second restart).
    void invoke('restart_app').catch(() => {
      // Fallback for older hosts without the command registered.
      void relaunch()
    })
  }

  /** Restart only when nothing runs; otherwise say what would stop and let the person choose. */
  async function handleRestart() {
    const active = await fetchActiveWork()
    if (active && active.total > 0) {
      setWork(active)
      setState('busy')
      return
    }
    await restartNow()
  }

  // "Install when nothing is running": poll until the last turn/run ends, then restart.
  useEffect(() => {
    if (state !== 'waiting') return
    let cancelled = false
    const tick = async () => {
      const active = await fetchActiveWork()
      if (cancelled) return
      if (active) setWork(active)
      if (active && active.total === 0) {
        cancelled = true
        await restartNow()
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), IDLE_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
    // restartNow only reads props/translations that are stable for this card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

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
          : state === 'busy'
            ? t('update.title.busy')
            : state === 'waiting'
              ? t('update.title.waiting')
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
            : state === 'busy' || state === 'waiting'
              ? describeWork(t, work, state)
            : (error && error.length <= 80 ? error : t('update.desc.errorFallback'))

  // Right-hand pill: version delta when idle, status word while working, hidden on error.
  const pill =
    state === 'available'
      ? `${update.currentVersion} → ${update.version}`
      : state === 'downloading'
        ? t('update.pill.downloading')
        : state === 'installing'
          ? t('update.pill.installing')
          : state === 'ready' || state === 'busy'
            ? t('update.pill.ready')
            : state === 'waiting'
              ? t('update.pill.waiting')
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
        <span className="min-w-0 flex-1 truncate text-strong leading-tight text-foreground">
          {title}
        </span>
        {pill != null && (
          <span
            className="shrink-0 whitespace-nowrap rounded-md border border-border/40 bg-background/60 px-1.5 py-0.5 text-caption font-medium tabular-nums text-muted-foreground"
            style={state !== 'available' ? { color: 'var(--u-accent)' } : undefined}
          >
            {pill}
          </span>
        )}
      </div>

      <p className="h-4 truncate text-caption leading-4 text-muted-foreground" data-testid="update-description">
        {description}
      </p>

      <ProgressTrack state={state} progress={progress} />

      <div className="flex items-center justify-end gap-1.5">
        {state === 'busy' || state === 'waiting' ? (
          <>
            {state === 'busy' ? (
              <button
                type="button"
                className="inline-grid h-7 min-w-[64px] place-items-center rounded-lg border border-[color:var(--u-accent)]/45 bg-[color:var(--u-accent)]/15 px-3 text-caption font-semibold leading-none text-foreground transition-colors hover:bg-[color:var(--u-accent)]/25"
                onClick={() => setState('waiting')}
              >
                {t('update.actions.whenIdle')}
              </button>
            ) : (
              <button
                type="button"
                className="h-7 rounded-lg px-2.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
                onClick={() => setState('ready')}
              >
                {t('update.actions.cancelWait')}
              </button>
            )}
            <button
              type="button"
              className="h-7 rounded-lg px-2.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={() => void restartNow()}
            >
              {t('update.actions.restartNow')}
            </button>
          </>
        ) : state === 'ready' ? (
          <>
            <button
              type="button"
              className="inline-grid h-7 min-w-[64px] place-items-center rounded-lg border border-[color:var(--u-accent)]/45 bg-[color:var(--u-accent)]/15 px-3 text-caption font-semibold leading-none text-foreground transition-colors hover:bg-[color:var(--u-accent)]/25"
              onClick={() => void handleRestart()}
            >
              {t('update.actions.restart')}
            </button>
            <button
              type="button"
              className="h-7 rounded-lg px-2.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={() => onClose?.()}
            >
              {t('update.actions.later')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="inline-grid h-7 min-w-[64px] place-items-center rounded-lg border border-[color:var(--u-accent)]/45 bg-[color:var(--u-accent)]/15 px-3 text-caption font-semibold leading-none text-foreground transition-colors hover:bg-[color:var(--u-accent)]/25 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => void installUpdate()}
            >
              {state === 'installing' ? t('update.actions.installing') : state === 'error' ? t('update.actions.tryAgain') : t('update.actions.update')}
            </button>
            <button
              type="button"
              className="h-7 rounded-lg px-2.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
              onClick={() => {
                dismissVersion(update.version)
                onDismiss?.()
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

// ─── The discreet update offer ──────────────────────────────────────────────
// A found update is an OFFER held here; the status bar shows it as a small
// chip (`components/DesktopUpdateChip.tsx`) that opens this card. Never a
// toast that stays forever, never over a modal (lib/startup-queue.ts).

let offer: DesktopUpdate | null = null
const offerListeners = new Set<() => void>()

export const desktopUpdateOffer = {
  get: (): DesktopUpdate | null => offer,
  set(next: DesktopUpdate | null): void {
    offer = next
    offerListeners.forEach((listener) => listener())
  },
  subscribe(listener: () => void): () => void {
    offerListeners.add(listener)
    return () => { offerListeners.delete(listener) }
  },
}

export function useDesktopUpdateOffer(): DesktopUpdate | null {
  return useSyncExternalStore(desktopUpdateOffer.subscribe, desktopUpdateOffer.get)
}

/**
 * Checks for a desktop update at launch and every 6 h. A found update is
 * offered only once the app has been quiet ~30 s with no modal open
 * (`whenIdle`), then waits in the status bar until the person opens it.
 */
export function useDesktopUpdateNotifier() {
  useEffect(() => {
    const useMockUpdate = isMockUpdateEnabled()
    if (!useMockUpdate && !isTauriRuntime()) return

    const controller = new AbortController()

    async function checkForUpdate() {
      if (controller.signal.aborted || desktopUpdateOffer.get()) return
      try {
        const update = useMockUpdate ? createMockUpdate() : await checkAppUpdate()
        if (controller.signal.aborted || !update || readDismissedVersion() === update.version) return
        await whenIdle(controller.signal)
        if (!desktopUpdateOffer.get()) desktopUpdateOffer.set(update)
      } catch (err) {
        if (controller.signal.aborted) return
        console.warn('[desktop-update] update check failed:', err)
        // no offer: the next interval tick retries
      }
    }

    void checkForUpdate()
    // Periodic re-check: recovers from a transient failure at launch and surfaces
    // releases published while the app stays open. An existing offer is kept
    // (never disrupts an in-progress download).
    const interval = setInterval(() => void checkForUpdate(), RECHECK_INTERVAL_MS)

    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [])
}
