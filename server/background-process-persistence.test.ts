import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

type FixtureChild = EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; alive: boolean }
const fixtures = vi.hoisted(() => ({ children: [] as FixtureChild[], nextPid: 78000, signals: [] as string[] }))
vi.mock('child_process', async () => ({
  ...await vi.importActual<typeof import('child_process')>('child_process'),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: ++fixtures.nextPid, stdout: new PassThrough(), stderr: new PassThrough(), alive: true })
    fixtures.children.push(child)
    return child as unknown as ChildProcess
  }),
}))
vi.mock('./background-process-control', () => ({
  createBackgroundProcessControl: (child: FixtureChild) => ({
    isAlive: async () => child.alive,
    terminate: async (signal: string) => {
      fixtures.signals.push(signal)
      child.alive = false
      child.emit('exit', null, signal); child.emit('close', null, signal)
    },
  }),
}))

let root: string
let file: string
let registry: typeof import('./transient-children')
let Store: typeof import('./background-process-store').BackgroundProcessStore
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-history-batches-'))
  file = path.join(root, 'history.sqlite')
  fixtures.children.length = 0; fixtures.signals.length = 0
  registry = await import('./transient-children')
  Store = (await import('./background-process-store')).BackgroundProcessStore
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    for (const child of fixtures.children) {
      child.alive = false; child.emit('close', 0, null)
      child.stdout.destroy(); child.stderr.destroy()
    }
    await vi.advanceTimersByTimeAsync(0)
    await registry.awaitBackgroundProcessesStopped(0)
    try { registry.closeBackgroundProcessPersistence() } catch { /* initialization failure fixtures have no open store */ }
  } finally { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }) }
})

