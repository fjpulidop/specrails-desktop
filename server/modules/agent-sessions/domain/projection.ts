import { KNOWN_EVENT_TYPES, type SessionEventEnvelope, type SessionPhase, type SubagentPhase, type ToolActivity, type TurnOrigin, type TurnStatus, type Usage } from './protocol'

/**
 * Surface-neutral read model of one Core session. The reducer turns committed
 * events into projection operations that a surface (missions, explore, ...)
 * maps onto its own tables through a ProjectionSink. Pure and idempotent by
 * sequence: duplicates are ignored and gaps are reported, never guessed.
 */

export interface SubagentView {
  subagentId: string
  parentId: string | null
  kind: 'foreground' | 'background'
  agentType: string | null
  description: string
  phase: SubagentPhase
  reason: string | null
  restarts: number
  startedAt: string
  endedAt: string | null
  usage: Usage | null
  toolUses: number | null
  durationMs: number | null
  resultSummary: string | null
  /** The turn whose activity launched it (for anchoring UI). */
  launchedInTurnId: string | null
}

export type ProjectionOp =
  | { kind: 'turn.opened'; turnId: string; origin: TurnOrigin; inputIds: string[]; triggeredBy: string[]; at: string }
  | { kind: 'turn.delta'; turnId: string; channel: 'text' | 'thinking'; delta: string }
  | { kind: 'turn.tool'; turnId: string; tool: ToolActivity }
  | { kind: 'turn.closed'; turnId: string; origin: TurnOrigin; status: TurnStatus; text: string; error: string | null; usage: Usage; startedAt: string; at: string }
  | { kind: 'input.state'; inputId: string; state: 'accepted' | 'queued' | 'started' | 'completed' | 'rejected' | 'interrupted'; turnId: string | null; reason: string | null }
  | { kind: 'subagent.upsert'; subagent: SubagentView }
  | { kind: 'subagent.output'; subagentId: string; channel: 'text' | 'tool'; delta: string | null; tool: ToolActivity | null; seq: number }
  | { kind: 'resident.phase'; phase: SessionPhase; liveSubagents: number; processAlive: boolean }
  | { kind: 'provider.ref'; providerSessionRef: string }
  | { kind: 'session.updated'; changes: Record<string, unknown>; outcome: 'applied' | 'deferred' }
  | { kind: 'session.closed'; reason: string }
  | { kind: 'notice'; level: 'info' | 'warning'; code: string; message: string }

export interface ProjectionState {
  sessionId: string
  lastSeq: number
  phase: SessionPhase
  processAlive: boolean
  openTurn: { turnId: string; origin: TurnOrigin; startedAt: string } | null
  liveSubagents: number
  subagents: Record<string, SubagentView>
}

export function initialProjection(sessionId: string, lastSeq = 0): ProjectionState {
  return { sessionId, lastSeq, phase: 'idle', processAlive: false, openTurn: null, liveSubagents: 0, subagents: {} }
}

export type ReduceResult =
  | { status: 'applied'; state: ProjectionState; ops: ProjectionOp[] }
  | { status: 'duplicate'; state: ProjectionState; ops: [] }
  | { status: 'gap'; state: ProjectionState; ops: []; expected: number }

const KNOWN: ReadonlySet<string> = new Set(KNOWN_EVENT_TYPES)

function phaseOp(state: ProjectionState): ProjectionOp {
  return { kind: 'resident.phase', phase: state.phase, liveSubagents: state.liveSubagents, processAlive: state.processAlive }
}

