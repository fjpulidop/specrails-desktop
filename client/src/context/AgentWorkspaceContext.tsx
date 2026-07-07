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
  jobsPaneOpen: boolean
  openJobsPane: () => void
  closeJobsPane: () => void
  toggleJobsPane: () => void
  integrationsModalOpen: boolean
  openIntegrationsModal: () => void
  closeIntegrationsModal: () => void
  toggleIntegrationsModal: () => void
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
  const [jobsPaneOpen, setJobsPaneOpen] = useState(false)
  const [integrationsModalOpen, setIntegrationsModalOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [pendingCaptures, setPendingCaptures] = useState<AgentAttachment[]>([])

  const openCodePane = useCallback(() => setCodePaneOpen(true), [])
  const closeCodePane = useCallback(() => setCodePaneOpen(false), [])
  const toggleCodePane = useCallback(() => setCodePaneOpen((v) => !v), [])
  const openJobsPane = useCallback(() => setJobsPaneOpen(true), [])
  const closeJobsPane = useCallback(() => setJobsPaneOpen(false), [])
  const toggleJobsPane = useCallback(() => setJobsPaneOpen((v) => !v), [])
  const openIntegrationsModal = useCallback(() => setIntegrationsModalOpen(true), [])
  const closeIntegrationsModal = useCallback(() => setIntegrationsModalOpen(false), [])
  const toggleIntegrationsModal = useCallback(() => setIntegrationsModalOpen((v) => !v), [])
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
      jobsPaneOpen, openJobsPane, closeJobsPane, toggleJobsPane,
      integrationsModalOpen, openIntegrationsModal, closeIntegrationsModal, toggleIntegrationsModal,
      browserOpen, openBrowser, closeBrowser,
      pendingCaptures, queueCapture, consumePendingCaptures,
    }),
    [codePaneOpen, openCodePane, closeCodePane, toggleCodePane, jobsPaneOpen, openJobsPane, closeJobsPane, toggleJobsPane, integrationsModalOpen, openIntegrationsModal, closeIntegrationsModal, toggleIntegrationsModal, browserOpen, openBrowser, closeBrowser, pendingCaptures, queueCapture, consumePendingCaptures],
  )
  return <AgentWorkspaceContext.Provider value={value}>{children}</AgentWorkspaceContext.Provider>
}

const NOOP: AgentWorkspaceContextValue = {
  codePaneOpen: false,
  openCodePane: () => {},
  closeCodePane: () => {},
  toggleCodePane: () => {},
  jobsPaneOpen: false,
  openJobsPane: () => {},
  closeJobsPane: () => {},
  toggleJobsPane: () => {},
  integrationsModalOpen: false,
  openIntegrationsModal: () => {},
  closeIntegrationsModal: () => {},
  toggleIntegrationsModal: () => {},
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
