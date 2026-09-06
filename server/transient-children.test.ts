import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import {
  trackTransientChild, killTransientChildren, startBackgroundProcess, killBackgroundProcess,
  killOwnedBackgroundProcess, killBackgroundProcessesForChat, getBackgroundProcess,
  getBackgroundProcessLogs, listBackgroundProcesses, awaitBackgroundProcessesStopped,
  BACKGROUND_LOG_RETENTION_MS,
} from './transient-children'
import { beginProjectProcessQuiescence, resetProcessAdmissionForTests } from './process-admission'
import treeKill from 'tree-kill'
import { spawn } from 'child_process'
import { spawnWindowsBackgroundBootstrap } from './background-windows-bootstrap'

vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('./background-process-control', () => ({ createBackgroundProcessControl: (child: any) => child.control }))
vi.mock('./util/win-spawn', () => ({ windowsSpawnEnv: () => ({}), treeKillSafe: (...args: Parameters<typeof treeKill>) => treeKill(...args) }))
vi.mock('./background-windows-bootstrap', () => ({ spawnWindowsBackgroundBootstrap: vi.fn() }))

const children: any[] = []
function fakeChild(pid: number | undefined): any {
  const child = new EventEmitter() as any
  child.pid = pid; child.alive = true
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.control = { isAlive: vi.fn(async () => child.alive), terminate: vi.fn(async () => {}) }
  children.push(child)
  return child
}
async function closeChild(child: any, code: number | null = 0, signal: string | null = null): Promise<void> {
  child.alive = false
  child.emit('close', code, signal)
  await vi.advanceTimersByTimeAsync(0)
}
function start(pid = 444, hooks = {}, chatId = 'chat-1', projectId = 'proj-1') {
  const child = fakeChild(pid)
  vi.mocked(spawn).mockReturnValue(child)
  const process = startBackgroundProcess('npm run dev', '/repo', chatId, projectId, hooks, { repositoryId: 'frontend', repositoryName: 'Frontend' })
  return { child, process }
}

