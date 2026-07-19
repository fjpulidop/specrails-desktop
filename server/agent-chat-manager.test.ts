import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing anything that spawns. On POSIX the
// spawnCli wrapper calls child_process.spawn directly, so this intercepts the
// real CLI launch (mirrors chat-manager.test.ts).
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}))

vi.mock('tree-kill', () => ({ default: vi.fn() }))

// The agent turn's peripheral wiring (cwd materialisation and MCP config) is
// stubbed so cost-accounting tests touch no real filesystem / ~/.specrails.
const agentCwdMocks = vi.hoisted(() => ({
  ensureGlobal: vi.fn(() => '/tmp/agent-cwd-test'),
  ensureConversation: vi.fn((conversationId: string) => `/tmp/agent-cwd-test/conversations/${conversationId}`),
}))
vi.mock('./agent-cwd-manager', () => ({
  ensureAgentCwd: agentCwdMocks.ensureGlobal,
  ensureAgentConversationCwd: agentCwdMocks.ensureConversation,
}))
const agentMcpMocks = vi.hoisted(() => ({
  prepare: vi.fn((_opts: unknown) => ({ extraArgs: [], env: {} })),
  removeCapabilityFile: vi.fn(),
}))
vi.mock('./agent-mcp-config', () => ({
  prepareAgentMcp: agentMcpMocks.prepare,
  removeAgentCapabilityFile: agentMcpMocks.removeCapabilityFile,
}))
vi.mock('./attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: vi.fn(async () => ({ textBlocks: [], imagePaths: [] })) },
  USER_ATTACHMENT_SYSTEM_NOTE: 'note',
}))

import { spawn as mockSpawn } from 'child_process'
import treeKill from 'tree-kill'
import { AgentChatManager, sanitizeAgentTitle } from './agent-chat-manager'
import { initDesktopDb } from './desktop-db'
import {
  createAgentConversation,
  getAgentConversation,
  updateAgentConversation,
  addAgentMessage,
  listAgentMessages,
} from './agent-store'
import type { DbInstance } from './db'
import { _resetAgentCapabilitiesForTest, verifyAgentCapability } from './mcp/agent-capability'

beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function createMockChildProcess(): any {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 51000
  child.kill = vi.fn()
  return child
}

// Configures the NEXT spawn to stream `lines` then close with `code`.
function primeTurn(lines: string[], code = 0): void {
  ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
    const child = createMockChildProcess()
    setImmediate(() => {
      for (const l of lines) child.stdout.push(l + '\n')
      child.stdout.push(null)
      setImmediate(() => child.emit('close', code))
    })
    return child
  })
}

function assistantLine(text: string, usage?: Record<string, number>, model = 'claude-sonnet-4'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model, content: [{ type: 'text', text }], ...(usage ? { usage } : {}) },
  })
}

function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: 'result', ...fields })
}

function broadcastsOfType(broadcast: ReturnType<typeof vi.fn>, type: string) {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((m) => m.type === type)
}

