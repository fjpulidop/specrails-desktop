import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Bridge between ⌘K and the surfaces that own an action's real handler.
 *
 * The palette (mounted once, in the app shell) must not re-implement what a
 * button does. A surface that is on screen registers the SAME callbacks its
 * buttons call (launch gating, Jira-backed moves, Flow availability, ...) and
 * unregisters on unmount. A surface that is not mounted is simply absent, so
 * the actions that need it are not offered.
 *
 * A surface is an object of functions only. `useRegisterPaletteSurface`
 * registers a stable facade that forwards every call to the surface's LATEST
 * render, so registering never re-runs on re-render yet the palette always
 * reads fresh data (lists are functions, not snapshots) and calls the newest
 * handler closures.
 */

export interface PaletteSpec {
  id: number
  title: string
  status: string
}

export interface PaletteRail {
  id: string
  label: string
  /** True while a job runs on the rail (launching would not start anything). */
  running: boolean
  /** The spec is already on this rail. */
  hasSpec: boolean
}

export interface PaletteStatusOption {
  id: string
  label: string
  current: boolean
}

/** The board dashboard: specs, rails, and the guarded handlers over them. */
export interface PaletteBoardSurface {
  specs: () => PaletteSpec[]
  /** Rails a spec can be launched on (labels, running state). */
  rails: (ticketId: number) => PaletteRail[]
  /** Why a spec cannot be launched right now (null = launchable). */
  launchBlocker: (ticketId: number) => string | null
  /** Moves the spec to the rail (when needed) and launches it through the rail's own gates. */
  launchOnRail: (ticketId: number, railId: string) => void
  /** Status targets for a spec (manual statuses, or the Jira board's workflow statuses). */
  statusOptions: (ticketId: number) => Promise<PaletteStatusOption[]>
  moveStatus: (ticketId: number, optionId: string) => void
  /** Route of the spec's review packet, or null when it has none. */
  reviewPath: (ticketId: number) => string | null
}

/** The specs column: opens the New spec modal (optionally already in Explore). */
export interface PaletteSpecsSurface {
  openNewSpec: (mode: 'quick' | 'explore') => void
}

/**
 * The specs board's multi-selection and saved views (CD4). `count` is 0 while
 * nothing is selected, which hides the bulk actions; the views functions work
 * regardless. Bulk calls run the same handlers as the floating bulk bar.
 */
export interface PaletteSelectionSurface {
  count: () => number
  selectAllInColumn: () => void
  clear: () => void
  /** Status targets for the selection: ids are `local:<status>` or `jira:<workflow status>`. */
  statusOptions: () => Promise<PaletteStatusOption[]>
  moveStatus: (optionId: string) => void
  priorityOptions: () => { id: string; label: string }[]
  setPriority: (priority: string) => void
  /** Labels not yet on every selected spec. */
  labelOptions: () => string[]
  addLabel: (label: string) => void
  railOptions: () => { id: string; label: string; running: boolean }[]
  addToRail: (railId: string) => void
  launch: () => void
  remove: () => void
  views: () => { id: string; name: string }[]
  switchView: (id: string) => void
  /** Opens the board's "Save current view" dialog. */
  saveCurrentView: () => void
}

export interface PaletteFlowControl {
  id: 'pause' | 'resume' | 'hand-off'
  label: string
  disabled: boolean
  run: () => void
}

/** The mounted Flow strip's controls (absent when no Flow is open). */
export interface PaletteFlowSurface {
  controls: () => PaletteFlowControl[]
}

export interface PaletteSurfaces {
  board: PaletteBoardSurface
  specs: PaletteSpecsSurface
  selection: PaletteSelectionSurface
  flow: PaletteFlowSurface
}

export type PaletteSurfaceKey = keyof PaletteSurfaces

const surfaces = new Map<PaletteSurfaceKey, unknown>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Register (or replace) a surface. Returns the unregister function. */
export function registerPaletteSurface<K extends PaletteSurfaceKey>(key: K, value: PaletteSurfaces[K]): () => void {
  surfaces.set(key, value)
  emit()
  return () => {
    if (surfaces.get(key) === value) {
      surfaces.delete(key)
      emit()
    }
  }
}

export function getPaletteSurface<K extends PaletteSurfaceKey>(key: K): PaletteSurfaces[K] | null {
  return (surfaces.get(key) as PaletteSurfaces[K] | undefined) ?? null
}

/** Snapshot of everything registered; changes identity when anything registers or leaves. */
export function usePaletteSurfaces(): Partial<PaletteSurfaces> {
  const v = useSyncExternalStore(subscribe, () => version, () => 0)
  // `version` is the cache key: a new object per registry change.
  const ref = useRef<{ v: number; value: Partial<PaletteSurfaces> }>({ v: -1, value: {} })
  if (ref.current.v !== v) {
    ref.current = { v, value: Object.fromEntries(surfaces) as Partial<PaletteSurfaces> }
  }
  return ref.current.value
}

/**
 * Register a surface for as long as the caller is mounted and `current` is
 * non-null (pass null while the surface is not usable, e.g. no Flow open).
 */
export function useRegisterPaletteSurface<K extends PaletteSurfaceKey>(key: K, current: PaletteSurfaces[K] | null): void {
  const ref = useRef(current)
  ref.current = current
  const enabled = current !== null
  useEffect(() => {
    if (!enabled) return
    const facade: Record<string, unknown> = {}
    for (const name of Object.keys(ref.current as object)) {
      facade[name] = (...args: unknown[]) => ((ref.current as unknown as Record<string, (...a: unknown[]) => unknown>)[name])(...args)
    }
    return registerPaletteSurface(key, facade as unknown as PaletteSurfaces[K])
  }, [key, enabled])
}

/** Test seam: forget every registered surface. */
export function resetPaletteSurfaces(): void {
  surfaces.clear()
  emit()
}
