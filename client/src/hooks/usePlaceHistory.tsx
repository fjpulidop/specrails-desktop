import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useDesktop } from './useDesktop'
import { useUiMode } from '../context/UiModeContext'
import {
  JOB_PARAM,
  MISSION_PARAM,
  OVERLAY_PARAM,
  PROJECT_PARAM,
  REVIEW_PARAM,
  SPEC_PARAM,
  PlaceStack,
  jobIdFromPath,
  parseOverlay,
  placeKey,
  reviewIdFromPath,
  type PlaceEntry,
  type PlaceMode,
} from '../lib/places'

/** What a place target can no longer be found as. */
export type MissingPlaceKind = 'spec' | 'mission' | 'job' | 'review'

export interface PlaceTarget {
  /** Offset-free absolute index in the history stack. */
  idx: number
  label: string
}

/** Resolves a human label for an id inside a place (e.g. a spec's title). Return null when unknown. */
export type PlaceLabelResolver = (kind: 'spec' | 'mission', id: string, projectId: string | null) => string | null

export interface PlaceHistoryValue {
  canBack: boolean
  canForward: boolean
  back: () => void
  forward: () => void
  /** Jump straight to an entry listed by `list()` (history menu). */
  goTo: (idx: number) => void
  backTarget: PlaceTarget | null
  forwardTarget: PlaceTarget | null
  /** Up to `limit` distinct places in a direction, nearest first. */
  list: (direction: 'back' | 'forward', limit?: number) => PlaceTarget[]
  /**
   * The place the URL points at no longer exists (deleted spec / mission).
   * After a Back/Forward the entry is skipped (continuing in the same
   * direction) with a quiet toast; otherwise the offending param is removed.
   */
  reportMissing: (kind: MissingPlaceKind) => void
  registerLabelResolver: (resolver: PlaceLabelResolver) => () => void
  /**
   * True (once) when the active project changed because Back/Forward restored
   * an entry of that project; the route memory must then keep the restored URL.
   */
  consumeProjectRestore: (projectId: string) => boolean
  /** Project the current history entry belongs to (null before the project list resolved). Live: safe in effects of the same commit. */
  getCurrentEntryProjectId: () => string | null
}

const PlaceHistoryContext = createContext<PlaceHistoryValue | null>(null)

/** Place history, or null outside the main window (mission windows, isolated tests). */
export function usePlaceHistory(): PlaceHistoryValue | null {
  return useContext(PlaceHistoryContext)
}

const MISSING_PARAMS: Record<MissingPlaceKind, string[]> = {
  spec: [SPEC_PARAM],
  mission: [MISSION_PARAM],
  job: [JOB_PARAM],
  review: [REVIEW_PARAM],
}

function readBrowserIdx(): number | undefined {
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx
    return typeof idx === 'number' ? idx : undefined
  } catch {
    return undefined
  }
}

