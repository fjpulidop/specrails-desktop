import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BackgroundProcessStore, BACKGROUND_HISTORY_RETENTION_MS } from './background-process-store'
import type { BackgroundProcess, BackgroundProcessLogLine } from './transient-children'

const stores: BackgroundProcessStore[] = [], directories: string[] = []
const open = (file = ':memory:', policy = {}) => { const store = new BackgroundProcessStore(file, policy); stores.push(store); return store }
const processInfo = (processId = 'execution-a', extra: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  processId, pid: 444, command: 'npm run dev -- --host 127.0.0.1', cwd: '/repo/frontend',
  startedAt: Date.now(), status: 'running', chatId: 'chat', projectId: 'project', repositoryId: 'frontend', repositoryName: 'Frontend', ...extra,
})
const line = (sequence: number, text = `line-${sequence}`, partial = false): BackgroundProcessLogLine => ({ sequence, at: Date.now(), source: 'stdout', line: text, partial })
const file = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-background-history-')); directories.push(dir); return path.join(dir, 'background.sqlite') }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-09-06T08:00:00Z')) })
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })

describe('durable background process history', () => {
  it('recovers metadata and exact partial output after reopening without adopting a pid', () => {
    const dbFile = file(), first = open(dbFile), original = processInfo()
    first.write({ process: original, nextSequence: 2, clipped: true, lines: [line(1, 'café 🚀'), line(2, 'still building', true)] })
    const before = first.logs(444)!
    first.close()
    vi.advanceTimersByTime(2000)
    const restored = open(dbFile)
    expect(restored.get(444)).toMatchObject({ ...original, status: 'interrupted', recoveredAt: Date.now(), error: expect.stringContaining('not attached') })
    expect(restored.logs(444)).toMatchObject({ lines: before.lines, nextSequence: 2, truncated: true, maxLines: 10000, retentionMs: BACKGROUND_HISTORY_RETENTION_MS })
    expect(restored.list()).toEqual([])
    expect(restored.list({ includeFinished: true, projectId: 'project', chatId: 'chat' })).toHaveLength(1)
    expect(restored.list({ includeFinished: true, chatId: 'other' })).toEqual([])
    restored.close()
    const again = open(dbFile)
    expect(again.get(444)?.recoveredAt).toBe(Date.now())
    expect(again.db.pragma('foreign_key_check')).toEqual([])
    if (process.platform !== 'win32') expect(fs.statSync(dbFile).mode & 0o777).toBe(0o600)
  })

  it('upserts partial lines, keeps stdout/stderr sequence order and retains terminal metadata', () => {
    const store = open(), process = processInfo()
    store.write({ process, nextSequence: 1, clipped: false, lines: [line(1, 'build', true)] })
    store.write({ process: { ...process, status: 'failed', exitCode: 2, endedAt: Date.now(), error: 'Build failed' }, nextSequence: 3, clipped: false,
      lines: [line(1, 'building complete'), { ...line(2, 'compiler warning'), source: 'stderr' }, line(3, 'done')] })
    const logs = store.logs(444)!
    expect(logs.process).toMatchObject({ status: 'failed', exitCode: 2, error: 'Build failed' })
    expect(logs.lines.map(value => [value.sequence, value.line, value.partial])).toEqual([[1, 'building complete', false], [2, 'compiler warning', false], [3, 'done', false]])
    expect(logs.truncated).toBe(false)
    expect(store.logs(444, { limit: 1 })).toMatchObject({ lines: [line(3, 'done')], droppedLines: 2, truncated: true })
  })

  it('keeps separate UUID histories after PID reuse and rejects owner mutation atomically', () => {
    const store = open(), old = processInfo('old', { status: 'killed' }), next = processInfo('new', { chatId: 'other-chat' })
    store.write({ process: old, nextSequence: 1, clipped: false, lines: [line(1, 'old command')] })
    store.write({ process: next, nextSequence: 1, clipped: false, lines: [line(1, 'new command')] })
    expect(store.get(444)?.processId).toBe('new')
    expect(store.logs(444, { processId: 'old', chatId: 'chat' })?.lines[0].line).toBe('old command')
    expect(store.logs(444, { processId: 'old', chatId: 'other-chat' })).toBeNull()
    expect(store.logs(444, { processId: 'old', projectId: 'foreign' })).toBeNull()
    expect(store.logs(445, { processId: 'old' })).toBeNull()
    expect(() => store.write({ process: { ...old, chatId: 'other-chat' }, nextSequence: 2, clipped: false, lines: [line(2, 'injected')] })).toThrow('original owner')
    expect(store.logs(444, { processId: 'old' })?.nextSequence).toBe(1)
  })

  it('rolls process metadata and output back together when a batch cannot be saved', () => {
    const store = open(), process = processInfo()
    store.write({ process, nextSequence: 1, clipped: false, lines: [line(1)] })
    store.db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON background_process_lines BEGIN SELECT RAISE(ABORT,'disk fixture failure'); END")
    expect(() => store.write({ process: { ...process, status: 'exited' }, nextSequence: 2, clipped: false, lines: [line(2)] })).toThrow('disk fixture failure')
    expect(store.logs(444)).toMatchObject({ process: { status: 'running' }, nextSequence: 1, lines: [line(1)] })
  })

  it('enforces per-run line count, terminal count and text bytes without dropping live process identities', () => {
    const store = open(':memory:', { maxLines: 3, maxFinishedRuns: 2, maxTextBytes: 12 })
    const active = processInfo('active')
    store.write({ process: active, nextSequence: 5, clipped: false, lines: [1, 2, 3, 4, 5].map(id => line(id, '1234')) })
    expect(store.logs(444)).toMatchObject({ nextSequence: 5, droppedLines: 2, lines: [line(3, '1234'), line(4, '1234'), line(5, '1234')] })
    const second = processInfo('second', { pid: 445 })
    store.write({ process: second, nextSequence: 1, clipped: false, lines: [line(1, 'abcdef')] })
    expect(store.get(444)?.status).toBe('running')
    expect(store.logs(444)?.droppedLines).toBeGreaterThan(2)
    expect((store.db.prepare('SELECT SUM(text_bytes) AS bytes FROM background_process_runs').get() as { bytes: number }).bytes).toBeLessThanOrEqual(12)
    for (let id = 0; id < 4; id++) { vi.advanceTimersByTime(1); store.write({ process: processInfo(`done-${id}`, { pid: 500 + id, status: 'exited' }), nextSequence: 0, clipped: false, lines: [] }) }
    expect(store.list({ includeFinished: true }).filter(value => value.status === 'exited')).toHaveLength(2)
    expect(store.list()).toHaveLength(2)
  })

  it('expires terminal histories on direct log reads and purges chat/project data with cascading lines', () => {
    const store = open(':memory:', { retentionMs: 1000 })
    for (const process of [processInfo('done', { status: 'exited' }), processInfo('other', { pid: 445, chatId: 'other' })]) store.write({ process, nextSequence: 1, clipped: false, lines: [line(1)] })
    vi.advanceTimersByTime(1001)
    expect(store.logs(444, { processId: 'done' })).toBeNull()
    expect(store.get(445)).not.toBeNull()
    expect(() => store.purge({})).toThrow('conversation or project')
    store.purge({ projectId: 'project', chatId: 'foreign' })
    expect(store.get(445)).not.toBeNull()
    store.purge({ chatId: 'other' })
    expect(store.list({ includeFinished: true })).toEqual([])
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM background_process_lines').get()).toEqual({ n: 0 })
  })

  it('does not recover another active server and reclaims a dead owner atomically', () => {
    const dbFile = file(), first = open(dbFile)
    first.write({ process: processInfo(), nextSequence: 1, clipped: false, lines: [line(1)] })
    expect(() => open(dbFile)).toThrow('another active Specrails server')
    expect(first.get(444)?.status).toBe('running')
    first.db.prepare('UPDATE background_process_session_owner SET pid=?').run(987654)
    // Simulate crash without the normal release of this store's owner token.
    first.db.close()
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => { if (pid === 987654) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return true })
    const second = open(dbFile)
    expect(kill).toHaveBeenCalledExactlyOnceWith(987654, 0)
    expect(second.get(444)?.status).toBe('interrupted')
    expect(second.db.prepare('SELECT pid FROM background_process_session_owner').get()).toEqual({ pid: process.pid })
  })

  it('refuses uncertain/reused owner PIDs and never sends a termination signal during recovery', () => {
    const dbFile = file(), first = open(dbFile)
    first.db.prepare('UPDATE background_process_session_owner SET pid=?').run(987654); first.db.close()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('cannot inspect'), { code: 'EPERM' }) })
    expect(() => open(dbFile)).toThrow('another active Specrails server')
    expect(kill.mock.calls).toEqual([[987654, 0]])
  })
})
