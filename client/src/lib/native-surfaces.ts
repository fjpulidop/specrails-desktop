/**
 * Native-window transport for modal surfaces (docs/internals/native-window-surfaces.md).
 *
 * In the Tauri app an opted-in surface opens as its own OS window owned by the
 * window that opened it (`src-tauri/src/surface_windows.rs`). Each window is a
 * separate JS context, so a surface crosses the boundary as:
 *   - an id plus string params (the window's URL: `index.html?surfaceWindow=<id>&…`),
 *   - a request id that correlates `result` and `closed` events back to the opener,
 *   - localStorage writes mirrored to the opener as `storage` events (theme,
 *     language, a11y prefs set in the surface apply live in the main window).
 * The web build never takes this path; callers keep their Radix modal.
 */
import { isTauri } from './tauri-shell'

/** Surfaces that may open natively. Must match `SURFACES` in surface_windows.rs. */
export const NATIVE_SURFACE_IDS = ['app-settings', 'job-detail'] as const
export type NativeSurfaceId = (typeof NATIVE_SURFACE_IDS)[number]
export type SurfaceParams = Record<string, string>

/** Opt-out switch (`localStorage['specrails.nativeSurfaces'] = 'off'`) for support and rollout. */
export const NATIVE_SURFACES_PREF_KEY = 'specrails.nativeSurfaces'
export const SURFACE_WINDOW_EVENT = 'surface-window:event'
export const SURFACE_STORAGE_EVENT = 'surface-window:storage'
const SURFACE_QUERY = 'surfaceWindow'

export interface SurfaceWindowEvent {
  kind: 'result' | 'closed'
  surface: NativeSurfaceId
  requestId: string
  windowLabel: string
  result?: unknown
}

export interface OpenedSurfaceWindow {
  windowLabel: string
  /** The live request. A reused window keeps the request id it was opened with. */
  requestId: string
  reused: boolean
}

export interface SurfaceGeometry { x?: number; y?: number; width?: number; height?: number }

function isNativeSurfaceId(value: string | null): value is NativeSurfaceId {
  return value !== null && (NATIVE_SURFACE_IDS as readonly string[]).includes(value)
}

/** The surface this window renders, when it is a surface window. */
export function surfaceWindowRoute(search = typeof window === 'undefined' ? '' : window.location.search): { id: NativeSurfaceId; requestId: string; params: SurfaceParams } | null {
  const query = new URLSearchParams(search)
  const id = query.get(SURFACE_QUERY)
  if (!isNativeSurfaceId(id)) return null
  const params: SurfaceParams = {}
  query.forEach((value, key) => { if (key !== SURFACE_QUERY && key !== 'requestId') params[key] = value })
  return { id, requestId: query.get('requestId') ?? '', params }
}

export function isSurfaceWindowRoute(): boolean {
  return surfaceWindowRoute() !== null
}

function readPref(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/**
 * Whether `id` opens as a native window here: inside Tauri, not switched off,
 * and not from inside another surface window (surfaces never nest windows; a
 * dialog opened inside one stays an in-window modal).
 */
export function nativeSurfaceEnabled(id: NativeSurfaceId): boolean {
  return nativeWindowsAllowed() && (NATIVE_SURFACE_IDS as readonly string[]).includes(id)
}

/** Native windows may open from here: Tauri, not a surface window, not switched off. */
export function nativeWindowsAllowed(): boolean {
  return isTauri() && !isSurfaceWindowRoute() && readPref(NATIVE_SURFACES_PREF_KEY) !== 'off'
}

export function newSurfaceRequestId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `req-${random}`
}

// ─── Geometry ────────────────────────────────────────────────────────────────

export function surfaceGeometryKey(id: NativeSurfaceId): string {
  return `specrails.surface.${id}.geometry`
}

export function loadSurfaceGeometry(id: NativeSurfaceId): SurfaceGeometry | null {
  const raw = readPref(surfaceGeometryKey(id))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const geometry: SurfaceGeometry = {}
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const value = parsed[key]
      if (typeof value === 'number' && Number.isFinite(value)) geometry[key] = value
    }
    return Object.keys(geometry).length ? geometry : null
  } catch {
    return null
  }
}