describe('AgentChatManager cost accounting (HIGH-3)', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: AgentChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    _resetAgentCapabilitiesForTest()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new AgentChatManager(broadcast, db, 4200)
  })

  function rows() {
    return db.prepare('SELECT * FROM agent_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
  }

  it('records a success row with native cost (estimated=0) and broadcasts spending.invalidated for a pinned project', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: 'proj-77' })
    primeTurn([
      assistantLine('Done.', { input_tokens: 100, output_tokens: 50 }),
      resultLine({
        session_id: 'sess-1',
        total_cost_usd: 0.42,
        num_turns: 2,
        model: 'claude-sonnet-4',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      }),
    ])

    await mgr.sendMessage(conv.id, 'hi')

    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].surface).toBe('agent-chat')
    expect(r[0].status).toBe('success')
    expect(r[0].project_id).toBe('proj-77')
    expect(r[0].provider).toBe('claude')
    expect(r[0].total_cost_usd).toBeCloseTo(0.42, 6)
    expect(r[0].total_cost_usd_estimated).toBe(0)
    expect(r[0].num_turns).toBe(2)
    expect(r[0].tokens_in).toBe(100)

    const inv = broadcastsOfType(broadcast, 'spending.invalidated')
    expect(inv).toHaveLength(1)
    expect(inv[0].projectId).toBe('proj-77')
  })

  it('estimates cost (estimated=1) for a turn that ends with no terminal result event', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: 'proj-9' })
    // Assistant frame carries usage but NO result event arrives (killed-style
    // exit) — extractClaudeResult reconstructs usage, finalise estimates.
    primeTurn([assistantLine('partial', { input_tokens: 1000, output_tokens: 500 })], 0)

    await mgr.sendMessage(conv.id, 'go')

    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].total_cost_usd_estimated).toBe(1)
    expect(r[0].total_cost_usd).not.toBeNull()
    expect((r[0].total_cost_usd as number)).toBeGreaterThan(0)
  })

  it('records a Home (app-global) turn with NULL project_id and does NOT broadcast spending.invalidated', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    primeTurn([
      assistantLine('ok', { input_tokens: 20, output_tokens: 10 }),
      resultLine({ session_id: 's', total_cost_usd: 0.01, num_turns: 1, model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 10 } }),
    ])

    await mgr.sendMessage(conv.id, 'home turn')

    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].project_id).toBeNull()
    expect(r[0].status).toBe('success')
    expect(broadcastsOfType(broadcast, 'spending.invalidated')).toHaveLength(0)
  })

  it('records a failed row when the turn produces no text', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    // No assistant text, no usable output → failure branch.
    primeTurn([], 1)

    await mgr.sendMessage(conv.id, 'x')

    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('failed')
    // No usage captured → cost persists NULL (matches claude's failed-row shape).
    expect(r[0].total_cost_usd).toBeNull()
  })

  it('records exactly one row per turn', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: 'proj-1' })
    primeTurn([
      assistantLine('a', { input_tokens: 5, output_tokens: 5 }),
      resultLine({ session_id: 's1', total_cost_usd: 0.1, model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 5 } }),
    ])
    await mgr.sendMessage(conv.id, 'first')

    primeTurn([
      assistantLine('b', { input_tokens: 5, output_tokens: 5 }),
      resultLine({ session_id: 's2', total_cost_usd: 0.2, model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 5 } }),
    ])
    await mgr.sendMessage(conv.id, 'second')

    expect(rows()).toHaveLength(2)
  })

  it('revokes the server capability and removes its file when a turn settles', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: 'proj-cap' })
    let capability = ''
    agentMcpMocks.prepare.mockImplementationOnce((raw: unknown) => {
      const opts = raw as { capability: string }
      capability = opts.capability
      expect(verifyAgentCapability(capability)).toMatchObject({
        conversationId: conv.id,
        projectId: 'proj-cap',
        tierLevel: 0,
      })
      return { extraArgs: [], env: {} }
    })
    primeTurn([assistantLine('done')])

    await mgr.sendMessage(conv.id, 'secure turn')

    expect(capability).not.toBe('')
    expect(verifyAgentCapability(capability)).toBeNull()
    expect(agentMcpMocks.removeCapabilityFile).toHaveBeenCalledWith(conv.id)
  })

  it('applies Kimi effort only to K3 and drops stale effort for other models', async () => {
    const inherited = process.env.KIMI_MODEL_THINKING_EFFORT
    process.env.KIMI_MODEL_THINKING_EFFORT = 'max'
    try {
      const k3 = createAgentConversation(db, { provider: 'kimi', model: 'k3' })
      updateAgentConversation(db, k3.id, { title: 'Existing title', reasoning_effort: 'high' })
      primeTurn([
        JSON.stringify({ role: 'assistant', content: 'K3 answer' }),
        JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'k3-session' }),
      ])
      await mgr.sendMessage(k3.id, 'think')
      const k3Env = vi.mocked(mockSpawn).mock.calls[0][2]?.env as NodeJS.ProcessEnv
      expect(k3Env.KIMI_MODEL_THINKING_EFFORT).toBe('high')

      const coding = createAgentConversation(db, {
        provider: 'kimi',
        model: 'kimi-for-coding',
      })
      updateAgentConversation(db, coding.id, {
        title: 'Existing title',
        reasoning_effort: 'high',
      })
      primeTurn([
        JSON.stringify({ role: 'assistant', content: 'Coding answer' }),
        JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'coding-session' }),
      ])
      await mgr.sendMessage(coding.id, 'code')
      const codingEnv = vi.mocked(mockSpawn).mock.calls[1][2]?.env as NodeJS.ProcessEnv
      expect(codingEnv).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT')
    } finally {
      if (inherited === undefined) delete process.env.KIMI_MODEL_THINKING_EFFORT
      else process.env.KIMI_MODEL_THINKING_EFFORT = inherited
    }
  })

  it('passes a configured Kimi model alias through exactly without K3 effort', async () => {
    const alias = 'moonshot-team/private-coder:v2'
    const conv = createAgentConversation(db, { provider: 'kimi', model: alias })
    updateAgentConversation(db, conv.id, {
      title: 'Existing title',
      reasoning_effort: 'max',
    })
    primeTurn([
      JSON.stringify({ role: 'assistant', content: 'Custom model answer' }),
      JSON.stringify({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'custom-model-session',
      }),
    ])

    await mgr.sendMessage(conv.id, 'use my configured model')

    const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
    expect(args[args.indexOf('-m') + 1]).toBe(alias)
    const env = vi.mocked(mockSpawn).mock.calls[0][2]?.env as NodeJS.ProcessEnv
    expect(env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT')
    expect(rows()[0].model).toBe(alias)
  })
})

