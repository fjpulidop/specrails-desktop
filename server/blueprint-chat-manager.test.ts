import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing anything that spawns (mirrors
// agent-chat-manager.test.ts — spawnCli calls child_process.spawn on POSIX).
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./builder-cwd-manager', () => ({
  ensureBuilderCwd: vi.fn(() => '/tmp/builder-cwd-test'),
}))

import { spawn as mockSpawn } from 'child_process'
import treeKill from 'tree-kill'
import { BlueprintChatManager } from './blueprint-chat-manager'
import { initDesktopDb } from './desktop-db'
import {
  createBlueprintConversation,
  getBlueprintConversation,
  listBlueprintMessages,
  updateBlueprintConversation,
} from './blueprint-store'
import type { DbInstance } from './db'

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
  child.pid = 52000
  child.kill = vi.fn()
  return child
}

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

const SNAPSHOT = {
  blueprintVersion: 1,
  product: { name: 'Recipely', pitch: 'p', audience: 'a' },
  coreFlow: 'flow',
  platform: 'web',
  stack: { language: 'ts', framework: 'next', db: 'sqlite' },
  assumptions: [],
  milestones: [],
  m1Specs: [],
}

describe('BlueprintChatManager', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: BlueprintChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new BlueprintChatManager(broadcast, db)
  })

  function invocationRows() {
    return db.prepare('SELECT * FROM agent_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
  }

  it('streams deltas, strips the blueprint block, persists messages and broadcasts the snapshot', async () => {
    const conv = createBlueprintConversation(db)
    const fenced = '```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'
    primeTurn([
      assistantLine('Here is the plan.\n' + fenced, { input_tokens: 10, output_tokens: 5 }),
      resultLine({ session_id: 'sess-1', total_cost_usd: 0.01 }),
    ])

    await mgr.sendMessage(conv.id, 'an app for recipes')

    const streams = broadcastsOfType(broadcast, 'blueprint.stream')
    expect(streams.length).toBeGreaterThan(0)
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].fullText).not.toContain('blueprint-draft')
    expect((done[0].blueprint as { product: { name: string } }).product.name).toBe('Recipely')
    expect((done[0].rawBlueprint as { product: { name: string } }).product.name).toBe('Recipely')

    const messages = listBlueprintMessages(db, conv.id)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toBe('Here is the plan.')

    const fresh = getBlueprintConversation(db, conv.id)
    expect(fresh?.session_id).toBe('sess-1')
    // deterministic auto-title from the first user prompt
    expect(fresh?.title).toBeTruthy()

    const rows = invocationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].project_id).toBeNull()
    expect(rows[0].status).toBe('success')
  })

  it('forwards a valid effort to the provider spawn and drops an invalid one', async () => {
    const valid = createBlueprintConversation(db)
    primeTurn([assistantLine('High-effort answer'), resultLine({ session_id: 'effort-session' })])
    await mgr.sendMessage(valid.id, 'think carefully', { reasoningEffort: 'high' })

    const validArgs = vi.mocked(mockSpawn).mock.calls[0]?.[1] as string[]
    const effortIndex = validArgs.indexOf('--effort')
    expect(effortIndex).toBeGreaterThanOrEqual(0)
    expect(validArgs[effortIndex + 1]).toBe('high')

    const invalid = createBlueprintConversation(db)
    primeTurn([assistantLine('Default-effort answer'), resultLine({ session_id: 'default-session' })])
    await mgr.sendMessage(invalid.id, 'ignore invalid effort', { reasoningEffort: 'turbo' })

    const invalidArgs = vi.mocked(mockSpawn).mock.calls[1]?.[1] as string[]
    expect(invalidArgs).not.toContain('--effort')
  })

  it('rejects Kimi before persistence or spawn when no pure-output policy exists', async () => {
    const conv = createBlueprintConversation(db, { provider: 'kimi', model: 'k3' })
    await mgr.sendMessage(conv.id, 'first request')

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(listBlueprintMessages(db, conv.id)).toEqual([])
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toEqual([
      expect.objectContaining({
        error: 'provider_tool_policy_unsupported:kimi:pure-output',
      }),
    ])
  })

  it('unknown conversation emits blueprint.error', async () => {
    await mgr.sendMessage('nope', 'hi')
    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/Unknown conversation/)
  })

  it('spawn failure surfaces a launch error and records a failed row', async () => {
    const conv = createBlueprintConversation(db)
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => child.emit('error', new Error('ENOENT')))
      return child
    })

    await mgr.sendMessage(conv.id, 'hi')

    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/Failed to launch/)
    expect(invocationRows()[0].status).toBe('failed')
  })

  it('empty output surfaces the exit-code reason and resets the session', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: null })
    primeTurn([], 1)

    await mgr.sendMessage(conv.id, 'hi')

    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(invocationRows()[0].status).toBe('failed')
    expect(getBlueprintConversation(db, conv.id)?.session_id).toBeNull()
  })

  it('auto-heals a stale resume: no-text resume retries fresh once', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: 'stale-sess' })
    primeTurn([], 0) // resume yields nothing
    primeTurn([assistantLine('Fresh answer'), resultLine({ session_id: 'new-sess' })])

    await mgr.sendMessage(conv.id, 'hi')

    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].fullText).toBe('Fresh answer')
    expect(getBlueprintConversation(db, conv.id)?.session_id).toBe('new-sess')
    // one settled row for the turn (the retry outcome is what's recorded)
    expect(invocationRows()).toHaveLength(1)
    expect(invocationRows()[0].status).toBe('success')
  })

  it('abort mid-turn keeps partial text, records aborted, never errors', async () => {
    const conv = createBlueprintConversation(db)
    let child: any
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('Partial thought') + '\n')
        // abort while streaming, then the killed child closes
        setImmediate(() => {
          mgr.abort(conv.id)
          child.stdout.push(null)
          setImmediate(() => child.emit('close', null))
        })
      })
      return child
    })

    await mgr.sendMessage(conv.id, 'hi')

    expect(vi.mocked(treeKill)).toHaveBeenCalled()
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
    const rows = invocationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('aborted')
    const messages = listBlueprintMessages(db, conv.id)
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('Partial thought'))).toBe(true)
  })

  it('busy conversation rejects a second concurrent send with blueprint.error', async () => {
    const conv = createBlueprintConversation(db)
    let release: () => void = () => {}
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('working') + '\n')
        release = () => {
          child.stdout.push(null)
          setImmediate(() => child.emit('close', 0))
        }
      })
      return child
    })

    const first = mgr.sendMessage(conv.id, 'one')
    await new Promise((r) => setTimeout(r, 20))
    expect(mgr.isStreaming(conv.id)).toBe(true)
    await mgr.sendMessage(conv.id, 'two')
    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/already streaming/)
    release()
    await first
  })

  it('shutdown kills live children and gates further sends', async () => {
    const conv = createBlueprintConversation(db)
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('never settles') + '\n')
      })
      return child
    })
    const pending = mgr.sendMessage(conv.id, 'hi')
    await new Promise((r) => setTimeout(r, 20))
    mgr.shutdown()
    await pending
    expect(vi.mocked(treeKill)).toHaveBeenCalled()
    await mgr.sendMessage(conv.id, 'after shutdown') // no throw, no broadcast
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
  })
})
