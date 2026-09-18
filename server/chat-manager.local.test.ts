// Explore / sidebar turns on a LOCAL (OpenAI-compatible) engine spawn the
// bundled runner through the adapter with the scope-derived tool flags.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./user-mcp-config', () => ({ buildUserMcpArgs: vi.fn(() => []) }))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import { ChatManager } from './chat-manager'
import { __resetBinaryProbeCacheForTest } from './binary-probe'
import { initDb, createConversation, getConversation, type DbInstance } from './db'
import { syncLocalAdapters } from './providers/local-adapter-registry'
import { unregisterAdapter } from './providers/registry'
import './providers'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 42000
  child.kill = vi.fn()
  return child
}
const pushLine = (child: any, line: string) => child.stdout.push(line + '\n')
const finishProcess = (child: any, code: number) => new Promise<void>((resolve) => {
  child.stdout.push(null)
  setImmediate(() => { child.emit('close', code); resolve() })
})

describe('ChatManager on a local engine', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    __resetBinaryProbeCacheForTest()
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/node'))
    db = initDb(':memory:')
    broadcast = vi.fn()
    syncLocalAdapters([{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LOCAL_KEY' }])
  })
  afterEach(() => { unregisterAdapter('local'); vi.restoreAllMocks() })

  it('Explore turn: runner argv with read-only tools, system prompt, then --resume on the second turn', async () => {
    const cm = new ChatManager(broadcast, db, undefined, 'Acme', 'claude', 'p1', 'acme')
    createConversation(db, { id: 'exp-local', model: 'qwen3.5-9b:latest', kind: 'explore', provider: 'local', contextScope: { specrails: false, openspec: false, full: true, mcp: false, contractRefine: false } })
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)
    const first = cm.sendMessage('exp-local', 'Explore this', { lightweight: true })
    pushLine(child, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    pushLine(child, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } }))
    pushLine(child, JSON.stringify({ type: 'result', session_id: 'sess-1', usage: { input_tokens: 10, output_tokens: 2 } }))
    await finishProcess(child, 0); await first

    const [bin, args] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[]]
    expect(['node', bin.replace(/\\/g, '/').split('/').pop()]).toContain('node')
    expect(args[0]).toMatch(/specrails-local-runner\.js$/)
    expect(args).toEqual(expect.arrayContaining(['--model', 'qwen3.5-9b:latest', '--base-url', 'http://127.0.0.1:8080/v1', '--api-key-env', 'LOCAL_KEY', '--output-format', 'stream-json', '--system-prompt']))
    // Scope-derived read-only tier reaches the runner; claude-only flags never do.
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob'])
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--setting-sources')
    expect(args).not.toContain('--permission-mode')
    expect(args[args.indexOf('-p') + 1]).toBe('Explore this')
    expect(getConversation(db, 'exp-local')?.session_id).toBe('sess-1')
    const done = broadcast.mock.calls.map((c) => c[0]).find((m) => m.type === 'chat_done')
    expect(done).toBeTruthy()

    // Second turn resumes the session the runner reported.
    const child2 = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child2 as any)
    const second = cm.sendMessage('exp-local', 'And then?', { lightweight: true })
    pushLine(child2, JSON.stringify({ type: 'result', session_id: 'sess-1' }))
    await finishProcess(child2, 0); await second
    const args2 = vi.mocked(mockSpawn).mock.calls[1][1] as string[]
    expect(args2.slice(args2.indexOf('--resume'), args2.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-1'])
  })

  it('Quick-scope (not full) Explore disables every tool with the __none__ sentinel', async () => {
    const cm = new ChatManager(broadcast, db, undefined, 'Acme', 'claude', 'p1', 'acme')
    createConversation(db, { id: 'exp-none', model: 'qwen', kind: 'explore', provider: 'local', contextScope: { specrails: false, openspec: false, full: false, mcp: false, contractRefine: false } })
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)
    const p = cm.sendMessage('exp-none', 'hi', { lightweight: true })
    pushLine(child, JSON.stringify({ type: 'result', session_id: 's' }))
    await finishProcess(child, 0); await p
    const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '__none__'])
  })
})
