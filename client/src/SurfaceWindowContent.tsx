import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { SurfaceWindowFrame } from './components/ui/dialog'
import { useDesktop } from './hooks/useDesktop'
import { MissionExtensionsProvider } from './features/missions/context/MissionExtensionsContext'
import { FLOW_MISSION_EXTENSIONS } from './features/intent/components/IntentMissionsBridge'
import { APP_SETTINGS_SECTIONS, type AppSettingsSection } from './lib/app-settings-events'
import { forwardSurfaceShellRequests } from './lib/surface-shell-requests'
import {
  closeCurrentSurfaceWindow,
  mirrorSurfaceStorageWrites,
  reportSurfaceResult,
  revealCurrentSurfaceWindow,
  trackSurfaceGeometry,
  type NativeSurfaceId,
  type SurfaceParams,
} from './lib/native-surfaces'
import { handOffSurfaceToasts } from './lib/surface-toasts'

// The window's content loads in its own chunk so the main window does not ship
// it. `preloadSurfaceWindowContent` starts that load as soon as the route is
// known; the window stays hidden until the content has painted (see below).
const loadSettingsDialog = () => import('./features/settings/pages/GlobalSettingsPage')
const loadProjectSettingsDialog = () => import('./features/settings/pages/SettingsPage')
const loadJobDetailModal = () => import('./features/jobs/components/JobDetailModal')
const loadLiveBoardWindow = () => import('./features/live-board/components/LiveBoardWindow')
const SettingsDialog = lazy(loadSettingsDialog)
const ProjectSettingsDialog = lazy(() => loadProjectSettingsDialog().then(module => ({ default: module.ProjectSettingsDialog })))
const JobDetailModal = lazy(() => loadJobDetailModal().then(module => ({ default: module.JobDetailModal })))
const LiveBoardWindow = lazy(loadLiveBoardWindow)

export function preloadSurfaceWindowContent(id: NativeSurfaceId): void {
  const load = {
    'app-settings': loadSettingsDialog,
    'project-settings': loadProjectSettingsDialog,
    'live-board': loadLiveBoardWindow,
    'job-detail': loadJobDetailModal,
  }[id]
  void load().catch(() => {})
}

/**
 * Results Settings reports to its opener (`onResult` of `<Surface>`). Shell
 * requests ("Open budget", another settings place) travel as
 * `{ action: 'shell' }` results instead (lib/surface-shell-requests).
 */
export type AppSettingsSurfaceResult = { action: 'openOnboarding' }

export function isAppSettingsSurfaceResult(value: unknown): value is AppSettingsSurfaceResult {
  return (value as { action?: unknown } | null)?.action === 'openOnboarding'
}

/**
 * Closing waits for any result still in flight, so "do X, then close" reaches
 * the opener before the window (and its IPC channel) goes away, and hands the
 * toasts still on screen to the opener so the last outcome is not lost.
 */
function useSurfaceWindowLifecycle(id: NativeSurfaceId, projectId?: string) {
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => mirrorSurfaceStorageWrites(), [])
  useEffect(() => {
    let stop: (() => void) | undefined
    let disposed = false
    void trackSurfaceGeometry(id).then(unlisten => { if (disposed) unlisten(); else stop = unlisten })
    return () => { disposed = true; stop?.() }
  }, [id])
  const surface = useMemo(() => ({
    report(result: unknown) { pending.current = reportSurfaceResult(result).catch(() => {}) },
    close() { setTimeout(() => { void pending.current.then(() => handOffSurfaceToasts()).then(() => closeCurrentSurfaceWindow()) }, 0) },
  }), [])
  // This window has no app shell: "Open budget", "Configure" (project settings)
  // and settings links run in the opener. Forward them, then close, so the
  // opener (focused by the host on close) shows the place in front. The live
  // board stays open on its screen (the host brings the opener forward).
  useEffect(() => forwardSurfaceShellRequests((result) => {
    surface.report(result)
    if (id !== 'live-board') surface.close()
  }, { projectId }), [surface, projectId, id])
  return surface
}