describe('background process durable lifecycle', () => {
  it('batches partial updates while reads include the latest unflushed output', async () => {
    registry.initializeBackgroundProcessPersistence(file)
    const process = registry.startBackgroundProcess('fixture app', root, 'chat', 'project')
    const write = vi.spyOn(Store.prototype, 'write')
    fixtures.children[0].stdout.write('starting')
    fixtures.children[0].stdout.write(' application')
    expect(registry.getBackgroundProcessLogs(process.pid)?.lines).toMatchObject([{ sequence: 1, line: 'starting application', partial: true }])
    await vi.advanceTimersByTimeAsync(249)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0].lines).toHaveLength(1)
    fixtures.children[0].stdout.write('\nready\n')
    fixtures.children[0].alive = false; fixtures.children[0].emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    // Evict the in-memory terminal tail: the same completed output remains on disk.
    await vi.advanceTimersByTimeAsync(registry.BACKGROUND_LOG_RETENTION_MS + 1)
    expect(registry.getBackgroundProcessLogs(process.pid, { processId: process.processId })).toMatchObject({
      process: { status: 'exited' }, lines: [{ sequence: 1, line: 'starting application', partial: false }, { sequence: 2, line: 'ready' }],
    })
  })

  it('merges durable and pending lines beyond the 2000-line live memory ring', async () => {
    registry.initializeBackgroundProcessPersistence(file)
    const process = registry.startBackgroundProcess('noisy fixture', root, 'chat', 'project')
    fixtures.children[0].stdout.write(Array.from({ length: 2501 }, (_, i) => `line ${i}\n`).join(''))
    const logs = registry.getBackgroundProcessLogs(process.pid, { limit: 10000 })!
    expect(logs.lines).toHaveLength(2501)
    expect(logs.lines[0].line).toBe('line 0')
    expect(logs.lines.at(-1)?.line).toBe('line 2500')
    expect(logs.truncated).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(registry.getBackgroundProcessLogs(process.pid, { limit: 10000 })?.lines).toEqual(logs.lines)
  })

  it('bounds failed write attempts, retries quiet output and never blocks stopping', async () => {
    registry.initializeBackgroundProcessPersistence(file)
    const process = registry.startBackgroundProcess('fixture app', root, 'chat', 'project')
    const write = vi.spyOn(Store.prototype, 'write').mockImplementation(() => { throw new Error('disk temporarily unavailable') })
    fixtures.children[0].stderr.write(Array.from({ length: 2501 }, (_, i) => `error ${i}\n`).join(''))
    expect(write.mock.calls.length).toBeLessThanOrEqual(1)
    expect(registry.getBackgroundProcess(process.pid)?.persistenceError).toContain('disk temporarily unavailable')
    expect(registry.killOwnedBackgroundProcess(process.pid, { projectId: 'project', chatId: 'chat', processId: process.processId })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(registry.getBackgroundProcess(process.pid)?.status).toBe('killed')
    await expect(registry.awaitBackgroundProcessesStopped(0)).resolves.toEqual([])
    write.mockRestore()
    // No new process output: the scheduled retry must still commit the final batch.
    await vi.advanceTimersByTimeAsync(5000)
    expect(registry.getBackgroundProcess(process.pid)?.persistenceError).toBeUndefined()
    await vi.advanceTimersByTimeAsync(registry.BACKGROUND_LOG_RETENTION_MS + 1)
    expect(registry.getBackgroundProcessLogs(process.pid)?.lines.at(-1)?.line).toBe('error 2500')
  })

  it('reports unavailable existing history and reopens it on a throttled read retry', async () => {
    const saved = { processId: 'saved', pid: 90123, command: 'fixture', cwd: root, projectId: 'project', chatId: 'chat', startedAt: Date.now(), status: 'failed' as const }
    const seed = new Store(file)
    seed.write({ process: saved, lines: [{ sequence: 1, at: Date.now(), source: 'stderr', line: 'saved failure' }], nextSequence: 1, clipped: false })
    seed.close()
    fs.renameSync(file, `${file}.backup`); fs.mkdirSync(file)
    expect(() => registry.initializeBackgroundProcessPersistence(file)).toThrow()
    expect(() => registry.listBackgroundProcesses({ includeFinished: true })).toThrow(/history is unavailable/)
    expect(() => registry.getBackgroundProcessLogs(saved.pid)).toThrow(/history is unavailable/)
    expect(() => registry.purgeBackgroundProcessHistory({ chatId: 'chat' })).toThrow(/history is unavailable/)
    expect(() => registry.startBackgroundProcess('fixture', root, 'chat', 'project')).toThrow(/history is unavailable/)
    expect(fixtures.children).toHaveLength(0)
    fs.rmdirSync(file); fs.renameSync(`${file}.backup`, file)
    expect(() => registry.listBackgroundProcesses({ includeFinished: true })).toThrow(/history is unavailable/)
    await vi.advanceTimersByTimeAsync(1000)
    expect(registry.listBackgroundProcesses({ includeFinished: true })).toMatchObject([saved])
    expect(registry.getBackgroundProcessLogs(saved.pid)?.lines[0].line).toBe('saved failure')
    registry.closeBackgroundProcessPersistence()
    await vi.advanceTimersByTimeAsync(2000)
    expect(() => registry.listBackgroundProcesses({ includeFinished: true })).toThrow(/store is closed/)
  })

  it('recovers active metadata as disconnected without adopting or signalling the recorded PID', () => {
    const seed = new Store(file)
    seed.write({ process: { processId: 'old-session', pid: 90124, command: 'fixture', cwd: root, projectId: 'project', chatId: 'chat', startedAt: Date.now(), status: 'running' }, lines: [], nextSequence: 0, clipped: false })
    seed.close()
    registry.initializeBackgroundProcessPersistence(file)
    expect(registry.getBackgroundProcess(90124)).toMatchObject({ status: 'interrupted', recoveredAt: expect.any(Number) })
    expect(registry.killOwnedBackgroundProcess(90124, { processId: 'old-session', projectId: 'project', chatId: 'chat' })).toBe(false)
    expect(fixtures.signals).toEqual([])
    expect(fixtures.children).toHaveLength(0)
  })

  it('purges a deleted mission without a late child close resurrecting its history', async () => {
    registry.initializeBackgroundProcessPersistence(file)
    const process = registry.startBackgroundProcess('fixture app', root, 'chat', 'project')
    fixtures.children[0].stdout.write('before delete\n')
    registry.purgeBackgroundProcessHistory({ chatId: 'chat' })
    fixtures.children[0].stdout.write('late output\n')
    fixtures.children[0].alive = false; fixtures.children[0].emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1000)
    expect(registry.listBackgroundProcesses({ includeFinished: true })).toEqual([])
    expect(registry.getBackgroundProcessLogs(process.pid, { processId: process.processId })).toBeNull()
  })
})
