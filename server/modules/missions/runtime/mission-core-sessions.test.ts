// End-to-end: mission manager → MissionCoreSessions → SessionHostRegistry → Core
// session runner → projector → SQLite. Only Core's out-of-process host is
// simulated (protocol-faithful: journal, seq, lag, resume, interrupt, close).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn(), execFileSync: vi.fn(), execFile: vi.fn() }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./agent-cwd-manager', () => ({
  ensureAgentCwd: () => '/tmp/agent-cwd-test',
  ensureAgentConversationCwd: (id: string) => `/tmp/agent-cwd-test/conversations/${id}`,
}))
const mcp = vi.hoisted(() => ({
  prepare: vi.fn(() => ({ extraArgs: [], env: {} })),
  spec: vi.fn((opts: { capability: string }) => [{ name: 'specrails', command: 'node', args: ['bridge.js'], env: { SPECRAILS_AGENT_CAPABILITY_FILE: `/tmp/cap-${opts.capability.slice(0, 4)}` } }]),
  remove: vi.fn(),
}))
vi.mock('../../../agent-mcp-config', () => ({ prepareAgentMcp: mcp.prepare, prepareAgentMcpSpec: mcp.spec, removeAgentCapabilityFile: mcp.remove }))
vi.mock('../../../attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: vi.fn(async () => ({ textBlocks: [], imagePaths: [] })), deleteAllAgent: vi.fn(async () => {}) },
  USER_ATTACHMENT_SYSTEM_NOTE: 'note',
}))

import { spawn as mockSpawn } from 'child_process'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import '../../../providers'
import { getAdapter } from '../../../providers/registry'
import { _resetAgentCapabilitiesForTest, revokeAgentCapability, verifyAgentCapability } from '../../../mcp/agent-capability'
import { SessionRequestError, type InitializeResult, type SessionEvent, type SessionEventEnvelope, type SessionHostClient } from '../../agent-sessions'
import { SessionHostRegistry } from '../../agent-sessions/runtime/session-host-registry'
import { createAgentConversation, listAgentMessages } from '../../agents/runtime/agent-store'
import { AgentChatManager } from './agent-chat-manager'
import { getSessionCursor, listSubagents } from './agent-session-store'
import { MissionCoreSessions } from './mission-core-sessions'

const usage = (costUsd: number) => ({ inputTokens: 100, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd, costEstimated: false, model: 'haiku' })
type Body = Omit<SessionEvent, 'at'>

