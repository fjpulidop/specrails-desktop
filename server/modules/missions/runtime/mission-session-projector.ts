import type { DbInstance } from '../../../db'
import { recordAgentInvocation } from '../../../desktop-db'
import type { ProviderAdapter } from '../../../providers/types'
import { finaliseNormalisedResult } from '../../accounting/runtime/result-event'
import type { ProjectionOp, ProjectionSink, TurnOrigin, Usage } from '../../agent-sessions'
import { addAgentMessage, getAgentConversation } from '../../agents/runtime/agent-store'
import { recordToolCall, type AgentAuditRecorder } from '../../audit'
import { advanceSessionCursor, appendSubagentEvent, conversationSessionState, coreTurnInvocationId, getSessionCursor, isCoreTurnRecorded, setResidentState, upsertSubagent } from './agent-session-store'

type Broadcast = (message: Record<string, unknown>) => void

export interface MissionSessionProjectorDeps {
  db: DbInstance
  broadcast: Broadcast
  adapterFor: (providerId: string) => ProviderAdapter
  /** The provider process of the session is gone (retired, crashed, closed). */
  onProcessEnded?: (conversationId: string) => void
  /** Agent actions audit of the mission's project (null when it has none loaded). */
  agentAudit?: (projectId: string) => Pick<AgentAuditRecorder, 'record'> | null
}

/** Which Core session of the conversation this projector follows. */
export interface MissionSessionProjection {
  /** Core session id (default: the conversation id, the mission's own session). */
  coreSessionId?: string
  /** Accounting surface of its invocations: the Flow session bills `flow`. */
  surface?: 'agent-chat' | 'flow'
  /** A later generation of the mission's OWN session (`<id>:g<n>`): broadcasts
   *  stay untagged and its process end releases the mission capability. */
  mission?: boolean
}

interface BackgroundTurn {
  origin: Exclude<TurnOrigin, 'user'>
  triggeredBy: string[]
  startedAt: string
}

/**
 * Missions' ProjectionSink: persists what happens in a mission's Core session
 * OUTSIDE user turns (which the mission manager settles itself): turns Core or
 * policy started after sub-agents finished, the sub-agent tree and its output,
 * and the resident phase. Every apply writes its rows and the cursor in one
 * transaction; WebSocket messages are sent only after the commit.
 */
export class MissionSessionProjector implements ProjectionSink {
  private readonly background = new Map<string, BackgroundTurn>()
  private readonly coreSessionId: string
  private readonly surface: 'agent-chat' | 'flow'
  /** Extra fields on every broadcast of a non-mission session (the client tells them apart). */
  private readonly tag: Record<string, unknown>
  private readonly missionSession: boolean

  constructor(private readonly conversationId: string, private readonly deps: MissionSessionProjectorDeps, projection: MissionSessionProjection = {}) {
    this.coreSessionId = projection.coreSessionId ?? conversationId
    this.surface = projection.surface ?? 'agent-chat'
    this.missionSession = this.coreSessionId === conversationId || projection.mission === true
    this.tag = this.missionSession ? {} : { coreSessionId: this.coreSessionId }
  }

  cursor(_sessionId: string): number {
    return getSessionCursor(this.deps.db, this.conversationId, this.coreSessionId)?.lastSeq ?? 0
  }