export function saveSurfaceGeometry(id: NativeSurfaceId, geometry: SurfaceGeometry): void {
  try { localStorage.setItem(surfaceGeometryKey(id), JSON.stringify(geometry)) } catch { /* storage full or blocked */ }
}

// ─── Opener side ─────────────────────────────────────────────────────────────

export async function openSurfaceWindow(id: NativeSurfaceId, params: SurfaceParams, requestId = newSurfaceRequestId()): Promise<OpenedSurfaceWindow> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<OpenedSurfaceWindow>('surface_window_open', {
    surface: id,
    requestId,
    params,
    geometry: loadSurfaceGeometry(id),
  })
}

export async function closeSurfaceWindow(windowLabel: string): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const window = await WebviewWindow.getByLabel(windowLabel)
  await window?.close()
}

/** Events for this window's surface requests (the host emits them only to the opener). */
export async function listenSurfaceWindowEvents(callback: (event: SurfaceWindowEvent) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<SurfaceWindowEvent>(SURFACE_WINDOW_EVENT, event => callback(event.payload))
}

// ─── Surface-window side ─────────────────────────────────────────────────────

/** Send a serializable result to the opener (≤ 64 KB). The host scopes it to this window's request. */
export async function reportSurfaceResult(result: unknown): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('surface_window_result', { result })
}

export async function closeCurrentSurfaceWindow(): Promise<void> {
  if (!isTauri()) { window.close(); return }
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().close()
}

/** Persist this window's logical size and position for the next open. */
export async function trackSurfaceGeometry(id: NativeSurfaceId): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const current = getCurrentWindow()
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void (async () => {
        try {
          if (await current.isMaximized() || await current.isMinimized()) return
          const scale = await current.scaleFactor()
          const size = (await current.innerSize()).toLogical(scale)
          const position = (await current.outerPosition()).toLogical(scale)
          saveSurfaceGeometry(id, { x: Math.round(position.x), y: Math.round(position.y), width: Math.round(size.width), height: Math.round(size.height) })
        } catch { /* window closing */ }
      })()
    }, 250)
  }
  const unlisteners = await Promise.all([current.onResized(save), current.onMoved(save)])
  return () => { clearTimeout(timer); unlisteners.forEach(unlisten => unlisten()) }
}

// ─── Preference mirroring ────────────────────────────────────────────────────

interface MirroredWrite { key: string; newValue: string | null }

/**
 * Surface windows share localStorage with the main window, but WebKit does not
 * reliably deliver `storage` events across webviews. A surface mirrors its own
 * writes; the opener replays them as `storage` events, so every existing
 * listener (theme, language, a11y, effects, editor) updates live.
 */
export function mirrorSurfaceStorageWrites(storage: Storage = window.localStorage): () => void {
  const proto = Object.getPrototypeOf(storage) as Storage
  const setItem = proto.setItem
  const removeItem = proto.removeItem
  const send = (write: MirroredWrite) => {
    void import('@tauri-apps/api/event').then(({ emit }) => emit(SURFACE_STORAGE_EVENT, write)).catch(() => {})
  }
  storage.setItem = function (key: string, value: string) {
    setItem.call(this, key, value)
    send({ key, newValue: String(value) })
  }
  storage.removeItem = function (key: string) {
    removeItem.call(this, key)
    send({ key, newValue: null })
  }
  return () => {
    delete (storage as Partial<Storage>).setItem
    delete (storage as Partial<Storage>).removeItem
  }
}

/** Opener side of the mirror: replay a surface's writes as `storage` events. */
export async function replaySurfaceStorageWrites(): Promise<() => void> {
  if (!isTauri() || isSurfaceWindowRoute()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<MirroredWrite>(SURFACE_STORAGE_EVENT, ({ payload }) => {
    if (!payload || typeof payload.key !== 'string') return
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: payload.key, newValue: payload.newValue, storageArea: window.localStorage }))
    } catch { /* non-DOM */ }
  })
}