describe('AgentChatManager Gemini MCP isolation', () => {
  let db: DbInstance
  let mgr: AgentChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    _resetAgentCapabilitiesForTest()
    db = initDesktopDb(':memory:')
    mgr = new AgentChatManager(vi.fn(), db, 4200)
  })

  it('keeps concurrent conversations on distinct cwd/config/capability scopes', async () => {
    const first = createAgentConversation(db, {
      provider: 'gemini',
      pinnedProjectId: 'project-alpha',
      tierLevel: 1,
    })
    const second = createAgentConversation(db, {
      provider: 'gemini',
      pinnedProjectId: 'project-beta',
      tierLevel: 3,
    })
    const children: ReturnType<typeof createMockChildProcess>[] = []
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const child = createMockChildProcess()
      children.push(child)
      return child
    })

    // Neither turn settles before both processes have spawned. This reproduces
    // the vulnerable overlap where the second prepare used to overwrite the
    // first turn's cwd-discovered Gemini settings.
    const firstTurn = mgr.sendMessage(first.id, 'alpha')
    const secondTurn = mgr.sendMessage(second.id, 'beta')
    await waitFor(() => children.length === 2 && agentMcpMocks.prepare.mock.calls.length === 2)

    const prepared = agentMcpMocks.prepare.mock.calls.map(([raw]) => raw as {
      conversationId: string
      cwd: string
      capability: string
    })
    const firstPrepared = prepared.find((opts) => opts.conversationId === first.id)!
    const secondPrepared = prepared.find((opts) => opts.conversationId === second.id)!

    expect(firstPrepared.cwd).toContain(`/conversations/${first.id}`)
    expect(secondPrepared.cwd).toContain(`/conversations/${second.id}`)
    expect(firstPrepared.cwd).not.toBe(secondPrepared.cwd)
    expect(verifyAgentCapability(firstPrepared.capability)).toMatchObject({
      conversationId: first.id,
      projectId: 'project-alpha',
      tierLevel: 1,
    })
    expect(verifyAgentCapability(secondPrepared.capability)).toMatchObject({
      conversationId: second.id,
      projectId: 'project-beta',
      tierLevel: 3,
    })
    expect(agentCwdMocks.ensureGlobal).not.toHaveBeenCalled()

    // Let both held invocations settle without producing an assistant response.
    for (const child of children) {
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('close', 1)
    }
    await Promise.all([firstTurn, secondTurn])
  })
})

async function waitFor(cond: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setImmediate(r))
  }
}

