import { isTauri } from '../../../lib/tauri-shell'

export function isPluginWindowRoute(): boolean {
  return new URLSearchParams(window.location.search).get('pluginsWindow') === '1'
}

let browserWindow: Window | null = null

/** Reopening focuses the current manager without resetting its forms. */
export async function openPluginWindow(): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin_window_open')
    return
  }
  if (browserWindow && !browserWindow.closed) { browserWindow.focus(); return }
  const url = new URL('/', window.location.origin)
  url.searchParams.set('pluginsWindow', '1')
  browserWindow = window.open(url.href, 'specrails-plugins', 'popup,width=1400,height=900,resizable=yes,scrollbars=yes')
  if (!browserWindow) throw new Error('The Plugins window could not be opened. Allow pop-up windows and retry.')
}
