// Flow turns through the real mission manager → MissionCoreSessions → Core
// session runner. Only Core's out-of-process host is simulated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn(), execFileSync: vi.fn(), execFile: vi.fn() }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./agent-cwd-manager', () => ({
  ensureAgentCwd: () => '/tmp/agent-cwd-test',
  ensureAgentConversationCwd: (id: string) => `/tmp/agent-cwd-test/conversations/${id}`,
}))
vi.mock('../../../agent-mcp-config', () => ({
  prepareAgentMcp: vi.fn(() => ({ extraArgs: [], env: {} })),
  prepareAgentMcpSpec: vi.fn(() => [{ name: 'specrails', command: 'node', args: ['bridge.js'], env: {} }]),
  removeAgentCapabilityFile: vi.fn(),
}))
vi.mock('../../../attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: vi.fn(async () => ({ textBlocks: [], imagePaths: [] })), deleteAllAgent: vi.fn(async () => {}) },
  USER_ATTACHMENT_SYSTEM_NOTE: 'note',
}))

import { spawn as mockSpawn } from 'child_process'
import { initDesktopDb, sumFlowInvocations } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import '../../../providers'
import { getAdapter } from '../../../providers/registry'
import { _resetAgentCapabilitiesForTest, revokeAgentCapability } from '../../../mcp/agent-capability'
import { SessionRequestError, type InitializeResult, type SessionEvent, type SessionEventEnvelope, type SessionHostClient } from '../../agent-sessions'
import { SessionHostRegistry } from '../../agent-sessions/runtime/session-host-registry'
import { addAgentMessage, createAgentConversation, getAgentConversation, updateAgentConversation } from '../../agents/runtime/agent-store'
import { AgentChatManager } from './agent-chat-manager'
import { FLOW_SUBAGENTS_ADDENDUM, FLOW_SYSTEM_PROMPT } from './agent-flow-prompt'
import { listSessionCursors, listSubagents } from './agent-session-store'
import { FLOW_SESSION_BOUNDARY, type FlowTurn } from './flow-turn-context'
import { MissionCoreSessions } from './mission-core-sessions'

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd: 0.02, costEstimated: false, model: 'haiku' }
type Body = Omit<SessionEvent, 'at'>

