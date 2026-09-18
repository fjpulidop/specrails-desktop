import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { AgentChatManager } from './agent-chat-manager'
import { createAgentConversation, listAgentMessages } from './agent-store'
import type { WsMessage } from './types'

// ── mission-rail-cards: failure row + the ONE automatic briefing turn ─────────
let db: DbInstance
let broadcast: ReturnType<typeof vi.fn>
let manager: AgentChatManager

beforeEach(() => {
  db = initDesktopDb(':memory:')
  broadcast = vi.fn()
  manager = new AgentChatManager(broadcast as unknown as (m: WsMessage) => void, db, 0, null)
  delete process.env.SPECRAILS_MISSION_FAILURE_TURN
  delete process.env.SPECRAILS_MISSION_RAIL_CARDS
})
afterEach(() => { db.close(); delete process.env.SPECRAILS_MISSION_FAILURE_TURN })

const row = { kind: 'run-failure' as const, runId: 'run-1', railIndex: 0, projectId: 'p1', prDeliveryId: 'run:run-1', ticketIds: [1], code: 'stalled', detail: null, stepId: null, at: 'now' }

describe('postRunFailureRow', () => {
  it('persists one system row per run and broadcasts agent_run_failure', () => {
    const conv = createAgentConversation(db, {})
    const id = manager.postRunFailureRow(conv.id, row)
    expect(id).toBeTruthy()
    const rows = listAgentMessages(db, conv.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('system')
    expect(JSON.parse(rows[0].content)).toMatchObject({ kind: 'run-failure', runId: 'run-1', code: 'stalled' })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_run_failure', conversationId: conv.id, messageId: id, runId: 'run-1', code: 'stalled' }))
    // Duplicate signal for the same run → no second row, no broadcast.
    expect(manager.postRunFailureRow(conv.id, { ...row, code: 'stuck' })).toBeNull()
    expect(listAgentMessages(db, conv.id)).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    // A different run gets its own row.
    expect(manager.postRunFailureRow(conv.id, { ...row, runId: 'run-2' })).toBeTruthy()
    // Unknown conversation → null, never throws.
    expect(manager.postRunFailureRow('nope', row)).toBeNull()
  })
})

describe('startSystemTurn', () => {
  it('routes through sendMessage with a run-derived queue id and the briefing ref; dedups per run', async () => {
    const conv = createAgentConversation(db, {})
    const send = vi.spyOn(manager, 'sendMessage').mockResolvedValue(undefined)
    const ref = { kind: 'system-briefing', id: 'run-1', label: 'Run failure briefing', token: '' }
    expect(await manager.startSystemTurn(conv.id, 'briefing text', { runId: 'run-1', ref })).toBe('started')
    expect(send).toHaveBeenCalledWith(conv.id, 'briefing text', { queueId: 'mission-failure:run-1', contextRefs: [ref] })
    expect(await manager.startSystemTurn(conv.id, 'briefing text', { runId: 'run-1', ref })).toBe('skipped')
    expect(send).toHaveBeenCalledTimes(1)
    expect(await manager.startSystemTurn(conv.id, 'other', { runId: 'run-2' })).toBe('started')
    expect(send).toHaveBeenLastCalledWith(conv.id, 'other', { queueId: 'mission-failure:run-2' })
    expect(await manager.startSystemTurn('missing', 'x', { runId: 'run-3' })).toBe('skipped')
  })

  it('is skipped when the flag is off, and never throws when sendMessage rejects', async () => {
    const conv = createAgentConversation(db, {})
    process.env.SPECRAILS_MISSION_FAILURE_TURN = 'false'
    const send = vi.spyOn(manager, 'sendMessage').mockResolvedValue(undefined)
    expect(await manager.startSystemTurn(conv.id, 'x', { runId: 'run-1' })).toBe('skipped')
    expect(send).not.toHaveBeenCalled()
    delete process.env.SPECRAILS_MISSION_FAILURE_TURN
    send.mockRejectedValue(new Error('boom'))
    expect(await manager.startSystemTurn(conv.id, 'x', { runId: 'run-9' })).toBe('skipped')
  })

  it('the durable queue id makes a real re-enqueue idempotent (created:false) across manager instances', async () => {
    const conv = createAgentConversation(db, {})
    // A second manager over the same DB (simulated restart) — its in-memory
    // dedup set is empty, so only the durable agent_inputs queue id stops it.
    const other = new AgentChatManager(broadcast as unknown as (m: WsMessage) => void, db, 0, null)
    const runTurn = vi.spyOn(other as unknown as { _runAcceptedTurns: () => Promise<void> }, '_runAcceptedTurns').mockResolvedValue(undefined)
    expect(await other.startSystemTurn(conv.id, 'briefing', { runId: 'run-1' })).toBe('started')
    expect(runTurn).toHaveBeenCalledTimes(1)
    const third = new AgentChatManager(broadcast as unknown as (m: WsMessage) => void, db, 0, null)
    const runTurn3 = vi.spyOn(third as unknown as { _runAcceptedTurns: () => Promise<void> }, '_runAcceptedTurns').mockResolvedValue(undefined)
    expect(await third.startSystemTurn(conv.id, 'briefing', { runId: 'run-1' })).toBe('started')
    expect(runTurn3).not.toHaveBeenCalled() // enqueueAgentInput: created:false → sendMessage resolves without a turn
  })
})
