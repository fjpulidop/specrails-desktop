/**
 * Cross-project spec generation tracker.
 *
 * Lives at DesktopApp level — never unmounts during a session. Owns the WebSocket
 * handlers and in-flight Maps so they survive project switches (which unmount
 * DashboardPage and ProposeSpecModal).
 *
 * Also restores in-flight specs from localStorage after a page refresh, polling
 * ALL projects (not just the currently active one).
 */
import {
  createContext,
  useContext,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import { useSharedWebSocket } from './useSharedWebSocket'
import { useDesktop } from './useDesktop'
import { API_ORIGIN } from '../lib/origin'
import { forceProjectRoute } from '../lib/route-memory'
import { formatElapsed, readPendingSpecs, savePendingSpec, removePendingSpec } from '../lib/pending-specs'
import { markSpecGenInFlight, unmarkSpecGenInFlight } from '../lib/spec-gen-suppression'
import type { LocalTicket } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Spec registration — ProposeSpecModal passes this to the tracker on submit. */
export interface SpecRegistration {
  toastId: string
  truncated: string
  knownTicketIds: Set<number>
  projectId: string
  projectName: string
  startTime: number
  persistId: string
}

interface TrackedSpec extends SpecRegistration {
  timerId: ReturnType<typeof setInterval>
}

interface SpecToOpen {
  ticket: LocalTicket
  projectId: string
}

interface SpecGenTrackerValue {
  registerFastSpec: (requestId: string, reg: SpecRegistration) => void
  registerExploreSpec: (conversationId: string, reg: SpecRegistration) => void
  /** Set when user clicks "View". DashboardPage reads and clears this. */
  specToOpen: SpecToOpen | null
  clearSpecToOpen: () => void
}

const SpecGenTrackerContext = createContext<SpecGenTrackerValue | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────────

const MAX_RESTORE_ATTEMPTS = 40
const RESTORE_POLL_MS = 3000

export function SpecGenTrackerProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const { setActiveProjectId } = useDesktop()
  const navigate = useNavigate()
  const [specToOpen, setSpecToOpen] = useState<SpecToOpen | null>(null)

  // fast mode: requestId → TrackedSpec
  const fastRef = useRef<Map<string, TrackedSpec>>(new Map())
  // explore mode: conversationId → TrackedSpec
  const exploreRef = useRef<Map<string, TrackedSpec>>(new Map())

  const activeProjectIdRef = useRef<string | null>(null)
  const { activeProjectId } = useDesktop()
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

  // ── Internal helpers ────────────────────────────────────────────────────────

  const startTimer = useCallback((spec: TrackedSpec) => {
    const id = setInterval(() => {
      toast.loading(`${spec.projectName} · ${spec.truncated}`, {
        id: spec.toastId,
        description: i18n.t('activity:specGen.generating', { elapsed: formatElapsed(Date.now() - spec.startTime) }),
      })
    }, 1000)
    spec.timerId = id
  }, [])

  const resolveSpec = useCallback((spec: TrackedSpec) => {
    clearInterval(spec.timerId)
    removePendingSpec(spec.persistId)
    unmarkSpecGenInFlight(spec.projectId)
  }, [])

  const openTicket = useCallback((spec: TrackedSpec, ticket: LocalTicket) => {
    if (spec.projectId !== activeProjectIdRef.current) {
      // Different project: force dashboard route, switch project
      forceProjectRoute(spec.projectId, '/')
      setSpecToOpen({ ticket, projectId: spec.projectId })
      setActiveProjectId(spec.projectId)
    } else {
      // Same project: signal DashboardPage directly (no project switch needed)
      setSpecToOpen({ ticket, projectId: spec.projectId })
      if (window.location.pathname !== '/') navigate('/')
    }
  }, [setActiveProjectId, navigate])

  const successToast = useCallback((spec: TrackedSpec, ticket: LocalTicket) => {
    resolveSpec(spec)
    const elapsed = formatElapsed(Date.now() - spec.startTime)
    toast.success(`${spec.projectName} · ${ticket.title || i18n.t('activity:specGen.specCreated')}`, {
      id: spec.toastId,
      duration: 10_000,
      description: i18n.t('activity:specGen.generatedIn', { elapsed }),
      action: { label: i18n.t('activity:specGen.view'), onClick: () => openTicket(spec, ticket) },
    })
  }, [resolveSpec, openTicket])

  const errorToast = useCallback((spec: TrackedSpec, message?: string) => {
    resolveSpec(spec)
    toast.error(`${spec.projectName} · ${message ?? i18n.t('activity:specGen.errorGenerating')}`, { id: spec.toastId })
  }, [resolveSpec])

  // ── Explore mode: poll for new ticket ──────────────────────────────────────

  const pollForNewTicket = useCallback((spec: TrackedSpec, convId?: string) => {
    let attempts = 0
    async function attempt() {
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects/${spec.projectId}/tickets`)
        if (!res.ok) throw new Error('fetch failed')
        const data = await res.json() as { tickets: LocalTicket[] } | LocalTicket[]
        const list: LocalTicket[] = Array.isArray(data) ? data : (data as { tickets: LocalTicket[] }).tickets ?? []
        const newTicket = list.find(t => !spec.knownTicketIds.has(t.id))
        if (newTicket) {
          if (convId) exploreRef.current.delete(convId)
          successToast(spec, newTicket)
          return
        }
      } catch { /* ignore */ }
      attempts++
      if (attempts < 5) setTimeout(attempt, 1000)
      else {
        if (convId) exploreRef.current.delete(convId)
        errorToast(spec, i18n.t('activity:specGen.couldNotFind'))
      }
    }
    attempt()
  }, [successToast, errorToast])

  // ── Registration (called by ProposeSpecModal) ──────────────────────────────

  const registerSpec = useCallback((reg: SpecRegistration): TrackedSpec => {
    const spec: TrackedSpec = { ...reg, timerId: 0 as unknown as ReturnType<typeof setInterval> }
    markSpecGenInFlight(reg.projectId)
    startTimer(spec)
    savePendingSpec({
      id: reg.persistId,
      knownTicketIds: [...reg.knownTicketIds],
      projectId: reg.projectId,
      projectName: reg.projectName,
      startTime: reg.startTime,
      truncated: reg.truncated,
    })
    return spec
  }, [startTimer])

  const registerFastSpec = useCallback((requestId: string, reg: SpecRegistration) => {
    const spec = registerSpec(reg)
    fastRef.current.set(requestId, spec)
  }, [registerSpec])

  const registerExploreSpec = useCallback((conversationId: string, reg: SpecRegistration) => {
    const spec = registerSpec(reg)
    exploreRef.current.set(conversationId, spec)
  }, [registerSpec])

  // ── WS handlers — registered ONCE, never unregistered (tracker is persistent) ──

  const handleSpecGenWs = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (!msg || typeof msg.type !== 'string') return
    // Only handle terminal fast-mode events
    if (msg.type !== 'spec_gen_done' && msg.type !== 'spec_gen_error') return
    const reqId = msg.requestId as string | undefined
    if (!reqId) return
    const spec = fastRef.current.get(reqId)
    if (!spec) return
    fastRef.current.delete(reqId)

    if (msg.type === 'spec_gen_done') {
      successToast(spec, msg.ticket as LocalTicket)
    } else {
      errorToast(spec)
    }
  }, [successToast, errorToast])

  const handleChatDone = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (!msg || typeof msg.type !== 'string') return
    const convId = msg.conversationId as string | undefined
    if (!convId) return
    const spec = exploreRef.current.get(convId)
    if (!spec) return

    if (msg.type === 'chat_error') {
      exploreRef.current.delete(convId)
      errorToast(spec)
      return
    }
    if (msg.type !== 'chat_done') return
    pollForNewTicket(spec, convId)
  }, [pollForNewTicket, errorToast])

  const handleTicketWs = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (!msg || typeof msg.type !== 'string') return
    if (msg.type !== 'ticket_created' && msg.type !== 'ticket_updated') return
    const ticket = msg.ticket as LocalTicket | undefined
    if (!ticket) return
    const eventProjectId = msg.projectId as string | undefined

    for (const [convId, spec] of exploreRef.current.entries()) {
      // Only consider specs belonging to the project that emitted the ticket
      // event — a ticket in project B almost never matches A's knownTicketIds,
      // which previously triggered spurious cross-project polls (and a premature
      // "couldn't find" drop of A's still-pending spec).
      if (eventProjectId && spec.projectId !== eventProjectId) continue
      if (!spec.knownTicketIds.has(ticket.id)) {
        pollForNewTicket(spec, convId)
      }
    }
  }, [pollForNewTicket])

  useLayoutEffect(() => {
    registerHandler('_tracker_spec_gen', handleSpecGenWs)
    registerHandler('_tracker_chat_done', handleChatDone)
    registerHandler('_tracker_tickets', handleTicketWs)
    return () => {
      unregisterHandler('_tracker_spec_gen')
      unregisterHandler('_tracker_chat_done')
      unregisterHandler('_tracker_tickets')
    }
  }, [handleSpecGenWs, handleChatDone, handleTicketWs, registerHandler, unregisterHandler])

  // ── Restore pending specs from localStorage on mount ──────────────────────

  const restoredRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const pending = readPendingSpecs()
    if (pending.length === 0) return

    for (const p of pending) {
      if (restoredRef.current.has(p.id)) continue
      restoredRef.current.add(p.id)

      const toastId = `spec-restore-${p.id}`
      const knownIds = new Set(p.knownTicketIds)

      const updateToast = () => {
        toast.loading(`${p.projectName} · ${p.truncated}`, {
          id: toastId,
          description: i18n.t('activity:specGen.generating', { elapsed: formatElapsed(Date.now() - p.startTime) }),
        })
      }
      updateToast()
      const timerId = setInterval(updateToast, 1000)
      markSpecGenInFlight(p.projectId)

      let attempts = 0
      const restoredSpec: TrackedSpec = {
        toastId,
        truncated: p.truncated,
        knownTicketIds: knownIds,
        projectId: p.projectId,
        projectName: p.projectName,
        startTime: p.startTime,
        persistId: p.id,
        timerId,
      }

      async function attempt() {
        try {
          const res = await fetch(`${API_ORIGIN}/api/projects/${p.projectId}/tickets`)
          if (!res.ok) throw new Error()
          const data = await res.json() as { tickets: LocalTicket[] } | LocalTicket[]
          const list: LocalTicket[] = Array.isArray(data) ? data : (data as { tickets: LocalTicket[] }).tickets ?? []
          const newTicket = list.find(t => !knownIds.has(t.id))
          if (newTicket) {
            clearInterval(timerId)
            removePendingSpec(p.id)
            unmarkSpecGenInFlight(p.projectId)
            const elapsed = formatElapsed(Date.now() - p.startTime)
            toast.success(`${p.projectName} · ${newTicket.title || i18n.t('activity:specGen.specCreated')}`, {
              id: toastId,
              duration: 10_000,
              description: i18n.t('activity:specGen.generatedIn', { elapsed }),
              action: { label: i18n.t('activity:specGen.view'), onClick: () => openTicket(restoredSpec, newTicket) },
            })
            return
          }
        } catch { /* ignore */ }
        attempts++
        if (attempts < MAX_RESTORE_ATTEMPTS) setTimeout(attempt, RESTORE_POLL_MS)
        else {
          clearInterval(timerId)
          removePendingSpec(p.id)
          unmarkSpecGenInFlight(p.projectId)
          toast.error(`${p.projectName} · ${i18n.t('activity:specGen.couldNotConfirm')}`, { id: toastId })
        }
      }
      attempt()
    }
  }, [openTicket])

  const clearSpecToOpen = useCallback(() => setSpecToOpen(null), [])

  const value = useMemo(
    () => ({ registerFastSpec, registerExploreSpec, specToOpen, clearSpecToOpen }),
    [registerFastSpec, registerExploreSpec, specToOpen, clearSpecToOpen],
  )

  return (
    <SpecGenTrackerContext.Provider value={value}>
      {children}
    </SpecGenTrackerContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const NOOP_TRACKER: SpecGenTrackerValue = {
  registerFastSpec: () => {},
  registerExploreSpec: () => {},
  specToOpen: null,
  clearSpecToOpen: () => {},
}

/** Returns the tracker, or a no-op fallback in legacy (non-Super) mode. */
export function useSpecGenTracker(): SpecGenTrackerValue {
  return useContext(SpecGenTrackerContext) ?? NOOP_TRACKER
}