class FakeCoreHost implements SessionHostClient {
  initialize: InitializeResult = {
    protocolVersion: 1, scope: 'global', runtime: {}, capabilities: { sessions: 1, flowSessions: 1 },
    drivers: [{ id: 'claude', displayName: 'Claude Code', capabilities: { resident: true, nativeInputQueue: true, subagents: 'supported', subagentDisable: true, autonomousContinuation: true, steer: true, toolFiltering: true, interrupt: 'native', usage: { costUsd: 'session-cumulative', tokens: 'per-turn' } } }],
  }
  requests: Array<{ method: string; params: Record<string, unknown> }> = []
  journals = new Map<string, SessionEventEnvelope[]>()
  turn = 0
  /** Hold the first turn open so mid-turn input can be tested. */
  holdTurn = false
  private events = new Set<(envelope: SessionEventEnvelope) => void>()

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    const sessionId = String((params.resume as { sessionId?: string } | undefined)?.sessionId ?? params.sessionId ?? '')
    switch (method) {
      case 'session.open':
        if (params.resume) {
          if (!this.journals.has(sessionId)) throw new SessionRequestError('Unknown session', { code: 'session_not_found', retryable: false })
          return { sessionId, snapshot: { lastSeq: this.journals.get(sessionId)!.length } } as T
        }
        this.journals.set(sessionId, [])
        return { sessionId, snapshot: { lastSeq: 0 } } as T
      case 'session.events':
        return { events: (this.journals.get(sessionId) ?? []).filter((envelope) => envelope.seq > Number(params.afterSeq)), hasMore: false } as T
      case 'session.send': {
        const input = params.input as { inputId: string; text: string; delivery: 'queue' | 'steer' | 'interrupt' }
        this.emit(sessionId, [{ type: 'input.accepted', inputId: input.inputId, delivery: input.delivery, text: input.text }])
        const current = `t${this.turn}`
        if (input.delivery === 'interrupt') {
          const next = `t${++this.turn}`
          setImmediate(() => this.emit(sessionId, [
            { type: 'turn.completed', turnId: current, status: 'interrupted', text: 'partial', usage },
            { type: 'turn.started', turnId: next, origin: 'user', inputIds: [input.inputId] },
            { type: 'turn.output', turnId: next, channel: 'text', delta: 'corrected' },
            { type: 'turn.completed', turnId: next, status: 'completed', text: 'corrected', usage },
          ]))
        } else if (input.delivery === 'queue') {
          const turnId = `t${++this.turn}`
          setImmediate(() => this.emit(sessionId, [
            { type: 'input.state', inputId: input.inputId, state: 'started' },
            { type: 'turn.started', turnId, origin: 'user', inputIds: [input.inputId] },
            { type: 'turn.output', turnId, channel: 'text', delta: 'partial' },
            ...(this.holdTurn ? [] : [{ type: 'turn.completed', turnId, status: 'completed', text: 'partial', usage } as Body]),
          ]))
        }
        return { inputId: input.inputId, state: 'accepted' } as T
      }
      default:
        return {} as T
    }
  }

  emit(sessionId: string, bodies: Body[]) {
    const journal = this.journals.get(sessionId) ?? []
    this.journals.set(sessionId, journal)
    for (const body of bodies) {
      const envelope = { sessionId, seq: journal.length + 1, event: { ...body, at: '2026-10-21T10:00:00.000Z' } as SessionEvent }
      journal.push(envelope)
      for (const listener of this.events) listener(envelope)
    }
  }
  onEvent(listener: (envelope: SessionEventEnvelope) => void) { this.events.add(listener); return () => { this.events.delete(listener) } }
  onLagged() { return () => {} }
  onClose() { return () => {} }
  async close() {}
}

