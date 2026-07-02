import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { AgentAttachment } from '../lib/agent-api'

/**
 * Coordinates the Agent-Mode "On workspace" tools (Files code pane + Browser
 * capture) between the right `AgentWorkspaceSidebar` (triggers) and the center
 * `AgentModeSurface` (renderers). Terminal is not tracked here — it is driven
 * directly through `TerminalsContext`.
 */
interface AgentWorkspaceContextValue {
  codePaneOpen: boolean
  openCodePane: () => void
  closeCodePane: () => void
  toggleCodePane: () => void
  browserOpen: boolean
  openBrowser: () => void
  closeBrowser: () => void
  /** Browser captures already uploaded as agent attachments, waiting for the
   *  composer to adopt them as chips (they ride the next manual send). */
  pendingCaptures: AgentAttachment[]
  queueCapture: (att: AgentAttachment) => void
  consumePendingCaptures: () => AgentAttachment[]
}

const AgentWorkspaceContext = createContext<AgentWorkspaceContextValue | null>(null)

export function AgentWorkspaceProvider({ children }: { children: ReactNode }) {
  const [codePaneOpen, setCodePaneOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [pendingCaptures, setPendingCaptures] = useState<AgentAttachment[]>([])

  const openCodePane = useCallback(() => setCodePaneOpen(true), [])
  const closeCodePane = useCallback(() => setCodePaneOpen(false), [])
  const toggleCodePane = useCallback(() => setCodePaneOpen((v) => !v), [])
  const openBrowser = useCallback(() => setBrowserOpen(true), [])
  const closeBrowser = useCallback(() => setBrowserOpen(false), [])
  const queueCapture = useCallback((att: AgentAttachment) => {
    setPendingCaptures((prev) => [...prev, att])
  }, [])
  const consumePendingCaptures = useCallback(() => {
    let taken: AgentAttachment[] = []
    setPendingCaptures((prev) => {
      taken = prev
      return prev.length ? [] : prev
    })
    return taken
  }, [])

  const value = useMemo(
    () => ({
      codePaneOpen, openCodePane, closeCodePane, toggleCodePane,
      browserOpen, openBrowser, closeBrowser,
      pendingCaptures, queueCapture, consumePendingCaptures,
    }),
    [codePaneOpen, openCodePane, closeCodePane, toggleCodePane, browserOpen, openBrowser, closeBrowser, pendingCaptures, queueCapture, consumePendingCaptures],
  )
  return <AgentWorkspaceContext.Provider value={value}>{children}</AgentWorkspaceContext.Provider>
}

const NOOP: AgentWorkspaceContextValue = {
  codePaneOpen: false,
  openCodePane: () => {},
  closeCodePane: () => {},
  toggleCodePane: () => {},
  browserOpen: false,
  openBrowser: () => {},
  closeBrowser: () => {},
  pendingCaptures: [],
  queueCapture: () => {},
  consumePendingCaptures: () => [],
}

export function useAgentWorkspace(): AgentWorkspaceContextValue {
  return useContext(AgentWorkspaceContext) ?? NOOP
}
