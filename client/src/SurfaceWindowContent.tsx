import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { SurfaceWindowFrame } from './components/ui/dialog'
import { useDesktop } from './hooks/useDesktop'
import { APP_SETTINGS_SECTIONS, OPEN_BUDGET_PANEL_EVENT, type AppSettingsSection } from './lib/app-settings-events'
import {
  closeCurrentSurfaceWindow,
  mirrorSurfaceStorageWrites,
  reportSurfaceResult,
  revealCurrentSurfaceWindow,
  trackSurfaceGeometry,
  type NativeSurfaceId,
  type SurfaceParams,
} from './lib/native-surfaces'

// The window's content loads in its own chunk so the main window does not ship
// it. `preloadSurfaceWindowContent` starts that load as soon as the route is
// known; the window stays hidden until the content has painted (see below).
const loadSettingsDialog = () => import('./features/settings/pages/GlobalSettingsPage')
const loadJobDetailModal = () => import('./features/jobs/components/JobDetailModal')
const SettingsDialog = lazy(loadSettingsDialog)
const JobDetailModal = lazy(() => loadJobDetailModal().then(module => ({ default: module.JobDetailModal })))

export function preloadSurfaceWindowContent(id: NativeSurfaceId): void {
  void (id === 'app-settings' ? loadSettingsDialog() : loadJobDetailModal()).catch(() => {})
}

/** Results a surface window reports to its opener (`onResult` of `<Surface>`). */
export type AppSettingsSurfaceResult = { action: 'openOnboarding' } | { action: 'openBudget' }

export function isAppSettingsSurfaceResult(value: unknown): value is AppSettingsSurfaceResult {
  const action = (value as { action?: unknown } | null)?.action
  return action === 'openOnboarding' || action === 'openBudget'
}

/**
 * Closing waits for any result still in flight, so "do X, then close" reaches
 * the opener before the window (and its IPC channel) goes away.
 */
function useSurfaceWindowLifecycle(id: NativeSurfaceId) {
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => mirrorSurfaceStorageWrites(), [])
  useEffect(() => {
    let stop: (() => void) | undefined
    let disposed = false
    void trackSurfaceGeometry(id).then(unlisten => { if (disposed) unlisten(); else stop = unlisten })
    return () => { disposed = true; stop?.() }
  }, [id])
  return useMemo(() => ({
    report(result: unknown) { pending.current = reportSurfaceResult(result).catch(() => {}) },
    close() { setTimeout(() => { void pending.current.then(() => closeCurrentSurfaceWindow()) }, 0) },
  }), [])
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
  // "Open budget" navigates the main window: forward it and close.
  useEffect(() => {
    const onOpenBudget = () => { surface.report({ action: 'openBudget' }); surface.close() }
    globalThis.addEventListener(OPEN_BUDGET_PANEL_EVENT, onOpenBudget)
    return () => globalThis.removeEventListener(OPEN_BUDGET_PANEL_EVENT, onOpenBudget)
  }, [surface])
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

function JobDetailWindow({ params }: { params: SurfaceParams }) {
  const surface = useSurfaceWindowLifecycle('job-detail')
  const ready = useSurfaceProject(params.projectId)
  if (!params.jobId || !ready) return null
  return <JobDetailModal jobId={params.jobId} projectId={params.projectId} onClose={surface.close} />
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
  return (
    <Suspense fallback={null}>
      <SurfaceWindowFrame>
        {id === 'app-settings' ? <AppSettingsWindow params={params} /> : <JobDetailWindow params={params} />}
        <RevealWhenPainted />
      </SurfaceWindowFrame>
    </Suspense>
  )
}