async function waitFor(condition: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('Flow turns in missions', () => {
  let db: DbInstance
  let host: FakeCoreHost
  let manager: AgentChatManager
  let broadcasts: Array<Record<string, unknown>>
  let flow: FlowTurn | null
  let allowSubagents: boolean
  let runtimeChoice: { provider: string; model: string } | null

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.mocked(mockSpawn).mockImplementation((() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      child.stdout = new Readable({ read() {} })
      child.stderr = new Readable({ read() {} })
      child.pid = 1
      child.kill = vi.fn()
      setImmediate(() => { (child.stdout as Readable).push(null); (child.stderr as Readable).push(null); child.emit('close', 0) })
      return child
    }) as never)
    db = initDesktopDb(':memory:')
    host = new FakeCoreHost()
    broadcasts = []
    flow = null
    allowSubagents = false
    runtimeChoice = null
    manager = new AgentChatManager((message) => broadcasts.push(message as unknown as Record<string, unknown>), db, 4200, null)
    const registry = new SessionHostRegistry({ launcher: { launch: async () => host }, clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } } })
    manager.setCoreSessions(new MissionCoreSessions({
      db, registry, port: 4200, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter,
      availability: async () => ({ enabled: true, flag: 'auto', reason: 'test' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
      // The project's "Allow sub-agents" (default off) and "Run sub-agents with".
      subagentPolicy: () => allowSubagents ? 'enabled' : 'disabled',
      subagentRuntime: () => runtimeChoice,
    }))
    manager.setFlowTurnContext({ forConversation: () => flow })
  })

  afterEach(async () => {
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  const doneCount = () => broadcasts.filter((message) => message.type === 'agent_done').length
  const flowTurn = (): FlowTurn => ({ flowId: 'f1', cwd: '/wt/f1/ticket-7', branch: 'feat/7-idea', coreSessionId: 'flow:f1', systemPrompt: FLOW_SYSTEM_PROMPT, policy: FLOW_SESSION_BOUNDARY })
  const opens = () => host.requests.filter((request) => request.method === 'session.open' && !request.params.resume)

  it('a null port leaves the mission turn exactly as before (own session, read-only boundary, agent-chat surface)', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await manager.sendMessage(conversation.id, 'hello')
    await waitFor(() => doneCount() === 1)
    expect(opens()[0]!.params).toMatchObject({ sessionId: conversation.id, cwd: '/tmp/agent-cwd-test', metadata: { surface: 'mission' } })
    // The read-only mission boundary (PR #793): bypass + read-only tools, never the Flow boundary.
    expect(opens()[0]!.params.policy).toMatchObject({ permissions: 'bypass', tools: { mode: 'read-only' } })
    expect(String(opens()[0]!.params.systemPrompt)).not.toContain('Specrails Flow')
    expect(db.prepare('SELECT surface FROM agent_invocations WHERE conversation_id = ?').all(conversation.id)).toEqual([{ surface: 'agent-chat' }])
    expect(manager.isFlowActive(conversation.id)).toBe(false)
  })

  it('a Flow turn runs in its own Core session in the worktree with the rail write-role permissions and the Flow persona', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    updateAgentConversation(db, conversation.id, { session_id: 'mission-provider-session' })
    addAgentMessage(db, { conversationId: conversation.id, role: 'user', content: 'earlier mission question' })
    flow = flowTurn()
    expect(manager.isFlowActive(conversation.id)).toBe(true)
    await manager.sendMessage(conversation.id, 'build the board')
    await waitFor(() => doneCount() === 1)
    const open = opens()[0]!.params
    expect(open).toMatchObject({
      sessionId: 'flow:f1', cwd: '/wt/f1/ticket-7', driver: 'claude', systemPrompt: FLOW_SYSTEM_PROMPT,
      metadata: { conversationId: conversation.id, surface: 'flow', flowId: 'f1' },
      policy: { subagents: 'disabled', permissions: 'bypass', tools: { mode: 'default' }, mcp: { inheritUserScope: true, servers: [expect.objectContaining({ name: 'specrails' })] } },
    })
    expect(open.providerSessionRef).toBeUndefined()
    expect(String(open.systemPrompt)).not.toContain('Sub-agents in Flow')
    const firstPrompt = String((host.requests.find((request) => request.method === 'session.send')!.params.input as { text: string }).text)
    expect(firstPrompt).toContain('Flow: worktree="/wt/f1/ticket-7" branch=feat/7-idea')
    expect(firstPrompt).toContain('earlier mission question')
    // Flow usage has its own surface; the mission's provider session is untouched.
    expect(db.prepare('SELECT surface, total_cost_usd FROM agent_invocations WHERE conversation_id = ?').all(conversation.id)).toEqual([{ surface: 'flow', total_cost_usd: 0.02 }])
    expect(getAgentConversation(db, conversation.id)?.session_id).toBe('mission-provider-session')

    // The second Flow turn resumes the Flow session and no longer resends history.
    await manager.sendMessage(conversation.id, 'now add colours')
    await waitFor(() => doneCount() === 2)
    const sends = host.requests.filter((request) => request.method === 'session.send')
    expect(String((sends.at(-1)!.params.input as { text: string }).text)).not.toContain('earlier mission question')
    expect(host.requests.filter((request) => request.method === 'session.open' && request.params.resume).at(-1)!.params).toMatchObject({ resume: { sessionId: 'flow:f1' } })
  })

  it.each([
    ['claude', 'haiku'],
    ['codex', 'gpt-5'],
  ])('a %s Flow turn runs without interactive approvals (Core: claude skip-permissions, codex danger-full-access); its mission turn stays read-only', async (provider, model) => {
    host.initialize = { ...host.initialize, drivers: [{ ...host.initialize.drivers[0]!, id: provider, displayName: provider }] }
    const conversation = createAgentConversation(db, { provider, model })
    await manager.sendMessage(conversation.id, 'explain the project')
    await waitFor(() => doneCount() === 1)
    const mission = opens()[0]!.params
    expect(mission).toMatchObject({ sessionId: conversation.id, driver: provider })
    expect(mission.policy).not.toMatchObject({ permissions: 'bypass', tools: { mode: 'default' } })
    expect((mission.policy as { tools?: { mode: string } }).tools?.mode === 'read-only' || (mission.policy as { permissions: string }).permissions === 'read-only').toBe(true)
    flow = flowTurn()
    await manager.sendMessage(conversation.id, 'start the app')
    await waitFor(() => doneCount() === 2)
    const open = opens().find((request) => request.params.sessionId === 'flow:f1')!.params
    expect(open).toMatchObject({ driver: provider, cwd: '/wt/f1/ticket-7', policy: { permissions: 'bypass', tools: { mode: 'default' } } })
  })

  it('mid-turn input in Flow interrupts the running turn (no session.interrupt first)', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    flow = flowTurn()
    host.holdTurn = true
    void manager.sendMessage(conversation.id, 'start building')
    await waitFor(() => host.requests.some((request) => request.method === 'session.send'))
    await waitFor(() => broadcasts.some((message) => message.type === 'agent_stream'))
    await manager.sendMessage(conversation.id, 'actually use blue', { deliveryMode: 'steer' })
    await waitFor(() => doneCount() === 1)
    const interrupt = host.requests.find((request) => request.method === 'session.send' && (request.params.input as { delivery: string }).delivery === 'interrupt')
    expect(interrupt?.params).toMatchObject({ sessionId: 'flow:f1', input: { delivery: 'interrupt', text: expect.stringContaining('actually use blue') } })
    expect(host.requests.some((request) => request.method === 'session.interrupt')).toBe(false)
    expect(broadcasts.find((message) => message.type === 'agent_done')).toMatchObject({ fullText: 'corrected' })
    // One invocation for the user turn with both Core turns' usage.
    expect(db.prepare('SELECT surface, total_cost_usd, tokens_in FROM agent_invocations WHERE conversation_id = ?').all(conversation.id)).toEqual([{ surface: 'flow', total_cost_usd: 0.04, tokens_in: 200 }])
  })

  it('never falls back to a legacy transport when the host lacks flowSessions', async () => {
    host.initialize = { ...host.initialize, capabilities: { sessions: 1 } }
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    flow = flowTurn()
    await expect(manager.assertFlowSupport(conversation.id)).rejects.toMatchObject({ code: 'flow_sessions_unavailable' })
    await manager.sendMessage(conversation.id, 'build')
    await waitFor(() => broadcasts.some((message) => message.type === 'agent_error'))
    expect(broadcasts.find((message) => message.type === 'agent_error')?.error).toMatch(/flowSessions/)
    expect(opens()).toEqual([])
    expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
  })

  it('checks Flow support per provider and closes the Flow session', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await expect(manager.assertFlowSupport(conversation.id)).resolves.toBeUndefined()
    const codex = createAgentConversation(db, { provider: 'codex' })
    await expect(manager.assertFlowSupport(codex.id)).rejects.toThrow(/no session driver for codex/)
    await expect(manager.assertFlowSupport('missing')).rejects.toThrow('Unknown conversation')
    await manager.closeFlowSession(conversation.id, 'flow:f1', 'flow_closed')
    expect(host.requests.find((request) => request.method === 'session.close')?.params).toEqual({ sessionId: 'flow:f1', reason: 'flow_closed' })
  })

  it('tells the operator on the USER turn when Flow is offerable (system prompt unchanged)', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    manager.setFlowTurnContext({ forConversation: () => null, offerable: async () => true })
    await manager.sendMessage(conversation.id, 'I want to try a calmer dashboard')
    await waitFor(() => doneCount() === 1)
    const send = host.requests.find((request) => request.method === 'session.send')!
    expect(String((send.params.input as { text: string }).text)).toContain('| Flow: offerable')
    expect(String(opens()[0]!.params.systemPrompt)).not.toContain('| Flow: offerable')
    manager.setFlowTurnContext({ forConversation: () => null, offerable: async () => { throw new Error('probe failed') } })
    await manager.sendMessage(conversation.id, 'again')
    await waitFor(() => doneCount() === 2)
    const last = host.requests.filter((request) => request.method === 'session.send').at(-1)!
    expect(String((last.params.input as { text: string }).text)).not.toContain('| Flow: offerable')
  })

  it('a Flow lookup failure degrades to a normal mission turn', async () => {
    manager.setFlowTurnContext({ forConversation: () => { throw new Error('project db closed') } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await manager.sendMessage(conversation.id, 'hello')
    await waitFor(() => doneCount() === 1)
    expect(opens()[0]!.params).toMatchObject({ sessionId: conversation.id })
  })

  describe('sub-agents in Flow', () => {
    const subagentEvents = (prefix: string): Body[] => [
      { type: 'subagent.started', subagentId: `${prefix}-a1`, parentId: null, kind: 'background', description: `${prefix} effect`, delegated: { driver: 'codex', model: 'gpt-5' } },
      { type: 'subagent.usage', subagentId: `${prefix}-a1`, usage: { ...usage, costUsd: 0.5 }, billing: 'separate' },
      { type: 'subagent.phase', subagentId: `${prefix}-a1`, phase: 'idle' },
      { type: 'turn.started', turnId: `${prefix}-bg`, origin: 'subagent', inputIds: [], trigger: { subagentIds: [`${prefix}-a1`] } } as Body,
      { type: 'turn.completed', turnId: `${prefix}-bg`, status: 'completed', text: `${prefix} integrated`, usage: { ...usage, costUsd: 0.1 } },
    ]

    it('policy off keeps Flow sub-agents disabled with no addendum', async () => {
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      flow = flowTurn()
      await manager.sendMessage(conversation.id, 'build')
      await waitFor(() => doneCount() === 1)
      const open = opens()[0]!.params
      expect(open.policy).toMatchObject({ subagents: 'disabled' })
      expect((open.policy as Record<string, unknown>).subagentRuntime).toBeUndefined()
      expect(open.systemPrompt).toBe(FLOW_SYSTEM_PROMPT)
    })

    it('policy on (native) enables them in the worktree session and appends the static Flow addendum', async () => {
      allowSubagents = true
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      flow = flowTurn()
      await manager.sendMessage(conversation.id, 'build')
      await waitFor(() => doneCount() === 1)
      const open = opens()[0]!.params
      expect(open).toMatchObject({ sessionId: 'flow:f1', cwd: '/wt/f1/ticket-7', policy: { subagents: 'enabled', permissions: 'bypass', subagentRuntime: { mode: 'native' } } })
      // Persona first, byte-identical; the addendum is separate and static.
      expect(open.systemPrompt).toBe(`${FLOW_SYSTEM_PROMPT}\n\n${FLOW_SUBAGENTS_ADDENDUM}`)
      expect(String(open.systemPrompt)).not.toContain('subagent_start')
    })

    it('policy on (delegated) delegates in the Flow session; Core gives children its cwd', async () => {
      allowSubagents = true
      runtimeChoice = { provider: 'codex', model: 'gpt-5' }
      host.initialize = {
        ...host.initialize,
        capabilities: { ...host.initialize.capabilities, delegation: 1 },
        drivers: [...host.initialize.drivers, { ...host.initialize.drivers[0]!, id: 'codex', displayName: 'Codex' }],
      }
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      flow = flowTurn()
      await manager.sendMessage(conversation.id, 'build')
      await waitFor(() => doneCount() === 1)
      const open = opens()[0]!.params
      expect(open.policy).toMatchObject({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'codex', model: 'gpt-5' } })
      expect(String(open.systemPrompt)).toContain(FLOW_SUBAGENTS_ADDENDUM)
      expect(String(open.systemPrompt)).toContain('sub-agents run on codex (gpt-5)')
      // The delegate request names the Flow session only: Core opens the child
      // with the parent session's cwd (the worktree) and permissions.
      await manager.delegateSubagent(conversation.id, { description: 'Trail', prompt: 'Add a particle trail' })
      expect(host.requests.find((request) => request.method === 'session.delegate')!.params).toEqual({ sessionId: 'flow:f1', description: 'Trail', prompt: 'Add a particle trail' })
    })

    it('projects the Flow session apart from the mission session: sub-agents and usage land in Flow cost only, exactly once', async () => {
      allowSubagents = true
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      // A normal mission turn first: the mission's own session is tracked too.
      await manager.sendMessage(conversation.id, 'plan it')
      await waitFor(() => doneCount() === 1)
      flow = flowTurn()
      await manager.sendMessage(conversation.id, 'build it')
      await waitFor(() => doneCount() === 2)

      host.emit('flow:f1', subagentEvents('flow'))
      host.emit(conversation.id, subagentEvents('mission'))
      await waitFor(() => listSubagents(db, conversation.id).length === 2 && broadcasts.filter((m) => m.type === 'agent_turn_done').length === 2)

      expect(listSubagents(db, conversation.id, 'flow:f1').map((row) => row.subagentId)).toEqual(['flow-a1'])
      expect(listSubagents(db, conversation.id, conversation.id).map((row) => row.subagentId)).toEqual(['mission-a1'])
      expect(listSessionCursors(db, conversation.id).map((cursor) => cursor.coreSessionId)).toEqual([conversation.id, 'flow:f1'])
      const rows = db.prepare("SELECT id, surface, origin, total_cost_usd FROM agent_invocations WHERE conversation_id = ? AND origin != 'user' ORDER BY id").all(conversation.id)
      expect(rows).toEqual([
        { id: `core-subagent:${conversation.id}:flow:f1:flow-a1:${host.journals.get('flow:f1')!.find((e) => e.event.type === 'subagent.usage')!.seq}`, surface: 'flow', origin: 'subagent', total_cost_usd: 0.5 },
        { id: `core-subagent:${conversation.id}:mission-a1:${host.journals.get(conversation.id)!.find((e) => e.event.type === 'subagent.usage')!.seq}`, surface: 'agent-chat', origin: 'subagent', total_cost_usd: 0.5 },
        { id: `core-turn:${conversation.id}:flow:f1:flow-bg`, surface: 'flow', origin: 'subagent', total_cost_usd: 0.1 },
        { id: `core-turn:${conversation.id}:mission-bg`, surface: 'agent-chat', origin: 'subagent', total_cost_usd: 0.1 },
      ])
      // Flow cost (the cost route and flowCostUsd read this) = Flow user turn + its sub-agent + its continuation.
      expect(sumFlowInvocations(db, { conversationId: conversation.id, from: '1970-01-01', to: null })).toMatchObject({ costUsd: 0.02 + 0.5 + 0.1, turns: 3 })
      // Flow broadcasts carry the session so the client can tell them apart.
      expect(broadcasts.find((m) => m.type === 'agent_subagent' && (m.subagent as { subagentId: string }).subagentId === 'flow-a1')).toMatchObject({ conversationId: conversation.id, coreSessionId: 'flow:f1' })
      expect(broadcasts.find((m) => m.type === 'agent_subagent' && (m.subagent as { subagentId: string }).subagentId === 'mission-a1')).not.toHaveProperty('coreSessionId')

      // Rebuild replays both journals without recording anything twice.
      const before = db.prepare('SELECT COUNT(*) AS n FROM agent_invocations').get()
      await manager.rebuildSessionProjection(conversation.id)
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_invocations').get()).toEqual(before)
      expect(listSubagents(db, conversation.id).map((row) => [row.coreSessionId, row.subagentId])).toEqual(expect.arrayContaining([[conversation.id, 'mission-a1'], ['flow:f1', 'flow-a1']]))
      expect(listSubagents(db, conversation.id)).toHaveLength(2)
    })
  })
})
