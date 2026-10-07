import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { getAgentActiveTurns, getMissionSubagents, stopMissionSubagents } from '../lib/agent-api'
import {
  applySessionMessage,
  applySessionSnapshot,
  dismissSessionNotice,
  settleMissingSessions,
  type MissionSessionView,
  type MissionSessionsState,
  type SessionWsMessage,
} from '../lib/mission-sessions'

const SESSION_EVENTS = new Set(['agent_resident_state', 'agent_subagent', 'agent_subagent_event', 'agent_turn_started', 'agent_turn_done', 'agent_session_updated', 'agent_session_notice', 'agent_sessions_host', 'agent_stream'])

interface MissionSessionsValue {
  sessions: MissionSessionsState
  /** Load a mission's sub-agents once (conversation opened). */
  ensureLoaded: (conversationId: string) => void
  stopSubagents: (conversationId: string, subagentIds?: string[]) => Promise<string[]>
  dismissNotice: (conversationId: string, noticeId: string) => void
  /** Missions whose agent is still working in the background (sidebar live dot). */
  backgroundConversationIds: ReadonlySet<string>
}

const MissionSessionsContext = createContext<MissionSessionsValue | null>(null)

/**
 * Live state of missions that run in Core agent sessions (sub-agents, resident
 * phase, background turns). Kept apart from AgentChatContext: it follows its own
 * server events and reconciles from the active-turns snapshot on reconnect.
 */
export function MissionSessionsProvider({ children }: { children: ReactNode }) {
  // State is keyed by conversation, so split panes share the outermost provider.
  const parent = useContext(MissionSessionsContext)
  if (parent) return <>{children}</>
  return <MissionSessionsRoot>{children}</MissionSessionsRoot>
}

function MissionSessionsRoot({ children }: { children: ReactNode }) {
  const handlerId = `mission-sessions:${useId()}`
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const [sessions, setSessions] = useState<MissionSessionsState>(() => new Map())
  const loading = useRef(new Set<string>())

  useEffect(() => {
    const handler = (raw: unknown): void => {
      const message = raw as SessionWsMessage
      if (!message || typeof message.type !== 'string' || !SESSION_EVENTS.has(message.type)) return
      setSessions((state) => applySessionMessage(state, message))
    }
    registerHandler(handlerId, handler)
    return () => unregisterHandler(handlerId)
  }, [registerHandler, unregisterHandler, handlerId])

  const ensureLoaded = useCallback((conversationId: string) => {
    if (loading.current.has(conversationId)) return
    loading.current.add(conversationId)
    void getMissionSubagents(conversationId)
      .then(({ subagents, session }) => setSessions((state) => applySessionSnapshot(state, conversationId, session ? { ...session, subagents } : subagents.length ? { residentPhase: 'idle', processAlive: false, liveSubagents: 0, subagents } : null)))
      .catch(() => { loading.current.delete(conversationId) })
  }, [])

  // Mount and reconnect: the server's snapshot is authoritative for background work.
  const previousStatus = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = connectionStatus
    if (connectionStatus !== 'connected' || previous === 'connected') return
    void getAgentActiveTurns().then((snapshot) => {
      const live = snapshot.sessions ?? []
      setSessions((state) => {
        // Settle only after a reconnect: on first mount nothing is stale, and a
        // concurrent per-mission load may be fresher than this snapshot.
        let next = previous === null ? state : settleMissingSessions(state, new Set(live.map((item) => item.conversationId)))
        for (const item of live) next = applySessionSnapshot(next, item.conversationId, item)
        return next
      })
    }).catch(() => { /* the next reconnect retries */ })
  }, [connectionStatus])

  const stopSubagents = useCallback(async (conversationId: string, subagentIds?: string[]) => (await stopMissionSubagents(conversationId, subagentIds)).stopped, [])

  const dismissNotice = useCallback((conversationId: string, noticeId: string) => setSessions((state) => dismissSessionNotice(state, conversationId, noticeId)), [])
  const backgroundConversationIds = useMemo(() => new Set([...sessions].filter(([, view]) => view.residentPhase !== 'idle' || view.liveSubagents > 0).map(([id]) => id)), [sessions])
  const value = useMemo(() => ({ sessions, ensureLoaded, stopSubagents, dismissNotice, backgroundConversationIds }), [sessions, ensureLoaded, stopSubagents, dismissNotice, backgroundConversationIds])
  return <MissionSessionsContext.Provider value={value}>{children}</MissionSessionsContext.Provider>
}

const NOOP: MissionSessionsValue = { sessions: new Map(), ensureLoaded: () => {}, stopSubagents: async () => [], dismissNotice: () => {}, backgroundConversationIds: new Set() }

export function useMissionSessions(): MissionSessionsValue {
  return useContext(MissionSessionsContext) ?? NOOP
}

/** One mission's session view (loads it on first use). */
export function useMissionSession(conversationId: string | null | undefined): MissionSessionView | undefined {
  const { sessions, ensureLoaded } = useMissionSessions()
  useEffect(() => { if (conversationId) ensureLoaded(conversationId) }, [conversationId, ensureLoaded])
  return conversationId ? sessions.get(conversationId) : undefined
}
