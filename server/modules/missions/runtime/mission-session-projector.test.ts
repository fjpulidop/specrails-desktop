import { beforeEach, describe, expect, it } from 'vitest'

import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import '../../../providers'
import { getAdapter } from '../../../providers/registry'
import { initialProjection, reduceEnvelope, type ProjectionState, type SessionEvent } from '../../agent-sessions'
import { createAgentConversation, listAgentMessages } from '../../agents/runtime/agent-store'
import { ensureSessionCursor, getSessionCursor, listSubagents, pageSubagentEvents } from './agent-session-store'
import { MissionSessionProjector } from './mission-session-projector'

const at = (second: number) => `2026-10-07T10:00:${String(second).padStart(2, '0')}.000Z`
const usage = (costUsd: number | null) => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd, costEstimated: false, model: 'haiku' })

describe('MissionSessionProjector', () => {
  let db: DbInstance
  let conversationId: string
  let broadcasts: Array<Record<string, unknown>>
  let ended: string[]
  let projector: MissionSessionProjector
  let state: ProjectionState

  function feed(events: Array<Omit<SessionEvent, 'at'>>) {
    for (const event of events) {
      const seq = state.lastSeq + 1
      const result = reduceEnvelope(state, { sessionId: conversationId, seq, event: { ...event, at: at(seq) } as SessionEvent })
      if (result.status !== 'applied') throw new Error(result.status)
      projector.apply(conversationId, seq, result.ops)
      state = result.state
    }
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    conversationId = createAgentConversation(db, { provider: 'claude', model: 'haiku' }).id
    ensureSessionCursor(db, conversationId, conversationId, 'global')
    broadcasts = []
    ended = []
    projector = new MissionSessionProjector(conversationId, { db, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter, onProcessEnded: (id) => ended.push(id) })
    state = initialProjection(conversationId)
  })

  it('persists sub-agents and continuation turns, leaves user turns to the manager and advances the cursor atomically', () => {
    feed([
      { type: 'session.process', state: 'started', generation: 1 },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: ['u1'] },
      { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', agentType: 'general-purpose', description: 'Run bash' },
      { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'LAUNCHED' },
      { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'LAUNCHED', usage: usage(0.02) },
      { type: 'session.phase', phase: 'background' },
      { type: 'subagent.output', subagentId: 'a1', channel: 'text', delta: 'working…' },
      { type: 'subagent.output', subagentId: 'a1', channel: 'tool', tool: { toolUseId: 'x', name: 'Bash', phase: 'started' } },
      { type: 'subagent.result', subagentId: 'a1', summary: 'SUBDONE' },
      { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId: 't2', origin: 'subagent', inputIds: [], trigger: { subagentIds: ['a1'] } },
      { type: 'turn.output', turnId: 't2', channel: 'text', delta: 'Sub-agent finished: SUBDONE' },
      { type: 'turn.completed', turnId: 't2', status: 'completed', text: 'Sub-agent finished: SUBDONE', usage: usage(0.03) },
      { type: 'subagents.settled', settled: true, live: 0 },
      { type: 'session.phase', phase: 'idle' },
    ])

    expect(getSessionCursor(db, conversationId)).toMatchObject({ lastSeq: 17, residentPhase: 'idle', processAlive: true, liveSubagents: 0 })
    const messages = listAgentMessages(db, conversationId)
    // The user turn is not persisted here; only the continuation turn is.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'Sub-agent finished: SUBDONE', turn_origin: 'subagent', core_turn_id: 't2' })
    const [subagent] = listSubagents(db, conversationId)
    expect(subagent).toMatchObject({ subagentId: 'a1', phase: 'idle', resultSummary: 'SUBDONE', launchedInTurnId: 't1', agentType: 'general-purpose' })
    expect(pageSubagentEvents(db, conversationId, 'a1', 0, 10)).toMatchObject({ hasMore: false, events: [{ channel: 'text', delta: 'working…' }, { channel: 'tool', tool: { name: 'Bash' } }] })
    const invocation = db.prepare('SELECT origin, status, total_cost_usd, total_cost_usd_estimated, provider FROM agent_invocations WHERE conversation_id = ?').all(conversationId)
    expect(invocation).toEqual([{ origin: 'subagent', status: 'success', total_cost_usd: 0.03, total_cost_usd_estimated: 0, provider: 'claude' }])

    const types = broadcasts.map((message) => message.type)
    expect(types).toContain('agent_subagent')
    expect(types).toContain('agent_subagent_event')
    expect(broadcasts.filter((message) => message.type === 'agent_turn_started')).toEqual([expect.objectContaining({ turnId: 't2', origin: 'subagent', triggeredBy: ['a1'] })])
    expect(broadcasts.filter((message) => message.type === 'agent_stream').map((message) => message.turnId)).toEqual(['t2'])
    expect(broadcasts.find((message) => message.type === 'agent_turn_done')).toMatchObject({ turnId: 't2', messageId: messages[0]!.id, status: 'completed' })
  })

  it('rolls back rows and cursor together when a write fails, and broadcasts nothing', () => {
    feed([{ type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', description: 'x' }])
    const before = broadcasts.length
    db.exec('DROP TABLE agent_subagent_events')
    const result = reduceEnvelope(state, { sessionId: conversationId, seq: 2, event: { type: 'subagent.output', subagentId: 'a1', channel: 'text', delta: 'x', at: at(2) } })
    expect(() => projector.apply(conversationId, 2, result.ops)).toThrow()
    expect(getSessionCursor(db, conversationId)?.lastSeq).toBe(1)
    expect(broadcasts.length).toBe(before)
  })

  it('reports the end of the provider process once and surfaces warnings and deferred updates', () => {
    feed([
      { type: 'session.process', state: 'started', generation: 1 },
      { type: 'session.updated', changes: { model: 'opus' }, outcome: 'deferred' },
      { type: 'provider.diagnostic', level: 'warning', code: 'illegal_transition', message: 'x' },
      { type: 'session.process', state: 'retired', generation: 1, reason: 'idle' },
      { type: 'session.process', state: 'retired', generation: 1, reason: 'idle' },
    ])
    expect(ended).toEqual([conversationId])
    expect(broadcasts.find((message) => message.type === 'agent_session_updated')).toMatchObject({ outcome: 'deferred', changes: { model: 'opus' } })
    expect(broadcasts.find((message) => message.type === 'agent_session_notice')).toMatchObject({ level: 'warning', code: 'illegal_transition' })
  })

  it('ignores output for unknown sub-agents and continuation turns of a deleted conversation', () => {
    feed([{ type: 'subagent.output', subagentId: 'ghost', channel: 'text', delta: 'x' }])
    db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(conversationId)
    expect(() => feed([
      { type: 'turn.started', turnId: 'bg', origin: 'subagent', inputIds: [] },
      { type: 'turn.completed', turnId: 'bg', status: 'completed', text: 'late', usage: usage(null) },
    ])).not.toThrow()
    expect(listAgentMessages(db, conversationId)).toEqual([])
  })

  it('records a replayed continuation turn once', () => {
    const turn: Array<Omit<SessionEvent, 'at'>> = [
      { type: 'session.process', state: 'started', generation: 1 },
      { type: 'turn.started', turnId: 'bg', origin: 'subagent', inputIds: [], trigger: { subagentIds: [] } },
      { type: 'turn.completed', turnId: 'bg', status: 'completed', text: '', usage: usage(0.01) },
    ]
    feed(turn)
    state = initialProjection(conversationId)
    broadcasts = []
    feed(turn)
    expect(listAgentMessages(db, conversationId)).toHaveLength(0)
    expect(db.prepare('SELECT id FROM agent_invocations WHERE conversation_id = ?').all(conversationId)).toEqual([{ id: `core-turn:${conversationId}:bg` }])
    // Clients still see the replayed turn close (no message to append).
    expect(broadcasts.find((message) => message.type === 'agent_turn_done')).toEqual(expect.not.objectContaining({ messageId: expect.anything() }))
  })
})