  apply(_sessionId: string, seq: number, ops: ProjectionOp[]): void {
    const conversationId = this.conversationId
    const outbox: Array<Record<string, unknown>> = []
    const timestamp = new Date().toISOString()
    let processEnded = false
    const audited: Array<{ name: string; input: unknown; role: string }> = []
    this.deps.db.transaction(() => {
      for (const op of ops) {
        switch (op.kind) {
          case 'resident.phase': {
            const before = getSessionCursor(this.deps.db, conversationId, this.coreSessionId)
            setResidentState(this.deps.db, conversationId, op.phase, op.processAlive, op.liveSubagents, this.coreSessionId)
            if (before?.processAlive && !op.processAlive) processEnded = true
            // The conversation's state across its sessions: a Flow's sub-agents are the mission's while in Flow.
            const state = conversationSessionState(this.deps.db, conversationId)
            outbox.push({ type: 'agent_resident_state', conversationId, phase: state?.residentPhase ?? op.phase, liveSubagents: state?.liveSubagents ?? op.liveSubagents, processAlive: state?.processAlive ?? op.processAlive, ...this.tag, timestamp })
            break
          }
          case 'turn.opened':
            if (op.origin === 'user') break
            this.background.set(op.turnId, { origin: op.origin, triggeredBy: op.triggeredBy, startedAt: op.at })
            outbox.push({ type: 'agent_turn_started', conversationId, turnId: op.turnId, origin: op.origin, triggeredBy: op.triggeredBy, ...this.tag, timestamp })
            break
          case 'turn.delta':
            if (op.channel === 'text' && this.background.has(op.turnId)) outbox.push({ type: 'agent_stream', conversationId, turnId: op.turnId, delta: op.delta, timestamp })
            break
          case 'turn.tool':
            if (op.tool.phase === 'started') audited.push({ name: op.tool.name, input: op.tool.input, role: 'mission' })
            if (!this.background.has(op.turnId)) break
            outbox.push(op.tool.phase === 'started'
              ? { type: 'agent_tool', conversationId, turnId: op.turnId, tool: op.tool.name, toolId: op.tool.toolUseId, timestamp }
              : { type: 'agent_tool_result', conversationId, turnId: op.turnId, toolId: op.tool.toolUseId, output: (op.tool.output ?? '').slice(0, 4000), ...(op.tool.isError ? { isError: true } : {}), timestamp })
            break
          case 'turn.closed': {
            const turn = this.background.get(op.turnId)
            if (!turn) break
            this.background.delete(op.turnId)
            const conversation = getAgentConversation(this.deps.db, conversationId)
            if (!conversation) break
            // A journal replay (projection rebuild) must not record a turn twice.
            if (isCoreTurnRecorded(this.deps.db, conversationId, op.turnId, this.coreSessionId)) {
              outbox.push({ type: 'agent_turn_done', conversationId, turnId: op.turnId, origin: turn.origin, status: op.status, triggeredBy: turn.triggeredBy, ...this.tag, timestamp })
              break
            }
            const message = op.text.trim()
              ? addAgentMessage(this.deps.db, { conversationId, role: 'assistant', content: op.text, turnOrigin: turn.origin, coreTurnId: op.turnId })
              : null
            this.recordInvocation(conversation, { id: coreTurnInvocationId(conversation.id, op.turnId, this.coreSessionId), providerId: conversation.provider, model: null, usage: op.usage, status: op.status, origin: turn.origin, startedAt: turn.startedAt, finishedAt: op.at })
            outbox.push({ type: 'agent_turn_done', conversationId, turnId: op.turnId, origin: turn.origin, status: op.status, triggeredBy: turn.triggeredBy, fullText: op.text, ...(message ? { messageId: message.id } : {}), ...this.tag, timestamp })
            if (conversation.pinned_project_id) outbox.push({ type: 'spending.invalidated', projectId: conversation.pinned_project_id })
            break
          }
          case 'subagent.upsert':
            upsertSubagent(this.deps.db, conversationId, op.subagent, this.coreSessionId)
            outbox.push({ type: 'agent_subagent', conversationId, subagent: op.subagent, ...this.tag, timestamp })
            break
          case 'subagent.output':
            if (!this.subagentKnown(op.subagentId)) break
            if (op.tool?.phase === 'started') audited.push({ name: op.tool.name, input: op.tool.input, role: 'subagent' })
            appendSubagentEvent(this.deps.db, conversationId, op.subagentId, op.seq, op.channel, op.delta, op.tool)
            outbox.push({ type: 'agent_subagent_event', conversationId, subagentId: op.subagentId, seq: op.seq, channel: op.channel, ...(op.delta !== null ? { delta: op.delta } : {}), ...(op.tool ? { tool: op.tool } : {}), ...this.tag, timestamp })
            break
          case 'subagent.billed': {
            // A delegated sub-agent's own spend: recorded once (deterministic id), on top of the parent's.
            const conversation = getAgentConversation(this.deps.db, conversationId)
            if (!conversation) break
            const invocationId = this.coreSessionId === conversationId
              ? `core-subagent:${conversationId}:${op.subagentId}:${op.seq}`
              : `core-subagent:${conversationId}:${this.coreSessionId}:${op.subagentId}:${op.seq}`
            if (this.deps.db.prepare('SELECT 1 FROM agent_invocations WHERE id = ?').get(invocationId)) break
            const startedAt = this.subagentStartedAt(op.subagentId) ?? op.at
            this.recordInvocation(conversation, { id: invocationId, providerId: op.driver, model: op.model, usage: op.usage, status: 'completed', origin: 'subagent', startedAt, finishedAt: op.at })
            if (conversation.pinned_project_id) outbox.push({ type: 'spending.invalidated', projectId: conversation.pinned_project_id })
            break
          }
          case 'session.updated':
            outbox.push({ type: 'agent_session_updated', conversationId, outcome: op.outcome, changes: op.changes, ...this.tag, timestamp })
            break
          case 'notice':
            outbox.push({ type: 'agent_session_notice', conversationId, level: op.level, code: op.code, message: op.message, ...this.tag, timestamp })
            break
          case 'provider.ref':
          case 'input.state':
          case 'session.closed':
            // User inputs, provider refs and closure are settled by the mission manager.
            break
        }
      }
      advanceSessionCursor(this.deps.db, conversationId, seq, this.coreSessionId)
    })()
    for (const message of outbox) this.deps.broadcast(message)
    if (audited.length > 0) this.recordAudit(audited)
    // The mission's capability belongs to its own resident process only.
    if (processEnded && this.missionSession) this.deps.onProcessEnded?.(conversationId)
  }

