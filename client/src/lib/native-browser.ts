// Native embedded browser pane — pure logic + thin Tauri IPC wrappers.
//
// The pane itself is a Tauri child webview (see src-tauri/src/browser.rs);
// this module owns everything unit-testable about it: address normalization,
// the scheme policy, hole-rect → logical-bounds mapping, and the memoized
// availability probe with its fallback semantics. The IPC transport is
// injectable so tests never touch @tauri-apps/api.

import { isTauri } from './tauri-shell'
import { FEATURE_NATIVE_BROWSER } from './feature-flags'

export interface PaneBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeBrowserEvent {
  kind: 'nav' | 'load-started' | 'load-finished' | 'title' | 'closed'
  url?: string | null
  title?: string | null
}

export const NATIVE_BROWSER_EVENT = 'native-browser:event'

/**
 * Normalize a user-typed address for the NATIVE pane. Bare hosts are upgraded
 * to `https://`; only `http:`/`https:`/`about:blank` survive. Unlike the
 * server-side screencast guard, loopback/private hosts are allowed — this is
 * client-side browsing in the user's own webview (dev-server preview is a
 * first-class use case). Returns the normalized URL string or null when the
 * input is unusable.
 */
export function normalizeAddress(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (trimmed === 'about:blank') return trimmed
  const direct = tryParseUrl(trimmed)
  if (direct) {
    if (direct.protocol === 'http:' || direct.protocol === 'https:') return direct.toString()
    // `host:port` inputs (localhost:5173, example.com:8080/x) parse as
    // scheme=host with a port-shaped path — those retry as https below. Real
    // schemes (file:, javascript:, data:, chrome:) never look like that.
    const tail = `${direct.pathname}${direct.search}${direct.hash}`
    if (!/^\d+([/?#].*)?$/.test(tail)) return null
  }
  const upgraded = tryParseUrl(`https://${trimmed}`)
  if (upgraded && upgraded.protocol === 'https:') return upgraded.toString()
  return null
}

function tryParseUrl(candidate: string): URL | null {
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

/** Map a hole element's client rect (CSS logical px) to pane bounds. */
export function rectToBounds(rect: { left: number; top: number; width: number; height: number }): PaneBounds {
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
export type ListenFn = (
  event: string,
  cb: (e: { payload: NativeBrowserEvent }) => void,
) => Promise<() => void>

let invokeOverride: InvokeFn | null = null
let listenOverride: ListenFn | null = null
let supportProbe: Promise<boolean> | null = null

/** Test seam: inject IPC fakes and reset the memoized probe. */
export function _setNativeBrowserIpcForTests(invoke: InvokeFn | null, listen?: ListenFn | null): void {
  invokeOverride = invoke
  listenOverride = listen ?? null
  supportProbe = null
}

async function getInvoke(): Promise<InvokeFn> {
  if (invokeOverride) return invokeOverride
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke as InvokeFn
}

/**
 * Memoized availability probe — step 1 of the fallback ladder. True only when
 * the feature flag is on AND we run inside Tauri AND the Rust side reports the
 * platform as supported. Any probe failure resolves false (→ screencast).
 */
export function isNativeBrowserAvailable(opts?: { flag?: boolean; tauri?: boolean }): Promise<boolean> {
  const flag = opts?.flag ?? FEATURE_NATIVE_BROWSER
  const inTauri = opts?.tauri ?? isTauri()
  if (!flag || !inTauri) return Promise.resolve(false)
  if (!supportProbe) {
    supportProbe = (async () => {
      try {
        const invoke = await getInvoke()
        return (await invoke<boolean>('browser_supported')) === true
      } catch {
        return false
      }
    })()
  }
  return supportProbe
}

async function inv<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = await getInvoke()
  return invoke<T>(cmd, args)
}

/** Thin command wrappers around the Rust pane (src-tauri/src/browser.rs). */
export const nativeBrowser = {
  open: (url: string, bounds: PaneBounds) => inv('browser_open', { url, bounds }),
  navigate: (url: string) => inv('browser_navigate', { url }),
  back: () => inv('browser_back'),
  forward: () => inv('browser_forward'),
  reload: () => inv('browser_reload'),
  setBounds: (bounds: PaneBounds) => inv('browser_set_bounds', { bounds }),
  show: () => inv('browser_show'),
  hide: () => inv('browser_hide'),
  close: () => inv('browser_close'),
  devtools: () => inv('browser_devtools'),
  zoom: (factor: number) => inv('browser_zoom', { factor }),
  /** Subscribe to pane events; resolves to the unlisten function. */
  onEvent: async (cb: (e: NativeBrowserEvent) => void): Promise<() => void> => {
    if (listenOverride) return listenOverride(NATIVE_BROWSER_EVENT, (e) => cb(e.payload))
    const { listen } = await import('@tauri-apps/api/event')
    return listen<NativeBrowserEvent>(NATIVE_BROWSER_EVENT, (e) => cb(e.payload))
  },
}
