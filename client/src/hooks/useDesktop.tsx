import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
  type ReactNode,
} from 'react'
import { API_ORIGIN } from '../lib/origin'
import type { ProviderId } from '../lib/provider-capabilities'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import { useSharedWebSocket } from './useSharedWebSocket'
import { setActiveProjectId as setApiActiveProjectId } from '../lib/api'
import { purgeProjectCache } from './useProjectCache'

export interface DesktopProject {
  id: string
  slug: string
  name: string
  path: string
  db_path: string
  /** Primary / default provider (first selected at install). */
  provider: ProviderId
  /** All providers installed for this project. Always contains `provider`.
   *  Optional for forward-compat: older server payloads omit it, callers fall
   *  back to `[provider]`. */
  providers?: ProviderId[]
  added_at: string
  last_seen_at: string
}

/** Installed providers for a project, tolerant of legacy payloads w/o `providers`. */
export function projectProviders(p: Pick<DesktopProject, 'provider' | 'providers'>): ProviderId[] {
  return p.providers && p.providers.length > 0 ? p.providers : [p.provider]
}

export interface AddProjectResult {
  project: DesktopProject
  has_specrails: boolean
}

interface DesktopContextValue {
  projects: DesktopProject[]
  activeProjectId: string | null
  setActiveProjectId: (id: string | null) => void
  addProject: (path: string, name?: string, providers?: ProviderId[]) => Promise<AddProjectResult | null>
  removeProject: (id: string) => Promise<void>
  isLoading: boolean
  /** True briefly after switching active project — triggers the loading bar */
  isSwitchingProject: boolean
}

const DesktopContext = createContext<DesktopContextValue | null>(null)

const ACTIVE_PROJECT_KEY = 'specrails-desktop:activeProjectId'

function writeSavedProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
  } catch { /* ignore */ }
}

// B22: the last-active project was persisted but never read back, so a refresh
// always activated the first-added project. This restores it.
function readSavedProjectId(): string | null {
  try { return localStorage.getItem(ACTIVE_PROJECT_KEY) } catch { return null }
}

