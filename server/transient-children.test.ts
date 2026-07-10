import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import {
  trackTransientChild,
  killTransientChildren,
  startBackgroundProcess,
  killBackgroundProcess,
  killOwnedBackgroundProcess,
  killBackgroundProcessesForChat,
  getBackgroundProcess,
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  BACKGROUND_LOG_RETENTION_MS,
} from './transient-children'

vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
import treeKill from 'tree-kill'
import { spawn } from 'child_process'
import {
  beginProjectProcessQuiescence,
  resetProcessAdmissionForTests,
} from './process-admission'

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
    resetProcessAdmissionForTests()
  })

  it('rejects new project processes after teardown admission closes', () => {
    beginProjectProcessQuiescence('closed-project')

    expect(() => startBackgroundProcess(
      'npm run dev',
      '/repo',
      'chat-1',
      'closed-project',
    )).toThrow(/closed for project closed-project/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('kills a child that reaches registration after its project closed', () => {
    const child = fakeChild(1099)
    beginProjectProcessQuiescence('closed-project')

    expect(() => trackTransientChild('closed-project', child))
      .toThrow(/closed for project closed-project/)
    expect(treeKill).toHaveBeenCalledWith(1099, 'SIGTERM', expect.any(Function))
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

  it('starts a background child, emits lifecycle hooks, and retains terminal logs briefly', async () => {
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
    expect(getBackgroundProcess(444)).toMatchObject({ pid: 444, status: 'exited', exitCode: 0 })
    expect(getBackgroundProcessLogs(444)).toMatchObject({
      process: expect.objectContaining({ pid: 444, status: 'exited' }),
      lines: [
        expect.objectContaining({ source: 'stdout', line: 'ready' }),
        expect.objectContaining({ source: 'stderr', line: 'warn' }),
      ],
      truncated: false,
    })
    vi.advanceTimersByTime(BACKGROUND_LOG_RETENTION_MS)
    expect(getBackgroundProcess(444)).toBeNull()
  })

  it('captures a bounded stdout/stderr tail even without an output hook', async () => {
    const child = fakeChild(445)
    vi.mocked(spawn).mockReturnValue(child)
    startBackgroundProcess('npm run dev', '/repo', 'chat-1', 'proj-1')

    for (let i = 0; i < 505; i += 1) {
      child.stdout.write(`line-${i}\n`)
    }
    child.stderr.write(`${'x'.repeat(1100)}\n`)
    await Promise.resolve()
    child.emit('close', 1, null)

    const logs = getBackgroundProcessLogs(445, { projectId: 'proj-1', chatId: 'chat-1', limit: 3 })
    expect(logs?.process).toMatchObject({ pid: 445, status: 'failed', exitCode: 1 })
    expect(logs?.truncated).toBe(true)
    expect(logs?.droppedLines).toBeGreaterThan(0)
    expect(logs?.lines).toEqual([
      expect.objectContaining({ source: 'stdout', line: 'line-503' }),
      expect.objectContaining({ source: 'stdout', line: 'line-504' }),
      expect.objectContaining({ source: 'stderr', line: `${'x'.repeat(1000)}...` }),
    ])
    expect(getBackgroundProcessLogs(445, { projectId: 'wrong', chatId: 'chat-1' })).toBeNull()
    expect(getBackgroundProcessLogs(445, { projectId: 'proj-1', chatId: 'wrong' })).toBeNull()
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
    child.emit('close', null, 'SIGTERM')
    expect(getBackgroundProcess(555)).toMatchObject({ status: 'killed' })

    const other = fakeChild(666)
    vi.mocked(spawn).mockReturnValue(other)
    startBackgroundProcess('npm run watch', '/repo', 'chat-2', 'proj-2')
    vi.mocked(treeKill).mockClear()
    killTransientChildren('proj-2')
    expect(treeKill).toHaveBeenCalledWith(666, 'SIGTERM', expect.any(Function))
    expect(getBackgroundProcess(666)).toMatchObject({ status: 'killed' })
    vi.advanceTimersByTime(2500)
    expect(treeKill).toHaveBeenCalledWith(666, 'SIGKILL', expect.any(Function))
    other.emit('close', null, 'SIGTERM')
    expect(getBackgroundProcess(666)).toMatchObject({ status: 'killed' })
  })

  it('lists active background processes for browser refresh hydration', () => {
    const first = fakeChild(777)
    vi.mocked(spawn).mockReturnValue(first)
    startBackgroundProcess('npm run dev', '/repo', 'chat-1', 'proj-1')

    const second = fakeChild(778)
    vi.mocked(spawn).mockReturnValue(second)
    startBackgroundProcess('npm run watch', '/repo', 'chat-2', 'proj-1')

    expect(listBackgroundProcesses({ projectId: 'proj-1', chatId: 'chat-1' })).toEqual([
      expect.objectContaining({ pid: 777, command: 'npm run dev', status: 'running' }),
    ])

    killBackgroundProcess(777)
    expect(listBackgroundProcesses({ projectId: 'proj-1', chatId: 'chat-1' })).toEqual([])
    first.emit('close', null, 'SIGTERM')
    second.emit('close', 0, null)
  })

  it('preserves killed status if a child emits error after kill is requested', () => {
    const child = fakeChild(779)
    vi.mocked(spawn).mockReturnValue(child)
    const exited = vi.fn()
    startBackgroundProcess('npm run dev', '/repo', 'chat-1', 'proj-1', { onExited: exited })

    killBackgroundProcess(779)
    child.emit('error', new Error('process already exited'))

    expect(exited).toHaveBeenCalledWith(expect.objectContaining({ pid: 779, status: 'killed' }))
    expect(getBackgroundProcess(779)).toMatchObject({ status: 'killed' })
  })

  it('kills every background process owned by a deleted chat', () => {
    const first = fakeChild(880)
    vi.mocked(spawn).mockReturnValue(first)
    const firstExited = vi.fn()
    startBackgroundProcess('npm run dev', '/repo', 'chat-z', 'proj-1', { onExited: firstExited })

    const second = fakeChild(881)
    vi.mocked(spawn).mockReturnValue(second)
    startBackgroundProcess('npm run watch', '/repo', 'other-chat', 'proj-1')

    expect(killBackgroundProcessesForChat('chat-z')).toBe(1)
    expect(firstExited).toHaveBeenCalledWith(expect.objectContaining({ pid: 880, status: 'killed' }))
    expect(treeKill).toHaveBeenCalledWith(880, 'SIGTERM', expect.any(Function))
    expect(getBackgroundProcess(880)).toMatchObject({ status: 'killed' })
    expect(getBackgroundProcess(881)).toMatchObject({ status: 'running' })

    vi.advanceTimersByTime(2500)
    expect(treeKill).toHaveBeenCalledWith(880, 'SIGKILL', expect.any(Function))
    first.emit('close', null, 'SIGTERM')
    second.emit('close', 0, null)
  })
})
