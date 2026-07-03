import { describe, it, expect, beforeEach, vi } from 'vitest'
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

// The agent turn's peripheral wiring (cwd materialisation, MCP config, active
// project) is out of scope for cost accounting — stub it so the test touches no
// real filesystem / ~/.specrails.
vi.mock('./agent-cwd-manager', () => ({ ensureAgentCwd: () => '/tmp/agent-cwd-test' }))
vi.mock('./agent-mcp-config', () => ({ prepareAgentMcp: () => ({ extraArgs: [], env: {} }) }))
vi.mock('./mcp/tools/types', () => ({ setActiveProject: vi.fn() }))
vi.mock('./attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: vi.fn(async () => ({ textBlocks: [], imagePaths: [] })) },
  USER_ATTACHMENT_SYSTEM_NOTE: 'note',
}))

import { spawn as mockSpawn } from 'child_process'
import { AgentChatManager } from './agent-chat-manager'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation } from './agent-store'
import type { DbInstance } from './db'

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
})
