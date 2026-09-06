import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { execFile } from 'child_process'
import { createBackgroundProcessControl } from './background-process-control'
import { treeKillSafe } from './util/win-spawn'

vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('./util/win-spawn', () => ({ treeKillSafe: vi.fn(), windowsSpawnEnv: () => ({ SystemRoot: 'C:\\Windows' }) }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const platform = (value: string) => Object.defineProperty(process, 'platform', { ...platformDescriptor, value })
const child = (pid: number) => Object.assign(new EventEmitter(), { pid }) as ChildProcess
const start = Date.parse('2026-09-05T22:00:00Z')
const identity = (pid: number, parentPid: number, offset = 0) => ({ pid, parentPid, createdAt: new Date(start + offset).toISOString() })
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

beforeEach(() => { vi.mocked(execFile).mockReset(); vi.mocked(treeKillSafe).mockReset() })
afterEach(async () => { await flush(); Object.defineProperty(process, 'platform', platformDescriptor); vi.restoreAllMocks() })

describe('owned background process OS control', () => {
  it('signals and probes the POSIX process group even after its original parent exits', async () => {
    platform('darwin')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const parent = child(42123), control = createBackgroundProcessControl(parent, start)
    expect(await control.isAlive()).toBe(true)
    await control.terminate('SIGTERM')
    parent.emit('exit', 0, null); parent.emit('close', 0, null)
    await control.terminate('SIGKILL')
    expect(kill.mock.calls).toEqual([[-42123, 0], [-42123, 'SIGTERM'], [-42123, 'SIGKILL']])
  })

  it('treats ESRCH as gone and exposes permission errors rather than claiming a successful stop', async () => {
    platform('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }) })
    const control = createBackgroundProcessControl(child(42123), start)
    expect(await control.isAlive()).toBe(false)
    await expect(control.terminate('SIGKILL')).resolves.toBeUndefined()
    kill.mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) })
    await expect(control.isAlive()).rejects.toThrow('permission denied')
    await expect(control.terminate('SIGTERM')).rejects.toThrow('permission denied')
  })

  it('shares Windows discovery across apps and force-stops only identified descendants after parent exit', async () => {
    platform('win32')
    const pending: Array<(error: Error | null, stdout: string) => void> = []
    vi.mocked(execFile).mockImplementation(((_binary: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => { pending.push(callback); return child(9000) }) as typeof execFile)
    const a = child(100), b = child(200)
    const controlA = createBackgroundProcessControl(a, start), controlB = createBackgroundProcessControl(b, start)
    expect(execFile).toHaveBeenCalledOnce()
    expect(vi.mocked(execFile).mock.calls[0]).toMatchObject(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', expect.any(Array), { timeout: 2500, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, expect.any(Function)])
    const first = controlA.isAlive(), second = controlB.isAlive()
    pending.shift()!(null, JSON.stringify([identity(100, 1), identity(101, 100, 10), identity(200, 1)]))
    expect(await Promise.all([first, second])).toEqual([true, true])
    a.emit('exit', 0, null)
    vi.mocked(treeKillSafe).mockImplementation((_pid, _signal, callback) => callback?.())
    const stopping = controlA.terminate('SIGTERM')
    // A new, unrelated process now has the old root's numeric pid. Its newer
    // creation identity cannot become an anchor, including its descendants.
    pending.shift()!(null, JSON.stringify([identity(100, 1, 5000), identity(102, 100, 5010), identity(101, 1, 10), identity(200, 1)]))
    await flush()
    expect(treeKillSafe).toHaveBeenCalledExactlyOnceWith(101, 'SIGTERM', expect.any(Function))
    expect(pending).toHaveLength(1)
    pending.shift()!(null, JSON.stringify([identity(100, 1, 5000), identity(102, 100, 5010), identity(200, 1)]))
    await expect(stopping).resolves.toBeUndefined()
  })

  it('refuses to adopt a Windows root that exits while its first identity snapshot is pending', async () => {
    platform('win32')
    let respond!: (error: Error | null, stdout: string) => void
    vi.mocked(execFile).mockImplementation(((_binary: string, _args: string[], _options: unknown, callback: typeof respond) => { respond = callback; return child(9000) }) as typeof execFile)
    const root = child(100), control = createBackgroundProcessControl(root, start)
    const alive = control.isAlive()
    root.emit('close', 0, null)
    respond(null, JSON.stringify([identity(100, 1, 5000)]))
    await expect(alive).rejects.toThrow('Could not verify')
    expect(treeKillSafe).not.toHaveBeenCalled()
  })

  it('does not signal a reused Windows pid and validates stop completion with a fresh snapshot', async () => {
    platform('win32')
    let rows = [identity(100, 1)]
    vi.mocked(execFile).mockImplementation(((_binary: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => { queueMicrotask(() => callback(null, JSON.stringify(rows))); return child(9000) }) as typeof execFile)
    const control = createBackgroundProcessControl(child(100), start)
    expect(await control.isAlive()).toBe(true)
    rows = [identity(100, 1, 5000), identity(101, 100, 5010)]
    await control.terminate('SIGKILL')
    expect(treeKillSafe).not.toHaveBeenCalled()
    expect(await control.isAlive()).toBe(false)
    expect(execFile).toHaveBeenCalledTimes(4)
  })

  it('exposes Windows taskkill errors while the verified tree remains alive and permits retry', async () => {
    platform('win32')
    let rows = [identity(100, 1)]
    vi.mocked(execFile).mockImplementation(((_binary: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => { queueMicrotask(() => callback(null, JSON.stringify(rows))); return child(9000) }) as typeof execFile)
    const control = createBackgroundProcessControl(child(100), start)
    await control.isAlive()
    vi.mocked(treeKillSafe).mockImplementation((_pid, _signal, callback) => callback?.(new Error('Access denied')))
    await expect(control.terminate('SIGTERM')).rejects.toThrow('Access denied')
    expect(await control.isAlive()).toBe(true)
    vi.mocked(treeKillSafe).mockImplementation((_pid, _signal, callback) => { rows = []; callback?.() })
    await control.terminate('SIGKILL')
    expect(await control.isAlive()).toBe(false)
  })

  it.each(['unavailable', 'malformed'])('never reports exit when Windows discovery is %s', async mode => {
    platform('win32')
    vi.mocked(execFile).mockImplementation(((_binary: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => { queueMicrotask(() => callback(mode === 'unavailable' ? new Error('PowerShell unavailable') : null, 'not JSON')); return child(9000) }) as typeof execFile)
    const control = createBackgroundProcessControl(child(100), start)
    await expect(control.isAlive()).rejects.toThrow()
    expect(treeKillSafe).not.toHaveBeenCalled()
  })
})
