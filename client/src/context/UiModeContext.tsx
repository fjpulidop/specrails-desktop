import { createContext, startTransition, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { FEATURE_AGENT_MODE } from '../lib/feature-flags'

export type UiMode = 'kanban' | 'agent'

interface UiModeContextValue {
  /** The mode whose surface is committed on screen. */
  uiMode: UiMode
  /** The mode the person asked for. Updates urgently (outside the surface
   *  transition), so radios and focus follow the click/arrow at once. */
  requestedMode: UiMode
  /** The requested surface is still rendering. */
  isPending: boolean
  /** `immediate` skips the transition: the surface commits with this update
   *  (callers that navigate right after the switch). */
  setUiMode: (m: UiMode, opts?: { immediate?: boolean }) => void
  toggleUiMode: () => void
}

const STORAGE_KEY = 'specrails-desktop:uiMode'

function readStored(): UiMode {
  // Flag OFF pins kanban so Kanban stays byte-identical.
  if (!FEATURE_AGENT_MODE) return 'kanban'
  try {
    // Agent Mode is the DEFAULT; an explicit user pick (either mode, persisted
    // on every switch) wins over it on the next launch.
    return localStorage.getItem(STORAGE_KEY) === 'kanban' ? 'kanban' : 'agent'
  } catch {
    return 'agent'
  }
}

function writeStored(m: UiMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, m)
  } catch {
    /* ignore */
  }
}

const UiModeContext = createContext<UiModeContextValue | null>(null)

export function UiModeProvider({ children, initialMode, persist = true }: { children: ReactNode; initialMode?: UiMode; persist?: boolean }) {
  const [initial] = useState<UiMode>(() => initialMode ?? readStored())
  const [uiMode, setUiModeState] = useState<UiMode>(initial)
  const [requestedMode, setRequestedMode] = useState<UiMode>(initial)
  const requestedRef = useRef<UiMode>(initial)

  const setUiMode = useCallback((m: UiMode, opts?: { immediate?: boolean }) => {
    if (!FEATURE_AGENT_MODE) return
    requestedRef.current = m
    // The request is urgent (radios, focus, aria-checked answer the click). Only
    // the surface renders as an interruptible transition: the current mode stays
    // interactive until the next one is ready.
    setRequestedMode(m)
    if (opts?.immediate) setUiModeState(m)
    else startTransition(() => setUiModeState(m))
    if (persist) writeStored(m)
  }, [persist])

  const toggleUiMode = useCallback(() => {
    if (!FEATURE_AGENT_MODE) return
    // Toggle from what was asked last, not from what is painted: two quick
    // arrows must not both resolve against the same stale mode.
    setUiMode(requestedRef.current === 'kanban' ? 'agent' : 'kanban')
  }, [setUiMode])

  const value = useMemo(
    () => ({ uiMode, requestedMode, isPending: requestedMode !== uiMode, setUiMode, toggleUiMode }),
    [uiMode, requestedMode, setUiMode, toggleUiMode],
  )
  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>
}

// NOOP fallback pinned to 'kanban' — keeps TitleBar / ArcSidebar / DesktopApp mountable
// in isolation & tests without a provider (mirrors the agent-chat NOOP fallback).
const NOOP_UI_MODE: UiModeContextValue = {
  uiMode: 'kanban',
  requestedMode: 'kanban',
  isPending: false,
  setUiMode: () => {},
  toggleUiMode: () => {},
}

export function useUiMode(): UiModeContextValue {
  return useContext(UiModeContext) ?? NOOP_UI_MODE
}
