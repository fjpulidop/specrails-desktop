// ─── Flow state on the client ─────────────────────────────────────────────────
// One provider above the mission chat. It caches the Flow of each
// (project, conversation) a view asked for, the per-project availability, and
// two session-local UI facts: which Flows are "wrapping up" (the user pressed
// "This is it" and the hand-off card is showing) and which were just handed
// off (the dock keeps the launched stub until the next reload).
//
// WebSocket: `flow.state { projectId, conversationId, flow }`. Missions can be
// pinned to any project, so the filter is the set of projects a mounted view
// WATCHES (a ref, never a stale closure); events for other projects are ignored.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { flowApi, type Flow, type FlowAvailability, type FlowHandOffResult } from '../lib/flow-api'

export interface FlowHandOffReceipt {
  railIndex: number
  runIds: string[]
  deliveryId: string | null
}

interface FlowEntry {
  flow: Flow | null
  loaded: boolean
}

export interface FlowContextValue {
  entries: ReadonlyMap<string, FlowEntry>
  availability: ReadonlyMap<string, FlowAvailability>
  wrappingUp: ReadonlySet<string>
  handedOff: ReadonlyMap<string, FlowHandOffReceipt>
  watch: (projectId: string, conversationId: string) => () => void
  loadAvailability: (projectId: string, force?: boolean) => void
  start: (projectId: string, conversationId: string, idea: string, title?: string | null) => Promise<Flow>
  pause: (projectId: string, flow: Flow) => Promise<Flow>
  resume: (projectId: string, flow: Flow) => Promise<Flow>
  discard: (projectId: string, flow: Flow) => Promise<Flow>
  handOff: (projectId: string, flow: Flow, input: { railIndex: number; loopId?: string; aiEngine?: string; model?: string; reasoningEffort?: string }) => Promise<FlowHandOffResult>
  /** Back to Flow from a Flow → Spec delivery that stopped with requested changes. */
  returnToFlow: (projectId: string, deliveryId: string) => Promise<Flow>
  /** Relaunch Flow → Spec on the same worktree from that delivery. */
  relaunch: (projectId: string, deliveryId: string) => Promise<FlowHandOffResult>
  setWrappingUp: (flowId: string, on: boolean) => void
}

const FlowContext = createContext<FlowContextValue | null>(null)

export const flowKey = (projectId: string, conversationId: string): string => `${projectId}\u0000${conversationId}`

interface FlowStateMessage {
  type?: string
  projectId?: string
  conversationId?: string
  flow?: Flow
}

export function FlowProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const [entries, setEntries] = useState<ReadonlyMap<string, FlowEntry>>(new Map())
  const [availability, setAvailability] = useState<ReadonlyMap<string, FlowAvailability>>(new Map())
  const [wrappingUp, setWrappingUpState] = useState<ReadonlySet<string>>(new Set())
  const [handedOff, setHandedOff] = useState<ReadonlyMap<string, FlowHandOffReceipt>>(new Map())
  // Watch counts per key / per project: the WS filter and refetch targets.
  const watchedKeys = useRef(new Map<string, { projectId: string; conversationId: string; count: number }>())
  const watchedProjects = useRef(new Map<string, number>())
  const availabilityRequested = useRef(new Set<string>())

  const upsert = useCallback((projectId: string, conversationId: string, flow: Flow | null) => {
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
        // Flow unavailable (old Core, disabled module): the conversation has none.
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
      const message = raw as FlowStateMessage
      if (message?.type !== 'flow.state' || !message.projectId || !message.conversationId || !message.flow) return
      if (!watchedProjects.current.has(message.projectId)) return
      upsert(message.projectId, message.conversationId, message.flow)
    })
    return () => unregisterHandler('flow-mode')
  }, [registerHandler, unregisterHandler, upsert])

  // A reconnect may have missed events: refetch every watched conversation.
  const previousStatus = useRef(connectionStatus)
  useEffect(() => {
    if (previousStatus.current !== 'connected' && connectionStatus === 'connected') {
      for (const { projectId, conversationId } of watchedKeys.current.values()) fetchFlow(projectId, conversationId)
    }
    previousStatus.current = connectionStatus
  }, [connectionStatus, fetchFlow])

  const setWrappingUp = useCallback((flowId: string, on: boolean) => {
    setWrappingUpState((current) => {
      if (current.has(flowId) === on) return current
      const next = new Set(current)
      if (on) next.add(flowId); else next.delete(flowId)
      return next
    })
  }, [])

  const apply = useCallback((projectId: string, flow: Flow) => {
    upsert(projectId, flow.conversationId, flow)
    return flow
  }, [upsert])

  const start = useCallback(async (projectId: string, conversationId: string, idea: string, title?: string | null) =>
    apply(projectId, await flowApi.start(projectId, { conversationId, idea, ...(title ? { title } : {}) })), [apply])
  const pause = useCallback(async (projectId: string, flow: Flow) => apply(projectId, await flowApi.pause(projectId, flow.id)), [apply])
  const resume = useCallback(async (projectId: string, flow: Flow) => {
    setWrappingUp(flow.id, false)
    return apply(projectId, await flowApi.resume(projectId, flow.id))
  }, [apply, setWrappingUp])
  const discard = useCallback(async (projectId: string, flow: Flow) => {
    const next = apply(projectId, await flowApi.discard(projectId, flow.id))
    setWrappingUp(flow.id, false)
    return next
  }, [apply, setWrappingUp])
  const handOff = useCallback(async (projectId: string, flow: Flow, input: Parameters<FlowContextValue['handOff']>[2]) => {
    const result = await flowApi.handOff(projectId, flow.id, input)
    setHandedOff((current) => new Map(current).set(flow.id, { railIndex: input.railIndex, runIds: result.loopRunIds, deliveryId: result.deliveryId }))
    apply(projectId, result.flow)
    setWrappingUp(flow.id, false)
    return result
  }, [apply, setWrappingUp])

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
    // The Flow bar replaces the "launched" stub: the work is back in Flow.
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

  const value = useMemo<FlowContextValue>(() => ({
    entries, availability, wrappingUp, handedOff, watch, loadAvailability, start, pause, resume, discard, handOff, returnToFlow, relaunch, setWrappingUp,
  }), [entries, availability, wrappingUp, handedOff, watch, loadAvailability, start, pause, resume, discard, handOff, returnToFlow, relaunch, setWrappingUp])

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>
}

export function useFlowContext(): FlowContextValue | null {
  return useContext(FlowContext)
}

/** The Flow of a conversation (watched while mounted). */
export function useConversationFlow(conversationId: string | null, projectId: string | null): { flow: Flow | null; loaded: boolean } {
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

/** Per-project Flow availability (loaded once per project, refreshable). */
export function useFlowAvailability(projectId: string | null): FlowAvailability | null {
  const ctx = useFlowContext()
  const load = ctx?.loadAvailability
  useEffect(() => {
    if (load && projectId) load(projectId)
  }, [load, projectId])
  return projectId ? ctx?.availability.get(projectId) ?? null : null
}
