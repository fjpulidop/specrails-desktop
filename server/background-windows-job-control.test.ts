import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import type { ChildProcess } from 'child_process'
import type { Socket, Server } from 'node:net'

vi.mock('node:net', () => ({ createServer: vi.fn() }))
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => process.execPath }))
vi.mock('./util/win-spawn', () => ({ windowsSpawnEnv: () => ({ SystemRoot: 'C:\\Windows' }) }))
import { createServer } from 'node:net'
import { spawn } from 'child_process'
import { spawnWindowsBackgroundBootstrap } from './background-windows-bootstrap'

let accept!: (socket: Socket) => void
let child: ChildProcess & { kill: ReturnType<typeof vi.fn> }
let socket: Socket & { write: ReturnType<typeof vi.fn> }
let server: Server
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { pid: 8001, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null, kill: vi.fn(() => true) }) as typeof child
  socket = Object.assign(new EventEmitter(), { destroyed: false, setEncoding: vi.fn(), write: vi.fn(() => true), destroy: vi.fn() }) as typeof socket
  server = Object.assign(new EventEmitter(), { close: vi.fn(), listen: vi.fn() }) as unknown as Server
  vi.mocked(createServer).mockImplementation(((callback: typeof accept) => { accept = callback; return server }) as typeof createServer)
  vi.mocked(spawn).mockReturnValue(child)
})
afterEach(() => { child.emit('close', 125, null); vi.useRealTimers(); vi.clearAllMocks() })
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

describe('Windows kernel Job control channel', () => {
  it('requires job assignment before admission and observes active descendants through the owned job', async () => {
    const app = spawnWindowsBackgroundBootstrap('node "España & API.js"', '/fixture')
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    const script = args[args.indexOf('-File') + 1]
    expect(readFileSync(script, 'utf8')).toContain('AssignProcessToJobObject(job,root.Handle)')
    expect(vi.mocked(server.listen)).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringMatching(/^\\\\\.\\pipe\\specrails-background-/), readableAll: false, writableAll: false }))
    expect(() => app.start()).toThrow('not assigned')
    accept(socket)
    socket.emit('data', 'rea'); socket.emit('data', 'dy\n')
    await app.control!.ready
    app.start()
    expect(socket.write).toHaveBeenCalledWith(`start\t${Buffer.from('node "España & API.js"').toString('base64')}\n`)
    const alive = app.control!.isAlive(); await tick()
    expect(socket.write).toHaveBeenLastCalledWith('poll\t1\n')
    // A kernel job can still own two descendants after its initial root exits.
    socket.emit('data', 'state\t1\t2\n')
    expect(await alive).toBe(true)
    const stop = app.control!.terminate('SIGTERM'); await tick()
    expect(socket.write).toHaveBeenLastCalledWith('stop\t2\n')
    socket.emit('data', 'state\t2\t1\n'); await stop
    const draining = app.control!.isAlive(); await tick()
    socket.emit('data', 'state\t3\t1\n')
    expect(await draining).toBe(true)
    socket.emit('data', 'empty\n')
    expect(await app.control!.isAlive()).toBe(false)
    child.emit('close', 0, null)
    expect(existsSync(script)).toBe(false)
  })

  it('cancels before assignment without permitting a late ready frame to execute the command', async () => {
    const app = spawnWindowsBackgroundBootstrap('must not run', '/fixture')
    app.cancel()
    expect(child.kill).toHaveBeenCalledOnce()
    accept(socket); socket.emit('data', 'ready\n'); await app.control!.ready
    expect(() => app.start()).toThrow('cancelled')
    expect(app.hasLaunched()).toBe(false)
    expect(socket.write).not.toHaveBeenCalled()
  })

  it('never reports an empty job from supervisor disconnection without the kernel receipt', async () => {
    const app = spawnWindowsBackgroundBootstrap('fixture', '/fixture')
    accept(socket); socket.emit('data', 'ready\n'); await app.control!.ready
    app.start()
    const pending = app.control!.isAlive(); await tick()
    socket.emit('close')
    await expect(pending).rejects.toThrow('before confirming an empty job')
    await expect(app.control!.isAlive()).rejects.toThrow('before confirming an empty job')
    child.emit('close', 125, null)
    expect(await app.control!.isAlive()).toBe(false)
    expect(app.control!.terminalFailure?.()).toContain('force-terminated by Windows')
  })

  it('bounds the UTF-8 bytes before encoding command text for the bootstrap', () => {
    expect(() => spawnWindowsBackgroundBootstrap('ñ'.repeat(150_000), '/fixture')).toThrow('transport limit')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('bounds preparation time and cleans private scripts after failed supervisor exit', async () => {
    vi.useFakeTimers()
    const app = spawnWindowsBackgroundBootstrap('fixture', '/fixture')
    const rejected = expect(app.control!.ready).rejects.toThrow('preparation timed out')
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    const script = args[args.indexOf('-File') + 1]
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    expect(app.hasLaunched()).toBe(false)
    child.emit('close', 125, null)
    expect(existsSync(script)).toBe(false)
  })

  it('fails closed on a job assignment error before application admission', async () => {
    const app = spawnWindowsBackgroundBootstrap('fixture', '/fixture')
    const rejected = expect(app.control!.ready).rejects.toThrow('AssignProcessToJobObject')
    accept(socket)
    socket.emit('data', `error\t${Buffer.from('AssignProcessToJobObject: access denied').toString('base64')}\n`)
    await rejected
    expect(() => app.start()).toThrow('AssignProcessToJobObject')
    expect(app.hasLaunched()).toBe(false)
  })
})