export function PlaceHistoryProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('nav')
  const location = useLocation()
  const navType = useNavigationType()
  const navigate = useNavigate()
  const { projects, activeProjectId, setActiveProjectId } = useDesktop()
  const { uiMode } = useUiMode()
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const stackRef = useRef<PlaceStack>(null as unknown as PlaceStack)
  if (!stackRef.current) stackRef.current = new PlaceStack()
  const stack = stackRef.current

  const modeRef = useRef<PlaceMode>(uiMode)
  modeRef.current = uiMode === 'agent' ? 'agent' : 'kanban'
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const activeProjectRef = useRef(activeProjectId)
  activeProjectRef.current = activeProjectId
  const setActiveProjectRef = useRef(setActiveProjectId)
  setActiveProjectRef.current = setActiveProjectId
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const locationRef = useRef(location)
  locationRef.current = location
  const tRef = useRef(t)
  tRef.current = t

  // A Back/Forward the user asked for, until its entry arrives.
  const pendingRef = useRef<{ dir: 1 | -1; fromIdx: number } | null>(null)
  // The last arrival caused by a user Back/Forward (valid until the next navigation).
  const arrivalRef = useRef<{ dir: 1 | -1; fromIdx: number; idx: number } | null>(null)
  const projectRestoreRef = useRef<string | null>(null)
  const resolversRef = useRef(new Set<PlaceLabelResolver>())

  const keyOf = useCallback((e: PlaceEntry) => placeKey(e, modeRef.current), [])

  // ── Mirror every navigation into the stack ────────────────────────────────
  useLayoutEffect(() => {
    const entry = stack.record(
      navType,
      { key: location.key, pathname: location.pathname, search: location.search },
      activeProjectRef.current,
      readBrowserIdx(),
    )
    const pending = pendingRef.current
    if (navType === 'POP' && pending) {
      arrivalRef.current = { ...pending, idx: stack.idx }
    } else {
      arrivalRef.current = null
    }
    pendingRef.current = null

    // Back/Forward onto an entry of another project restores that project.
    if (navType === 'POP') {
      const fromUrl = new URLSearchParams(entry.search).get(PROJECT_PARAM)
      const wanted = entry.projectId ?? fromUrl
      if (wanted && wanted !== activeProjectRef.current) {
        if (projectsRef.current.some((p) => p.id === wanted)) {
          projectRestoreRef.current = wanted
          setActiveProjectRef.current(wanted)
        } else if (projectsRef.current.length > 0) {
          // The project was removed: this place is gone for good.
          stack.markDead(stack.idx)
          const arrival = arrivalRef.current
          if (arrival) {
            const next = stack.findTarget(arrival.dir, keyOf)
            navigateRef.current((next ?? arrival.fromIdx) - stack.idx)
          }
        }
      }
    }
    bump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  // An entry created before the project list resolved adopts the first project.
  useEffect(() => {
    stack.adoptProject(activeProjectId)
  }, [activeProjectId, stack])

  // The mode decides which entries are restorable: re-render consumers on toggle.
  useEffect(() => { bump() }, [uiMode])

  // ── Navigation ────────────────────────────────────────────────────────────
  const step = useCallback((dir: 1 | -1) => {
    const target = stack.findTarget(dir, keyOf)
    if (target === null) return
    pendingRef.current = { dir, fromIdx: stack.idx }
    navigateRef.current(target - stack.idx)
  }, [stack, keyOf])

  const back = useCallback(() => step(-1), [step])
  const forward = useCallback(() => step(1), [step])

  const goTo = useCallback((idx: number) => {
    if (idx === stack.idx) return
    pendingRef.current = { dir: idx < stack.idx ? -1 : 1, fromIdx: stack.idx }
    navigateRef.current(idx - stack.idx)
  }, [stack])

  const reportMissing = useCallback((kind: MissingPlaceKind) => {
    const arrival = arrivalRef.current
    toast(tRef.current(`places.skipped.${kind}`), { duration: 3500 })
    if (arrival && arrival.idx === stack.idx) {
      stack.markDead(stack.idx)
      arrivalRef.current = null
      const next = stack.findTarget(arrival.dir, keyOf)
      pendingRef.current = { dir: arrival.dir, fromIdx: arrival.fromIdx }
      // Nothing further that way: return to where the user was.
      navigateRef.current((next ?? arrival.fromIdx) - stack.idx)
      return
    }
    const loc = locationRef.current
    const params = new URLSearchParams(loc.search)
    for (const name of MISSING_PARAMS[kind]) params.delete(name)
    const search = params.toString()
    navigateRef.current({ pathname: loc.pathname, search: search ? `?${search}` : '' }, { replace: true, state: loc.state })
  }, [stack, keyOf])

  // ── Labels ────────────────────────────────────────────────────────────────
  const registerLabelResolver = useCallback((resolver: PlaceLabelResolver) => {
    resolversRef.current.add(resolver)
    return () => { resolversRef.current.delete(resolver) }
  }, [])

  const describe = useCallback((entry: PlaceEntry): string => {
    if (entry.label) return entry.label
    const tt = tRef.current
    const params = new URLSearchParams(entry.search)
    const resolve = (kind: 'spec' | 'mission', id: string): string | null => {
      for (const r of resolversRef.current) {
        const label = r(kind, id, entry.projectId)
        if (label) return label
      }
      return null
    }
    let label: string
    let resolved = false
    const spec = params.get(SPEC_PARAM)
    const review = params.get(REVIEW_PARAM) ?? reviewIdFromPath(entry.pathname)
    const job = params.get(JOB_PARAM) ?? jobIdFromPath(entry.pathname)
    const overlay = parseOverlay(params.get(OVERLAY_PARAM))
    const mission = params.get(MISSION_PARAM)
    const path = entry.pathname
    if (spec) {
      const title = resolve('spec', spec)
      resolved = !!title
      label = title ? tt('places.specTitled', { id: spec, title }) : tt('places.spec', { id: spec })
    } else if (review) {
      label = tt('places.review')
    } else if (job) {
      label = tt('places.job', { id: job.slice(0, 8) })
    } else if (overlay) {
      label = tt(`places.overlays.${overlay}`)
    } else if (modeRef.current === 'agent' && mission && !path.startsWith('/docs')) {
      const title = resolve('mission', mission)
      resolved = !!title
      label = title ? tt('places.missionTitled', { title }) : tt('places.mission')
    } else if (path.startsWith('/docs')) label = tt('places.routes.docs')
    else if (path.startsWith('/loops')) label = tt('places.routes.loops')
    else if (path.startsWith('/plugins')) label = tt('places.routes.plugins')
    else if (path === '/jobs') label = tt('places.routes.jobs')
    else if (path === '/analytics') label = tt('places.routes.analytics')
    else if (path === '/activity') label = tt('places.routes.activity')
    else if (path === '/agents') label = tt('places.routes.agents')
    else if (path === '/code') label = tt('places.routes.code')
    else if (path === '/integrations') label = tt('places.routes.integrations')
    else if (path === '/settings') label = tt('places.routes.settings')
    else label = modeRef.current === 'agent' ? tt('places.mission') : tt('places.routes.dashboard')
    if (entry.projectId && entry.projectId !== activeProjectRef.current) {
      const name = projectsRef.current.find((p) => p.id === entry.projectId)?.name
      if (name) label = tt('places.inProject', { place: label, project: name })
    }
    if (resolved) entry.label = label
    return label
  }, [])

  const toTarget = useCallback((item: { idx: number; entry: PlaceEntry }): PlaceTarget => ({ idx: item.idx, label: describe(item.entry) }), [describe])

  const list = useCallback((direction: 'back' | 'forward', limit = 10): PlaceTarget[] =>
    stack.list(direction === 'back' ? -1 : 1, keyOf, limit).map(toTarget), [stack, keyOf, toTarget])

  const consumeProjectRestore = useCallback((projectId: string): boolean => {
    if (projectRestoreRef.current !== projectId) return false
    projectRestoreRef.current = null
    return true
  }, [])

  // ── Mouse back/forward buttons (4/5) ──────────────────────────────────────
  // preventDefault so WebView2 (which navigates natively) never double-navigates.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
      if (e.button === 3) back()
      else forward()
    }
    const swallow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
    }
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('mousedown', swallow, true)
    window.addEventListener('auxclick', swallow, true)
    return () => {
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('mousedown', swallow, true)
      window.removeEventListener('auxclick', swallow, true)
    }
  }, [back, forward])

  const backList = stack.list(-1, keyOf, 1)
  const forwardList = stack.list(1, keyOf, 1)
  const backTarget = backList[0] ? toTarget(backList[0]) : null
  const forwardTarget = forwardList[0] ? toTarget(forwardList[0]) : null
  const canBack = stack.findTarget(-1, keyOf) !== null
  const canForward = stack.findTarget(1, keyOf) !== null
  const getCurrentEntryProjectId = useCallback(() => stack.current()?.projectId ?? null, [stack])

  const value = useMemo<PlaceHistoryValue>(() => ({
    canBack,
    canForward,
    back,
    forward,
    goTo,
    backTarget,
    forwardTarget,
    list,
    reportMissing,
    registerLabelResolver,
    consumeProjectRestore,
    getCurrentEntryProjectId,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [backTarget?.idx, backTarget?.label, forwardTarget?.idx, forwardTarget?.label, canBack, canForward, getCurrentEntryProjectId, back, forward, goTo, list, reportMissing, registerLabelResolver, consumeProjectRestore, location.key, uiMode])

  return <PlaceHistoryContext.Provider value={value}>{children}</PlaceHistoryContext.Provider>
}
