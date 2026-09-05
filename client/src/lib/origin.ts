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
export const API_ORIGIN = (() => {
  if (typeof window === 'undefined') return ''
  if ('__TAURI_INTERNALS__' in window || window.location.hostname === 'tauri.localhost') return 'http://localhost:4200'
  const proto = window.location.protocol
  if (proto !== 'http:' && proto !== 'https:') return 'http://localhost:4200'
  return ''
})()