export function reduceEnvelope(state: ProjectionState, envelope: SessionEventEnvelope): ReduceResult {
  if (envelope.sessionId !== state.sessionId) throw new Error(`Event for ${envelope.sessionId} applied to ${state.sessionId}`)
  if (envelope.seq <= state.lastSeq) return { status: 'duplicate', state, ops: [] }
  if (envelope.seq !== state.lastSeq + 1) return { status: 'gap', state, ops: [], expected: state.lastSeq + 1 }
  const next: ProjectionState = { ...state, lastSeq: envelope.seq }
  const event = envelope.event
  if (!KNOWN.has(event.type)) return { status: 'applied', state: next, ops: [] }
  const ops: ProjectionOp[] = []
  switch (event.type) {
    case 'session.phase':
      next.phase = event.phase
      ops.push(phaseOp(next))
      break
    case 'session.process':
      next.processAlive = event.state === 'started'
      ops.push(phaseOp(next))
      break
    case 'session.provider-ref':
      ops.push({ kind: 'provider.ref', providerSessionRef: event.providerSessionRef })
      break
    case 'session.updated':
      ops.push({ kind: 'session.updated', changes: event.changes, outcome: event.outcome })
      break
    case 'session.closed':
      ops.push({ kind: 'session.closed', reason: event.reason })
      break
    case 'input.accepted':
      ops.push({ kind: 'input.state', inputId: event.inputId, state: 'accepted', turnId: null, reason: null })
      break
    case 'input.state':
      ops.push({ kind: 'input.state', inputId: event.inputId, state: event.state, turnId: event.turnId ?? null, reason: event.reason ?? null })
      break
    case 'turn.started':
      next.openTurn = { turnId: event.turnId, origin: event.origin, startedAt: event.at }
      ops.push({ kind: 'turn.opened', turnId: event.turnId, origin: event.origin, inputIds: [...event.inputIds], triggeredBy: [...(event.trigger?.subagentIds ?? [])], at: event.at })
      break
    case 'turn.output':
      ops.push({ kind: 'turn.delta', turnId: event.turnId, channel: event.channel, delta: event.delta })
      break
    case 'turn.tool': {
      const { type: _type, at: _at, turnId, ...tool } = event
      ops.push({ kind: 'turn.tool', turnId, tool })
      break
    }
    case 'turn.completed': {
      const open = next.openTurn
      next.openTurn = null
      ops.push({ kind: 'turn.closed', turnId: event.turnId, origin: open?.origin ?? 'user', status: event.status, text: event.text, error: event.error ?? null, usage: event.usage, startedAt: open?.startedAt ?? event.at, at: event.at })
      break
    }
    case 'subagent.started': {
      const existing = next.subagents[event.subagentId]
      const node: SubagentView = existing
        ? { ...existing, phase: 'running', reason: null, endedAt: null, restarts: existing.restarts + (existing.phase === 'idle' ? 1 : 0) }
        : {
            subagentId: event.subagentId,
            parentId: event.parentId,
            kind: event.kind,
            agentType: event.agentType ?? null,
            description: event.description,
            phase: 'running',
            reason: null,
            restarts: 0,
            startedAt: event.at,
            endedAt: null,
            usage: null,
            toolUses: null,
            durationMs: null,
            resultSummary: null,
            launchedInTurnId: next.openTurn?.turnId ?? null,
          }
      next.subagents = { ...next.subagents, [node.subagentId]: node }
      ops.push({ kind: 'subagent.upsert', subagent: node })
      break
    }
    case 'subagent.phase': {
      const node = next.subagents[event.subagentId]
      if (!node) break
      const live = event.phase === 'running'
      const updated: SubagentView = { ...node, phase: event.phase, reason: event.reason ?? (live ? null : node.reason), endedAt: live ? null : event.at }
      next.subagents = { ...next.subagents, [node.subagentId]: updated }
      ops.push({ kind: 'subagent.upsert', subagent: updated })
      break
    }
    case 'subagent.usage': {
      const node = next.subagents[event.subagentId]
      if (!node) break
      const updated: SubagentView = { ...node, usage: event.usage, toolUses: event.toolUses ?? node.toolUses, durationMs: event.durationMs ?? node.durationMs }
      next.subagents = { ...next.subagents, [node.subagentId]: updated }
      ops.push({ kind: 'subagent.upsert', subagent: updated })
      break
    }
    case 'subagent.result': {
      const node = next.subagents[event.subagentId]
      if (!node) break
      const updated: SubagentView = { ...node, resultSummary: event.summary }
      next.subagents = { ...next.subagents, [node.subagentId]: updated }
      ops.push({ kind: 'subagent.upsert', subagent: updated })
      break
    }
    case 'subagent.output':
      ops.push({ kind: 'subagent.output', subagentId: event.subagentId, channel: event.channel, delta: event.delta ?? null, tool: event.tool ?? null, seq: envelope.seq })
      break
    case 'subagents.settled':
      next.liveSubagents = event.live
      ops.push(phaseOp(next))
      break
    case 'output.truncated':
      ops.push({ kind: 'notice', level: 'info', code: 'output_truncated', message: `${event.droppedEvents} output chunks (${event.droppedBytes} bytes) were not stored` })
      break
    case 'provider.diagnostic':
      if (event.level === 'warning') ops.push({ kind: 'notice', level: 'warning', code: event.code, message: event.message })
      break
    case 'session.opened':
    case 'notice.interruption':
      break
  }
  return { status: 'applied', state: next, ops }
}

/** Number of sub-agents the provider is still running. */
export function liveSubagentCount(state: ProjectionState): number {
  return Object.values(state.subagents).filter((node) => node.phase === 'running').length
}