export function DesktopProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<DesktopProject[]>([])
  const [activeProjectId, setActiveProjectIdRaw] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSwitchingProject, setIsSwitchingProject] = useState(false)
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // BUG-CLIENT-04: project ids this client just added via `addProject`. The
  // server echoes a `desktop.project_added` broadcast back to the initiator;
  // we skip the redundant toast + re-activation for our own additions.
  const justAddedRef = useRef<Set<string>>(new Set())

  const setActiveProjectId = useCallback((id: string | null): void => {
    writeSavedProjectId(id)
    setApiActiveProjectId(id)
    setActiveProjectIdRaw((prev) => {
      if (prev !== null && prev !== id) {
        // Briefly flag project switching for the progress bar
        if (switchTimerRef.current) clearTimeout(switchTimerRef.current)
        setIsSwitchingProject(true)
        switchTimerRef.current = setTimeout(() => setIsSwitchingProject(false), 400)
      }
      return id
    })
  }, [])
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // Load projects from REST on mount
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects`)
        if (!res.ok) return
        const data = await res.json() as { projects: DesktopProject[] }
        setProjects(data.projects)
      } catch {
        // Network error — treat as empty project list
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  // Handle app-level WebSocket messages
  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (typeof msg.type !== 'string') return

    if (msg.type === 'desktop.projects') {
      // BUG-CLIENT-01: guard against a malformed frame whose `projects` isn't an
      // array — otherwise `incoming.find` below throws and (pre-fix) starved the
      // shared WS fan-out for every later-registered handler.
      if (!Array.isArray(msg.projects)) return
      const incoming = msg.projects as DesktopProject[]
      setProjects(incoming)
      setActiveProjectIdRaw((prev) => {
        let next: string | null
        if (prev && incoming.find((p) => p.id === prev)) {
          next = prev
        } else {
          // B22: on first resolution prefer the persisted last-active project,
          // falling back to the first project when it's gone / unset.
          const saved = readSavedProjectId()
          next = (saved && incoming.find((p) => p.id === saved))
            ? saved
            : (incoming.length > 0 ? incoming[0].id : null)
        }
        writeSavedProjectId(next)
        setApiActiveProjectId(next)
        return next
      })
      setIsLoading(false)
    } else if (msg.type === 'desktop.project_added') {
      const project = msg.project as DesktopProject
      setProjects((prev) => {
        if (prev.find((p) => p.id === project.id)) return prev
        return [...prev, project]
      })
      // BUG-CLIENT-04: this broadcast is echoed back to the client that called
      // `addProject` (which already appended + activated locally). Suppress the
      // redundant "project added" toast and the no-op re-activation for our own
      // additions; peers still get both.
      if (justAddedRef.current.has(project.id)) {
        justAddedRef.current.delete(project.id)
      } else {
        toast.success(i18n.t('nav:projects.added', { name: project.name }))
        // Activate the newly added project
        setActiveProjectId(project.id)
      }
    } else if (msg.type === 'providers.detected_changed') {
      // The machine's detected provider set changed (CLI installed/removed).
      // Project rows mirror the detected set server-side — refetch so every
      // selector/section converges without a reload.
      fetch(`${API_ORIGIN}/api/projects`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { projects: DesktopProject[] } | null) => {
          if (data && Array.isArray(data.projects)) setProjects(data.projects)
        })
        .catch(() => { /* transient — next trigger converges */ })
    } else if (msg.type === 'desktop.project_removed') {
      const projectId = msg.projectId as string
      toast.success(i18n.t('nav:projects.removed'))
      // BUG-CLIENT-03: free the removed project's cache entries so the module-
      // level globalCache doesn't grow unbounded across add/remove cycles.
      purgeProjectCache(projectId)
      setProjects((prev) => prev.filter((p) => p.id !== projectId))
      setActiveProjectIdRaw((prev) => {
        if (prev !== projectId) return prev
        writeSavedProjectId(null)
        setApiActiveProjectId(null)
        return null
      })
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('desktop', handleMessage)
    return () => unregisterHandler('desktop')
  }, [handleMessage, registerHandler, unregisterHandler])

  // Window-focus is a provider-detection refresh trigger (spec:
  // provider-auto-detection). Throttled client-side to the server's 60s cache
  // window; the server broadcasts `providers.detected_changed` when the usable
  // set actually changed, which the handler above turns into a projects refetch.
  const lastDetectRefreshRef = useRef(0)
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now()
      if (now - lastDetectRefreshRef.current < 60_000) return
      lastDetectRefreshRef.current = now
      fetch(`${API_ORIGIN}/api/providers/detected?refresh=1`).catch(() => { /* best-effort */ })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const addProject = useCallback(async (projectPath: string, name?: string, providers?: ProviderId[]): Promise<AddProjectResult | null> => {
    try {
      // Omitting providers registers with the machine's DETECTED set (server
      // authoritative — global-core-zero-friction). Explicit lists are wire
      // compat for callers that still pass one.
      const body: Record<string, unknown> = { path: projectPath }
      if (providers && providers.length > 0) body.providers = providers
      if (name) body.name = name

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as AddProjectResult
      // BUG-CLIENT-04: mark this id so the echoed `desktop.project_added`
      // broadcast doesn't double-toast / re-activate for the initiator.
      justAddedRef.current.add(data.project.id)
      setProjects((prev) => {
        if (prev.find((p) => p.id === data.project.id)) return prev
        return [...prev, data.project]
      })
      setActiveProjectId(data.project.id)
      return data
    } catch (err) {
      console.error('[useDesktop] addProject error:', err)
      throw err
    }
  }, [setActiveProjectId])

  const removeProject = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      // BUG-CLIENT-03: drop this project's cached data on local removal too
      // (not only via the echoed WS broadcast).
      purgeProjectCache(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
      setActiveProjectIdRaw((prev) => {
        if (prev !== id) return prev
        writeSavedProjectId(null)
        setApiActiveProjectId(null)
        return null
      })
    } catch (err) {
      console.error('[useDesktop] removeProject error:', err)
      throw err
    }
  }, [])

  const contextValue = useMemo(() => ({
    projects,
    activeProjectId,
    setActiveProjectId,
    addProject,
    removeProject,
    isLoading,
    isSwitchingProject,
  }), [projects, activeProjectId, setActiveProjectId, addProject, removeProject, isLoading, isSwitchingProject])

  return (
    <DesktopContext.Provider value={contextValue}>
      {children}
    </DesktopContext.Provider>
  )
}

const LEGACY_FALLBACK: DesktopContextValue = {
  projects: [],
  activeProjectId: null,
  setActiveProjectId: () => {},
  addProject: async () => null,
  removeProject: async () => {},
  isLoading: false,
  isSwitchingProject: false,
}

export function useDesktop(): DesktopContextValue {
  const ctx = useContext(DesktopContext)
  // In legacy (non-Super) mode there is no DesktopProvider — return safe defaults
  return ctx ?? LEGACY_FALLBACK
}