  /** After commit: the audit observes; it never joins the projection transaction. */
  private recordAudit(tools: Array<{ name: string; input: unknown; role: string }>): void {
    try {
      if (!this.deps.agentAudit) return
      const projectId = getAgentConversation(this.deps.db, this.conversationId)?.pinned_project_id
      const recorder = projectId ? this.deps.agentAudit(projectId) : null
      if (!recorder) return
      for (const tool of tools) recordToolCall(recorder, { runId: this.conversationId, role: tool.role, source: 'core-session' }, tool.name, tool.input)
    } catch { /* audit is observing only */ }
  }

  private subagentKnown(subagentId: string): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM agent_subagents WHERE conversation_id = ? AND subagent_id = ? AND core_session_id = ?').get(this.conversationId, subagentId, this.coreSessionId)
  }

  private subagentStartedAt(subagentId: string): string | null {
    const row = this.deps.db.prepare('SELECT started_at FROM agent_subagents WHERE conversation_id = ? AND subagent_id = ?').get(this.conversationId, subagentId) as { started_at: string } | undefined
    return row?.started_at ?? null
  }

  private recordInvocation(conversation: NonNullable<ReturnType<typeof getAgentConversation>>, invocation: {
    id: string
    providerId: string
    model: string | null
    usage: Usage
    status: string
    origin: TurnOrigin
    startedAt: string
    finishedAt: string
  }): void {
    let adapter: ProviderAdapter
    try { adapter = this.deps.adapterFor(invocation.providerId) } catch { return }
    const usage = invocation.usage
    const normalised = {
      ...(usage.inputTokens !== null ? { tokens_in: usage.inputTokens } : {}),
      ...(usage.outputTokens !== null ? { tokens_out: usage.outputTokens } : {}),
      ...(usage.cacheReadTokens !== null ? { tokens_cache_read: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== null ? { tokens_cache_create: usage.cacheWriteTokens } : {}),
      ...(usage.costUsd !== null && !usage.costEstimated ? { total_cost_usd: usage.costUsd } : {}),
      ...(usage.model ?? invocation.model ? { model: usage.model ?? invocation.model! } : {}),
    }
    const fallbackModel = invocation.model ?? (invocation.providerId === conversation.provider ? conversation.model : null)
    const { result, estimated } = finaliseNormalisedResult(adapter, normalised, {
      ...(fallbackModel ? { fallbackModel } : {}),
      durationMs: Math.max(0, Date.parse(invocation.finishedAt) - Date.parse(invocation.startedAt)),
    })
    recordAgentInvocation(this.deps.db, {
      id: invocation.id,
      conversation_id: conversation.id,
      project_id: conversation.pinned_project_id ?? null,
      provider: adapter.id,
      status: invocation.status === 'completed' ? 'success' : invocation.status === 'stopped' || invocation.status === 'interrupted' ? 'aborted' : 'failed',
      started_at: invocation.startedAt,
      finished_at: invocation.finishedAt,
      total_cost_usd_estimated: estimated,
      origin: invocation.origin,
      surface: this.surface,
      ...result,
    })
  }
}