/** Protocol-faithful Core host for one scope. */
class FakeCoreHost implements SessionHostClient {
  closed = false
  initialize: InitializeResult = {
    protocolVersion: 1, scope: 'global', runtime: {}, capabilities: { sessions: 1 },
    drivers: [{ id: 'claude', displayName: 'Claude Code', capabilities: { resident: true, nativeInputQueue: true, subagents: 'supported', subagentDisable: true, autonomousContinuation: true, steer: true, toolFiltering: true, usage: { costUsd: 'session-cumulative', tokens: 'per-turn' } } }],
  }
  requests: Array<{ method: string; params: Record<string, unknown> }> = []
  journals = new Map<string, SessionEventEnvelope[]>()
  turn = 0
  /** Provider behaviour for a user input. */
  script: (inputId: string, turnId: string) => Body[] = (inputId, turnId) => [
    { type: 'input.state', inputId, state: 'started' },
    { type: 'session.phase', phase: 'turn' },
    { type: 'turn.started', turnId, origin: 'user', inputIds: [inputId] },
    { type: 'turn.output', turnId, channel: 'text', delta: `reply ${turnId}` },
    { type: 'turn.completed', turnId, status: 'completed', text: `reply ${turnId}`, usage: usage(0.02) },
    { type: 'session.phase', phase: 'idle' },
  ]
  private events = new Set<(envelope: SessionEventEnvelope) => void>()
  private closes = new Set<(reason: string) => void>()

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (this.closed) throw new SessionRequestError('closed', { code: 'host_unavailable', retryable: true })
    const sessionId = String((params.resume as { sessionId?: string } | undefined)?.sessionId ?? params.sessionId ?? '')
    switch (method) {
      case 'session.open': {
        if (params.resume) {
          if (!this.journals.has(sessionId)) throw new SessionRequestError('Unknown session', { code: 'session_not_found', retryable: false })
          return { sessionId, snapshot: { lastSeq: this.journals.get(sessionId)!.length } } as T
        }
        this.journals.set(sessionId, [])
        this.emit(sessionId, [{ type: 'session.opened', driver: String(params.driver), model: String(params.model), resumed: false, providerSessionRef: null }, { type: 'session.process', state: 'started', generation: 1 }])
        return { sessionId, snapshot: { lastSeq: 2 } } as T
      }
      case 'session.events': {
        if (!this.journals.has(sessionId)) throw new SessionRequestError('Unknown session', { code: 'session_not_found', retryable: false })
        return { events: this.journals.get(sessionId)!.filter((envelope) => envelope.seq > Number(params.afterSeq)), hasMore: false } as T
      }
      case 'session.send': {
        const input = params.input as { inputId: string; text: string; delivery: 'queue' | 'steer' }
        this.emit(sessionId, [{ type: 'input.accepted', inputId: input.inputId, delivery: input.delivery, text: input.text }])
        if (input.delivery === 'queue') {
          const turnId = `t${++this.turn}`
          setImmediate(() => this.emit(sessionId, this.script(input.inputId, turnId)))
        }
        return { inputId: input.inputId, state: 'accepted' } as T
      }
      default:
        return {} as T
    }
  }

  emit(sessionId: string, bodies: Body[]) {
    const journal = this.journals.get(sessionId)!
    for (const body of bodies) {
      const envelope = { sessionId, seq: journal.length + 1, event: { ...body, at: new Date(Date.UTC(2026, 9, 7, 10, 0, journal.length)).toISOString() } as SessionEvent }
      journal.push(envelope)
      for (const listener of this.events) listener(envelope)
    }
  }
  onEvent(listener: (envelope: SessionEventEnvelope) => void) { this.events.add(listener); return () => { this.events.delete(listener) } }
  onLagged() { return () => {} }
  onClose(listener: (reason: string) => void) { this.closes.add(listener); return () => { this.closes.delete(listener) } }
  async close() { this.closed = true; for (const listener of this.closes) listener('closed') }
}

