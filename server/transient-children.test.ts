import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import {
  trackTransientChild,
  killTransientChildren,
  startBackgroundProcess,
  killBackgroundProcess,
  killOwnedBackgroundProcess,
  getBackgroundProcess,
} from './transient-children'

vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
import treeKill from 'tree-kill'
import { spawn } from 'child_process'

function fakeChild(pid: number | undefined): any {
  const ee = new EventEmitter() as any
  ee.pid = pid
  ee.stdout = new PassThrough()
  ee.stderr = new PassThrough()
  return ee
}

describe('transient-children', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(treeKill).mockClear()
    vi.mocked(spawn).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tree-kills tracked children on killTransientChildren', () => {
    const c1 = fakeChild(111)
    const c2 = fakeChild(222)
    trackTransientChild('p1', c1)
    trackTransientChild('p1', c2)
    killTransientChildren('p1')
    expect(treeKill).toHaveBeenCalledWith(111, 'SIGTERM', expect.any(Function))
    expect(treeKill).toHaveBeenCalledWith(222, 'SIGTERM', expect.any(Function))
    // forgotten after kill — a second call kills nothing new
    ;(treeKill as any).mockClear()
    killTransientChildren('p1')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('auto-unregisters a child on close so it is not killed later', () => {
    const c = fakeChild(333)
    trackTransientChild('p2', c)
    c.emit('close')
    ;(treeKill as any).mockClear()
    killTransientChildren('p2')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('killing an unknown project is a no-op', () => {
    ;(treeKill as any).mockClear()
    killTransientChildren('nope')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('skips a child with no pid', () => {
    const c = fakeChild(undefined)
    trackTransientChild('p3', c)
    ;(treeKill as any).mockClear()
    killTransientChildren('p3')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('starts a background child, emits lifecycle hooks, and removes it on close', async () => {
    const child = fakeChild(444)
    vi.mocked(spawn).mockReturnValue(child)
    const started = vi.fn()
    const output = vi.fn()
    const exited = vi.fn()

    const proc = startBackgroundProcess(
      'npm run dev',
      '/repo',
      'chat-1',
      'proj-1',
      { onStarted: started, onOutput: output, onExited: exited },
    )

    expect(spawn).toHaveBeenCalledWith('npm run dev', {
      cwd: '/repo',
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(proc).toMatchObject({
      pid: 444,
      command: 'npm run dev',
      cwd: '/repo',
      status: 'running',
      chatId: 'chat-1',
      projectId: 'proj-1',
    })
    expect(typeof proc.startedAt).toBe('number')
    expect(started).toHaveBeenCalledWith(proc)

    child.stdout.write('ready\n')
    child.stderr.write('warn\n')
    await Promise.resolve()
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      pid: 444,
      chatId: 'chat-1',
      projectId: 'proj-1',
      source: 'stdout',
      line: 'ready',
    }))
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      pid: 444,
      source: 'stderr',
      line: 'warn',
    }))

    child.emit('close', 0, null)
    expect(exited).toHaveBeenCalledWith(expect.objectContaining({ pid: 444, status: 'exited', exitCode: 0 }))
    expect(getBackgroundProcess(444)).toBeNull()
  })

  it('kills only owned registered background processes and project cleanup kills the same registry', () => {
    const child = fakeChild(555)
    vi.mocked(spawn).mockReturnValue(child)
    startBackgroundProcess('npm run dev', '/repo', 'chat-1', 'proj-1')

    expect(killBackgroundProcess(999)).toBeUndefined()
    expect(treeKill).not.toHaveBeenCalled()
    expect(killOwnedBackgroundProcess(555, { projectId: 'wrong', chatId: 'chat-1' })).toBe(false)
    expect(treeKill).not.toHaveBeenCalled()
    expect(killOwnedBackgroundProcess(555, { projectId: 'proj-1', chatId: 'chat-1' })).toBe(true)
    expect(treeKill).toHaveBeenCalledWith(555, 'SIGTERM', expect.any(Function))

    vi.advanceTimersByTime(2500)
    expect(treeKill).toHaveBeenCalledWith(555, 'SIGKILL', expect.any(Function))

    const other = fakeChild(666)
    vi.mocked(spawn).mockReturnValue(other)
    startBackgroundProcess('npm run watch', '/repo', 'chat-2', 'proj-2')
    vi.mocked(treeKill).mockClear()
    killTransientChildren('proj-2')
    expect(treeKill).toHaveBeenCalledWith(666, 'SIGTERM', expect.any(Function))
    expect(getBackgroundProcess(666)).toBeNull()
  })
})