/** Selects the surface's project in this window only (isolated DesktopProvider). */
function useSurfaceProject(projectId: string | undefined): boolean {
  const { projects, isLoading, activeProjectId, setActiveProjectId } = useDesktop()
  const known = !!projectId && projects.some(project => project.id === projectId)
  useEffect(() => {
    if (!isLoading && known && activeProjectId !== projectId) setActiveProjectId(projectId!)
  }, [isLoading, known, activeProjectId, projectId, setActiveProjectId])
  return !projectId || (!isLoading && activeProjectId === projectId) || (!isLoading && !known)
}

function AppSettingsWindow({ params }: { params: SurfaceParams }) {
  const surface = useSurfaceWindowLifecycle('app-settings')
  const section = (APP_SETTINGS_SECTIONS as readonly string[]).includes(params.section ?? '') ? params.section as AppSettingsSection : 'appearance'
  return (
    <SettingsDialog
      open
      initialSection={section}
      initialSettingId={params.settingId}
      onClose={surface.close}
      onOpenOnboarding={params.onboarding === '1' ? () => { surface.report({ action: 'openOnboarding' }); surface.close() } : undefined}
    />
  )
}

function ProjectSettingsWindow({ params }: { params: SurfaceParams }) {
  const surface = useSurfaceWindowLifecycle('project-settings', params.projectId)
  const ready = useSurfaceProject(params.projectId)
  const { activeProjectId, projects } = useDesktop()
  const available = !!params.projectId && projects.some(({ id }) => id === params.projectId)
  useEffect(() => {
    if (ready && !available) surface.close()
  }, [ready, available, surface])
  // Once shown, the dialog stays mounted while projects refresh: unmounting it would reset its
  // scroll and in-progress edits.
  const shown = useRef(false)
  const showable = ready && available && params.projectId === activeProjectId
  if (showable) shown.current = true
  if (!showable && !shown.current) return null
  return <ProjectSettingsDialog target={params} onClose={surface.close} />
}

function JobDetailWindow({ params }: { params: SurfaceParams }) {
  const surface = useSurfaceWindowLifecycle('job-detail', params.projectId)
  const ready = useSurfaceProject(params.projectId)
  if (!params.jobId || !ready) return null
  return <JobDetailModal jobId={params.jobId} projectId={params.projectId} onClose={surface.close} />
}

/** The live board on a second screen: card actions run in the main window (the host brings it forward). */
function LiveBoardSurfaceWindow() {
  const surface = useSurfaceWindowLifecycle('live-board')
  // Intent sessions read through the missions seam, as in the main window (no Intent state is mounted here).
  return (
    <MissionExtensionsProvider value={FLOW_MISSION_EXTENSIONS}>
      <LiveBoardWindow report={surface.report} onClose={surface.close} />
    </MissionExtensionsProvider>
  )
}

/**
 * Shows the (hidden) window once the surface has painted: two frames after the
 * framed dialog is in the DOM, so the first visible frame is the real content.
 */
function RevealWhenPainted() {
  useEffect(() => {
    let frame = 0
    let revealed = false
    const reveal = () => {
      if (revealed || !document.querySelector('[data-surface-window]')) return false
      revealed = true
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { void revealCurrentSurfaceWindow().catch(() => {}) }) })
      return true
    }
    if (reveal()) return () => cancelAnimationFrame(frame)
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  return null
}

/**
 * The content of a native surface window (`index.html?surfaceWindow=<id>`).
 * The frame (and so `[data-surface-window]`) only enters the DOM with the
 * loaded content, so the reveal still shows real content on its first frame.
 */
export function SurfaceWindowContent({ id, params }: { id: NativeSurfaceId; params: SurfaceParams }) {
  const content = {
    'app-settings': <AppSettingsWindow params={params} />,
    'project-settings': <ProjectSettingsWindow params={params} />,
    'live-board': <LiveBoardSurfaceWindow />,
    'job-detail': <JobDetailWindow params={params} />,
  }[id]
  return (
    <Suspense fallback={null}>
      <SurfaceWindowFrame>
        {content}
        <RevealWhenPainted />
      </SurfaceWindowFrame>
    </Suspense>
  )
}
