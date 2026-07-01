import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { _registerRouteForcer } from './lib/route-memory'
import DashboardPage from './pages/DashboardPage'
import SettingsPage from './pages/SettingsPage'
import SettingsDialog from './pages/GlobalSettingsPage'
import { Dialog, DialogContent } from './components/ui/dialog'
import { useKeyboardShortcuts, useCheatsheetState } from './hooks/useKeyboardShortcuts'
import { KeyboardShortcutsCheatsheet } from './components/KeyboardShortcutsCheatsheet'
import { TitleBar } from './components/TitleBar'
import { ThemeEffectLayer } from './components/theme-effects/ThemeEffectLayer'

// Lazy-loaded pages — never visible at initial render
const JobDetailPage = lazy(() => import('./pages/JobDetailPage'))
const JobsPage = lazy(() => import('./pages/JobsPage'))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'))
const ActivityFeedPage = lazy(() => import('./pages/ActivityFeedPage'))
const AgentsPage = lazy(() => import('./pages/AgentsPage'))
const CodePage = lazy(() => import('./pages/CodePage'))
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage'))
const DesktopAnalyticsPage = lazy(() => import('./pages/DesktopAnalyticsPage'))
const DocsPage = lazy(() => import('./pages/DocsPage'))
const DocsDialog = lazy(() => import('./components/DocsDialog'))
const LoopsPage = lazy(() => import('./pages/LoopsPage'))
const LoopBuilderPage = lazy(() => import('./pages/LoopBuilderPage'))
import { ProjectLayout } from './components/ProjectLayout'
import { ProjectErrorBoundary } from './components/ProjectErrorBoundary'
import { WelcomeScreen } from './components/WelcomeScreen'
import { SetupWizard } from './components/SetupWizard'
import { OnboardingWizard, hasSeenOnboarding } from './components/OnboardingWizard'
import { ArcSidebar } from './components/ArcSidebar'
import { ProjectRightSidebar } from './components/ProjectRightSidebar'
import { AddProjectDialog } from './components/AddProjectDialog'
import { SidebarPinProvider, useSidebarPin } from './context/SidebarPinContext'
import { CommandPalette } from './components/CommandPalette'
import { SharedWebSocketProvider } from './hooks/useSharedWebSocket'
import { DesktopProvider, useDesktop } from './hooks/useDesktop'
import { SpecGenTrackerProvider } from './hooks/useSpecGenTracker'
import { ContractRefineTrackerProvider } from './hooks/useContractRefineTracker'
import { SmashTrackerProvider } from './context/SmashTrackerContext'
import { useOsNotifications } from './hooks/useOsNotifications'
import { useDesktopUpdateNotifier } from './hooks/useDesktopUpdateNotifier'
import { useTrayLabels } from './hooks/useTrayLabels'
import { useSuppressNativeContextMenu } from './hooks/useSuppressNativeContextMenu'
import { WS_URL } from './lib/ws-url'
import { TerminalsProvider, useTerminals } from './context/TerminalsContext'
import { RailMetricsProvider } from './context/RailMetricsContext'
import { MinimizedChatsProvider, } from './context/MinimizedChatsContext'
import { AgentChatProvider, useAgentChat } from './context/AgentChatContext'
import { TicketDetailModalProvider } from './context/TicketDetailModalContext'
import { WebViewModalProvider } from './context/WebViewModalContext'
import { useCompareUrlSync } from './hooks/useCompareUrlSync'
import { ThemeProvider, useTheme } from './context/ThemeContext'
import { LanguageProvider } from './context/LanguageContext'
import { FEATURE_AGENTS_SECTION, FEATURE_CODE_EXPLORER, FEATURE_TERMINAL_PANEL, FEATURE_LOOPS_SECTION, FEATURE_AGENT_CHAT } from './lib/feature-flags'

// ─── Per-project route memory (in-memory only — resets on app restart) ───────

// Paths that should never be remembered as a project's "last visited" —
// re-entering a project should never land on a config/admin surface.
const ROUTE_MEMORY_EXCLUDE = new Set<string>(['/settings', '/loops'])

// Global (cross-project) routes must never be saved or restored as a project's
// "last visited" surface — they aren't project-scoped, so persisting one would
// e.g. restore the global Loops page when switching back to a project instead
// of that project's dashboard. Covers exact excludes + the /loops and /docs
// route trees (e.g. the loop builder at /loops/:id/edit).
function isNonProjectRoute(path: string): boolean {
  return ROUTE_MEMORY_EXCLUDE.has(path) || path.startsWith('/loops') || path.startsWith('/docs')
}

// One-time cleanup of legacy persisted route memory so users upgrading from a
// version that wrote to localStorage don't keep their stale "last visited" routes.
const LEGACY_ROUTE_MEMORY_KEY = 'specrails-desktop:routeMemory'
try { localStorage.removeItem(LEGACY_ROUTE_MEMORY_KEY) } catch { /* ignore */ }

