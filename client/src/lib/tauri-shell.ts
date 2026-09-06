/**
 * Thin Tauri shell helpers. All functions are no-ops outside the Tauri webview.
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
}

/** Explicit host command: bundled by Vite and enforced by the main-view guard. */
export async function revealItemInDir(path: string): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('desktop_reveal_path', { path })
}

/** Open a URL in the user's default external browser. In Tauri this goes
 *  through the shell plugin so it leaves the WebView; in plain browsers it
 *  falls back to window.open which opens a new tab in the same browser. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const shell = await import('@tauri-apps/plugin-shell')
      if (typeof shell.open === 'function') {
        await shell.open(url)
        return
      }
    } catch (err) {
      console.warn('[openExternalUrl] tauri shell open failed:', err)
    }
  }
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
}
