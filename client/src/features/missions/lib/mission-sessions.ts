import type { AgentSessionState, AgentSubagent, AgentSubagentEvent, AgentSubagentTool } from './agent-api'

/**
 * Client view of a mission's Core agent session: resident phase, sub-agent
 * tree, a bounded live tail per sub-agent and the turn the agent runs on its
 * own after background work. Pure reducer over server events/snapshots so the
 * provider stays thin and every transition is unit-testable.
 */
export interface BackgroundTurnView {
  turnId: string
  origin: 'subagent' | 'system'
  triggeredBy: string[]
  text: string
}

/** Something the user should know about the mission's session (host trouble, policy enforcement). */
export interface SessionNotice {
  id: string
  code: string
  level: 'info' | 'warning' | 'error'
  message: string
  /** Host scope the notice is about, when it concerns the session host. */
  scope: string | null
}

export const MAX_NOTICES = 5

export interface MissionSessionView {
  residentPhase: 'idle' | 'turn' | 'background'
  processAlive: boolean
  liveSubagents: number
  subagents: Record<string, AgentSubagent>
  /** Last live events per sub-agent (bounded); the drawer pages older history over HTTP. */
  liveEvents: Record<string, AgentSubagentEvent[]>
  backgroundTurn: BackgroundTurnView | null
  /** A settings change the session will apply once background work finishes. */
  deferredChanges: Record<string, unknown> | null
  notices: SessionNotice[]
  loaded: boolean
}

export type MissionSessionsState = ReadonlyMap<string, MissionSessionView>

export const MAX_LIVE_EVENTS_PER_SUBAGENT = 200

export function emptySession(): MissionSessionView {
  return { residentPhase: 'idle', processAlive: false, liveSubagents: 0, subagents: {}, liveEvents: {}, backgroundTurn: null, deferredChanges: null, notices: [], loaded: false }
}

export interface SessionWsMessage {
  type: string
  conversationId?: string
  phase?: 'idle' | 'turn' | 'background'
  liveSubagents?: number
  processAlive?: boolean
  subagent?: AgentSubagent
  subagentId?: string
  seq?: number
  channel?: 'text' | 'tool'
  delta?: string
  tool?: AgentSubagentTool
  turnId?: string
  origin?: 'user' | 'subagent' | 'system'
  triggeredBy?: string[]
  outcome?: 'applied' | 'deferred'
  changes?: Record<string, unknown>
  level?: 'info' | 'warning' | 'error'
  code?: string | null
  message?: string
  scope?: string
  status?: string
  timestamp?: string
}

function update(state: MissionSessionsState, conversationId: string, change: (view: MissionSessionView) => MissionSessionView): MissionSessionsState {
  const next = new Map(state)
  next.set(conversationId, change(state.get(conversationId) ?? emptySession()))
  return next
}

/** Apply one WebSocket message; unrelated messages return the same state object. */
export function applySessionMessage(state: MissionSessionsState, message: SessionWsMessage): MissionSessionsState {
  // App-level host status: a scope that is ready again clears its host notices everywhere.
  if (message.type === 'agent_sessions_host') {
    if (message.status !== 'ready' || !message.scope) return state
    return clearScopeNotices(state, message.scope)
  }
  const conversationId = message.conversationId
  if (!conversationId) return state
  switch (message.type) {
    case 'agent_resident_state':
      return update(state, conversationId, (view) => ({
        ...view,
        residentPhase: message.phase ?? view.residentPhase,
        processAlive: message.processAlive ?? view.processAlive,
        liveSubagents: message.liveSubagents ?? view.liveSubagents,
      }))
    case 'agent_subagent': {
      const subagent = message.subagent
      if (!subagent) return state
      return update(state, conversationId, (view) => ({ ...view, subagents: { ...view.subagents, [subagent.subagentId]: subagent } }))
    }
    case 'agent_subagent_event': {
      const subagentId = message.subagentId
      if (!subagentId || typeof message.seq !== 'number' || !message.channel) return state
      const event: AgentSubagentEvent = { seq: message.seq, channel: message.channel, delta: message.delta ?? null, tool: message.tool ?? null }
      return update(state, conversationId, (view) => {
        const current = view.liveEvents[subagentId] ?? []
        if (current.some((existing) => existing.seq === event.seq)) return view
        return { ...view, liveEvents: { ...view.liveEvents, [subagentId]: [...current, event].slice(-MAX_LIVE_EVENTS_PER_SUBAGENT) } }
      })
    }
    case 'agent_turn_started':
      if (!message.turnId || (message.origin !== 'subagent' && message.origin !== 'system')) return state
      return update(state, conversationId, (view) => ({ ...view, backgroundTurn: { turnId: message.turnId!, origin: message.origin as 'subagent' | 'system', triggeredBy: message.triggeredBy ?? [], text: '' } }))
    case 'agent_stream':
      // Only background turns carry a turnId; user-turn streaming belongs to AgentChatContext.
      if (!message.turnId) return state
      return update(state, conversationId, (view) => {
        const turn = view.backgroundTurn
        if (!turn || turn.turnId !== message.turnId) return view
        return { ...view, backgroundTurn: { ...turn, text: turn.text + (message.delta ?? '') } }
      })
    case 'agent_turn_done':
      return update(state, conversationId, (view) => view.backgroundTurn?.turnId === message.turnId ? { ...view, backgroundTurn: null } : view)
    case 'agent_session_notice': {
      if (!message.code) return state
      const notice: SessionNotice = {
        id: `${message.code}:${message.timestamp ?? Date.now()}`,
        code: message.code,
        level: message.level ?? 'warning',
        message: message.message ?? message.code,
        scope: message.scope ?? null,
      }
      return update(state, conversationId, (view) => {
        // One notice per code: a repeat refreshes it instead of stacking.
        const others = view.notices.filter((existing) => existing.code !== notice.code)
        return { ...view, notices: [...others, notice].slice(-MAX_NOTICES) }
      })
    }
    case 'agent_session_updated':
      return update(state, conversationId, (view) => ({ ...view, deferredChanges: message.outcome === 'deferred' ? { ...(view.deferredChanges ?? {}), ...(message.changes ?? {}) } : null }))
    default:
      return state
  }
}