describe('AgentChatManager AI title', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: AgentChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new AgentChatManager(broadcast, db, 4200)
  })

  function rows() {
    return db.prepare('SELECT * FROM agent_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
  }

  it('upgrades the title with an AI-generated one after the first turn', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    // Main turn (spawn #1).
    primeTurn([
      assistantLine('Sure — here is the game.', { input_tokens: 50, output_tokens: 20 }),
      resultLine({ session_id: 's', total_cost_usd: 0.05, num_turns: 1, model: 'claude-sonnet-4', usage: { input_tokens: 50, output_tokens: 20 } }),
    ])
    // Fire-and-forget AI title spawn (spawn #2).
    primeTurn([
      assistantLine('Connect Four Mini-Game', { input_tokens: 20, output_tokens: 5 }),
      resultLine({ total_cost_usd: 0.001, num_turns: 1, model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 5 } }),
    ])

    await mgr.sendMessage(conv.id, 'add a connect four game')
    await waitFor(() => getAgentConversation(db, conv.id)?.title === 'Connect Four Mini-Game')

    expect(getAgentConversation(db, conv.id)?.title).toBe('Connect Four Mini-Game')
    const titleArgs = vi.mocked(mockSpawn).mock.calls[1][1] as string[]
    expect(titleArgs.slice(titleArgs.indexOf('--tools'), titleArgs.indexOf('--tools') + 2))
      .toEqual(['--tools', '__none__'])
    expect(titleArgs).not.toContain('--dangerously-skip-permissions')
    // Two billable rows: the main turn + the title spawn (LOW-1 accounting parity).
    await waitFor(() => rows().length === 2)
    expect(rows()).toHaveLength(2)
    // The AI title reached the client over the same agent_title event.
    expect(broadcastsOfType(broadcast, 'agent_title').some((m) => m.title === 'Connect Four Mini-Game')).toBe(true)
  })

  it('keeps the deterministic title and skips an unsafe Kimi pure-output spawn', async () => {
    const conv = createAgentConversation(db, {
      provider: 'kimi',
      model: 'k3',
      pinnedProjectId: null,
    })
    primeTurn([
      JSON.stringify({ role: 'assistant', content: 'I can implement that flow.' }),
      JSON.stringify({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'kimi-title-session',
      }),
    ])

    await mgr.sendMessage(conv.id, 'implement the oauth callback flow')
    await new Promise((resolve) => setImmediate(resolve))

    expect(getAgentConversation(db, conv.id)?.title).toBeTruthy()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
  })

  it('never clobbers a manually-renamed conversation (no title spawn fires)', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    updateAgentConversation(db, conv.id, { title: 'My Custom Name' })
    primeTurn([
      assistantLine('ok', { input_tokens: 5, output_tokens: 5 }),
      resultLine({ session_id: 's', total_cost_usd: 0.01, num_turns: 1, model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 5 } }),
    ])

    await mgr.sendMessage(conv.id, 'hello')
    await new Promise((r) => setImmediate(r))

    expect(getAgentConversation(db, conv.id)?.title).toBe('My Custom Name')
    // Only the main turn spawned — the AI title gate skipped the second spawn.
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
  })

  it('does NOT fire on turns after the first', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    // Seed a prior completed exchange so this send is NOT the first turn.
    addAgentMessage(db, { conversationId: conv.id, role: 'user', content: 'old' })
    addAgentMessage(db, { conversationId: conv.id, role: 'assistant', content: 'old reply' })
    primeTurn([
      assistantLine('second reply', { input_tokens: 5, output_tokens: 5 }),
      resultLine({ session_id: 's', total_cost_usd: 0.01, num_turns: 1, model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 5 } }),
    ])

    await mgr.sendMessage(conv.id, 'new')
    await new Promise((r) => setImmediate(r))

    // assistantCount === 2 → gate skips the AI title, only the main turn spawned.
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
  })

  it('shutdown suppresses a late AI-title close callback and its DB writes', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    const mainChild = createMockChildProcess()
    const titleChild = createMockChildProcess()
    titleChild.pid = 51999
    vi.mocked(mockSpawn)
      .mockReturnValueOnce(mainChild)
      .mockReturnValueOnce(titleChild)

    const turn = mgr.sendMessage(conv.id, 'build a tiny calendar')
    mainChild.stdout.push(assistantLine('Done.') + '\n')
    mainChild.stdout.push(resultLine({
      session_id: 'sess-title-shutdown',
      total_cost_usd: 0.02,
      model: 'claude-sonnet-4',
      usage: { input_tokens: 20, output_tokens: 10 },
    }) + '\n')
    mainChild.stdout.push(null)
    await new Promise<void>((resolve) => setImmediate(() => {
      mainChild.emit('close', 0)
      resolve()
    }))
    await turn
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    const titleBeforeShutdown = getAgentConversation(db, conv.id)?.title
    const rowsBeforeShutdown = rows().length

    await mgr.shutdown()
    expect(vi.mocked(treeKill)).toHaveBeenCalledWith(titleChild.pid, 'SIGTERM')
    const broadcastsAtShutdown = broadcast.mock.calls.length

    titleChild.emit('error', new Error('late title error'))
    titleChild.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(getAgentConversation(db, conv.id)?.title).toBe(titleBeforeShutdown)
    expect(rows()).toHaveLength(rowsBeforeShutdown)
    expect(broadcast.mock.calls).toHaveLength(broadcastsAtShutdown)
  })
})