async function waitFor(condition: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('missions on Core agent sessions', () => {
  let db: DbInstance
  let host: FakeCoreHost
  let manager: AgentChatManager
  let broadcasts: Array<Record<string, unknown>>
  let enabled: boolean

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    // Any legacy spawn (e.g. AI titles) closes immediately with no output.
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
    enabled = true
    manager = new AgentChatManager((message) => broadcasts.push(message as unknown as Record<string, unknown>), db, 4200, null)
    const registry = new SessionHostRegistry({ launcher: { launch: async () => host }, clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } } })
    manager.setCoreSessions(new MissionCoreSessions({
      db, registry, port: 4200, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter,
      availability: async () => ({ enabled, flag: 'auto', reason: 'test' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
    }))
  })

  afterEach(async () => {
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  const doneCount = () => broadcasts.filter((message) => message.type === 'agent_done').length
  const capabilityOf = (call: number) => (mcp.spec.mock.calls[call]![0] as { capability: string }).capability

  it('runs user turns in one resident session, projects background work and keeps the capability alive for it', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    mcp.spec.mockClear()
    host.script = (inputId, turnId) => [
      { type: 'input.state', inputId, state: 'started' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId, origin: 'user', inputIds: [inputId] },
      { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', agentType: 'general-purpose', description: 'Run the tests' },
      { type: 'turn.output', turnId, channel: 'text', delta: 'LAUNCHED' },
      { type: 'turn.completed', turnId, status: 'completed', text: 'LAUNCHED', usage: usage(0.02) },
      { type: 'session.phase', phase: 'background' },
      { type: 'subagents.settled', settled: false, live: 1 },
    ]
    await manager.sendMessage(conversation.id, 'run the tests in the background')
    await waitFor(() => doneCount() === 1)

    const [first] = listAgentMessages(db, conversation.id).filter((message) => message.role === 'assistant')
    expect(first).toMatchObject({ content: 'LAUNCHED', core_turn_id: 't1', turn_origin: 'user' })
    // Clients anchor this turn's sub-agents under the reply without a reload.
    expect(broadcasts.find((message) => message.type === 'agent_done')).toMatchObject({ messageId: first!.id, coreTurnId: 't1' })
    expect(host.requests.find((request) => request.method === 'session.open' && !request.params.resume)?.params).toMatchObject({ sessionId: conversation.id, driver: 'claude', policy: { permissions: 'bypass', subagents: 'enabled' } })
    const firstCapability = capabilityOf(0)
    // The resident session still needs Specrails tools for its background turns.
    expect(verifyAgentCapability(firstCapability)).not.toBeNull()
    await waitFor(() => listSubagents(db, conversation.id).length === 1)
    expect(getSessionCursor(db, conversation.id)).toMatchObject({ residentPhase: 'background', liveSubagents: 1 })

    // The sub-agent finishes and Claude continues on its own.
    host.emit(conversation.id, [
      { type: 'subagent.result', subagentId: 'a1', summary: 'All green' },
      { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId: 'bg1', origin: 'subagent', inputIds: [], trigger: { subagentIds: ['a1'] } },
      { type: 'turn.output', turnId: 'bg1', channel: 'text', delta: 'Tests are green.' },
      { type: 'turn.completed', turnId: 'bg1', status: 'completed', text: 'Tests are green.', usage: usage(0.03) },
      { type: 'subagents.settled', settled: true, live: 0 },
      { type: 'session.phase', phase: 'idle' },
    ])
    await waitFor(() => broadcasts.some((message) => message.type === 'agent_turn_done'))
    expect(listAgentMessages(db, conversation.id).filter((message) => message.role === 'assistant').map((message) => [message.content, message.turn_origin])).toEqual([['LAUNCHED', 'user'], ['Tests are green.', 'subagent']])
    expect(listSubagents(db, conversation.id)[0]).toMatchObject({ phase: 'idle', resultSummary: 'All green', launchedInTurnId: 't1' })
    // The user turn is billed from Core's usage; the continuation turn has its own row.
    const invocations = db.prepare('SELECT origin, total_cost_usd FROM agent_invocations WHERE conversation_id = ? AND total_cost_usd IS NOT NULL').all(conversation.id)
    expect(invocations).toEqual(expect.arrayContaining([{ origin: 'user', total_cost_usd: 0.02 }, { origin: 'subagent', total_cost_usd: 0.03 }]))
    expect(invocations).toHaveLength(2)

    // A second user turn reuses the same Core session and rotates the capability.
    host.script = (inputId, turnId) => [
      { type: 'input.state', inputId, state: 'started' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId, origin: 'user', inputIds: [inputId] },
      { type: 'turn.completed', turnId, status: 'completed', text: 'second', usage: usage(0.01) },
      { type: 'session.phase', phase: 'idle' },
    ]
    await manager.sendMessage(conversation.id, 'thanks')
    await waitFor(() => doneCount() === 2)
    expect(host.requests.filter((request) => request.method === 'session.open').map((request) => request.params.resume ? 'resume' : 'open')).toEqual(['resume', 'open', 'resume'])
    expect(verifyAgentCapability(firstCapability)).toBeNull()
    const secondCapability = capabilityOf(1)
    expect(verifyAgentCapability(secondCapability)).not.toBeNull()

    // Core retires the idle provider process: the capability can no longer be presented.
    host.emit(conversation.id, [{ type: 'session.process', state: 'retired', generation: 1, reason: 'idle' }])
    await waitFor(() => verifyAgentCapability(secondCapability) === null)
    expect(mcp.remove).toHaveBeenCalledWith(conversation.id)
  })

  it('stops a running turn through Core instead of killing a process', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    host.script = (inputId, turnId) => [
      { type: 'input.state', inputId, state: 'started' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId, origin: 'user', inputIds: [inputId] },
      { type: 'turn.output', turnId, channel: 'text', delta: 'working' },
    ]
    const turn = manager.sendMessage(conversation.id, 'long task')
    await waitFor(() => manager.isStreaming(conversation.id))
    expect(manager.abort(conversation.id)).toBe(true)
    await waitFor(() => host.requests.some((request) => request.method === 'session.interrupt'))
    host.emit(conversation.id, [{ type: 'turn.completed', turnId: 't1', status: 'stopped', text: 'working', usage: usage(0.005) }])
    await turn
    expect(process.kill).not.toHaveBeenCalled()
    expect(manager.isStreaming(conversation.id)).toBe(false)
  })

  it('closes the Core session when the conversation is deleted', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await manager.sendMessage(conversation.id, 'hello')
    await waitFor(() => doneCount() === 1)
    await manager.closeCoreSession(conversation.id)
    expect(host.requests.at(-1)).toMatchObject({ method: 'session.close', params: { sessionId: conversation.id, reason: 'conversation_deleted' } })
  })

  it('keeps the legacy transport when Core sessions are unavailable', async () => {
    enabled = false
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await manager.sendMessage(conversation.id, 'hello')
    expect(host.requests).toEqual([])
    expect(mockSpawn).toHaveBeenCalled()
  })

  it('rebuilds the projection from the journal without duplicating turns', async () => {
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    host.script = (inputId, turnId) => [
      { type: 'input.state', inputId, state: 'started' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId, origin: 'user', inputIds: [inputId] },
      { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', agentType: 'Explore', description: 'Scan' },
      { type: 'turn.completed', turnId, status: 'completed', text: 'LAUNCHED', usage: usage(0.02) },
      { type: 'session.phase', phase: 'background' },
    ]
    await manager.sendMessage(conversation.id, 'scan in the background')
    await waitFor(() => doneCount() === 1)
    host.emit(conversation.id, [
      { type: 'subagent.output', subagentId: 'a1', channel: 'text', delta: 'found 3 files' },
      { type: 'subagent.result', subagentId: 'a1', summary: 'Three files' },
      { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
      { type: 'session.phase', phase: 'turn' },
      { type: 'turn.started', turnId: 'bg1', origin: 'subagent', inputIds: [], trigger: { subagentIds: ['a1'] } },
      { type: 'turn.completed', turnId: 'bg1', status: 'completed', text: 'Scan done.', usage: usage(0.03) },
      { type: 'session.phase', phase: 'idle' },
    ])
    await waitFor(() => broadcasts.some((message) => message.type === 'agent_turn_done'))

    const snapshot = () => ({
      cursor: getSessionCursor(db, conversation.id),
      subagents: db.prepare('SELECT * FROM agent_subagents WHERE conversation_id = ? ORDER BY subagent_id').all(conversation.id).map((row) => ({ ...(row as Record<string, unknown>), updated_at: null })),
      events: db.prepare('SELECT subagent_id, seq, channel, delta, tool_json FROM agent_subagent_events WHERE conversation_id = ? ORDER BY seq').all(conversation.id),
      messages: listAgentMessages(db, conversation.id).map((message) => message.id),
      invocations: db.prepare('SELECT id, origin, total_cost_usd FROM agent_invocations WHERE conversation_id = ? ORDER BY id').all(conversation.id),
    })
    const live = snapshot()
    expect(live.events).toHaveLength(1)
    // Corrupt the projection to prove the rebuild restores it from Core.
    db.prepare('DELETE FROM agent_subagent_events WHERE conversation_id = ?').run(conversation.id)
    db.prepare("UPDATE agent_subagents SET phase = 'running' WHERE conversation_id = ?").run(conversation.id)

    broadcasts.length = 0
    await expect(manager.rebuildSessionProjection(conversation.id)).resolves.toEqual({ lastSeq: live.cursor!.lastSeq, subagents: 1 })
    expect(snapshot()).toEqual(live)
    // The replay is silent; clients get the rebuilt state once.
    expect(broadcasts.map((message) => message.type)).toEqual(['agent_resident_state', 'agent_subagent'])
    expect(broadcasts[1]).toMatchObject({ subagent: { subagentId: 'a1', phase: 'idle', resultSummary: 'Three files' } })

    // Live events keep flowing to clients after the rebuild.
    host.emit(conversation.id, [{ type: 'session.phase', phase: 'idle' }])
    await waitFor(() => broadcasts.length === 3)
    await expect(manager.rebuildSessionProjection(createAgentConversation(db, { provider: 'claude', model: 'haiku' }).id)).resolves.toBeNull()
  })

  it('presents app-installed plugin servers as structured specs without shadowing configured ones', async () => {
    const registry = new SessionHostRegistry({ launcher: { launch: async () => host }, clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } } })
    const sessions = new MissionCoreSessions({
      db, registry, port: 4200, broadcast: () => {}, adapterFor: getAdapter,
      availability: async () => ({ enabled: true, flag: 'auto', reason: 'test' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
    })
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    const context = await sessions.prepareTurn(conversation, getAdapter('claude'), {
      capability: 'cap-plugins', external: [],
      plugins: [{ name: 'serena', command: 'uvx', args: ['serena'] }, { name: 'specrails', command: 'evil', args: [] }],
    })
    expect(context?.mcpServers.map((server) => [server.name, server.command])).toEqual([['specrails', 'node'], ['serena', 'uvx']])
    sessions.shutdown()
  })

  describe('"Allow sub-agents" policy', () => {
    function withPolicy(allow: { value: boolean }) {
      const registry = new SessionHostRegistry({ launcher: { launch: async () => host }, clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } } })
      const sessions = new MissionCoreSessions({
        db, registry, port: 4200, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter,
        availability: async () => ({ enabled: true, flag: 'auto', reason: 'test' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
        subagentPolicy: () => (allow.value ? 'enabled' : 'disabled'),
      })
      manager.setCoreSessions(sessions)
      return sessions
    }
    const updates = () => host.requests.filter((request) => request.method === 'session.update' && (request.params.policy as { subagents?: string } | undefined) && !request.params.model)

    it('opens with the resolved policy and refreshes open sessions of the changed scope only', async () => {
      const allow = { value: false }
      const sessions = withPolicy(allow)
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      await manager.sendMessage(conversation.id, 'hello')
      await waitFor(() => doneCount() === 1)
      expect(host.requests.find((request) => request.method === 'session.open' && !request.params.resume)?.params).toMatchObject({ policy: { subagents: 'disabled' } })

      await sessions.refreshSubagentPolicy({ projectId: null })
      expect(updates()).toHaveLength(0) // nothing changed
      allow.value = true
      await sessions.refreshSubagentPolicy({ projectId: 'another-project' })
      expect(updates()).toHaveLength(0) // other scope
      await sessions.refreshSubagentPolicy({ projectId: null })
      expect(updates()).toHaveLength(1)
      // The whole policy travels (Core replaces it), MCP servers included.
      expect(updates()[0]!.params).toMatchObject({ sessionId: conversation.id, policy: { subagents: 'enabled', permissions: 'bypass', mcp: { inheritUserScope: true, servers: [expect.objectContaining({ name: 'specrails' })] } } })
      await sessions.refreshSubagentPolicy({ projectId: null })
      expect(updates()).toHaveLength(1)
    })

    it('explains a policy the provider cannot enforce', async () => {
      withPolicy({ value: false })
      const original = host.request.bind(host)
      host.request = (async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'session.open' && !params.resume) throw new SessionRequestError('Codex cannot disable sub-agents', { code: 'policy_unenforceable', retryable: false })
        return original(method, params)
      }) as typeof host.request
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      await manager.sendMessage(conversation.id, 'hello')
      await waitFor(() => broadcasts.some((message) => message.type === 'agent_error'))
      expect(broadcasts.find((message) => message.type === 'agent_error')).toMatchObject({ conversationId: conversation.id, code: 'policy_unenforceable', provider: 'claude' })
    })
  })

  it('tells the mission why a turn fell back when its scope is degraded', async () => {
    const launcher = { launch: async () => { throw new SessionRequestError('Another session host owns this scope', { code: 'journal_locked', retryable: false }) } }
    const registry = new SessionHostRegistry({ launcher, clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } } })
    manager.setCoreSessions(new MissionCoreSessions({
      db, registry, port: 4200, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter,
      availability: async () => ({ enabled: true, flag: 'auto', reason: 'test' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
    }))
    const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await manager.sendMessage(conversation.id, 'first')
    await waitFor(() => broadcasts.some((message) => message.type === 'agent_session_notice'))
    expect(broadcasts.find((message) => message.type === 'agent_session_notice')).toMatchObject({ conversationId: conversation.id, code: 'journal_locked', scope: 'global', level: 'warning' })
    // The turn itself ran on the legacy transport.
    expect(mockSpawn).toHaveBeenCalled()
  })

  describe('who runs sub-agents (hybrid runtime)', () => {
    function withRuntime(choice: { provider: string; model: string; effort: string | null } | null) {
      const registry = new SessionHostRegistry({ launcher: { launch: async () => host }, clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } } })
      manager.setCoreSessions(new MissionCoreSessions({
        db, registry, port: 4200, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter,
        availability: async () => ({ enabled: true, flag: 'auto', reason: 'test' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
        subagentPolicy: () => 'enabled',
        subagentRuntime: () => choice,
      }))
    }
    const openPolicy = () => host.requests.find((request) => request.method === 'session.open' && !request.params.resume)?.params.policy as Record<string, unknown>
    const claude = { id: 'claude', displayName: 'Claude Code', capabilities: { resident: true, nativeInputQueue: true, subagents: 'supported' as const, subagentDisable: true, subagentModel: true, subagentEffort: false, autonomousContinuation: true, steer: true, toolFiltering: true, usage: { costUsd: 'session-cumulative' as const, tokens: 'per-turn' as const } } }
    const codex = { ...claude, id: 'codex', displayName: 'Codex', capabilities: { ...claude.capabilities, subagentEffort: true } }

    it('lets Core launch them when the chosen provider differs from the mission', async () => {
      host.initialize = { ...host.initialize, capabilities: { sessions: 1, delegation: 1 }, drivers: [claude, codex] }
      withRuntime({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'low' })
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      await manager.sendMessage(conversation.id, 'hello')
      await waitFor(() => doneCount() === 1)
      expect(openPolicy()).toMatchObject({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'codex', model: 'gpt-5.6-terra', effort: 'low' } })
    })

    it('keeps them native with the supported overrides when the providers match', async () => {
      host.initialize = { ...host.initialize, capabilities: { sessions: 1, delegation: 1 }, drivers: [claude, codex] }
      withRuntime({ provider: 'claude', model: 'sonnet', effort: 'high' })
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      await manager.sendMessage(conversation.id, 'hello')
      await waitFor(() => doneCount() === 1)
      // Claude cannot set a sub-agent effort: only the model travels.
      expect(openPolicy()).toMatchObject({ subagentRuntime: { mode: 'native', model: 'sonnet' } })
      expect((openPolicy().subagentRuntime as Record<string, unknown>).effort).toBeUndefined()
    })

    it('stays native and tells the mission when this Core cannot delegate', async () => {
      host.initialize = { ...host.initialize, capabilities: { sessions: 1 }, drivers: [claude] }
      withRuntime({ provider: 'codex', model: 'gpt-5.6-terra', effort: null })
      const conversation = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
      await manager.sendMessage(conversation.id, 'hello')
      await waitFor(() => doneCount() === 1)
      expect(openPolicy()).toMatchObject({ subagentRuntime: { mode: 'native' } })
      expect(broadcasts.find((message) => message.type === 'agent_session_notice')).toMatchObject({ conversationId: conversation.id, code: 'subagents.delegation_unsupported' })
    })
  })
})