describe('transient children and background apps', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(treeKill).mockClear(); vi.mocked(spawn).mockReset() })
  afterEach(async () => {
    for (const child of children.splice(0)) { child.alive = false; child.emit('close', 0, null); child.stdout.destroy(); child.stderr.destroy() }
    await vi.advanceTimersByTimeAsync(BACKGROUND_LOG_RETENTION_MS + 1)
    vi.useRealTimers(); vi.restoreAllMocks(); resetProcessAdmissionForTests()
  })

  it('closes project admission before spawning and terminates a late registered provider child', () => {
    beginProjectProcessQuiescence('closed')
    expect(() => startBackgroundProcess('npm run dev', '/repo', 'chat', 'closed')).toThrow(/closed for project/)
    expect(spawn).not.toHaveBeenCalled()
    expect(() => trackTransientChild('closed', fakeChild(1099))).toThrow(/closed for project/)
    expect(treeKill).toHaveBeenCalledWith(1099, 'SIGTERM', expect.any(Function))
  })

  it('admits a Windows shell only after its root identity is captured', async () => {
    const child = fakeChild(55111)
    let ready!: () => void
    child.control.ready = new Promise<void>(resolve => { ready = resolve })
    let launched = false
    const bootstrap = { child, hasLaunched: () => launched, start: vi.fn(() => { launched = true }), cancel: vi.fn() }
    vi.mocked(spawnWindowsBackgroundBootstrap).mockReturnValue(bootstrap)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const onUpdated = vi.fn()
    const app = startBackgroundProcess('fixture', '/repo', 'windows-admit', 'project', { onUpdated })
    expect(app.status).toBe('starting')
    expect(bootstrap.start).not.toHaveBeenCalled()
    ready(); await vi.advanceTimersByTimeAsync(0)
    expect(bootstrap.start).toHaveBeenCalledOnce()
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    await closeChild(child, 7)
    expect(getBackgroundProcess(app.pid)?.status).toBe('failed')
    expect(getBackgroundProcess(app.pid)?.exitCode).toBe(7)
  })

  it('marks forced kernel containment cleanup as failed even if the supervisor exit code looks successful', async () => {
    const { child, process: app } = start(55113)
    child.control.terminalFailure = () => 'The job supervisor failed; Windows force-terminated its job.'
    await closeChild(child, 0)
    expect(getBackgroundProcess(app.pid)).toMatchObject({ status: 'failed', error: expect.stringContaining('supervisor failed') })
  })

  it.each(['stop', 'discovery-error'])('does not run a Windows command after %s during startup and settles on bootstrap close', async reason => {
    const child = fakeChild(55112)
    let ready!: () => void, reject!: (error: Error) => void
    child.control.ready = new Promise<void>((resolve, fail) => { ready = resolve; reject = fail })
    const bootstrap = { child, hasLaunched: () => false, start: vi.fn(), cancel: vi.fn(() => {
      child.alive = false
      queueMicrotask(() => child.emit('close', 125, null))
    }) }
    vi.mocked(spawnWindowsBackgroundBootstrap).mockReturnValue(bootstrap)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const app = startBackgroundProcess('must not execute', '/repo', 'windows-cancel', 'project')
    child.control.isAlive.mockRejectedValue(new Error('identity unavailable'))
    if (reason === 'stop') {
      expect(killOwnedBackgroundProcess(app.pid, { processId: app.processId, projectId: app.projectId, chatId: app.chatId })).toBe(true)
      ready()
    } else reject(new Error('identity unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bootstrap.start).not.toHaveBeenCalled()
    expect(getBackgroundProcess(app.pid)?.status).toBe(reason === 'stop' ? 'killed' : 'failed')
  })

  it('cleans up generic provider children, removes closed children and skips unknown projects/missing pids', () => {
    const a = fakeChild(111), b = fakeChild(222), closed = fakeChild(333)
    for (const child of [a, b, closed, fakeChild(undefined)]) trackTransientChild('project', child)
    closed.emit('close')
    killTransientChildren('project')
    expect(treeKill).toHaveBeenCalledTimes(2)
    expect(treeKill).toHaveBeenCalledWith(111, 'SIGTERM', expect.any(Function))
    expect(treeKill).toHaveBeenCalledWith(222, 'SIGTERM', expect.any(Function))
    vi.mocked(treeKill).mockClear()
    killTransientChildren('project'); killTransientChildren('unknown')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('starts with stable identity and repository metadata, retaining terminal output for inspection', async () => {
    const onStarted = vi.fn(), onOutput = vi.fn(), onExited = vi.fn()
    const { child, process } = start(444, { onStarted, onOutput, onExited })
    expect(spawn).toHaveBeenCalledWith('npm run dev', { cwd: '/repo', shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(process).toMatchObject({ processId: expect.any(String), pid: 444, status: 'running', repositoryId: 'frontend', repositoryName: 'Frontend' })
    expect(onStarted).toHaveBeenCalledWith(process)
    child.stdout.write('ready\n'); child.stderr.write('warn\n')
    expect(onOutput.mock.calls.map(([line]) => [line.sequence, line.line, line.partial])).toEqual([[1, 'ready', false], [2, 'warn', false]])
    await closeChild(child)
    expect(onExited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pid: 444, status: 'exited', exitCode: 0, endedAt: expect.any(Number) }))
    expect(getBackgroundProcessLogs(444, { processId: process.processId })).toMatchObject({ nextSequence: 2, truncated: false, lines: [{ line: 'ready' }, { line: 'warn' }] })
    expect(listBackgroundProcesses()).toEqual([])
    expect(listBackgroundProcesses({ includeFinished: true })).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(BACKGROUND_LOG_RETENTION_MS)
    expect(getBackgroundProcess(444)).toBeNull()
  })

  it('keeps a partial UTF-8 line visible, updates its identity, strips chunked ANSI and handles CR progress', async () => {
    const { child } = start()
    const bytes = Buffer.from('café 🚀')
    child.stdout.write(bytes.subarray(0, bytes.length - 2))
    expect(getBackgroundProcessLogs(444)?.lines).toMatchObject([{ sequence: 1, line: 'café ', partial: true }])
    child.stdout.write(bytes.subarray(bytes.length - 2))
    child.stdout.write('\u001b['); child.stdout.write('31m red\u001b[0m\u001b]8;;https://secret.invalid'); child.stdout.write('\u001b\\link\u001b]8;;\u0007\n')
    expect(getBackgroundProcessLogs(444)?.lines[0]).toMatchObject({ sequence: 1, line: 'café 🚀 redlink', partial: false })
    child.stderr.write('10%\r'); child.stderr.write('20%\r'); child.stderr.write('\n')
    child.stdout.write('tail without newline')
    expect(getBackgroundProcessLogs(444)?.lines).toMatchObject([{ sequence: 1 }, { sequence: 2, line: '20%', partial: false }, { sequence: 3, line: 'tail without newline', partial: true }])
    await closeChild(child)
    expect(getBackgroundProcessLogs(444)?.lines[2].partial).toBe(false)
  })

  it('bounds memory before a newline and records ordered stdout/stderr tails despite notification throttling', async () => {
    const onOutput = vi.fn(), { child } = start(445, { onOutput })
    for (let index = 0; index < 2005; index++) child.stdout.write(`line-${index}\n`)
    child.stderr.write('x'.repeat(2_000_000))
    const logs = getBackgroundProcessLogs(445, { limit: 3 })!
    expect(logs).toMatchObject({ maxLines: 2000, maxLineChars: 4000, nextSequence: 2006, truncated: true, droppedLines: 2003 })
    expect(logs.lines.map(line => [line.sequence, line.line])).toEqual([[2004, 'line-2003'], [2005, 'line-2004'], [2006, `${'x'.repeat(3999)}…`]])
    expect(logs.lines[2].partial).toBe(true)
    expect(onOutput).toHaveBeenCalledTimes(20)
    expect(getBackgroundProcessLogs(445)?.lines).toHaveLength(2000)
    expect(getBackgroundProcessLogs(445, { projectId: 'wrong' })).toBeNull()
    expect(getBackgroundProcessLogs(445, { chatId: 'wrong' })).toBeNull()
    await closeChild(child, 1)
    expect(getBackgroundProcess(445)?.status).toBe('failed')
  })

  it('reports stopping immediately but waits for both group disappearance and stream close', async () => {
    const onUpdated = vi.fn(), onExited = vi.fn(), { child, process } = start(555, { onUpdated, onExited })
    expect(killOwnedBackgroundProcess(555, { projectId: 'wrong', chatId: 'chat-1', processId: process.processId })).toBe(false)
    expect(killOwnedBackgroundProcess(555, { projectId: 'proj-1', chatId: 'chat-1', processId: 'wrong' })).toBe(false)
    expect(child.control.terminate).not.toHaveBeenCalled()
    expect(killOwnedBackgroundProcess(555, { projectId: 'proj-1', chatId: 'chat-1', processId: process.processId })).toBe(true)
    expect(getBackgroundProcess(555)).toMatchObject({ status: 'stopping', stopRequestedAt: expect.any(Number) })
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'stopping' }))
    expect(onExited).not.toHaveBeenCalled()
    expect(listBackgroundProcesses()).toMatchObject([{ status: 'stopping' }])
    child.alive = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(onExited).not.toHaveBeenCalled()
    await closeChild(child, null, 'SIGTERM')
    expect(getBackgroundProcess(555)?.status).toBe('killed')
    expect(onExited).toHaveBeenCalledOnce()
  })

  it('escalates against the still-owned group even when the shell has already closed', async () => {
    const onExited = vi.fn(), { child } = start(666, { onExited })
    killTransientChildren('proj-1')
    child.emit('close', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(2499)
    expect(child.control.terminate.mock.calls).toEqual([['SIGTERM']])
    expect(getBackgroundProcess(666)?.status).toBe('stopping')
    expect(onExited).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.control.terminate.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    child.alive = false
    await vi.advanceTimersByTimeAsync(100)
    expect(getBackgroundProcess(666)?.status).toBe('killed')
    expect(onExited).toHaveBeenCalledOnce()
  })

  it.each([0, 1])('cleans up descendants after natural wrapper exit %s while preserving its outcome', async code => {
    const { child } = start()
    child.emit('close', code, null)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getBackgroundProcess(444)?.status).toBe('stopping')
    expect(child.control.terminate).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    child.alive = false
    await vi.advanceTimersByTimeAsync(100)
    expect(getBackgroundProcess(444)?.status).toBe(code === 0 ? 'exited' : 'failed')
  })

  it('does not reset the grace period on repeated stop requests and permits safe terminal retries', async () => {
    const { child, process } = start()
    killBackgroundProcess(444)
    await vi.advanceTimersByTimeAsync(2000)
    killBackgroundProcess(444); killBackgroundProcessesForChat('chat-1'); killTransientChildren('proj-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(child.control.terminate.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    await closeChild(child, null, 'SIGKILL')
    expect(killOwnedBackgroundProcess(444, { projectId: 'proj-1', chatId: 'chat-1', processId: process.processId })).toBe(true)
    expect(child.control.terminate).toHaveBeenCalledTimes(2)
    expect(killBackgroundProcess(9999)).toBeUndefined()
  })

  it('surfaces signal failures without claiming exit and allows an explicit retry', async () => {
    const onUpdated = vi.fn(), onExited = vi.fn(), { child } = start(779, { onUpdated, onExited })
    child.control.terminate.mockRejectedValueOnce(new Error('Access denied'))
    killBackgroundProcess(779)
    await vi.advanceTimersByTimeAsync(0)
    expect(getBackgroundProcess(779)).toMatchObject({ status: 'stopping', error: 'Access denied' })
    expect(onUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'Access denied' }))
    expect(onExited).not.toHaveBeenCalled()
    child.emit('error', new Error('Child process error'))
    expect(getBackgroundProcess(779)?.status).toBe('stopping')
    killBackgroundProcess(779)
    expect(child.control.terminate).toHaveBeenCalledTimes(2)
    expect(getBackgroundProcess(779)?.error).toBeUndefined()
    await closeChild(child, null, 'SIGTERM')
    expect(onExited).toHaveBeenCalledOnce()
  })

  it('exposes failed exit verification and a force-stop deadline while retaining ownership for retry', async () => {
    const { child } = start()
    child.control.isAlive.mockRejectedValueOnce(new Error('Cannot inspect group'))
    killBackgroundProcess(444)
    await vi.advanceTimersByTimeAsync(0)
    expect(getBackgroundProcess(444)).toMatchObject({ status: 'stopping', error: 'Cannot inspect group' })
    await vi.advanceTimersByTimeAsync(5100)
    expect(getBackgroundProcess(444)).toMatchObject({ status: 'stopping', error: expect.stringContaining('has not stopped') })
    killBackgroundProcess(444)
    expect(child.control.terminate.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGTERM']])
    await closeChild(child, null, 'SIGTERM')
  })

  it('isolates old timers, retained logs and stop requests when an OS pid is reused', async () => {
    const first = start(777)
    first.child.stdout.write('old output\n')
    killBackgroundProcess(777, first.process.processId)
    const second = start(777)
    expect(second.process.processId).not.toBe(first.process.processId)
    first.child.emit('close', null, 'SIGTERM')
    killBackgroundProcess(777, first.process.processId)
    expect(killOwnedBackgroundProcess(777, { projectId: 'proj-1', chatId: 'chat-1', processId: first.process.processId })).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(second.child.control.terminate).not.toHaveBeenCalled()
    expect(getBackgroundProcess(777, second.process.processId)?.status).toBe('running')
    expect(getBackgroundProcessLogs(777, { processId: first.process.processId })?.lines[0].line).toBe('old output')
    expect(getBackgroundProcessLogs(777, { processId: second.process.processId })?.lines).toEqual([])
    expect(getBackgroundProcessLogs(888, { processId: first.process.processId })).toBeNull()
  })

  it('stops only apps owned by a requested chat and project', async () => {
    const a = start(880, {}, 'chat-z', 'proj-1'), b = start(881, {}, 'other', 'proj-1'), c = start(882, {}, 'chat-z', 'proj-2')
    expect(killBackgroundProcessesForChat('chat-z', 'proj-1')).toBe(1)
    expect(a.child.control.terminate).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(b.child.control.terminate).not.toHaveBeenCalled()
    expect(c.child.control.terminate).not.toHaveBeenCalled()
    expect(listBackgroundProcesses({ projectId: 'proj-1', chatId: 'chat-z' })).toMatchObject([{ pid: 880, status: 'stopping' }])
  })

  it('bounds finished retention to 32 records and returns detached snapshot copies', async () => {
    for (let index = 0; index < 34; index++) {
      const { child } = start(1000 + index)
      child.stdout.write(`${index}\n`)
      await closeChild(child)
    }
    expect(listBackgroundProcesses({ includeFinished: true })).toHaveLength(32)
    expect(getBackgroundProcess(1000)).toBeNull()
    const copy = getBackgroundProcessLogs(1033)!
    copy.lines[0].line = 'mutated'; copy.process.command = 'mutated'
    expect(getBackgroundProcessLogs(1033)?.lines[0].line).toBe('33')
    expect(getBackgroundProcess(1033)?.command).toBe('npm run dev')
  })

  it('drains confirmed stops and returns unresolved apps on a bounded shutdown timeout', async () => {
    const first = start(900)
    const draining = awaitBackgroundProcessesStopped(6000)
    await vi.advanceTimersByTimeAsync(2500)
    expect(first.child.control.terminate.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    await closeChild(first.child, null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(50)
    expect(await draining).toEqual([])
    const second = start(901)
    const deadline = awaitBackgroundProcessesStopped(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await deadline).toMatchObject([{ pid: 901, processId: second.process.processId, status: 'stopping' }])
  })

  it('handles asynchronous spawn errors with no pid and isolates throwing observer hooks', async () => {
    const missing = fakeChild(undefined)
    vi.mocked(spawn).mockReturnValue(missing)
    expect(() => startBackgroundProcess('missing', '/missing', 'chat', 'project')).toThrow('failed to start')
    expect(() => missing.emit('error', new Error('ENOENT'))).not.toThrow()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fail = () => { throw new Error('observer failed') }
    const { child } = start(902, { onStarted: fail, onOutput: fail, onUpdated: fail, onExited: fail })
    expect(() => child.stdout.write('ready\n')).not.toThrow()
    expect(() => killBackgroundProcess(902)).not.toThrow()
    await closeChild(child)
    expect(getBackgroundProcess(902)?.status).toBe('killed')
  })

  it('honors the shutdown deadline even while an OS identity query is still pending', async () => {
    const { child } = start(903)
    let finishProbe!: (alive: boolean) => void
    child.control.isAlive.mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve }))
    const draining = awaitBackgroundProcessesStopped(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await draining).toMatchObject([{ pid: 903, status: 'stopping' }])
    finishProbe(false)
    await closeChild(child, null, 'SIGTERM')
    expect(getBackgroundProcess(903)?.status).toBe('killed')
  })
})