function useProjectRouteMemory(activeProjectId: string | null) {
  const location = useLocation()
  const navigate = useNavigate()

  // Map of projectId → last visited path. In-memory only: deliberately not
  // persisted, so a cold start always lands on Dashboard ('/') for every
  // project, while in-session project switches still restore the last route.
  const routeMemory = useRef<Map<string, string>>(new Map())
  const prevProjectId = useRef<string | null>(null)
  const didColdStartReset = useRef(false)

  // Allow external code (e.g. SpecGenTracker "View" button) to force a route
  // for a project before the switch happens, so route memory restores it.
  useEffect(() => {
    _registerRouteForcer((projectId, route) => {
      routeMemory.current.set(projectId, route)
    })
  }, [])

  // Cold-start reset: on the very first mount, regardless of what URL the
  // browser/Tauri webview restored, force the user back to Dashboard. This
  // makes a closed-and-reopened app always start from a known surface.
  useEffect(() => {
    if (didColdStartReset.current) return
    didColdStartReset.current = true
    if (location.pathname !== '/') {
      navigate('/', { replace: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Save the current route for the outgoing project — but never a global
    // (non-project) route like /loops or /docs, which would otherwise be
    // restored as that project's surface on the next switch.
    if (
      prevProjectId.current &&
      prevProjectId.current !== activeProjectId &&
      !isNonProjectRoute(location.pathname)
    ) {
      routeMemory.current.set(prevProjectId.current, location.pathname)
    }

    // Restore route for the incoming project (defaults to Dashboard '/' when
    // no in-session memory exists, or when the remembered route is a global one).
    if (activeProjectId && activeProjectId !== prevProjectId.current) {
      const savedRoute = routeMemory.current.get(activeProjectId)
      const targetRoute = savedRoute && !isNonProjectRoute(savedRoute) ? savedRoute : '/'
      if (location.pathname !== targetRoute) {
        navigate(targetRoute, { replace: true })
      }
    }

    prevProjectId.current = activeProjectId
  }, [activeProjectId, location.pathname, navigate])

  // Continuously update the in-memory map for the active project so a project
  // switch restores precisely the last surface the user was on.
  useEffect(() => {
    if (activeProjectId && location.pathname !== '/' && !isNonProjectRoute(location.pathname)) {
      routeMemory.current.set(activeProjectId, location.pathname)
    }
  }, [activeProjectId, location.pathname])
}

// ─── Desktop app shell ────────────────────────────────────────────────────────────

function DesktopApp() {
  const { t } = useTranslation('common')
  const { projects, activeProjectId, isLoading, isSwitchingProject, setupProjectIds, completeSetupWizard, setActiveProjectId } = useDesktop()
  const { cycleLeftMode, cycleRightMode } = useSidebarPin()
  const navigate = useNavigate()
  const location = useLocation()
  const terminals = useTerminals()
  const agentChat = useAgentChat()

  // Two-way sync between split-view comparison state and ?compare=… URL params.
  useCompareUrlSync()
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [docsOpen, setDocsOpen] = useState(false)
  // Stable onClose so memoised DocsDialog doesn't re-render every DesktopApp render.
  const closeDocs = useCallback(() => setDocsOpen(false), [])
  const [onboardingOpen, setOnboardingOpen] = useState(() => !hasSeenOnboarding())

  // Remember which page each project was on
  useProjectRouteMemory(activeProjectId)

  // Push localized system-tray labels to the Rust host (no-op outside Tauri).
  useTrayLabels()

  // Keyboard shortcuts
  const { cheatsheetOpen, setCheatsheetOpen, openCheatsheet } = useCheatsheetState()
  const PROJECT_PAGES = [
    '/',
    '/jobs',
    '/analytics',
    ...(FEATURE_AGENTS_SECTION ? ['/agents'] : []),
    ...(FEATURE_CODE_EXPLORER ? ['/code'] : []),
    '/integrations',
    '/settings',
  ]
  useKeyboardShortcuts({
    onOpenCheatsheet: openCheatsheet,
    onToggleLeftSidebar: cycleLeftMode,
    onToggleRightSidebar: cycleRightMode,
    onSwitchProject: (index) => {
      const project = projects[index - 1]
      if (project) setActiveProjectId(project.id)
    },
    onSwitchProjectPage: (index) => {
      const route = PROJECT_PAGES[index - 1]
      if (route) navigate(route)
    },
    onToggleTerminalPanel: FEATURE_TERMINAL_PANEL ? () => {
      if (!activeProjectId) return
      terminals.togglePanel(activeProjectId)
      const state = terminals.getState(activeProjectId)
      // After toggle, state.visibility reflects the NEW value (togglePanel is synchronous to state updater)
      // Focus the active terminal once the panel is opening.
      if (state.visibility !== 'hidden') terminals.focusActive(activeProjectId)
      else {
        // Ensure focus after next tick when panel is now open
        queueMicrotask(() => terminals.focusActive(activeProjectId))
      }
    } : undefined,
    onToggleAgentChat: FEATURE_AGENT_CHAT ? () => agentChat.toggle() : undefined,
  })

  // OS notifications for job completions/failures
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects]
  )
  useOsNotifications({ setActiveProjectId, projectsById })

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const isInSetup = activeProjectId !== null && setupProjectIds.has(activeProjectId)

  if (isLoading) {
    return (
      <div className="flex h-full">
        <div className="w-11 border-r border-border bg-card/50 animate-pulse flex-shrink-0" />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('states.loading')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden font-sans">
      {/* Arc-style collapsible sidebar */}
      <ArcSidebar
        onAddProject={() => setAddDialogOpen(true)}
        onOpenLoops={() => navigate('/loops')}
        onOpenAnalytics={() => setAnalyticsOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main area — navbar + content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Project switching progress bar */}
        {isSwitchingProject && (
          <div
            className="h-0.5 w-full bg-accent-primary/70 animate-pulse shrink-0"
            data-testid="project-switching-bar"
          />
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {isInSetup && activeProject ? (
            <SetupWizard
              key={activeProject.id}
              project={activeProject}
              onComplete={() => completeSetupWizard(activeProject.id)}
              onSkip={() => completeSetupWizard(activeProject.id)}
            />
          ) : (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('states.loading')}</p></div>}>
              <Routes>
                <Route path="/docs" element={<DocsPage />} />
                <Route path="/docs/:category/:slug" element={<DocsPage />} />
                {/* Loops — GLOBAL routes (cross-project), outside ProjectLayout.
                    The builder route (/loops/:id/edit) lands in a later phase;
                    until then it falls back to the library so Edit never dead-ends. */}
                {FEATURE_LOOPS_SECTION && <Route path="/loops" element={<LoopsPage />} />}
                {FEATURE_LOOPS_SECTION && <Route path="/loops/:id/edit" element={<LoopBuilderPage />} />}
                {/* Project routes */}
                {projects.length === 0 ? (
                  <Route path="*" element={<WelcomeScreen onAddProject={() => setAddDialogOpen(true)} />} />
                ) : activeProject ? (
                  <Route element={
                    <ProjectErrorBoundary key={activeProject.id} projectName={activeProject.name}>
                      <ProjectLayout project={activeProject} />
                    </ProjectErrorBoundary>
                  }>
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/jobs" element={<JobsPage />} />
                    <Route path="/jobs/:id" element={<JobDetailPage />} />
                    <Route path="/analytics" element={<AnalyticsPage />} />
                    <Route path="/activity" element={<ActivityFeedPage />} />
                    <Route path="/agents" element={<AgentsPage />} />
                    <Route path="/code" element={FEATURE_CODE_EXPLORER ? <CodePage /> : <Navigate to="/" replace />} />
                    <Route path="/integrations" element={<IntegrationsPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                ) : (
                  <Route path="*" element={<WelcomeScreen onAddProject={() => setAddDialogOpen(true)} />} />
                )}
              </Routes>
            </Suspense>
          )}
        </div>
      </div>

      {/* Right sidebar — full height, only when a project is active and not in
          setup. Hidden on the global /loops surface so the builder/library use
          the full width. */}
      {activeProject && !isInSetup && !location.pathname.startsWith('/loops') && <ProjectRightSidebar />}

      <AddProjectDialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onOpenOnboarding={() => { setSettingsOpen(false); setOnboardingOpen(true) }} />

      <Dialog open={analyticsOpen} onOpenChange={setAnalyticsOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden p-0 flex flex-col">
          <div className="flex-1 overflow-auto">
            <Suspense fallback={<div className="flex items-center justify-center h-40"><p className="text-sm text-muted-foreground">{t('states.loading')}</p></div>}>
              <DesktopAnalyticsPage />
            </Suspense>
          </div>
        </DialogContent>
      </Dialog>

      <Suspense fallback={null}>
        <DocsDialog open={docsOpen} onClose={closeDocs} />
      </Suspense>

      <CommandPalette
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAnalytics={() => setAnalyticsOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
      />
      <KeyboardShortcutsCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
      <OnboardingWizard open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </div>
  )
}

// ─── Terminals provider wrapper (reads active project from useDesktop) ───────────

function TerminalsProviderWithDesktop({ children }: { children: React.ReactNode }) {
  const { activeProjectId } = useDesktop()
  return <TerminalsProvider activeProjectId={activeProjectId}>{children}</TerminalsProvider>
}

// Rail execution metrics provider — app-level (above the routes) so live metrics
// persist across Dashboard ⇄ Jobs navigation. Reads the active project for the
// per-project WS filter + reset.
function RailMetricsProviderWithDesktop({ children }: { children: React.ReactNode }) {
  const { activeProjectId } = useDesktop()
  return <RailMetricsProvider activeProjectId={activeProjectId}>{children}</RailMetricsProvider>
}

// ─── Themed Toaster — single global instance, glass-card chrome ──────────────
// Unified across the app so every toast looks the same and stacks together.
// `unstyled: true` strips sonner's defaults; classNames apply our glass-card
// look. Type-variant classes (success / error / warning / info / loading)
// add a subtle status-coloured left border so the type still reads at a
// glance without breaking visual harmony.

function ToastLoadingSpinner() {
  // Loading toasts use a rotating halo around the whole card (see globals.css
  // `[data-sonner-toast][data-type='loading']`) instead of an inline spinner.
  // Returning an empty span suppresses sonner's default pinwheel.
  return <span aria-hidden style={{ display: 'none' }} />
}

function ThemedToaster() {
  const { theme } = useTheme()
  const accent = theme.previewSwatches.accents[0]
  const success = theme.status.completed
  const danger = theme.status.failed
  const warning = theme.status.canceled
  const info = theme.status.running
  return (
    <Toaster
      position="bottom-right"
      theme={theme.scheme}
      gap={8}
      closeButton
      visibleToasts={6}
      icons={{ loading: <ToastLoadingSpinner /> }}
      style={{
        '--accent':                accent,
        '--toast-success-border': `color-mix(in srgb, ${success} 38%, transparent)`,
        '--toast-error-border':   `color-mix(in srgb, ${danger}  38%, transparent)`,
        '--toast-warning-border': `color-mix(in srgb, ${warning} 38%, transparent)`,
        '--toast-info-border':    `color-mix(in srgb, ${info}    38%, transparent)`,
      } as React.CSSProperties}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'glass-card border border-border/30 text-foreground text-xs p-3 rounded-lg flex items-start gap-2 w-[356px] max-w-[356px] overflow-hidden shadow-lg',
          content: 'flex-1 min-w-0 flex flex-col gap-0.5',
          icon: 'shrink-0 mt-[2px] flex items-center justify-center',
          title: 'font-medium text-sm',
          description: 'text-muted-foreground mt-0.5',
          actionButton:
            'text-[11px] px-2.5 py-1 rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 whitespace-nowrap shrink-0 self-start',
          cancelButton:
            'text-[11px] px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 whitespace-nowrap shrink-0 self-start',
          closeButton:
            'text-muted-foreground hover:text-foreground rounded-md p-0.5',
          success: 'border-l-4 border-l-[var(--toast-success-border)]',
          error: 'border-l-4 border-l-[var(--toast-error-border)]',
          warning: 'border-l-4 border-l-[var(--toast-warning-border)]',
          info: 'border-l-4 border-l-[var(--toast-info-border)]',
          loading: '',
        },
      }}
    />
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  useDesktopUpdateNotifier()
  useSuppressNativeContextMenu()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      {/* Main app content — fills remaining height below titlebar */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <SharedWebSocketProvider url={WS_URL}>
          <ThemeProvider>
            <LanguageProvider>
            {/* Theme-scoped decorative effects (e.g. matrix rain). Dispatcher
                renders the matching effect or nothing. See
                `components/theme-effects/ThemeEffectLayer.tsx`. */}
            <ThemeEffectLayer />
            <DesktopProvider>
              {/* Custom frameless titlebar inside DesktopProvider so it can read active project */}
              <TitleBar />
              <SpecGenTrackerProvider>
                <ContractRefineTrackerProvider>
                <SmashTrackerProvider>
                <SidebarPinProvider>
                  <TerminalsProviderWithDesktop>
                    <RailMetricsProviderWithDesktop>
                    <MinimizedChatsProvider>
                      <AgentChatProvider>
                        <TicketDetailModalProvider>
                          <WebViewModalProvider>
                            <DesktopApp />
                            <ThemedToaster />
                          </WebViewModalProvider>
                        </TicketDetailModalProvider>
                      </AgentChatProvider>
                    </MinimizedChatsProvider>
                    </RailMetricsProviderWithDesktop>
                  </TerminalsProviderWithDesktop>
                </SidebarPinProvider>
                </SmashTrackerProvider>
                </ContractRefineTrackerProvider>
              </SpecGenTrackerProvider>
            </DesktopProvider>
            </LanguageProvider>
          </ThemeProvider>
        </SharedWebSocketProvider>
      </div>
    </div>
  )
}