/** The user dismissed a notice. */
export function dismissSessionNotice(state: MissionSessionsState, conversationId: string, noticeId: string): MissionSessionsState {
  const view = state.get(conversationId)
  if (!view || !view.notices.some((notice) => notice.id === noticeId)) return state
  return update(state, conversationId, (current) => ({ ...current, notices: current.notices.filter((notice) => notice.id !== noticeId) }))
}

function clearScopeNotices(state: MissionSessionsState, scope: string): MissionSessionsState {
  let next: Map<string, MissionSessionView> | null = null
  for (const [conversationId, view] of state) {
    if (!view.notices.some((notice) => notice.scope === scope)) continue
    next ??= new Map(state)
    next.set(conversationId, { ...view, notices: view.notices.filter((notice) => notice.scope !== scope) })
  }
  return next ?? state
}

/** Replace a mission's state with authoritative server state (load or reconnect). */
export function applySessionSnapshot(state: MissionSessionsState, conversationId: string, snapshot: AgentSessionState | null): MissionSessionsState {
  return update(state, conversationId, (view) => {
    if (!snapshot) return { ...view, loaded: true }
    const subagents = Object.fromEntries(snapshot.subagents.map((node) => [node.subagentId, node]))
    return {
      ...view,
      residentPhase: snapshot.residentPhase,
      processAlive: snapshot.processAlive,
      liveSubagents: snapshot.liveSubagents,
      // Keep rows not in this (possibly partial) snapshot: a reconnect lists live ones only.
      subagents: { ...view.subagents, ...subagents },
      loaded: true,
    }
  })
}

/** Missions the server reports as idle after a reconnect lose stale live markers. */
export function settleMissingSessions(state: MissionSessionsState, liveConversationIds: ReadonlySet<string>): MissionSessionsState {
  let next: Map<string, MissionSessionView> | null = null
  for (const [conversationId, view] of state) {
    if (liveConversationIds.has(conversationId) || (view.residentPhase === 'idle' && view.liveSubagents === 0 && !view.backgroundTurn)) continue
    next ??= new Map(state)
    next.set(conversationId, { ...view, residentPhase: 'idle', liveSubagents: 0, backgroundTurn: null })
  }
  return next ?? state
}

/** Sub-agents a turn launched, oldest first (top-level first, children after their parent). */
export function subagentsForTurn(view: MissionSessionView | undefined, turnId: string | undefined | null): AgentSubagent[] {
  if (!view || !turnId) return []
  return Object.values(view.subagents)
    .filter((node) => node.launchedInTurnId === turnId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/** Sub-agents of turns with no settled message yet (the user turn in flight). */
export function unanchoredSubagents(view: MissionSessionView | undefined, anchoredTurnIds: ReadonlySet<string>): AgentSubagent[] {
  if (!view) return []
  return Object.values(view.subagents)
    .filter((node) => !node.launchedInTurnId || !anchoredTurnIds.has(node.launchedInTurnId))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export function isLiveSubagent(node: AgentSubagent): boolean {
  return node.phase === 'running'
}

export function isInterruptedSubagent(node: AgentSubagent): boolean {
  return node.phase === 'interrupted' || node.phase === 'stopped' || node.phase === 'killed'
}

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO → epoch ms. */
function timeOf(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value)
}

export interface SubagentPlacement {
  /** Launches whose reply message is not known, placed after the message that preceded them. */
  afterMessage: Map<string, AgentSubagent[][]>
  /** The launch of the turn still streaming (no reply yet). */
  live: AgentSubagent[]
}

/**
 * Where sub-agent launches without a settled reply belong in the timeline. A
 * launch stays where it happened: only the in-flight turn's agents follow the
 * live area; every other launch sits after the last message that preceded it,
 * so it never drifts to the bottom as the conversation grows.
 */
export function placeUnanchoredSubagents(
  nodes: AgentSubagent[],
  messages: ReadonlyArray<{ id: string; created_at: string }>,
  streaming: boolean,
): SubagentPlacement {
  const groups = new Map<string, AgentSubagent[]>()
  for (const node of nodes) {
    const key = node.launchedInTurnId ?? `node:${node.subagentId}`
    groups.set(key, [...(groups.get(key) ?? []), node])
  }
  const ordered = [...groups.values()].map((group) => group.sort((a, b) => a.startedAt.localeCompare(b.startedAt)))
    .sort((a, b) => a[0]!.startedAt.localeCompare(b[0]!.startedAt))
  const placement: SubagentPlacement = { afterMessage: new Map(), live: [] }
  if (streaming && ordered.length > 0) placement.live = ordered.pop()!
  for (const group of ordered) {
    const startedAt = Date.parse(group[0]!.startedAt)
    let anchor: string | null = null
    for (const message of messages) {
      if (timeOf(message.created_at) <= startedAt) anchor = message.id
      else break
    }
    if (!anchor) { placement.live = [...placement.live, ...group]; continue }
    placement.afterMessage.set(anchor, [...(placement.afterMessage.get(anchor) ?? []), group])
  }
  return placement
}

