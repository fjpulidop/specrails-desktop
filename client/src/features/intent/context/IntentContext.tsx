// ─── Intent state on the client ─────────────────────────────────────────────────
// One provider above the mission chat. It caches the Intent of each
// (project, conversation) a view asked for, the per-project availability, and
// session-local UI facts: which Flows are "wrapping up" (the user pressed
// "Hand off" and the hand-off panel is showing), the hand-off choices the
// person made (rail, engine, model, effort — restored when it reopens), which
// hand-offs are in flight, and which were just handed off (the run strip keeps
// a launching skeleton until the run itself shows).
//
// WebSocket: `flow.state { projectId, conversationId, flow }`. Missions can be
// pinned to any project, so the filter is the set of projects a mounted view
// WATCHES (a ref, never a stale closure); events for other projects are ignored.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { flowApi, type IntentSession, type IntentAvailability, type IntentHandOffResult } from '../lib/intent-api'

/** Conversations in Intent mode, per project (the mission list's mark). */
export type IntentOpenConversations = ReadonlyMap<string, ReadonlyMap<string, IntentSession['state']>>

const IN_FLOW_STATES: ReadonlySet<IntentSession['state']> = new Set(['active', 'paused', 'needs-review'])

/** The hand-off choices kept per Intent while the app runs (rail, engine, model, effort). */
export interface IntentHandOffDraft {
  railIndex: number | null
  newRail: boolean
  aiEngine: string | null
  model: string | null
  reasoningEffort: string | null
}

export interface IntentHandOffReceipt {
  railIndex: number
  runIds: string[]
  deliveryId: string | null
}

interface IntentEntry {
  flow: IntentSession | null
  loaded: boolean
}

export interface IntentContextValue {
  entries: ReadonlyMap<string, IntentEntry>
  availability: ReadonlyMap<string, IntentAvailability>
  wrappingUp: ReadonlySet<string>
  /** Flows whose hand-off request is in flight (the strip's launching skeleton). */
  launching: ReadonlySet<string>
  handedOff: ReadonlyMap<string, IntentHandOffReceipt>
  /** The person's hand-off choices per Intent id (kept across "Not yet" and reopening). */
  handOffDrafts: ReadonlyMap<string, IntentHandOffDraft>
  setHandOffDraft: (flowId: string, draft: IntentHandOffDraft | null) => void
  watch: (projectId: string, conversationId: string) => () => void
  /** Re-read a conversation's Intent from the server (nothing is dropped meanwhile). */
  refreshFlow: (projectId: string, conversationId: string) => void
  /** Conversations in Intent per watched project (watchOpen). */
  openConversations: IntentOpenConversations
  /** Keep a project's in-Intent conversations current (fetch + flow.state events). */
  watchOpen: (projectId: string) => () => void
  loadAvailability: (projectId: string, force?: boolean) => void
  /** `ticketId`: start from that existing spec instead of a free idea. */
  start: (projectId: string, conversationId: string, idea: string, title?: string | null, repositoryId?: string | null, ticketId?: number | null) => Promise<IntentSession>
  pause: (projectId: string, flow: IntentSession) => Promise<IntentSession>
  resume: (projectId: string, flow: IntentSession) => Promise<IntentSession>
  discard: (projectId: string, flow: IntentSession) => Promise<IntentSession>
  /** End a needs-review Intent keeping its branch (and whatever worktree is left). */
  close: (projectId: string, flow: IntentSession) => Promise<IntentSession>
  handOff: (projectId: string, flow: IntentSession, input: { railIndex: number; loopId?: string; aiEngine?: string; model?: string; reasoningEffort?: string }) => Promise<IntentHandOffResult>
  /** Back to Intent from an Intent session → Spec delivery that stopped with requested changes. */
  returnToFlow: (projectId: string, deliveryId: string) => Promise<IntentSession>
  /** Relaunch Intent → Spec on the same worktree from that delivery. */
  relaunch: (projectId: string, deliveryId: string) => Promise<IntentHandOffResult>
  setWrappingUp: (flowId: string, on: boolean) => void
  /** Drop the hand-off receipt (the strip stops waiting for the run; the Intent state rules). */
  forgetHandOff: (flowId: string) => void
}

