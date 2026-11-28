import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { SurfaceWindowFrame } from './components/ui/dialog'
import { useDesktop } from './hooks/useDesktop'
import { MissionExtensionsProvider } from './features/missions/context/MissionExtensionsContext'
import { FLOW_MISSION_EXTENSIONS } from './features/intent/components/IntentMissionsBridge'
import { APP_SETTINGS_SECTIONS, type AppSettingsSection } from './lib/app-settings-events'
import { forwardSurfaceShellRequests } from './lib/surface-shell-requests'
import {
  NATIVE_SURFACE_IDS,
  adoptSurfaceRoute,
  awaitSurfaceAssignment,
  closeCurrentSurfaceWindow,
  mirrorSurfaceStorageWrites,
  reportSurfaceResult,
  revealCurrentSurfaceWindow,
  trackSurfaceGeometry,
  type NativeSurfaceId,
  type SurfaceAssignment,
  type SurfaceParams,
} from './lib/native-surfaces'
import { handOffSurfaceToasts } from './lib/surface-toasts'

// The window's content loads in its own chunk so the main window does not ship it. It renders
// only once its module has loaded, as a plain component: not `React.lazy`, whose first render
// suspends even when the chunk is already loaded, and React then holds the revealed content back
// (its Suspense throttle, ~300 ms) on every window, the pre-loaded spare included.
interface SurfaceModules {
  'app-settings': typeof import('./features/settings/pages/GlobalSettingsPage').default
  'project-settings': typeof import('./features/settings/pages/SettingsPage').ProjectSettingsDialog
  'job-detail': typeof import('./features/jobs/components/JobDetailModal').JobDetailModal
  'live-board': typeof import('./features/live-board/components/LiveBoardWindow').default
}
const loaders: { [Id in NativeSurfaceId]: () => Promise<SurfaceModules[Id]> } = {
  'app-settings': () => import('./features/settings/pages/GlobalSettingsPage').then(module => module.default),
  'project-settings': () => import('./features/settings/pages/SettingsPage').then(module => module.ProjectSettingsDialog),
  'job-detail': () => import('./features/jobs/components/JobDetailModal').then(module => module.JobDetailModal),
  'live-board': () => import('./features/live-board/components/LiveBoardWindow').then(module => module.default),
}
/** Loaded surface components. Code, not data: nothing here is per project. */
const modules: Partial<SurfaceModules> = {}

export function preloadSurfaceWindowContent(id: NativeSurfaceId): Promise<void> {
  return loaders[id]().then((component: SurfaceModules[typeof id]) => { (modules as Record<NativeSurfaceId, unknown>)[id] = component }, () => {})
}

/** Whether `id`'s component has loaded; loads it otherwise. */
function useSurfaceModule(id: NativeSurfaceId): boolean {
  const [loaded, setLoaded] = useState(() => !!modules[id])
  useEffect(() => {
    if (loaded) return
    let live = true
    void preloadSurfaceWindowContent(id).then(() => { if (live && modules[id]) setLoaded(true) })
    return () => { live = false }
  }, [id, loaded])
  return loaded
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
  const SettingsDialog = modules['app-settings']!
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
  const ProjectSettingsDialog = modules['project-settings']!
  return <ProjectSettingsDialog target={params} onClose={surface.close} />
}

function JobDetailWindow({ params }: { params: SurfaceParams }) {
  const surface = useSurfaceWindowLifecycle('job-detail', params.projectId)
  const ready = useSurfaceProject(params.projectId)
  if (!params.jobId || !ready) return null
  const JobDetailModal = modules['job-detail']!
  return <JobDetailModal jobId={params.jobId} projectId={params.projectId} onClose={surface.close} />
}

/** The live board on a second screen: card actions run in the main window (the host brings it forward). */
function LiveBoardSurfaceWindow() {
  const LiveBoardWindow = modules['live-board']!
  const surface = useSurfaceWindowLifecycle('live-board')
  // Intent sessions read through the missions seam, as in the main window (no Intent state is mounted here).
  return (
    <MissionExtensionsProvider value={FLOW_MISSION_EXTENSIONS}>
      <LiveBoardWindow report={surface.report} onClose={surface.close} />
    </MissionExtensionsProvider>
  )
}

