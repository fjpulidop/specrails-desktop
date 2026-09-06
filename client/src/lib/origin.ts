/**
 * In the Tauri desktop app the frontend is served by Tauri's internal file
 * server, so relative URLs (/api/...) resolve to the wrong origin.
 * All network calls must use this prefix to hit the Express server.
 *
 * Detection uses both __TAURI_INTERNALS__ (set by Tauri's IPC bridge) and
 * window.location.protocol. On WebView2 under Windows ARM64 emulation the
 * IPC symbol is not always present at module-load time, but the tauri://
 * protocol is — so the protocol check is the reliable fallback.
 */
declare const __API_ORIGIN__: string

export function getApiOrigin(configuredOrigin = typeof __API_ORIGIN__ !== 'undefined' ? __API_ORIGIN__ : ''): string {
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol
  if ('__TAURI_INTERNALS__' in window || window.location.hostname === 'tauri.localhost' || (proto !== 'http:' && proto !== 'https:')) {
    return configuredOrigin || 'http://127.0.0.1:4200'
  }
  // Browser requests use Vite's proxy in dev and the page origin in production.
  return ''
}

export const API_ORIGIN = getApiOrigin()
