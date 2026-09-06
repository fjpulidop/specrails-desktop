declare const __WS_URL__: string

export function getWsUrl(configuredUrl = typeof __WS_URL__ !== 'undefined' ? __WS_URL__ : ''): string {
  // In dev mode, Vite injects the backend WS URL directly (bypasses Vite's own WS)
  if (configuredUrl) {
    return configuredUrl
  }
  // In Tauri, window.location is tauri://localhost — must use explicit port 4200.
  // Check __TAURI_INTERNALS__ OR any non-http(s) protocol: WebView2 under Windows
  // ARM64 emulation may not expose the IPC symbol at module-load time.
  const inTauri =
    (typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || window.location.hostname === 'tauri.localhost')) ||
    (typeof window !== 'undefined' &&
      window.location.protocol !== 'http:' &&
      window.location.protocol !== 'https:')
  if (inTauri) {
    return 'ws://127.0.0.1:4200'
  }
  // In production browser, derive from page origin
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

export const WS_URL = getWsUrl()
