import type { DbInstance } from '../../../db'
import { recordAgentInvocation } from '../../../desktop-db'
import type { ProviderAdapter } from '../../../providers/types'
import { finaliseNormalisedResult } from '../../accounting/runtime/result-event'
import type { ProjectionOp, ProjectionSink, TurnOrigin, Usage } from '../../agent-sessions'
import { addAgentMessage, getAgentConversation } from '../../agents/runtime/agent-store'
import { advanceSessionCursor, appendSubagentEvent, coreTurnInvocationId, getSessionCursor, isCoreTurnRecorded, setResidentState, upsertSubagent } from './agent-session-store'

type Broadcast = (message: Record<string, unknown>) => void

export interface MissionSessionProjectorDeps {
  db: DbInstance
  broadcast: Broadcast
  adapterFor: (providerId: string) => ProviderAdapter
  /** The provider process of the session is gone (retired, crashed, closed). */
  onProcessEnded?: (conversationId: string) => void
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

  constructor(private readonly conversationId: string, private readonly deps: MissionSessionProjectorDeps) {}

  cursor(_sessionId: string): number {
    return getSessionCursor(this.deps.db, this.conversationId)?.lastSeq ?? 0
  }

  apply(_sessionId: string, seq: number, ops: ProjectionOp[]): void {
    const conversationId = this.conversationId
    const outbox: Array<Record<string, unknown>> = []
    const timestamp = new Date().toISOString()
    let processEnded = false
    this.deps.db.transaction(() => {
      for (const op of ops) {
        switch (op.kind) {
          case 'resident.phase': {
            const before = getSessionCursor(this.deps.db, conversationId)
            setResidentState(this.deps.db, conversationId, op.phase, op.processAlive, op.liveSubagents)
            if (before?.processAlive && !op.processAlive) processEnded = true
            outbox.push({ type: 'agent_resident_state', conversationId, phase: op.phase, liveSubagents: op.liveSubagents, processAlive: op.processAlive, timestamp })
            break
          }
          case 'turn.opened':
            if (op.origin === 'user') break
            this.background.set(op.turnId, { origin: op.origin, triggeredBy: op.triggeredBy, startedAt: op.at })
            outbox.push({ type: 'agent_turn_started', conversationId, turnId: op.turnId, origin: op.origin, triggeredBy: op.triggeredBy, timestamp })
            break
          case 'turn.delta':
            if (op.channel === 'text' && this.background.has(op.turnId)) outbox.push({ type: 'agent_stream', conversationId, turnId: op.turnId, delta: op.delta, timestamp })
            break
          case 'turn.tool':
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
            if (isCoreTurnRecorded(this.deps.db, conversationId, op.turnId)) {
              outbox.push({ type: 'agent_turn_done', conversationId, turnId: op.turnId, origin: turn.origin, status: op.status, triggeredBy: turn.triggeredBy, timestamp })
              break
            }
            const message = op.text.trim()
              ? addAgentMessage(this.deps.db, { conversationId, role: 'assistant', content: op.text, turnOrigin: turn.origin, coreTurnId: op.turnId })
              : null
            this.recordInvocation(conversation, { id: coreTurnInvocationId(conversation.id, op.turnId), providerId: conversation.provider, model: null, usage: op.usage, status: op.status, origin: turn.origin, startedAt: turn.startedAt, finishedAt: op.at })
            outbox.push({ type: 'agent_turn_done', conversationId, turnId: op.turnId, origin: turn.origin, status: op.status, triggeredBy: turn.triggeredBy, fullText: op.text, ...(message ? { messageId: message.id } : {}), timestamp })
            if (conversation.pinned_project_id) outbox.push({ type: 'spending.invalidated', projectId: conversation.pinned_project_id })
            break
          }
          case 'subagent.upsert':
            upsertSubagent(this.deps.db, conversationId, op.subagent)
            outbox.push({ type: 'agent_subagent', conversationId, subagent: op.subagent, timestamp })
            break
          case 'subagent.output':
            if (!this.subagentKnown(op.subagentId)) break
            appendSubagentEvent(this.deps.db, conversationId, op.subagentId, op.seq, op.channel, op.delta, op.tool)
            outbox.push({ type: 'agent_subagent_event', conversationId, subagentId: op.subagentId, seq: op.seq, channel: op.channel, ...(op.delta !== null ? { delta: op.delta } : {}), ...(op.tool ? { tool: op.tool } : {}), timestamp })
            break
          case 'subagent.billed': {
            // A delegated sub-agent's own spend: recorded once (deterministic id), on top of the parent's.
            const conversation = getAgentConversation(this.deps.db, conversationId)
            if (!conversation) break
            const invocationId = `core-subagent:${conversationId}:${op.subagentId}:${op.seq}`
            if (this.deps.db.prepare('SELECT 1 FROM agent_invocations WHERE id = ?').get(invocationId)) break
            const startedAt = this.subagentStartedAt(op.subagentId) ?? op.at
            this.recordInvocation(conversation, { id: invocationId, providerId: op.driver, model: op.model, usage: op.usage, status: 'completed', origin: 'subagent', startedAt, finishedAt: op.at })
            if (conversation.pinned_project_id) outbox.push({ type: 'spending.invalidated', projectId: conversation.pinned_project_id })
            break
          }
          case 'session.updated':
            outbox.push({ type: 'agent_session_updated', conversationId, outcome: op.outcome, changes: op.changes, timestamp })
            break
          case 'notice':
            outbox.push({ type: 'agent_session_notice', conversationId, level: op.level, code: op.code, message: op.message, timestamp })
            break
          case 'provider.ref':
          case 'input.state':
          case 'session.closed':
            // User inputs, provider refs and closure are settled by the mission manager.
            break
        }
      }
      advanceSessionCursor(this.deps.db, conversationId, seq)
    })()
    for (const message of outbox) this.deps.broadcast(message)
    if (processEnded) this.deps.onProcessEnded?.(conversationId)
  }

  private subagentKnown(subagentId: string): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM agent_subagents WHERE conversation_id = ? AND subagent_id = ?').get(this.conversationId, subagentId)
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
      ...result,
    })
  }
}
