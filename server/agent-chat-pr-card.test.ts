import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The card methods never spawn, but the manager module pulls in the turn
// peripherals at load — stub them so the test touches no real filesystem /
// ~/.specrails (mirrors agent-chat-manager.test.ts).
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./agent-cwd-manager', () => ({ ensureAgentCwd: () => '/tmp/agent-cwd-test' }))
vi.mock('./agent-mcp-config', () => ({
  prepareAgentMcp: () => ({ extraArgs: [], env: {} }),
  removeAgentCapabilityFile: vi.fn(),
}))
vi.mock('./mcp/tools/types', () => ({ setActiveProject: vi.fn() }))
vi.mock('./attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: vi.fn(async () => ({ textBlocks: [], imagePaths: [] })) },
  USER_ATTACHMENT_SYSTEM_NOTE: 'note',
}))

import { AgentChatManager } from './agent-chat-manager'
import { setAgentChatManager, getAgentChatManager } from './agent-chat-registry'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation, addAgentMessage, listAgentMessages } from './agent-store'
import type { DbInstance } from './db'
import type { PrDecisionCardEnvelope } from './types'

function envelope(overrides: Partial<PrDecisionCardEnvelope> = {}): PrDecisionCardEnvelope {
  return {
    kind: 'pr_decision',
    prDeliveryId: 'del-1',
    railIndex: 0,
    projectId: 'proj-1',
    baseBranch: 'main',
    ticketIds: [1, 2],
    decision: 'on_review',
    prUrl: null,
    prNumber: null,
    prState: 'none',
    branch: null,
    ...overrides,
  }
}

function decisionBroadcasts(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((m) => m.type === 'agent_pr_decision')
}

describe('AgentChatManager PR-decision card (safe-pr-review-flow)', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: AgentChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new AgentChatManager(broadcast, db, 4200)
  })

  it('postPrDecisionCard persists a system row (envelope round-trips) and broadcasts agent_pr_decision', () => {
    const conv = createAgentConversation(db, {})
    const env = envelope()

    mgr.postPrDecisionCard(conv.id, env)

    const msgs = listAgentMessages(db, conv.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(JSON.parse(msgs[0].content)).toEqual(env)

    const events = decisionBroadcasts(broadcast)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'agent_pr_decision',
      conversationId: conv.id,
      kind: 'pr_decision',
      prDeliveryId: 'del-1',
      railIndex: 0,
      projectId: 'proj-1',
      baseBranch: 'main',
      ticketIds: [1, 2],
      decision: 'on_review',
      prUrl: null,
      prState: 'none',
      branch: null,
    })
    expect(typeof events[0].timestamp).toBe('string')
  })

  it('postPrDecisionCard no-ops (no insert, no broadcast) when the conversation is gone', () => {
    mgr.postPrDecisionCard('missing-conv', envelope())

    const count = (db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n
    expect(count).toBe(0)
    expect(decisionBroadcasts(broadcast)).toHaveLength(0)
  })

  it('updatePrDecisionCard rewrites the SAME message in place (matched by prDeliveryId) and re-broadcasts', () => {
    const conv = createAgentConversation(db, {})
    // Surrounding turns must not confuse the card lookup.
    addAgentMessage(db, { conversationId: conv.id, role: 'user', content: 'launch it' })
    mgr.postPrDecisionCard(conv.id, envelope())
    addAgentMessage(db, { conversationId: conv.id, role: 'assistant', content: 'launched' })
    const cardId = listAgentMessages(db, conv.id).find((m) => m.role === 'system')!.id

    const updated = envelope({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created', branch: 'sr/p/batch-1' })
    mgr.updatePrDecisionCard(conv.id, updated)

    const msgs = listAgentMessages(db, conv.id)
    const systemMsgs = msgs.filter((m) => m.role === 'system')
    expect(systemMsgs).toHaveLength(1) // updated in place, never a second card
    expect(systemMsgs[0].id).toBe(cardId)
    expect(JSON.parse(systemMsgs[0].content)).toEqual(updated)
    expect(msgs).toHaveLength(3)

    const events = decisionBroadcasts(broadcast)
    expect(events).toHaveLength(2) // post + update
    expect(events[1]).toMatchObject({ conversationId: conv.id, decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7' })
  })

  it('updatePrDecisionCard only touches the card with the matching prDeliveryId', () => {
    const conv = createAgentConversation(db, {})
    mgr.postPrDecisionCard(conv.id, envelope({ prDeliveryId: 'del-a', railIndex: 0 }))
    mgr.postPrDecisionCard(conv.id, envelope({ prDeliveryId: 'del-b', railIndex: 1 }))

    mgr.updatePrDecisionCard(conv.id, envelope({ prDeliveryId: 'del-b', railIndex: 1, decision: 'merged' }))

    const cards = listAgentMessages(db, conv.id)
      .filter((m) => m.role === 'system')
      .map((m) => JSON.parse(m.content) as PrDecisionCardEnvelope)
    expect(cards.find((c) => c.prDeliveryId === 'del-a')!.decision).toBe('on_review')
    expect(cards.find((c) => c.prDeliveryId === 'del-b')!.decision).toBe('merged')
  })

  it('updatePrDecisionCard falls back to posting a fresh card when none exists', () => {
    const conv = createAgentConversation(db, {})
    const env = envelope({ decision: 'pr_ready' })

    mgr.updatePrDecisionCard(conv.id, env)

    const msgs = listAgentMessages(db, conv.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(JSON.parse(msgs[0].content)).toEqual(env)
    expect(decisionBroadcasts(broadcast)).toHaveLength(1)
  })

  it('a malformed-JSON system row never breaks the card lookup', () => {
    const conv = createAgentConversation(db, {})
    addAgentMessage(db, { conversationId: conv.id, role: 'system', content: 'not-json{' })
    mgr.postPrDecisionCard(conv.id, envelope())

    mgr.updatePrDecisionCard(conv.id, envelope({ decision: 'discarded' }))

    const cards = listAgentMessages(db, conv.id).filter((m) => m.role === 'system')
    expect(cards).toHaveLength(2) // the junk row + the one real card, updated in place
    expect(JSON.parse(cards[1].content).decision).toBe('discarded')
  })

  it('neither method ever throws — a broadcast failure is swallowed (rail settle path safety)', () => {
    const conv = createAgentConversation(db, {})
    const boom = vi.fn(() => {
      throw new Error('ws down')
    })
    const fragile = new AgentChatManager(boom, db, 4200)

    expect(() => fragile.postPrDecisionCard(conv.id, envelope())).not.toThrow()
    expect(() => fragile.updatePrDecisionCard(conv.id, envelope({ decision: 'merged' }))).not.toThrow()
    // The persisted state still advanced despite the broadcast failures.
    const card = listAgentMessages(db, conv.id).find((m) => m.role === 'system')!
    expect(JSON.parse(card.content).decision).toBe('merged')
  })
})

describe('agent-chat-registry', () => {
  afterEach(() => setAgentChatManager(null))

  it('defaults to null, returns the set instance, and clears back to null', () => {
    expect(getAgentChatManager()).toBeNull()
    const mgr = new AgentChatManager(vi.fn(), initDesktopDb(':memory:'), 4200)
    setAgentChatManager(mgr)
    expect(getAgentChatManager()).toBe(mgr)
    setAgentChatManager(null)
    expect(getAgentChatManager()).toBeNull()
  })
})
