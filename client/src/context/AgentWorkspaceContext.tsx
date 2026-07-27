import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
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
  analyticsPaneOpen: boolean
  openAnalyticsPane: () => void
  closeAnalyticsPane: () => void
  toggleAnalyticsPane: () => void
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
  const [analyticsPaneOpen, setAnalyticsPaneOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [pendingCaptures, setPendingCaptures] = useState<AgentAttachment[]>([])

  const openCodePane = useCallback(() => setCodePaneOpen(true), [])
  const closeCodePane = useCallback(() => setCodePaneOpen(false), [])
  const toggleCodePane = useCallback(() => setCodePaneOpen((v) => !v), [])
  const openJobsPane = useCallback(() => setJobsPaneOpen(true), [])
  const closeJobsPane = useCallback(() => setJobsPaneOpen(false), [])
  const toggleJobsPane = useCallback(() => setJobsPaneOpen((v) => !v), [])
  const openAnalyticsPane = useCallback(() => setAnalyticsPaneOpen(true), [])
  const closeAnalyticsPane = useCallback(() => setAnalyticsPaneOpen(false), [])
  const toggleAnalyticsPane = useCallback(() => setAnalyticsPaneOpen((v) => !v), [])
  const openBrowser = useCallback(() => setBrowserOpen(true), [])
  const closeBrowser = useCallback(() => setBrowserOpen(false), [])
  // The queue ALSO lives in a ref: `consumePendingCaptures` must return the
  // pending items synchronously, and reading them inside a functional setState
  // updater is NOT reliable — React only runs the updater eagerly when the
  // hook's update queue is empty, otherwise it defers it and the consumer saw
  // `[]` (the captured screenshot silently never became a composer chip).
  const pendingCapturesRef = useRef<AgentAttachment[]>([])
  const queueCapture = useCallback((att: AgentAttachment) => {
    pendingCapturesRef.current = [...pendingCapturesRef.current, att]
    setPendingCaptures(pendingCapturesRef.current)
  }, [])
  const consumePendingCaptures = useCallback(() => {
    const taken = pendingCapturesRef.current
    if (taken.length) {
      pendingCapturesRef.current = []
      setPendingCaptures([])
    }
    return taken
  }, [])

  const value = useMemo(
    () => ({
      codePaneOpen, openCodePane, closeCodePane, toggleCodePane,
      jobsPaneOpen, openJobsPane, closeJobsPane, toggleJobsPane,
      analyticsPaneOpen, openAnalyticsPane, closeAnalyticsPane, toggleAnalyticsPane,
      browserOpen, openBrowser, closeBrowser,
      pendingCaptures, queueCapture, consumePendingCaptures,
    }),
    [codePaneOpen, openCodePane, closeCodePane, toggleCodePane, jobsPaneOpen, openJobsPane, closeJobsPane, toggleJobsPane, analyticsPaneOpen, openAnalyticsPane, closeAnalyticsPane, toggleAnalyticsPane, browserOpen, openBrowser, closeBrowser, pendingCaptures, queueCapture, consumePendingCaptures],
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
  analyticsPaneOpen: false,
  openAnalyticsPane: () => {},
  closeAnalyticsPane: () => {},
  toggleAnalyticsPane: () => {},
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
