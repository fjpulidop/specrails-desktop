import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

// tree-kill targets real OS pids; in tests the FakeChild pid is synthetic, so
// mock it to capture (pid, signal) calls without touching the host.
const treeKillCalls: Array<{ pid: number; signal?: string }> = []
vi.mock('tree-kill', () => ({
  default: (pid: number, signal?: string, cb?: (err?: Error) => void) => {
    treeKillCalls.push({ pid, signal })
    cb?.()
  },
}))

import {
  ExploreStdinSessions,
  frameStreamJsonUserMessage,
  isExplorePersistentStdinEnabled,
} from './explore-stdin-session'

class FakeChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  stdin: Writable & { written: string[]; destroyed: boolean }
  pid = 4321
  killed = false
  killSignals: string[] = []
  private _push: (s: string) => void
  constructor() {
    super()
    let pushFn: (s: string) => void = () => {}
    this.stdout = new Readable({ read() {} })
    this._push = (s: string) => this.stdout.push(s)
    void pushFn
    this.stderr = new Readable({ read() {} })
    const written: string[] = []
    const w = new Writable({
      write(chunk, _enc, cb) {
        written.push(chunk.toString())
        cb()
      },
    }) as Writable & { written: string[]; destroyed: boolean }
    w.written = written
    this.stdin = w
  }
  pushLine(obj: unknown) { this._push(JSON.stringify(obj) + '\n') }
  pushStderr(s: string) { this.stderr.push(s) }
  kill(sig?: string): boolean { this.killed = true; this.killSignals.push(sig ?? 'SIGTERM'); return true }
}

function fakeSpawn(child: FakeChild) {
  return ((_bin: string, _args: string[]) => child as unknown as ChildProcess) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']
}

afterEach(() => {
  delete process.env.SPECRAILS_EXPLORE_PERSISTENT_STDIN
  treeKillCalls.length = 0
  vi.useRealTimers()
})

describe('isExplorePersistentStdinEnabled', () => {
  it('is off by default and on only for exactly "1"', () => {
    delete process.env.SPECRAILS_EXPLORE_PERSISTENT_STDIN
    expect(isExplorePersistentStdinEnabled()).toBe(false)
    process.env.SPECRAILS_EXPLORE_PERSISTENT_STDIN = '0'
    expect(isExplorePersistentStdinEnabled()).toBe(false)
    process.env.SPECRAILS_EXPLORE_PERSISTENT_STDIN = 'true'
    expect(isExplorePersistentStdinEnabled()).toBe(false)
    process.env.SPECRAILS_EXPLORE_PERSISTENT_STDIN = '1'
    expect(isExplorePersistentStdinEnabled()).toBe(true)
  })
})

describe('frameStreamJsonUserMessage', () => {
  it('frames a newline-terminated stream-json user message', () => {
    const line = frameStreamJsonUserMessage('hello')
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.trim())).toEqual({ type: 'user', message: { role: 'user', content: 'hello' } })
  })
})

