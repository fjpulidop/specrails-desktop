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
  ownerId: string
  kind: 'nav' | 'load-started' | 'load-finished' | 'title' | 'closed' | 'popup-error' | 'popup-opened'
  url?: string | null
  title?: string | null
}

export interface NativeBrowserSelection {
  selector: string
  tagName: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

export interface NativeBrowserCapture {
  screenshotDataUrl: string
  url: string
  title: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  element?: NativeBrowserSelection | null
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
  if (upgraded && upgraded.protocol === 'https:') {
    // Development servers normally expose HTTP, including IPv6 loopback.
    const hostname = upgraded.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname)) upgraded.protocol = 'http:'
    return upgraded.toString()
  }
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
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
  return {
    x: Math.max(0, Math.round(finite(rect.left, 0))),
    y: Math.max(0, Math.round(finite(rect.top, 0))),
    width: Math.max(1, Math.round(finite(rect.width, 1))),
    height: Math.max(1, Math.round(finite(rect.height, 1))),
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
let captureProbe: Promise<boolean> | null = null
let lifecycle: Promise<unknown> = Promise.resolve()

/** Test seam: inject IPC fakes and reset the memoized probe. */
export function _setNativeBrowserIpcForTests(invoke: InvokeFn | null, listen?: ListenFn | null): void {
  invokeOverride = invoke
  listenOverride = listen ?? null
  supportProbe = null
  captureProbe = null
  lifecycle = Promise.resolve()
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
        // An IPC failure during startup is not a permanent platform verdict.
        supportProbe = null
        return false
      }
    })()
  }
  return supportProbe
}

/** Capture must use the same live native page, never a second browser profile. */
export async function isNativeBrowserCaptureAvailable(opts?: { flag?: boolean; tauri?: boolean }): Promise<boolean> {
  if (!await isNativeBrowserAvailable(opts)) return false
  if (!captureProbe) {
    captureProbe = inv<boolean>('browser_capture_supported').then(result => result === true).catch(() => {
      captureProbe = null
      return false
    })
  }
  return captureProbe
}

async function inv<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = await getInvoke()
  return invoke<T>(cmd, args)
}

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(operation, operation)
  lifecycle = next.catch(() => {})
  return next
}

/** Every operation belongs to a single pane lifetime, including late cleanup. */
export const nativeBrowser = {
  open: (ownerId: string, url: string, bounds: PaneBounds) => serializeLifecycle(() => inv('browser_open', { ownerId, url, bounds })),
  navigate: (ownerId: string, url: string) => inv('browser_navigate', { ownerId, url }),
  back: (ownerId: string) => inv('browser_back', { ownerId }),
  forward: (ownerId: string) => inv('browser_forward', { ownerId }),
  reload: (ownerId: string) => inv('browser_reload', { ownerId }),
  setBounds: (ownerId: string, bounds: PaneBounds) => inv('browser_set_bounds', { ownerId, bounds }),
  show: (ownerId: string) => inv('browser_show', { ownerId }),
  hide: (ownerId: string) => inv('browser_hide', { ownerId }),
  close: (ownerId: string) => serializeLifecycle(() => inv('browser_close', { ownerId })),
  devtools: (ownerId: string) => inv('browser_devtools', { ownerId }),
  zoom: (ownerId: string, factor: number) => inv('browser_zoom', { ownerId, factor }),
  setSelectMode: (ownerId: string, enabled: boolean) => inv('browser_set_select_mode', { ownerId, enabled }),
  selection: (ownerId: string) => inv<NativeBrowserSelection | null>('browser_selection', { ownerId }),
  capture: (ownerId: string, selectionOnly: boolean) => inv<NativeBrowserCapture>('browser_capture', { ownerId, selectionOnly }),
  /** Subscribe to pane events; resolves to the unlisten function. */
  onEvent: async (ownerId: string, cb: (e: NativeBrowserEvent) => void): Promise<() => void> => {
    const receive = (e: { payload: NativeBrowserEvent }) => { if (e.payload.ownerId === ownerId) cb(e.payload) }
    if (listenOverride) return listenOverride(NATIVE_BROWSER_EVENT, receive)
    const { listen } = await import('@tauri-apps/api/event')
    return listen<NativeBrowserEvent>(NATIVE_BROWSER_EVENT, receive)
  },
}
