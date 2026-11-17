import { useEffect, useMemo, useRef } from 'react'
import { SurfaceWindowFrame } from './components/ui/dialog'
import SettingsDialog from './features/settings/pages/GlobalSettingsPage'
import { JobDetailModal } from './features/jobs/components/JobDetailModal'
import { useDesktop } from './hooks/useDesktop'
import { APP_SETTINGS_SECTIONS, OPEN_BUDGET_PANEL_EVENT, type AppSettingsSection } from './lib/app-settings-events'
import {
  closeCurrentSurfaceWindow,
  mirrorSurfaceStorageWrites,
  reportSurfaceResult,
  trackSurfaceGeometry,
  type NativeSurfaceId,
  type SurfaceParams,
} from './lib/native-surfaces'

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

/** The content of a native surface window (`index.html?surfaceWindow=<id>`). */
export function SurfaceWindowContent({ id, params }: { id: NativeSurfaceId; params: SurfaceParams }) {
  return (
    <SurfaceWindowFrame>
      {id === 'app-settings' ? <AppSettingsWindow params={params} /> : <JobDetailWindow params={params} />}
    </SurfaceWindowFrame>
  )
}
