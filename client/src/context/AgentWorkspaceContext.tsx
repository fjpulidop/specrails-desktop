import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentAttachment } from '../lib/agent-api'
import type { MissionWindowSnapshot } from '../lib/mission-windows'

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
  browserOwnerId: string | null
  browserUrl: string | null
  setBrowserUrl: (url: string) => void
  captureWorkspace: () => MissionWindowSnapshot['workspace']
  restoreWorkspace: (snapshot: MissionWindowSnapshot['workspace']) => void
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
  const [browserOwnerId, setBrowserOwnerId] = useState<string | null>(null)
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
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
  const openBrowser = useCallback(() => { setBrowserOwnerId(crypto.randomUUID()); setBrowserOpen(true) }, [])
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

  const restoreWorkspace = useCallback((snapshot: MissionWindowSnapshot['workspace']) => {
    setCodePaneOpen(snapshot.codePaneOpen)
    setJobsPaneOpen(snapshot.jobsPaneOpen)
    setAnalyticsPaneOpen(snapshot.analyticsPaneOpen)
    setBrowserOwnerId(snapshot.browserOwnerId ?? null)
    setBrowserUrl(snapshot.browserUrl ?? null)
    setBrowserOpen(snapshot.browserOpen)
    pendingCapturesRef.current = snapshot.pendingCaptures
    setPendingCaptures(snapshot.pendingCaptures)
  }, [])
  const captureWorkspace = useCallback((): MissionWindowSnapshot['workspace'] => ({
    codePaneOpen, jobsPaneOpen, analyticsPaneOpen, browserOpen, browserOwnerId, browserUrl,
    pendingCaptures: pendingCapturesRef.current,
  }), [codePaneOpen, jobsPaneOpen, analyticsPaneOpen, browserOpen, browserOwnerId, browserUrl])

  const value = useMemo(
    () => ({
      codePaneOpen, openCodePane, closeCodePane, toggleCodePane,
      jobsPaneOpen, openJobsPane, closeJobsPane, toggleJobsPane,
      analyticsPaneOpen, openAnalyticsPane, closeAnalyticsPane, toggleAnalyticsPane,
      browserOpen, openBrowser, closeBrowser, browserOwnerId, browserUrl, setBrowserUrl, captureWorkspace, restoreWorkspace,
      pendingCaptures, queueCapture, consumePendingCaptures,
    }),
    [browserOwnerId, browserUrl, captureWorkspace, restoreWorkspace, codePaneOpen, openCodePane, closeCodePane, toggleCodePane, jobsPaneOpen, openJobsPane, closeJobsPane, toggleJobsPane, analyticsPaneOpen, openAnalyticsPane, closeAnalyticsPane, toggleAnalyticsPane, browserOpen, openBrowser, closeBrowser, pendingCaptures, queueCapture, consumePendingCaptures],
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
  browserOwnerId: null, browserUrl: null, setBrowserUrl: () => {},
  captureWorkspace: () => ({ codePaneOpen: false, jobsPaneOpen: false, analyticsPaneOpen: false, browserOpen: false, pendingCaptures: [] }),
  restoreWorkspace: () => {},
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
