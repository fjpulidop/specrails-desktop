import { isTauri } from './tauri-shell'
import i18n from './i18n'

interface NotifyArgs {
  command: string | null
  exitCode: number | null
  elapsedMs: number
}

const debounce = new Map<string, number>()
const DEBOUNCE_WINDOW_MS = 5_000

export function shouldNotify(): boolean {
  return typeof document !== 'undefined' && !document.hasFocus()
}

export async function notifyCommandFinished(sessionId: string, args: NotifyArgs): Promise<void> {
  const key = `${sessionId}:${args.command ?? ''}`
  const now = Date.now()
  const last = debounce.get(key) ?? 0
  if (now - last < DEBOUNCE_WINDOW_MS) return
  debounce.set(key, now)

  const title = args.command
    ? i18n.t('terminal:notifications.commandFinishedNamed', { command: truncate(args.command, 50) })
    : i18n.t('terminal:notifications.commandFinished')
  const body = i18n.t('terminal:notifications.finishedBody', {
    code: args.exitCode ?? '?',
    elapsed: formatElapsed(args.elapsedMs),
  })

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('desktop_notify', { title, body })
    } catch { /* Notification policy must never interrupt the terminal. */ }
    return
  }

  // Browser fallback.
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission().catch(() => 'denied')
      if (perm !== 'granted') return
    }
    if (Notification.permission !== 'granted') return
    new Notification(title, { body })
  } catch { /* ignore */ }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return i18n.t('terminal:duration.seconds', { seconds: (ms / 1000).toFixed(1) })
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return i18n.t('terminal:duration.minutesSeconds', { minutes: m, seconds: s })
}
