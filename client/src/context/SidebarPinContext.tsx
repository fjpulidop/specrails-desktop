import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'

export type SidebarMode = 'pinned-open' | 'pinned-collapsed' | 'unpinned'

const VALID_MODES: readonly SidebarMode[] = ['pinned-open', 'pinned-collapsed', 'unpinned']
const STORAGE_KEY_LEFT = 'specrails-desktop:sidebar-mode:left'
const STORAGE_KEY_RIGHT = 'specrails-desktop:sidebar-mode:right'
/** Below this window width a pinned-open sidebar behaves as unpinned (an
 *  overlay rail) so the content keeps its room; nothing is written to storage. */
export const NARROW_WINDOW_QUERY = '(max-width: 1100px)'
/** New users get the project/mission navigation open; the right rail stays quiet. */
const DEFAULT_LEFT_MODE: SidebarMode = 'pinned-open'
const DEFAULT_RIGHT_MODE: SidebarMode = 'unpinned'

function isSidebarMode(value: unknown): value is SidebarMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value)
}

function readMode(key: string, fallback: SidebarMode): SidebarMode {
  try {
    const raw = window.localStorage.getItem(key)
    if (isSidebarMode(raw)) return raw
  } catch {
    // localStorage unavailable (private mode, SSR, etc.) — fall through
  }
  return fallback
}

function writeMode(key: string, mode: SidebarMode): void {
  try {
    window.localStorage.setItem(key, mode)
  } catch {
    // best-effort: ignore quota / private-mode failures
  }
}

function nextMode(mode: SidebarMode): SidebarMode {
  switch (mode) {
    case 'pinned-open':
      return 'pinned-collapsed'
    case 'pinned-collapsed':
      return 'unpinned'
    case 'unpinned':
      return 'pinned-open'
  }
}

interface SidebarPinContextValue {
  /** The user's chosen (persisted) mode. */
  leftMode: SidebarMode
  rightMode: SidebarMode
  /** The mode the sidebar actually renders with: a pinned-open sidebar falls
   *  back to unpinned in a narrow window. Not persisted. */
  effectiveLeftMode: SidebarMode
  effectiveRightMode: SidebarMode
  setLeftMode: (mode: SidebarMode) => void
  setRightMode: (mode: SidebarMode) => void
  cycleLeftMode: () => void
  cycleRightMode: () => void
}

const SidebarPinContext = createContext<SidebarPinContextValue>({
  leftMode: DEFAULT_LEFT_MODE,
  rightMode: DEFAULT_RIGHT_MODE,
  effectiveLeftMode: DEFAULT_LEFT_MODE,
  effectiveRightMode: DEFAULT_RIGHT_MODE,
  setLeftMode: () => {},
  setRightMode: () => {},
  cycleLeftMode: () => {},
  cycleRightMode: () => {},
})

export function SidebarPinProvider({ children }: { children: ReactNode }) {
  const [leftMode, setLeftModeState] = useState<SidebarMode>(() => readMode(STORAGE_KEY_LEFT, DEFAULT_LEFT_MODE))
  const [rightMode, setRightModeState] = useState<SidebarMode>(() => readMode(STORAGE_KEY_RIGHT, DEFAULT_RIGHT_MODE))
  const narrow = useMediaQuery(NARROW_WINDOW_QUERY)
  const effectiveLeftMode: SidebarMode = narrow && leftMode === 'pinned-open' ? 'unpinned' : leftMode
  const effectiveRightMode: SidebarMode = narrow && rightMode === 'pinned-open' ? 'unpinned' : rightMode

  useEffect(() => {
    writeMode(STORAGE_KEY_LEFT, leftMode)
  }, [leftMode])

  useEffect(() => {
    writeMode(STORAGE_KEY_RIGHT, rightMode)
  }, [rightMode])

  const setLeftMode = useCallback((mode: SidebarMode) => setLeftModeState(mode), [])
  const setRightMode = useCallback((mode: SidebarMode) => setRightModeState(mode), [])
  const cycleLeftMode = useCallback(() => setLeftModeState((m) => nextMode(m)), [])
  const cycleRightMode = useCallback(() => setRightModeState((m) => nextMode(m)), [])

  // Memoise so consumers don't re-render unless leftMode/rightMode actually change
  // (the setters are stable). An inline object would re-render every consumer on
  // every parent render.
  const value = useMemo(
    () => ({ leftMode, rightMode, effectiveLeftMode, effectiveRightMode, setLeftMode, setRightMode, cycleLeftMode, cycleRightMode }),
    [leftMode, rightMode, effectiveLeftMode, effectiveRightMode, setLeftMode, setRightMode, cycleLeftMode, cycleRightMode],
  )

  return (
    <SidebarPinContext.Provider value={value}>
      {children}
    </SidebarPinContext.Provider>
  )
}

export function useSidebarPin() {
  return useContext(SidebarPinContext)
}