describe('ExploreStdinSessions', () => {
  it('spawns once then reuses the same child across turns', () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    const a = sessions.getOrSpawn('c1', { binary: 'claude', args: ['-p'], spawn: fakeSpawn(child) })
    expect(a.isNew).toBe(true)
    expect(sessions.size()).toBe(1)
    const b = sessions.getOrSpawn('c1', { binary: 'claude', args: ['-p'], spawn: fakeSpawn(new FakeChild()) })
    expect(b.isNew).toBe(false)
    expect(b.child).toBe(child) // same long-lived child
  })

  it('fans stdout lines to the current turn handler and frames stdin writes', async () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })

    const lines: string[] = []
    sessions.setHandlers('c1', { onLine: (l) => lines.push(l), onStderr: () => {}, onClose: () => {} })
    sessions.writeTurn('c1', 'hi there')
    expect(JSON.parse(child.stdin.written[0].trim())).toEqual({
      type: 'user', message: { role: 'user', content: 'hi there' },
    })

    child.pushLine({ type: 'assistant', text: 'x' })
    await new Promise((r) => setTimeout(r, 5))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).type).toBe('assistant')
  })

  it('clearHandlers drops lines received between turns', async () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    const lines: string[] = []
    sessions.setHandlers('c1', { onLine: (l) => lines.push(l), onStderr: () => {}, onClose: () => {} })
    sessions.clearHandlers('c1')
    child.pushLine({ type: 'assistant', text: 'ignored' })
    await new Promise((r) => setTimeout(r, 5))
    expect(lines).toHaveLength(0)
  })

  it('routes stderr to the current handler', async () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    const errs: string[] = []
    sessions.setHandlers('c1', { onLine: () => {}, onStderr: (s) => errs.push(s), onClose: () => {} })
    child.pushStderr('boom')
    await new Promise((r) => setTimeout(r, 5))
    expect(errs.join('')).toContain('boom')
  })

  it('evicts the session and notifies onClose when the child exits', async () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    let closedCode: number | null | undefined
    sessions.setHandlers('c1', { onLine: () => {}, onStderr: () => {}, onClose: (c) => { closedCode = c } })
    child.emit('close', 0)
    expect(closedCode).toBe(0)
    expect(sessions.has('c1')).toBe(false)
  })

  it('treats a spawn error event as a close with null code', () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    let closedCode: number | null | undefined = 999
    sessions.setHandlers('c1', { onLine: () => {}, onStderr: () => {}, onClose: (c) => { closedCode = c } })
    child.emit('error', new Error('ENOENT'))
    expect(closedCode).toBeNull()
    expect(sessions.has('c1')).toBe(false)
  })

  it('re-spawns after the child has exited', () => {
    const sessions = new ExploreStdinSessions()
    const c1 = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(c1) })
    c1.emit('close', 1)
    const c2 = new FakeChild()
    const r = sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(c2) })
    expect(r.isNew).toBe(true)
    expect(r.child).toBe(c2)
  })

  it('kill() tree-kills the child subtree with SIGTERM and forgets it; writeTurn then fails', () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    sessions.kill('c1')
    // BUG-CHAT-01: must treeKill(pid, 'SIGTERM') (whole subtree), NOT child.kill.
    expect(child.killed).toBe(false)
    expect(treeKillCalls).toEqual([{ pid: 4321, signal: 'SIGTERM' }])
    expect(sessions.has('c1')).toBe(false)
    expect(sessions.writeTurn('c1', 'x')).toBe(false)
  })

  it('kill() escalates to SIGKILL via treeKill if the child ignores SIGTERM', () => {
    vi.useFakeTimers()
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    sessions.kill('c1')
    expect(treeKillCalls).toEqual([{ pid: 4321, signal: 'SIGTERM' }])
    // Child never emits 'close' → after the 2s grace window SIGKILL fires.
    vi.advanceTimersByTime(2000)
    expect(treeKillCalls).toEqual([
      { pid: 4321, signal: 'SIGTERM' },
      { pid: 4321, signal: 'SIGKILL' },
    ])
  })

  it('kill() cancels the SIGKILL escalation once the child closes', () => {
    vi.useFakeTimers()
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    sessions.kill('c1')
    child.emit('close', 0) // child obeyed SIGTERM
    vi.advanceTimersByTime(5000)
    expect(treeKillCalls).toEqual([{ pid: 4321, signal: 'SIGTERM' }]) // no SIGKILL
  })

  it('killAll() tree-kills every session', () => {
    const sessions = new ExploreStdinSessions()
    const a = new FakeChild(); a.pid = 11
    const b = new FakeChild(); b.pid = 22
    sessions.getOrSpawn('a', { binary: 'claude', args: [], spawn: fakeSpawn(a) })
    sessions.getOrSpawn('b', { binary: 'claude', args: [], spawn: fakeSpawn(b) })
    sessions.killAll()
    expect(treeKillCalls.map((c) => c.pid).sort()).toEqual([11, 22])
    expect(treeKillCalls.every((c) => c.signal === 'SIGTERM')).toBe(true)
    expect(sessions.size()).toBe(0)
  })

  it('writeTurn returns false for an unknown conversation', () => {
    const sessions = new ExploreStdinSessions()
    expect(sessions.writeTurn('nope', 'x')).toBe(false)
  })

  it('an async stdin error routes to onClose(null) and is not unhandled (BUG-CHAT-06)', () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    let closedCode: number | null | undefined = 999
    sessions.setHandlers('c1', { onLine: () => {}, onStderr: () => {}, onClose: (c) => { closedCode = c } })
    // The 'error' listener must exist — emitting on an unhandled Writable would
    // otherwise throw and crash the process.
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(closedCode).toBeNull()
    expect(sessions.has('c1')).toBe(false)
  })

  it('writeTurn surfaces a delayed stdin write failure on the next turn (BUG-CHAT-06)', () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    sessions.getOrSpawn('c1', { binary: 'claude', args: [], spawn: fakeSpawn(child) })
    sessions.setHandlers('c1', { onLine: () => {}, onStderr: () => {}, onClose: () => {} })
    // First write enqueues fine; the buffered write then errors asynchronously.
    expect(sessions.writeTurn('c1', 'first')).toBe(true)
    child.stdin.emit('error', new Error('EPIPE'))
    // Session is evicted, so a subsequent write must fail rather than report success.
    expect(sessions.writeTurn('c1', 'second')).toBe(false)
  })

  it('setHandlers/clearHandlers/kill are no-ops for unknown ids', () => {
    const sessions = new ExploreStdinSessions()
    expect(() => sessions.setHandlers('nope', { onLine: () => {}, onStderr: () => {}, onClose: () => {} })).not.toThrow()
    expect(() => sessions.clearHandlers('nope')).not.toThrow()
    expect(() => sessions.kill('nope')).not.toThrow()
  })

  it('vi.fn spawn receives piped stdio', () => {
    const sessions = new ExploreStdinSessions()
    const child = new FakeChild()
    const spy = vi.fn(fakeSpawn(child))
    sessions.getOrSpawn('c1', { binary: 'claude', args: ['--x'], spawn: spy as never })
    expect(spy).toHaveBeenCalledWith('claude', ['--x'], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }))
  })
})