const IntentContext = createContext<IntentContextValue | null>(null)

export const flowKey = (projectId: string, conversationId: string): string => `${projectId}\u0000${conversationId}`

interface IntentStateMessage {
  type?: string
  projectId?: string
  conversationId?: string
  flow?: IntentSession
}

export function IntentProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const [entries, setEntries] = useState<ReadonlyMap<string, IntentEntry>>(new Map())
  const [availability, setAvailability] = useState<ReadonlyMap<string, IntentAvailability>>(new Map())
  const [wrappingUp, setWrappingUpState] = useState<ReadonlySet<string>>(new Set())
  const [handedOff, setHandedOff] = useState<ReadonlyMap<string, IntentHandOffReceipt>>(new Map())
  const [launching, setLaunching] = useState<ReadonlySet<string>>(new Set())
  const [handOffDrafts, setHandOffDrafts] = useState<ReadonlyMap<string, IntentHandOffDraft>>(new Map())
  const setHandOffDraft = useCallback((flowId: string, draft: IntentHandOffDraft | null) => {
    setHandOffDrafts((current) => {
      if (!draft && !current.has(flowId)) return current
      const next = new Map(current)
      if (draft) next.set(flowId, draft); else next.delete(flowId)
      return next
    })
  }, [])
  // Watch counts per key / per project: the WS filter and refetch targets.
  const watchedKeys = useRef(new Map<string, { projectId: string; conversationId: string; count: number }>())
  const watchedProjects = useRef(new Map<string, number>())
  const availabilityRequested = useRef(new Set<string>())
  const [openConversations, setOpenConversations] = useState<IntentOpenConversations>(new Map())
  const openWatched = useRef(new Map<string, number>())

  const setOpenState = useCallback((projectId: string, conversationId: string, state: IntentSession['state'] | null) => {
    setOpenConversations((current) => {
      const before = current.get(projectId)
      const inFlow = state !== null && IN_FLOW_STATES.has(state)
      if ((before?.get(conversationId) ?? null) === (inFlow ? state : null)) return current
      const project = new Map(before ?? [])
      if (inFlow) project.set(conversationId, state)
      else project.delete(conversationId)
      return new Map(current).set(projectId, project)
    })
  }, [])

  const fetchOpen = useCallback((projectId: string) => {
    flowApi.open(projectId)
      .then((flows) => {
        if (!openWatched.current.has(projectId)) return
        setOpenConversations((current) => new Map(current).set(projectId, new Map(flows.filter((flow) => IN_FLOW_STATES.has(flow.state)).map((flow) => [flow.conversationId, flow.state]))))
      })
      .catch(() => { /* older server or Intent unavailable: no marks */ })
  }, [])

  const watchOpen = useCallback((projectId: string) => {
    const count = openWatched.current.get(projectId) ?? 0
    openWatched.current.set(projectId, count + 1)
    if (count === 0) fetchOpen(projectId)
    return () => {
      const left = (openWatched.current.get(projectId) ?? 1) - 1
      if (left <= 0) openWatched.current.delete(projectId)
      else openWatched.current.set(projectId, left)
    }
  }, [fetchOpen])

  const upsert = useCallback((projectId: string, conversationId: string, flow: IntentSession | null) => {
    setEntries((current) => {
      const next = new Map(current)
      next.set(flowKey(projectId, conversationId), { flow, loaded: true })
      return next
    })
  }, [])

  const fetchFlow = useCallback((projectId: string, conversationId: string) => {
    flowApi.byConversation(projectId, conversationId)
      .then((flow) => {
        if (watchedKeys.current.has(flowKey(projectId, conversationId))) upsert(projectId, conversationId, flow)
      })
      .catch(() => {
        // Intent unavailable (old Core, disabled module): the conversation has none.
        if (watchedKeys.current.has(flowKey(projectId, conversationId))) upsert(projectId, conversationId, null)
      })
  }, [upsert])

  const watch = useCallback((projectId: string, conversationId: string) => {
    const key = flowKey(projectId, conversationId)
    const existing = watchedKeys.current.get(key)
    if (existing) existing.count += 1
    else {
      watchedKeys.current.set(key, { projectId, conversationId, count: 1 })
      fetchFlow(projectId, conversationId)
    }
    watchedProjects.current.set(projectId, (watchedProjects.current.get(projectId) ?? 0) + 1)
    return () => {
      const entry = watchedKeys.current.get(key)
      if (entry && --entry.count <= 0) watchedKeys.current.delete(key)
      const projectCount = (watchedProjects.current.get(projectId) ?? 1) - 1
      if (projectCount <= 0) watchedProjects.current.delete(projectId)
      else watchedProjects.current.set(projectId, projectCount)
    }
  }, [fetchFlow])

  const loadAvailability = useCallback((projectId: string, force = false) => {
    if (!force && availabilityRequested.current.has(projectId)) return
    availabilityRequested.current.add(projectId)
    flowApi.availability(projectId)
      .then((value) => setAvailability((current) => new Map(current).set(projectId, value)))
      .catch((error: unknown) => setAvailability((current) => new Map(current).set(projectId, {
        available: false, reason: error instanceof Error ? error.message : String(error), missing: [],
      })))
  }, [])

  // Live updates, filtered by the watched projects (current ref, no stale closure).
  useEffect(() => {
    registerHandler('flow-mode', (raw: unknown) => {
      const message = raw as IntentStateMessage
      if (message?.type !== 'flow.state' || !message.projectId || !message.conversationId || !message.flow) return
      if (openWatched.current.has(message.projectId)) setOpenState(message.projectId, message.conversationId, message.flow.state)
      if (!watchedProjects.current.has(message.projectId)) return
      upsert(message.projectId, message.conversationId, message.flow)
    })
    return () => unregisterHandler('flow-mode')
  }, [registerHandler, unregisterHandler, upsert, setOpenState])

  // A reconnect may have missed events: refetch every watched conversation.
  const previousStatus = useRef(connectionStatus)
  useEffect(() => {
    if (previousStatus.current !== 'connected' && connectionStatus === 'connected') {
      for (const { projectId, conversationId } of watchedKeys.current.values()) fetchFlow(projectId, conversationId)
      for (const projectId of openWatched.current.keys()) fetchOpen(projectId)
    }
    previousStatus.current = connectionStatus
  }, [connectionStatus, fetchFlow, fetchOpen])

  const setWrappingUp = useCallback((flowId: string, on: boolean) => {
    setWrappingUpState((current) => {
      if (current.has(flowId) === on) return current
      const next = new Set(current)
      if (on) next.add(flowId); else next.delete(flowId)
      return next
    })
  }, [])

  const apply = useCallback((projectId: string, flow: IntentSession) => {
    upsert(projectId, flow.conversationId, flow)
    if (openWatched.current.has(projectId)) setOpenState(projectId, flow.conversationId, flow.state)
    return flow
  }, [upsert])

  const start = useCallback(async (projectId: string, conversationId: string, idea: string, title?: string | null, repositoryId?: string | null, ticketId?: number | null) =>
    apply(projectId, await flowApi.start(projectId, { conversationId, idea, ...(title ? { title } : {}), ...(repositoryId ? { repositoryId } : {}), ...(ticketId ? { ticketId } : {}) })), [apply])
  const pause = useCallback(async (projectId: string, flow: IntentSession) => apply(projectId, await flowApi.pause(projectId, flow.id)), [apply])
  const resume = useCallback(async (projectId: string, flow: IntentSession) => {
    setWrappingUp(flow.id, false)
    return apply(projectId, await flowApi.resume(projectId, flow.id))
  }, [apply, setWrappingUp])
  const discard = useCallback(async (projectId: string, flow: IntentSession) => {
    const next = apply(projectId, await flowApi.discard(projectId, flow.id))
    setWrappingUp(flow.id, false)
    return next
  }, [apply, setWrappingUp])
  const close = useCallback(async (projectId: string, flow: IntentSession) => {
    const next = apply(projectId, await flowApi.close(projectId, flow.id))
    setWrappingUp(flow.id, false)
    return next
  }, [apply, setWrappingUp])
  const handOff = useCallback(async (projectId: string, flow: IntentSession, input: Parameters<IntentContextValue['handOff']>[2]) => {
    setLaunching((current) => new Set(current).add(flow.id))
    let result: IntentHandOffResult
    try {
      result = await flowApi.handOff(projectId, flow.id, input)
    } finally {
      setLaunching((current) => {
        if (!current.has(flow.id)) return current
        const next = new Set(current)
        next.delete(flow.id)
        return next
      })
    }
    setHandedOff((current) => new Map(current).set(flow.id, { railIndex: input.railIndex, runIds: result.loopRunIds, deliveryId: result.deliveryId }))
    apply(projectId, result.flow)
    setWrappingUp(flow.id, false)
    // Launched: the next hand-off (after Back to Intent) starts from the defaults again.
    setHandOffDraft(flow.id, null)
    return result
  }, [apply, setWrappingUp, setHandOffDraft])

  const forgetHandOff = useCallback((flowId: string) => {
    setHandedOff((current) => {
      if (!current.has(flowId)) return current
      const next = new Map(current)
      next.delete(flowId)
      return next
    })
  }, [])
  const returnToFlow = useCallback(async (projectId: string, deliveryId: string) => {
    const flow = apply(projectId, await flowApi.returnToFlow(projectId, deliveryId))
    // The Intent bar replaces the "launched" stub: the work is back in Intent.
    forgetHandOff(flow.id)
    setWrappingUp(flow.id, false)
    return flow
  }, [apply, forgetHandOff, setWrappingUp])
  const relaunch = useCallback(async (projectId: string, deliveryId: string) => {
    const result = await flowApi.relaunch(projectId, deliveryId)
    if (result.flow.railIndex !== null) {
      setHandedOff((current) => new Map(current).set(result.flow.id, { railIndex: result.flow.railIndex!, runIds: result.loopRunIds, deliveryId: result.deliveryId }))
    }
    apply(projectId, result.flow)
    return result
  }, [apply])

  // A watched conversation's Intent is the freshest source for its mark too.
  useEffect(() => {
    for (const [key, entry] of entries) {
      const [projectId, conversationId] = key.split('\u0000')
      if (openWatched.current.has(projectId)) setOpenState(projectId, conversationId, entry.flow?.state ?? null)
    }
  }, [entries, setOpenState])

  const value = useMemo<IntentContextValue>(() => ({
    entries, availability, wrappingUp, launching, handedOff, handOffDrafts, setHandOffDraft, watch, refreshFlow: fetchFlow, openConversations, watchOpen, loadAvailability, start, pause, resume, discard, close, handOff, returnToFlow, relaunch, setWrappingUp, forgetHandOff,
  }), [entries, availability, wrappingUp, launching, handedOff, handOffDrafts, setHandOffDraft, watch, fetchFlow, openConversations, watchOpen, loadAvailability, start, pause, resume, discard, close, handOff, returnToFlow, relaunch, setWrappingUp, forgetHandOff])

  return <IntentContext.Provider value={value}>{children}</IntentContext.Provider>
}

export function useFlowContext(): IntentContextValue | null {
  return useContext(IntentContext)
}

/** The Intent of a conversation (watched while mounted). */
export function useConversationFlow(conversationId: string | null, projectId: string | null): { flow: IntentSession | null; loaded: boolean } {
  const ctx = useFlowContext()
  const watch = ctx?.watch
  useEffect(() => {
    if (!watch || !conversationId || !projectId) return
    return watch(projectId, conversationId)
  }, [watch, projectId, conversationId])
  if (!ctx || !conversationId || !projectId) return { flow: null, loaded: !ctx }
  const entry = ctx.entries.get(flowKey(projectId, conversationId))
  return { flow: entry?.flow ?? null, loaded: !!entry?.loaded }
}

/** Per-project Intent availability (loaded once per project, refreshable). */
export function useFlowAvailability(projectId: string | null): IntentAvailability | null {
  const ctx = useFlowContext()
  const load = ctx?.loadAvailability
  useEffect(() => {
    if (load && projectId) load(projectId)
  }, [load, projectId])
  return projectId ? ctx?.availability.get(projectId) ?? null : null
}