/**
 * Shows the (hidden) window as soon as the framed dialog is in the DOM, laid
 * out and its fonts are ready, so the first visible frame is the real content.
 *
 * Not `requestAnimationFrame`: WebKit runs no animation frames in a hidden
 * window, so a frame-based reveal never fired and every window waited for the
 * host's fallback show (2.5 s). A macrotask after the commit runs hidden, and
 * the window paints its current DOM the moment it is shown.
 */
export function RevealWhenPainted({ reveal = revealCurrentSurfaceWindow }: { reveal?: () => Promise<void> }) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const show = () => {
      if (done || !document.querySelector('[data-surface-window]')) return false
      done = true
      timer = setTimeout(() => { void fontsReady().then(() => reveal()).catch(() => {}) }, 0)
      return true
    }
    if (show()) return () => clearTimeout(timer)
    const observer = new MutationObserver(() => { if (show()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [reveal])
  return null
}

/** Web fonts settle before the window shows (bounded: a stuck font never holds the window). */
function fontsReady(limitMs = 150): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts || fonts.status === 'loaded') return Promise.resolve()
  return Promise.race([fonts.ready.then(() => {}), new Promise<void>(resolve => setTimeout(resolve, limitMs))])
}

/**
 * The content of a native surface window (`index.html?surfaceWindow=<id>`), rendered once its
 * module has loaded. The frame (and so `[data-surface-window]`) only enters the DOM with that
 * content, so the reveal shows real content on its first frame. The Suspense boundary is for code
 * the content itself loads later (a dialog opened inside it).
 */
export function SurfaceWindowContent({ id, params }: { id: NativeSurfaceId; params: SurfaceParams }) {
  const loaded = useSurfaceModule(id)
  if (!loaded) return null
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
/** Every localStorage value, to tell which preferences changed while a spare waited. */
function snapshotStorage(): Map<string, string | null> {
  const values = new Map<string, string | null>()
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key !== null) values.set(key, localStorage.getItem(key))
    }
  } catch { /* storage blocked */ }
  return values
}

function storageEvent(key: string, oldValue: string | null, newValue: string | null): StorageEvent {
  try { return new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }) } catch {
    // Environments whose localStorage is not a native Storage reject `storageArea`.
    return new StorageEvent('storage', { key, oldValue, newValue })
  }
}

/**
 * Preferences (theme, language, accessibility…) changed in another window since this one loaded:
 * WebKit does not reliably deliver `storage` events across webviews, so replay them here, and every
 * listener (ThemeProvider, LanguageProvider, a11y, effects, editor) applies the current value.
 */
export function replayStorageChanges(before: Map<string, string | null>): void {
  const after = snapshotStorage()
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key) ?? null
    const newValue = after.get(key) ?? null
    if (oldValue === newValue) continue
    window.dispatchEvent(storageEvent(key, oldValue, newValue))
  }
}

/**
 * The spare window (`?surfaceWindow=spare`): the surface shell is mounted and every surface's
 * code is loaded while the window is hidden. When the host assigns it a surface, it takes that
 * surface's URL, catches up on preferences and projects that changed meanwhile, and renders it;
 * the window shows once the content has painted, like a cold one.
 */
export function SpareSurfaceWindowContent() {
  const [assignment, setAssignment] = useState<SurfaceAssignment | null>(null)
  const { projects, refreshProjects } = useDesktop()
  const desktop = useRef({ projects, refreshProjects })
  desktop.current = { projects, refreshProjects }
  useEffect(() => {
    const before = snapshotStorage()
    let stop: (() => void) | undefined
    let disposed = false
    void Promise.all(NATIVE_SURFACE_IDS.map(preloadSurfaceWindowContent))
      .then(() => awaitSurfaceAssignment((next) => {
        adoptSurfaceRoute(next)
        replayStorageChanges(before)
        // A project added after this window loaded: know it before the surface looks for it.
        const projectId = next.params.projectId
        const known = !projectId || desktop.current.projects.some(({ id }) => id === projectId)
        void (known ? Promise.resolve() : desktop.current.refreshProjects().catch(() => {})).then(() => { if (!disposed) setAssignment(next) })
      }))
      .then((unlisten) => { if (disposed) unlisten(); else stop = unlisten })
      .catch(() => { /* no host: stays a blank hidden window, never used */ })
    return () => { disposed = true; stop?.() }
  }, [])
  return assignment ? <SurfaceWindowContent id={assignment.surface} params={assignment.params} /> : null
}
