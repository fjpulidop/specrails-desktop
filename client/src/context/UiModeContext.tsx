import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { FEATURE_AGENT_MODE } from '../lib/feature-flags'

export type UiMode = 'kanban' | 'agent'

interface UiModeContextValue {
  uiMode: UiMode
  setUiMode: (m: UiMode) => void
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

export function UiModeProvider({ children }: { children: ReactNode }) {
  const [uiMode, setUiModeState] = useState<UiMode>(readStored)

  const setUiMode = useCallback((m: UiMode) => {
    if (!FEATURE_AGENT_MODE) return
    setUiModeState(m)
    writeStored(m)
  }, [])

  const toggleUiMode = useCallback(() => {
    setUiModeState((cur) => {
      if (!FEATURE_AGENT_MODE) return 'kanban'
      const next: UiMode = cur === 'kanban' ? 'agent' : 'kanban'
      writeStored(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({ uiMode, setUiMode, toggleUiMode }),
    [uiMode, setUiMode, toggleUiMode],
  )
  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>
}

// NOOP fallback pinned to 'kanban' — keeps TitleBar / ArcSidebar / DesktopApp mountable
// in isolation & tests without a provider (mirrors the agent-chat NOOP fallback).
const NOOP_UI_MODE: UiModeContextValue = {
  uiMode: 'kanban',
  setUiMode: () => {},
  toggleUiMode: () => {},
}

export function useUiMode(): UiModeContextValue {
  return useContext(UiModeContext) ?? NOOP_UI_MODE
}
