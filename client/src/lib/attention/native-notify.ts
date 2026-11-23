/**
 * The one way the app shows an OS notification. In the desktop app it calls
 * the guarded host command `desktop_notify` (main window only; no plugin
 * permission is granted to the webview, so the plugin's `window.Notification`
 * polyfill is never relied on). In a browser it uses the Web Notification API.
 *
 * Native notifications in the desktop app cannot report a click back; a
 * browser notification can (`onClick`). Callers that need a way back use the
 * attention center's return toast.
 */
import { isTauri } from '../tauri-shell'

export interface NativeNotification {
  title: string
  body: string
  /** Browser only: a notification with the same tag replaces the previous one. */
  tag?: string
  /**
   * `true` plays the platform's default notification sound, `false` asks for a
   * silent one. Left out: the desktop app is silent and a browser uses its default.
   */
  sound?: boolean
  /** Browser only: the notification was clicked (the window is focused first). */
  onClick?: () => void
}

// The host command bounds sizes in bytes (title ≤ 512, body ≤ 4096). These
// character limits stay inside them even for 3-byte (CJK) text.
const MAX_TITLE_CHARS = 150
const MAX_BODY_CHARS = 1_000

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** Resolves to whether the notification was handed to the system. Never throws. */
export async function showNativeNotification(notification: NativeNotification): Promise<boolean> {
  const title = clip(notification.title.trim() || 'Specrails', MAX_TITLE_CHARS)
  const body = clip(notification.body, MAX_BODY_CHARS)
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('desktop_notify', { title, body, sound: notification.sound === true })
      return true
    } catch {
      return false
    }
  }
  try {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission)
      if (permission !== 'granted') return false
    }
    if (Notification.permission !== 'granted') return false
    const shown = new Notification(title, { body, tag: notification.tag, silent: notification.sound === false })
    const onClick = notification.onClick
    if (onClick) {
      shown.onclick = () => {
        try { window.focus() } catch { /* not focusable */ }
        onClick()
        shown.close()
      }
    }
    return true
  } catch {
    return false
  }
}