describe('AgentChatManager lifecycle shutdown', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: AgentChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    _resetAgentCapabilitiesForTest()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new AgentChatManager(broadcast, db, 4200)
  })

  it('settles an in-flight turn, drops its queue, and blocks late auto-heal after shutdown', async () => {
    const conv = createAgentConversation(db, { provider: 'claude', pinnedProjectId: null })
    updateAgentConversation(db, conv.id, { session_id: 'stale-session' })
    const child = createMockChildProcess()
    child.pid = 51888
    vi.mocked(mockSpawn).mockImplementationOnce(() => child) // deliberately left open

    const first = mgr.sendMessage(conv.id, 'first')
    await waitFor(() => vi.mocked(mockSpawn).mock.calls.length === 1)
    await mgr.sendMessage(conv.id, 'queued', { queueId: 'q-after-shutdown' })
    expect(mgr.isBusy(conv.id)).toBe(true)

    vi.useFakeTimers()
    await mgr.shutdown()
    await mgr.shutdown() // idempotent: no duplicate signal/timer/listener ownership
    await expect(first).resolves.toBeUndefined()
    expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
    expect(vi.mocked(treeKill)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mockSpawn).mock.calls[0][2]).toMatchObject({ detached: true })
    // Root exits before grace; escalation must still target the detached group
    // where a resistant MCP descendant remains.
    child.emit('close', 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.mocked(process.kill)).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    vi.useRealTimers()
    expect(mgr.isBusy(conv.id)).toBe(false)
    expect(mgr.editQueued(conv.id, 'q-after-shutdown', 'edited')).toBe(false)
    expect(mgr.abort(conv.id)).toBe(false)
    const broadcastsAtShutdown = broadcast.mock.calls.length

    // A no-output resume would normally trigger the fresh-session auto-heal.
    // Its late close must not spawn again or drain the queued turn.
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls).toHaveLength(broadcastsAtShutdown)
    expect(listAgentMessages(db, conv.id).some((m) => m.content === 'queued')).toBe(false)

    await mgr.sendMessage(conv.id, 'after shutdown')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(listAgentMessages(db, conv.id).some((m) => m.content === 'after shutdown')).toBe(false)
  })
})

describe('sanitizeAgentTitle', () => {
  it('strips surrounding quotes', () => {
    expect(sanitizeAgentTitle('"Great Title"')).toBe('Great Title')
  })
  it('takes the first non-empty line', () => {
    expect(sanitizeAgentTitle('\n\nTitle Here\nextra prose the model leaked')).toBe('Title Here')
  })
  it('strips markdown emphasis and leading list markers', () => {
    expect(sanitizeAgentTitle('- **Bold Title**')).toBe('Bold Title')
  })
  it('collapses internal whitespace', () => {
    expect(sanitizeAgentTitle('A   B\tC')).toBe('A B C')
  })
  it('returns empty string for blank input', () => {
    expect(sanitizeAgentTitle('   \n  ')).toBe('')
  })
  it('caps length word-aware with an ellipsis', () => {
    const out = sanitizeAgentTitle('word '.repeat(30).trim())
    expect(out.length).toBeLessThanOrEqual(81)
    expect(out.endsWith('…')).toBe(true)
  })
})
