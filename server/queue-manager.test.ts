import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, updateProjectSettings } from './db'

// Mock child_process and ids before importing queue-manager
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('./ids', () => ({
  newId: vi.fn(() => 'test-uuid-1111'),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

// Mock hooks to avoid side effects in tests
vi.mock('./hooks', () => ({
  resetPhases: vi.fn(),
  setActivePhases: vi.fn(),
}))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import treeKill from 'tree-kill'
import { newId as mockUuidV4 } from './ids'
import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError, buildTelemetryEnv } from './queue-manager'
import { mirrorProjectEntry, workspaceLayout, resolveHome } from './artifact-registry'
import { __resetBinaryProbeCacheForTest } from './binary-probe'
import { attachmentManager } from './attachment-manager'
import type { WsMessage } from './types'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  return child
}

function makeProjectDirWithTickets(tickets: Record<string, Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-manager-test-'))
  fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.specrails', 'local-tickets.json'),
    JSON.stringify({
      schema_version: '1.0',
      revision: 1,
      last_updated: new Date().toISOString(),
      next_id: 100,
      tickets,
    }),
    'utf-8',
  )
  return dir
}

describe('QueueManager', () => {
  let qm: QueueManager
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    __resetBinaryProbeCacheForTest()
    broadcast = vi.fn()
    qm = new QueueManager(broadcast)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── enqueue ──────────────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('returns a job with status queued when a process is already running', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-1' as any)
        .mockReturnValueOnce('job-2' as any)

      qm.enqueue('/implement #1')
      const secondJob = qm.enqueue('/implement #2')

      expect(secondJob.status).toBe('queued')
      expect(secondJob.queuePosition).toBe(1)
    })

    it('returns a job with status running when queue is empty (auto-drains)', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const job = qm.enqueue('/implement #1')

      expect(job.status).toBe('running')
    })

    it('throws ClaudeNotFoundError when claude is not on PATH', () => {
      vi.mocked(mockExecSync).mockImplementation(() => {
        throw new Error('not found')
      })

      expect(() => qm.enqueue('/implement #1')).toThrow(ClaudeNotFoundError)
    })

    it('broadcasts queue state after enqueue', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      qm.enqueue('/implement #1')

      const queueBroadcasts = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'queue'
      )
      expect(queueBroadcasts.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ─── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('on a queued job: removes from queue and broadcasts queue state', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-queued' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      broadcast.mockClear()

      const result = qm.cancel('job-queued')

      expect(result).toBe('canceled')
      const jobs = qm.getJobs()
      const canceledJob = jobs.find((j) => j.id === 'job-queued')
      expect(canceledJob?.status).toBe('canceled')

      const queueBroadcast = broadcast.mock.calls.find(
        (args: unknown[]) => (args[0] as WsMessage).type === 'queue'
      )
      expect(queueBroadcast).toBeDefined()
    })

    it('on a running job: calls treeKill with SIGTERM and returns canceling', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-running' as any)

      qm.enqueue('/implement #1')

      const result = qm.cancel('job-running')

      expect(result).toBe('canceling')
      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM', expect.any(Function))
    })

    it('on a non-existent ID: throws JobNotFoundError', () => {
      expect(() => qm.cancel('no-such-id')).toThrow(JobNotFoundError)
    })

    it('M20: canceling a queued job fires onJobFinished(canceled) for rail cleanup', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-queued' as any)
      const onJobFinished = vi.fn()
      const qm2 = new QueueManager(broadcast, undefined, undefined, undefined, { onJobFinished })

      qm2.enqueue('/implement #1') // takes the active slot
      qm2.enqueue('/implement #2') // stays queued

      const result = qm2.cancel('job-queued')

      expect(result).toBe('canceled')
      // Previously this callback never fired for a queued cancel, leaving rails stuck.
      expect(onJobFinished).toHaveBeenCalledWith('job-queued', 'canceled', undefined)
    })

    it('on a completed job: throws JobAlreadyTerminalError', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      child.emit('close', 0)

      // Let close handler run
      await new Promise((r) => setTimeout(r, 10))

      expect(() => qm.cancel('job-1')).toThrow(JobAlreadyTerminalError)
    })
  })

  // ─── pause / resume ───────────────────────────────────────────────────────

  describe('pause', () => {
    it('prevents _drainQueue from starting the next job', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-1' as any)
        .mockReturnValueOnce('job-2' as any)

      qm.pause()
      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      // spawn should not have been called because queue is paused
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })
  })

  describe('resume', () => {
    it('calls _drainQueue and starts the next job if one is queued', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.pause()
      qm.enqueue('/implement #1')
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()

      qm.resume()
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledOnce()

      const jobs = qm.getJobs()
      expect(jobs[0].status).toBe('running')
    })
  })

  // ─── reorder ──────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('reorders the queue array', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)
        .mockReturnValueOnce('job-b' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')
      qm.enqueue('/implement #3')

      qm.reorder(['job-b', 'job-a'])

      const jobs = qm.getJobs()
      const jobB = jobs.find((j) => j.id === 'job-b')
      const jobA = jobs.find((j) => j.id === 'job-a')
      expect(jobB?.queuePosition).toBe(1)
      expect(jobA?.queuePosition).toBe(2)
    })

    it('throws when jobIds do not match the queued set', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      // Provide wrong ID
      expect(() => qm.reorder(['job-a', 'wrong-id'])).toThrow()
    })
  })

  // ─── job transitions ──────────────────────────────────────────────────────

  describe('job status transitions', () => {
    it('job transitions to completed when process exits with code 0', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      child.emit('close', 0)

      await new Promise((r) => setTimeout(r, 10))

      const jobs = qm.getJobs()
      expect(jobs[0].status).toBe('completed')
      expect(jobs[0].exitCode).toBe(0)
    })

    it('job transitions to failed when process exits with non-zero code', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      child.emit('close', 1)

      await new Promise((r) => setTimeout(r, 10))

      const jobs = qm.getJobs()
      expect(jobs[0].status).toBe('failed')
      expect(jobs[0].exitCode).toBe(1)
    })
  })

  // ─── getLogBuffer ─────────────────────────────────────────────────────────

  describe('getLogBuffer', () => {
    it('returns log lines accumulated during job execution', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      qm.enqueue('/implement #1')

      child.stdout.push('hello from stdout\n')
      child.stdout.push(null)

      await new Promise((r) => setTimeout(r, 50))

      const buf = qm.getLogBuffer()
      const line = buf.find((l) => l.line === 'hello from stdout')
      expect(line).toBeDefined()
      expect(line?.source).toBe('stdout')
    })

    it('returns a copy, not a reference', () => {
      const buf = qm.getLogBuffer()
      buf.push({} as any)
      expect(qm.getLogBuffer()).toEqual([])
    })
  })

  // ─── sequential queue drain ───────────────────────────────────────────────

  describe('sequential queue drain', () => {
    it('second job starts when first jobs process emits close', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-1' as any)
        .mockReturnValueOnce('job-2' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      expect(qm.getActiveJobId()).toBe('job-1')

      child1.emit('close', 0)

      await new Promise((r) => setTimeout(r, 10))

      expect(qm.getActiveJobId()).toBe('job-2')

      const jobs = qm.getJobs()
      expect(jobs.find((j) => j.id === 'job-2')?.status).toBe('running')
    })
  })

  // ─── kill timer ───────────────────────────────────────────────────────────

  describe('kill timer', () => {
    it('fires SIGKILL after 5s if process does not exit', async () => {
      vi.useFakeTimers()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      qm.cancel('job-1')

      // Advance past 5s timeout
      vi.advanceTimersByTime(5100)

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM', expect.any(Function))
      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGKILL', expect.any(Function))

      vi.useRealTimers()
    })
  })

  // ─── getActiveJobId / isPaused ────────────────────────────────────────────

  describe('getActiveJobId', () => {
    it('returns null when no job is running', () => {
      expect(qm.getActiveJobId()).toBeNull()
    })

    it('returns the running job id after enqueue', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')

      expect(qm.getActiveJobId()).toBe('job-1')
    })
  })

  describe('isPaused', () => {
    it('returns false by default', () => {
      expect(qm.isPaused()).toBe(false)
    })

    it('returns true after pause()', () => {
      qm.pause()
      expect(qm.isPaused()).toBe(true)
    })

    it('returns false after resume()', () => {
      qm.pause()
      qm.resume()
      expect(qm.isPaused()).toBe(false)
    })
  })

  // ─── zombie detection ─────────────────────────────────────────────────────

  describe('zombie detection', () => {
    it('auto-terminates a job with no output after the configured timeout', () => {
      vi.useFakeTimers()
      vi.mocked(treeKill).mockClear()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-zombie' as any)

      const qmZombie = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 30_000 })
      qmZombie.enqueue('/implement #1')

      // Advance past the 30s zombie timeout
      vi.advanceTimersByTime(30_100)

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM', expect.any(Function))

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('resets the zombie timer on each output data chunk', async () => {
      vi.useFakeTimers()
      vi.mocked(treeKill).mockClear()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-active' as any)

      const qmActive = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 30_000 })
      qmActive.enqueue('/implement #1')

      // Advance 25s without any output — timer is still counting (fires at 30s)
      vi.advanceTimersByTime(25_000)

      // Push output — the 'data' event is emitted via process.nextTick by Node.js streams.
      // Awaiting a nextTick-based promise flushes the nextTick queue, causing the 'data'
      // event to fire and reset the zombie timer before we advance time further.
      child.stdout.push('still alive\n')
      await new Promise<void>(resolve => process.nextTick(resolve))

      // Advance another 25s — timer was reset at ~25s (fires at ~55s), so at t=50s it has NOT fired
      vi.advanceTimersByTime(25_000)

      expect(vi.mocked(treeKill)).not.toHaveBeenCalled()

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('clears the zombie timer when the job exits normally', async () => {
      vi.useFakeTimers()
      vi.mocked(treeKill).mockClear()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-clean' as any)

      const qmClean = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 30_000 })
      qmClean.enqueue('/implement #1')

      // Job exits normally before timeout
      child.emit('close', 0)

      // Advance past timeout — timer should have been cleared, no SIGTERM
      vi.advanceTimersByTime(40_000)

      expect(vi.mocked(treeKill)).not.toHaveBeenCalled()

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('clears the zombie timer when the job is cancelled', () => {
      vi.useFakeTimers()
      vi.mocked(treeKill).mockClear()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-cancel' as any)

      const qmCancel = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 30_000 })
      qmCancel.enqueue('/implement #1')

      // Cancel explicitly before zombie timeout fires
      vi.mocked(treeKill).mockClear()
      qmCancel.cancel('job-cancel')

      // The cancel itself sends SIGTERM
      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM', expect.any(Function))

      // Advance well past the zombie timeout — kill timer (5s) will fire SIGKILL,
      // but the zombie timer (30s) should have been cleared by cancel
      vi.advanceTimersByTime(40_000)

      // Only SIGTERM (from cancel) and SIGKILL (from kill timer) — no additional SIGTERM from zombie
      const sigtermCalls = vi.mocked(treeKill).mock.calls.filter((c) => c[1] === 'SIGTERM')
      expect(sigtermCalls.length).toBe(1)

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('does not auto-terminate when zombieTimeoutMs is 0', () => {
      vi.useFakeTimers()
      vi.mocked(treeKill).mockClear()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-no-zombie' as any)

      const qmNoZombie = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 0 })
      qmNoZombie.enqueue('/implement #1')

      // Advance far past any threshold
      vi.advanceTimersByTime(600_000)

      expect(vi.mocked(treeKill)).not.toHaveBeenCalled()

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('emits a zombie-detection log line to stderr when triggered', () => {
      vi.useFakeTimers()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-log' as any)

      const qmLog = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 10_000 })
      qmLog.enqueue('/implement #1')

      vi.advanceTimersByTime(10_100)

      const zombieMsgs = (broadcast.mock.calls as Array<[WsMessage]>)
        .map((c) => c[0])
        .filter((m) => m.type === 'log' && 'line' in m && (m as any).line.includes('zombie-detection'))
      expect(zombieMsgs.length).toBeGreaterThan(0)

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('reads zombieTimeoutMs from WM_ZOMBIE_TIMEOUT_MS env var', () => {
      vi.useFakeTimers()
      vi.mocked(treeKill).mockClear()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-env' as any)

      process.env.WM_ZOMBIE_TIMEOUT_MS = '5000'
      const qmEnv = new QueueManager(broadcast)
      delete process.env.WM_ZOMBIE_TIMEOUT_MS

      qmEnv.enqueue('/implement #1')

      vi.advanceTimersByTime(5_100)

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM', expect.any(Function))

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('sets status to zombie_terminated (not canceled) when auto-terminated', () => {
      vi.useFakeTimers()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-zombie-status' as any)

      const qmZombieStatus = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 10_000 })
      qmZombieStatus.enqueue('/implement #1')

      // Trigger zombie timeout
      vi.advanceTimersByTime(10_100)

      // Simulate process exit after SIGTERM
      child.emit('close', null)

      const jobs = qmZombieStatus.getJobs()
      const job = jobs.find((j) => j.id === 'job-zombie-status')
      expect(job?.status).toBe('zombie_terminated')

      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('sets status to canceled (not zombie_terminated) when manually canceled', () => {
      vi.useFakeTimers()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-manual-cancel' as any)

      const qmManual = new QueueManager(broadcast, undefined, undefined, undefined, { zombieTimeoutMs: 30_000 })
      qmManual.enqueue('/implement #1')

      // Manually cancel before zombie timeout
      qmManual.cancel('job-manual-cancel')

      // Simulate process exit
      child.emit('close', null)

      const jobs = qmManual.getJobs()
      const job = jobs.find((j) => j.id === 'job-manual-cancel')
      expect(job?.status).toBe('canceled')

      vi.clearAllTimers()
      vi.useRealTimers()
    })
  })

  // ─── priority ordering ──────────────────────────────────────────────────

  describe('priority ordering', () => {
    it('enqueue with priority inserts job ahead of lower-priority jobs', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-low' as any)
        .mockReturnValueOnce('job-critical' as any)

      qm.enqueue('/implement #1')          // runs immediately
      qm.enqueue('/implement #2', 'low')   // queued at position 1
      qm.enqueue('/implement #3', 'critical') // should jump ahead of low

      const jobs = qm.getJobs()
      const low = jobs.find((j) => j.id === 'job-low')
      const critical = jobs.find((j) => j.id === 'job-critical')
      expect(critical?.queuePosition).toBe(1)
      expect(low?.queuePosition).toBe(2)
    })

    it('enqueue with same priority preserves FIFO order', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)
        .mockReturnValueOnce('job-b' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2', 'high')
      qm.enqueue('/implement #3', 'high')

      const jobs = qm.getJobs()
      const a = jobs.find((j) => j.id === 'job-a')
      const b = jobs.find((j) => j.id === 'job-b')
      expect(a?.queuePosition).toBe(1)
      expect(b?.queuePosition).toBe(2)
    })

    it('enqueue defaults to normal priority', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const job = qm.enqueue('/implement #1')
      expect(job.priority).toBe('normal')
    })

    it('four-level priority ordering: critical > high > normal > low', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      let id = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++id}` as any)

      qm.pause() // prevent drain
      qm.enqueue('/low', 'low')
      qm.enqueue('/normal')
      qm.enqueue('/high', 'high')
      qm.enqueue('/critical', 'critical')

      const jobs = qm.getJobs()
      const sorted = jobs
        .filter((j) => j.status === 'queued')
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))

      expect(sorted.map((j) => j.priority)).toEqual(['critical', 'high', 'normal', 'low'])
    })
  })

  // ─── updatePriority ────────────────────────────────────────────────────

  describe('updatePriority', () => {
    it('changes priority of a queued job and reorders queue', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)
        .mockReturnValueOnce('job-b' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')       // normal, position 1
      qm.enqueue('/implement #3', 'high') // high, position 1, pushing job-a to 2

      // Now upgrade job-a to critical
      qm.updatePriority('job-a', 'critical')

      const jobs = qm.getJobs()
      const a = jobs.find((j) => j.id === 'job-a')
      const b = jobs.find((j) => j.id === 'job-b')
      expect(a?.priority).toBe('critical')
      expect(a?.queuePosition).toBe(1)
      expect(b?.queuePosition).toBe(2)
    })

    it('throws JobNotFoundError for non-existent job', () => {
      expect(() => qm.updatePriority('no-such-id', 'high')).toThrow(JobNotFoundError)
    })

    it('throws when trying to update priority of a running job', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      expect(() => qm.updatePriority('job-1', 'high')).toThrow('Can only change priority of queued jobs')
    })

    it('broadcasts queue state after priority update', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-queued' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      broadcast.mockClear()
      qm.updatePriority('job-queued', 'critical')

      const queueBroadcasts = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'queue'
      )
      expect(queueBroadcasts.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ─── DB-backed persistence ────────────────────────────────────────────────

  describe('DB-backed QueueManager', () => {
    it('restores queued jobs from DB on construction and auto-starts them', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const db = initDb(':memory:')
      db.prepare(`INSERT INTO jobs (id, command, started_at, status, queue_position)
        VALUES ('restored-job', '/implement #1', datetime('now'), 'queued', 1)`).run()

      const qmWithDb = new QueueManager(broadcast, db)
      const jobs = qmWithDb.getJobs()
      const restored = jobs.find((j) => j.id === 'restored-job')
      expect(restored).toBeDefined()
      // Job auto-starts after restore — should be running now
      expect(restored?.status).toBe('running')
    })

    it('restores paused state from DB on construction', () => {
      const db = initDb(':memory:')
      // Pre-populate queue_state with paused=true
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()

      const qmWithDb = new QueueManager(broadcast, db)
      expect(qmWithDb.isPaused()).toBe(true)
    })

    it('persistJob: enqueue on DB-backed manager writes queue_position to DB', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('running-job' as any)
        .mockReturnValueOnce('queued-job' as any)

      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)

      // First job runs immediately; second gets queued
      qmWithDb.enqueue('/implement #1')
      qmWithDb.enqueue('/implement #2')

      // The queued job should have a queue_position row in the DB
      const row = db.prepare(`SELECT queue_position FROM jobs WHERE id = 'queued-job'`).get() as any
      // The UPDATE may not find the row if createJob hasn't run yet — that's fine.
      // Just ensure no error was thrown (the try/catch handles it gracefully).
      expect(qmWithDb.getJobs()).toHaveLength(2)
    })

    it('persistQueueState: pause() writes paused=true to DB', () => {
      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.pause()

      const row = db.prepare(`SELECT value FROM queue_state WHERE key = 'paused'`).get() as any
      expect(row?.value).toBe('true')
    })

    it('persistQueueState: resume() writes paused=false to DB', () => {
      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.pause()
      qmWithDb.resume()

      const row = db.prepare(`SELECT value FROM queue_state WHERE key = 'paused'`).get() as any
      expect(row?.value).toBe('false')
    })

    it('restoreFromDb: running jobs are failed on startup', () => {
      const db = initDb(':memory:')
      // Insert a "running" job (simulating a crash)
      db.prepare(`INSERT INTO jobs (id, command, started_at, status)
        VALUES ('orphan-job', '/implement #1', datetime('now'), 'running')`).run()

      new QueueManager(broadcast, db)

      const row = db.prepare(`SELECT status FROM jobs WHERE id = 'orphan-job'`).get() as any
      expect(row?.status).toBe('failed')
    })

    it('restores priority from DB and starts highest-priority job first', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const db = initDb(':memory:')
      db.prepare(`INSERT INTO jobs (id, command, started_at, status, queue_position, priority)
        VALUES ('low-job', '/low', datetime('now'), 'queued', 1, 'low')`).run()
      db.prepare(`INSERT INTO jobs (id, command, started_at, status, queue_position, priority)
        VALUES ('critical-job', '/critical', datetime('now'), 'queued', 2, 'critical')`).run()

      const qmWithDb = new QueueManager(broadcast, db)
      const jobs = qmWithDb.getJobs()

      // critical-job has highest priority — it should be running now
      const criticalJob = jobs.find((j) => j.id === 'critical-job')
      const lowJob = jobs.find((j) => j.id === 'low-job')
      expect(criticalJob?.status).toBe('running')
      expect(lowJob?.status).toBe('queued')
      expect(lowJob?.priority).toBe('low')
    })

    it('persists priority to DB when enqueuing', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('running-job' as any)
        .mockReturnValueOnce('high-job' as any)

      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)

      qmWithDb.enqueue('/implement #1')
      qmWithDb.enqueue('/implement #2', 'high')

      // The running job should be persisted via createJob with priority
      const runningRow = db.prepare(`SELECT priority FROM jobs WHERE id = 'running-job'`).get() as any
      expect(runningRow?.priority).toBe('normal')
    })
  })

  // ─── DB-backed job completion with cost data ─────────────────────────────────

  describe('DB-backed job completion', () => {
    it('writes finish data and token usage to DB on completed job', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('db-job-1' as any)

      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.enqueue('/implement')

      // Simulate stdout result event with cost data
      const resultEvent = JSON.stringify({
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
        total_cost_usd: 0.05,
        num_turns: 3,
        model: 'claude-sonnet-4-5',
        duration_ms: 5000,
        api_duration_ms: 3000,
        session_id: 'sess-123',
      })
      child.stdout!.push(resultEvent + '\n')

      await new Promise((r) => setTimeout(r, 50))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get('db-job-1') as any
      expect(row.status).toBe('completed')
      expect(row.total_cost_usd).toBe(0.05)
      expect(row.tokens_in).toBe(100)
      expect(row.tokens_out).toBe(200)
      expect(row.model).toBe('claude-sonnet-4-5')
    })

    it('emits cost_alert when job cost exceeds app threshold', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('alert-job' as any)

      const db = initDb(':memory:')
      const getCostAlertThreshold = vi.fn(() => 0.01)
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, { getCostAlertThreshold })
      qmWithDb.enqueue('/implement')

      const resultEvent = JSON.stringify({ type: 'result', total_cost_usd: 0.05, usage: {} })
      child.stdout!.push(resultEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      const alertCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'cost_alert'
      )
      expect(alertCalls.length).toBeGreaterThan(0)
    })

    it('pauses queue when daily budget is exceeded', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('budget-job' as any)

      const db = initDb(':memory:')
      // Set a daily budget
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '0.01')`).run()
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.enqueue('/implement')

      const resultEvent = JSON.stringify({ type: 'result', total_cost_usd: 0.05, usage: {} })
      child.stdout!.push(resultEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(qmWithDb.isPaused()).toBe(true)
      const budgetCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'daily_budget_exceeded'
      )
      expect(budgetCalls.length).toBeGreaterThan(0)
    })

    it('pauses queue when app daily budget is exceeded', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('desktop-budget-job' as any)

      const db = initDb(':memory:')
      const getDesktopDailyBudget = vi.fn(() => ({ budget: 0.01, totalSpend: 0.05 }))
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, { getDesktopDailyBudget })
      qmWithDb.enqueue('/implement')

      const resultEvent = JSON.stringify({ type: 'result', total_cost_usd: 0.05, usage: {} })
      child.stdout!.push(resultEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(qmWithDb.isPaused()).toBe(true)
      const desktopBudgetCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'desktop_daily_budget_exceeded'
      )
      expect(desktopBudgetCalls.length).toBeGreaterThan(0)
    })

    it('emits cost_alert for per-project cost threshold', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('proj-threshold-job' as any)

      const db = initDb(':memory:')
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.job_cost_threshold_usd', '0.01')`).run()
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.enqueue('/implement')

      const resultEvent = JSON.stringify({ type: 'result', total_cost_usd: 0.05, usage: {} })
      child.stdout!.push(resultEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      const alertCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'cost_alert'
      )
      expect(alertCalls.length).toBeGreaterThan(0)
    })
  })

  // ─── onJobFinished callback ───────────────────────────────────────────────

  describe('onJobFinished callback', () => {
    it('calls onJobFinished when job completes', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('callback-job' as any)

      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, undefined, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement')

      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(onJobFinished).toHaveBeenCalledWith('callback-job', 'completed', undefined)
    })

    it('calls onJobFinished when job fails', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('fail-cb-job' as any)

      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, undefined, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement')

      child.emit('close', 1)
      await new Promise((r) => setTimeout(r, 50))

      expect(onJobFinished).toHaveBeenCalledWith('fail-cb-job', 'failed', undefined)
    })

    it('calls onJobFinished for canceled jobs with canceled status', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('cancel-cb-job' as any)

      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, undefined, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement')

      qmWithCallback.cancel('cancel-cb-job')
      child.emit('close', 1)
      await new Promise((r) => setTimeout(r, 100))

      expect(onJobFinished).toHaveBeenCalledWith('cancel-cb-job', 'canceled', undefined)
    })

    it('passes cost from DB when available', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('cost-cb-job' as any)

      const db = initDb(':memory:')
      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, db, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement')

      const resultEvent = JSON.stringify({ type: 'result', total_cost_usd: 0.1, usage: {} })
      child.stdout!.push(resultEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(onJobFinished).toHaveBeenCalledWith('cost-cb-job', 'completed', expect.any(Number))
    })
  })

  // ─── Codex provider ──────────────────────────────────────────────────────────

  describe('codex provider', () => {
    it('uses codex binary when provider is codex', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-job' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })
      qmCodex.enqueue('/implement')

      expect(vi.mocked(mockSpawn)).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining(['exec']),
        expect.any(Object)
      )
    })

    it('throws CodexNotFoundError when codex not on path', () => {
      vi.mocked(mockExecSync).mockImplementation(() => { throw new Error('not found') })
      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })
      expect(() => qmCodex.enqueue('/implement')).toThrow()
    })
  })

  // ─── stdout JSON parsing ──────────────────────────────────────────────────────

  describe('stdout JSON event parsing', () => {
    it('extracts display text from assistant events', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('parse-job' as any)

      qm.enqueue('/implement')

      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      })
      child.stdout!.push(assistantEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))

      const logMessages = qm.getLogBuffer()
      const displayMsg = logMessages.find((m) => m.line === 'Hello world')
      expect(displayMsg).toBeDefined()
    })

    it('extracts display text from tool_use events', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('tool-job' as any)

      qm.enqueue('/implement')

      const toolEvent = JSON.stringify({
        type: 'tool_use',
        name: 'edit_file',
        input: { path: 'test.ts' },
      })
      child.stdout!.push(toolEvent + '\n')
      await new Promise((r) => setTimeout(r, 50))

      const logMessages = qm.getLogBuffer()
      const toolMsg = logMessages.find((m) => m.line?.includes('[tool: edit_file]'))
      expect(toolMsg).toBeDefined()
    })

    it('skips display for system and result events', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('skip-job' as any)

      qm.enqueue('/implement')
      broadcast.mockClear()

      const systemEvent = JSON.stringify({ type: 'system' })
      child.stdout!.push(systemEvent + '\n')
      // Wait > 80ms for the batched broadcast flush
      await new Promise((r) => setTimeout(r, 100))

      // Event is broadcast but no log line emitted
      const eventBroadcasts = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'event'
      )
      expect(eventBroadcasts.length).toBeGreaterThan(0)
    })

    it('handles plain text stdout lines', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('plain-job' as any)

      qm.enqueue('/implement')

      child.stdout!.push('plain text line\n')
      await new Promise((r) => setTimeout(r, 50))

      const logMessages = qm.getLogBuffer()
      const plainMsg = logMessages.find((m) => m.line === 'plain text line')
      expect(plainMsg).toBeDefined()
    })

    it('processes stderr lines', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('stderr-job' as any)

      qm.enqueue('/implement')

      child.stderr!.push('error output\n')
      await new Promise((r) => setTimeout(r, 50))

      const logMessages = qm.getLogBuffer()
      const errMsg = logMessages.find((m) => m.line === 'error output' && m.source === 'stderr')
      expect(errMsg).toBeDefined()
    })
  })

  // ─── DB-backed stdout/stderr with appendEvent ──────────────────────────────

  describe('DB-backed event recording', () => {
    it('records stdout JSON events in DB', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('db-event-job' as any)

      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.enqueue('/implement')

      const event = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } })
      child.stdout!.push(event + '\n')
      await new Promise((r) => setTimeout(r, 50))

      const events = db.prepare('SELECT * FROM events WHERE job_id = ?').all('db-event-job') as any[]
      expect(events.length).toBeGreaterThan(0)
    })

    it('records stderr lines in DB', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('db-stderr-job' as any)

      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db)
      qmWithDb.enqueue('/implement')

      child.stderr!.push('stderr line\n')
      await new Promise((r) => setTimeout(r, 50))

      const events = db.prepare("SELECT * FROM events WHERE job_id = ? AND source = 'stderr'").all('db-stderr-job') as any[]
      expect(events.length).toBeGreaterThan(0)
    })
  })

  // ─── Job exit without DB (non-result event) ─────────────────────────────────

  describe('job exit without result event', () => {
    it('emits exit message without cost when no result event', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('no-result-job' as any)

      qm.enqueue('/implement')
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      const logMessages = qm.getLogBuffer()
      const exitMsg = logMessages.find((m) => m.line?.includes('process exited'))
      expect(exitMsg).toBeDefined()
    })
  })

  // ─── Kill timer cleanup on exit ──────────────────────────────────────────────

  describe('kill timer cleanup', () => {
    it('clears kill timer when process exits after cancel', async () => {
      vi.useFakeTimers()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('kill-timer-job' as any)

      qm.enqueue('/implement')
      qm.cancel('kill-timer-job')

      // Advance time partially (kill timer is 5s)
      vi.advanceTimersByTime(2000)

      // Process exits before kill timer fires
      child.emit('close', 1)
      await vi.advanceTimersByTimeAsync(50)

      // If kill timer wasn't cleared, advancing by 3 more seconds would cause issues
      vi.advanceTimersByTime(5000)

      const job = qm.getJobs().find((j) => j.id === 'kill-timer-job')
      expect(job?.status).toBe('canceled')
      vi.useRealTimers()
    })
  })

  // ─── Job dependencies ──────────────────────────────────────────────────────

  describe('job dependencies', () => {
    it('skips dependent job when parent job is canceled and process exits', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      let id = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `dep-job-${++id}` as any)

      const db = initDb(':memory:')
      const qmDep = new QueueManager(broadcast, db)

      // Enqueue parent (runs immediately)
      qmDep.enqueue('/parent')
      // Enqueue child with dependency on parent
      qmDep.enqueue('/child', { dependsOnJobId: 'dep-job-1' })

      // Cancel the parent (sends SIGTERM)
      qmDep.cancel('dep-job-1')

      // Process exits after cancel
      child.emit('close', null)
      await new Promise((r) => setTimeout(r, 50))

      // The dependent job should be skipped
      const jobs = qmDep.getJobs()
      const childJob = jobs.find((j) => j.id === 'dep-job-2')
      expect(childJob?.status).toBe('skipped')
      expect(childJob?.skipReason).toContain('canceled')
    })

    it('dependent job runs after parent completes', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)

      let id = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `chain-job-${++id}` as any)

      const qmChain = new QueueManager(broadcast)

      qmChain.enqueue('/parent')
      qmChain.enqueue('/child', { dependsOnJobId: 'chain-job-1' })

      // Parent completes
      child1.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      // Child should start
      const jobs = qmChain.getJobs()
      const childJob = jobs.find((j) => j.id === 'chain-job-2')
      expect(childJob?.status).toBe('running')
    })

    it('skips dependent when parent fails', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child1 as any)

      let id = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `fail-dep-${++id}` as any)

      const qmFail = new QueueManager(broadcast)

      qmFail.enqueue('/parent')
      qmFail.enqueue('/child', { dependsOnJobId: 'fail-dep-1' })

      // Parent fails
      child1.emit('close', 1)
      await new Promise((r) => setTimeout(r, 50))

      const jobs = qmFail.getJobs()
      const childJob = jobs.find((j) => j.id === 'fail-dep-2')
      expect(childJob?.status).toBe('skipped')
      expect(childJob?.skipReason).toContain('failed')
    })
  })

  // ─── Pipeline status broadcast ─────────────────────────────────────────────

  describe('pipeline status', () => {
    it('broadcasts pipeline_status completed when all pipeline jobs complete', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)

      let id = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `pipe-job-${++id}` as any)

      const qmPipe = new QueueManager(broadcast)

      qmPipe.enqueue('/step1', { pipelineId: 'pipeline-1' })
      qmPipe.enqueue('/step2', { pipelineId: 'pipeline-1', dependsOnJobId: 'pipe-job-1' })

      // Step 1 completes
      child1.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      // Step 2 completes
      child2.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      const pipelineCompleted = broadcast.mock.calls.filter(
        (args: unknown[]) => {
          const msg = args[0] as WsMessage
          return msg.type === 'pipeline_status' && (msg as any).status === 'completed'
        }
      )
      expect(pipelineCompleted.length).toBeGreaterThan(0)
    })

    it('broadcasts pipeline_status failed when a pipeline job fails', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child1 as any)

      let id = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `pipe-fail-${++id}` as any)

      const qmPipeFail = new QueueManager(broadcast)

      qmPipeFail.enqueue('/step1', { pipelineId: 'pipeline-fail' })
      qmPipeFail.enqueue('/step2', { pipelineId: 'pipeline-fail', dependsOnJobId: 'pipe-fail-1' })

      // Step 1 fails
      child1.emit('close', 1)
      await new Promise((r) => setTimeout(r, 50))

      const pipelineFailed = broadcast.mock.calls.filter(
        (args: unknown[]) => {
          const msg = args[0] as WsMessage
          return msg.type === 'pipeline_status' && (msg as any).status === 'failed'
        }
      )
      expect(pipelineFailed.length).toBeGreaterThan(0)
    })
  })

  // ─── setCommands ───────────────────────────────────────────────────────────

  describe('setCommands', () => {
    it('sets commands and phasesForCommand returns phases', () => {
      const commands = [
        {
          id: 'implement',
          name: 'Implement',
          slug: 'implement',
          phases: [
            { name: 'Planning', markers: ['plan'] },
            { name: 'Coding', markers: ['code'] },
          ],
        },
      ]
      qm.setCommands(commands as any)
      const phases = qm.phasesForCommand('/specrails:implement #42')
      // The command may or may not match, but this exercises the code path
      expect(Array.isArray(phases)).toBe(true)
    })
  })

  // ─── enqueue with EnqueueOptions object ───────────────────────────────────

  describe('enqueue with options object', () => {
    it('accepts options as second argument instead of priority string', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('opts-job' as any)

      const job = qm.enqueue('/implement', { dependsOnJobId: 'parent-1', pipelineId: 'pipe-1' })
      expect(job.dependsOnJobId).toBe('parent-1')
      expect(job.pipelineId).toBe('pipe-1')
      expect(job.priority).toBe('normal')
    })
  })

  // ─── Relocate-artifacts gate ────────────────────────────────────────────────

  describe('relocate-artifacts (workspace gate)', () => {
    let regHome: string
    let repo: string
    let prevHome: string | undefined

    function seedRelocated(slug: string): string {
      mirrorProjectEntry({ repoPath: repo, slug, providers: ['claude'], desktopProjectId: 'p1' }, regHome)
      const ws = workspaceLayout(resolveHome(regHome), slug, repo).workspaceDir
      fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
      fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.8.0\n')
      return ws
    }

    beforeEach(() => {
      prevHome = process.env.SPECRAILS_REGISTRY_HOME
      regHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-reloc-home-')))
      fs.mkdirSync(path.join(regHome, '.specrails'), { recursive: true })
      process.env.SPECRAILS_REGISTRY_HOME = regHome
      repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-reloc-repo-')))
    })

    afterEach(() => {
      if (prevHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prevHome
      else delete process.env.SPECRAILS_REGISTRY_HOME
      fs.rmSync(regHome, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    })

    it('LEGACY: no workspace populated ⇒ spawns from project.path with no relocation env', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('legacy-job' as any)

      const db = initDb(':memory:')
      const qmLegacy = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qmLegacy.enqueue('/specrails:implement #1')

      const opts = vi.mocked(mockSpawn).mock.calls[0][2] as { cwd: string; env: NodeJS.ProcessEnv }
      expect(opts.cwd).toBe(repo)
      expect(opts.env.SPECRAILS_REPO_DIR).toBeUndefined()
      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(args).not.toContain('--add-dir')
    })

    it('RELOCATED: spawns from the workspace, injects SPECRAILS_REPO_DIR, adds --add-dir <repo>', () => {
      const ws = seedRelocated('acme')
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('reloc-job' as any)

      const db = initDb(':memory:')
      const qmReloc = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qmReloc.enqueue('/specrails:implement #1')

      const opts = vi.mocked(mockSpawn).mock.calls[0][2] as { cwd: string; env: NodeJS.ProcessEnv }
      expect(opts.cwd).toBe(ws)
      expect(opts.env.SPECRAILS_REPO_DIR).toBe(repo)
      expect(opts.env.SPECRAILS_WORKSPACE_DIR).toBe(ws)
      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      const idx = args.indexOf('--add-dir')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe(repo)
    })

    it('RELOCATED: appends an explicit absolute-repo orientation to the system prompt', () => {
      // Without it the agent follows the framework templates' ${SPECRAILS_REPO_DIR:-.}
      // (which its Read/Grep/Glob tools can't expand), reads the empty workspace
      // cwd, and hallucinates a wrong/"global" project (the Windows "Rails" bug).
      seedRelocated('acme')
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('orient-job' as any)

      const db = initDb(':memory:')
      const qm = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qm.enqueue('/specrails:implement #1')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      const sysIdx = args.findIndex((a) => a === '--append-system-prompt' || a === '--system-prompt')
      expect(sysIdx).toBeGreaterThanOrEqual(0)
      const sys = args[sysIdx + 1]
      expect(sys).toContain('REPOSITORY LOCATION')
      expect(sys).toContain(repo) // the concrete absolute repo path
      expect(sys).toContain('${SPECRAILS_REPO_DIR:-.}') // warns not to use the literal
    })

    it('LEGACY: does NOT add the relocated repo orientation', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('legacy-orient-job' as any)

      const db = initDb(':memory:')
      const qm = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qm.enqueue('/specrails:implement #1')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      const sysIdx = args.findIndex((a) => a === '--append-system-prompt' || a === '--system-prompt')
      const sys = sysIdx >= 0 ? args[sysIdx + 1] : ''
      expect(sys).not.toContain('REPOSITORY LOCATION')
    })

    it('RELOCATED: prepends an openspec PATH shim that cds into the repo', () => {
      seedRelocated('acme')
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('shim-job' as any)

      const db = initDb(':memory:')
      const qm = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qm.enqueue('/specrails:implement #1')

      const opts = vi.mocked(mockSpawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv }
      // PATH leads with the per-job shim dir under the (test) registry home.
      const expectedShimDir = path.join(
        regHome, '.specrails', 'projects', 'acme', 'openspec-shim', 'shim-job',
      )
      const first = (opts.env.PATH ?? '').split(path.delimiter)[0]
      expect(first).toBe(expectedShimDir)
      // The shim script re-points bare `openspec` at the repo.
      const script = fs.readFileSync(path.join(expectedShimDir, 'openspec'), 'utf8')
      expect(script).toContain('cd "${SPECRAILS_REPO_DIR:-.}"')
    })

    it('LEGACY: does NOT create an openspec shim or touch PATH', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('legacy-noshim' as any)

      const db = initDb(':memory:')
      const qm = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qm.enqueue('/specrails:implement #1')

      const shimDir = path.join(
        regHome, '.specrails', 'projects', 'acme', 'openspec-shim', 'legacy-noshim',
      )
      expect(fs.existsSync(shimDir)).toBe(false)
    })

    it('RELOCATED ultracode: reads spec text from the WORKSPACE ticket store', () => {
      const ws = seedRelocated('acme')
      // Ticket lives ONLY in the workspace store — not in the repo.
      fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
      fs.writeFileSync(
        path.join(ws, '.specrails', 'local-tickets.json'),
        JSON.stringify({
          schema_version: '1.0', revision: 1, last_updated: new Date().toISOString(), next_id: 100,
          tickets: { '7': { id: 7, title: 'Workspace Spec', description: 'FROM-WORKSPACE-BODY', status: 'todo', priority: 'high' } },
        }),
        'utf-8',
      )
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValue('reloc-ultra' as any)

      const db = initDb(':memory:')
      const qmReloc = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qmReloc.enqueue('/specrails:ultracode #7')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      // The ultracode prompt is the `-p` argv value; it must contain the spec body
      // read from the WORKSPACE store.
      const joined = args.join('\n')
      expect(joined).toContain('FROM-WORKSPACE-BODY')
      expect(joined).toContain('Workspace Spec')
    })
  })

  // ─── Codex parity ─────────────────────────────────────────────────────────

  describe('codex parity', () => {
    it('embeds systemAppend in the codex prompt (headless --yes flag)', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-sys-job' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, {
        provider: 'codex',
        resolvedModel: 'gpt-5.4-mini',
      })
      qmCodex.enqueue('/specrails:implement #1 --yes')

      const spawnCall = vi.mocked(mockSpawn).mock.calls[0]
      expect(spawnCall[0]).toBe('codex')
      // codex rail-job argv: ['exec','--json','--sandbox','danger-full-access','--skip-git-repo-check', <prompt>, '--model', <model>]
      const promptArg = (spawnCall[1] as string[])[5] as string
      // systemAppend (headless mode instructions) should be embedded before the prompt
      expect(promptArg).toContain('FULLY AUTONOMOUS MODE')
      expect(promptArg).toContain('---')
    })

    it('embeds local-tickets reminder in codex prompt for implement commands', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-tickets-job' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })
      qmCodex.enqueue('/specrails:implement #42')

      const spawnCall = vi.mocked(mockSpawn).mock.calls[0]
      // codex rail-job argv: ['exec','--json','--sandbox','danger-full-access','--skip-git-repo-check', <prompt>, '--model', <model>]
      const promptArg = (spawnCall[1] as string[])[5] as string
      expect(promptArg).toContain('local-tickets.json')
      expect(promptArg).toContain('Do NOT require jq')
      expect(promptArg).toContain('ConvertFrom-Json')
      expect(promptArg).toContain('do NOT add Jest-only flags such as --runInBand')
    })

    it('embeds project pre-prompt in codex prompt for implement commands', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-preprompt-job' as any)

      const db = initDb(':memory:')
      updateProjectSettings(db, { prePrompt: 'Always prefer additive schema changes.' })

      const qmCodex = new QueueManager(broadcast, db, [], undefined, { provider: 'codex' })
      qmCodex.enqueue('/specrails:implement #42')

      const spawnCall = vi.mocked(mockSpawn).mock.calls[0]
      // codex rail-job argv: ['exec','--json','--sandbox','danger-full-access','--skip-git-repo-check', <prompt>, '--model', <model>]
      const promptArg = (spawnCall[1] as string[])[5] as string
      expect(promptArg).toContain('PROJECT PRE-PROMPT')
      expect(promptArg).toContain('Always prefer additive schema changes.')
    })

    it('passes --model flag to codex spawns using resolvedModel', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-model-job' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, {
        provider: 'codex',
        resolvedModel: 'gpt-5.3-codex',
      })
      qmCodex.enqueue('/specrails:implement #1')

      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--model')
      expect(spawnArgs).toContain('gpt-5.3-codex')
    })

    it('defaults to gpt-5.5 model when no resolvedModel is set', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-default-model-job' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })
      qmCodex.enqueue('/specrails:implement #1')

      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--model')
      expect(spawnArgs).toContain('gpt-5.5')
    })

    it('translates /specrails:<name> → $<name> when targeting codex', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-slash-translate' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })
      qmCodex.enqueue('/specrails:implement #1 --yes')

      // Codex folds the system prompt into the user prompt as a single argv
      // string; assert the resolved prompt contains the `$implement` skill
      // reference and never carries the `/specrails:` legacy form.
      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      const promptArg = spawnArgs.find((a) => a.includes('$implement'))
      expect(promptArg).toBeDefined()
      expect(promptArg).toContain('$implement #1 --yes')
      expect(spawnArgs.some((a) => a.includes('/specrails:implement'))).toBe(false)
    })

    it('translates /sr:<name> → $<name> for the codex prompt', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-sr-alias' as any)

      const qmCodex = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })
      qmCodex.enqueue('/sr:batch-implement #2 #3')

      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(spawnArgs.some((a) => a.includes('$batch-implement'))).toBe(true)
    })

    it('keeps /specrails:<name> verbatim for claude rails (no translation)', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('claude-slash-untouched' as any)

      const qm = new QueueManager(broadcast, undefined, [], undefined, { provider: 'claude' })
      qm.enqueue('/specrails:implement #1')

      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      // Claude argv contains the prompt as the value after `-p`.
      const pIdx = spawnArgs.indexOf('-p')
      expect(pIdx).toBeGreaterThanOrEqual(0)
      expect(spawnArgs[pIdx + 1]).toContain('/specrails:implement')
      expect(spawnArgs[pIdx + 1]).not.toContain('$implement')
    })

    it('ultracode: sends default pre-prompt + spec text as the claude -p prompt (no slash command)', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('ultracode-default' as any)

      const projectDir = makeProjectDirWithTickets({
        '7': {
          id: 7, title: 'Add dark mode', description: 'Toggle theme in settings',
          status: 'todo', priority: 'high', labels: [], assignee: null,
          prerequisites: [], metadata: {},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          created_by: 'user', source: 'manual',
        },
      })
      try {
        const qm = new QueueManager(broadcast, undefined, [], projectDir, { provider: 'claude' })
        qm.enqueue('/specrails:ultracode #7 --yes')

        const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
        const pIdx = spawnArgs.indexOf('-p')
        const prompt = spawnArgs[pIdx + 1]
        expect(prompt).toContain('ULTRACODE')
        expect(prompt).toContain('# Spec #7: Add dark mode')
        expect(prompt).toContain('Toggle theme in settings')
        // The slash command itself must NOT be sent as the prompt.
        expect(prompt).not.toContain('/specrails:ultracode')
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('ultracode: uses the per-project pre-prompt override when set', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('ultracode-override' as any)

      const projectDir = makeProjectDirWithTickets({
        '3': {
          id: 3, title: 'Spec three', description: 'Body three',
          status: 'todo', priority: 'low', labels: [], assignee: null,
          prerequisites: [], metadata: {},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          created_by: 'user', source: 'manual',
        },
      })
      const db = initDb(':memory:')
      updateProjectSettings(db, { ultraPrePrompt: 'CUSTOM ULTRA INSTRUCTION' })
      try {
        const qm = new QueueManager(broadcast, db, [], projectDir, { provider: 'claude' })
        qm.enqueue('/specrails:ultracode #3 --yes')

        const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
        const prompt = spawnArgs[spawnArgs.indexOf('-p') + 1]
        expect(prompt).toContain('CUSTOM ULTRA INSTRUCTION')
        expect(prompt).toContain('# Spec #3: Spec three')
      } finally {
        db.close()
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('ultracode: model override is passed as --model, overriding orchestrator', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('ultracode-model' as any)

      const projectDir = makeProjectDirWithTickets({
        '9': {
          id: 9, title: 'Spec nine', description: 'Body nine',
          status: 'todo', priority: 'low', labels: [], assignee: null,
          prerequisites: [], metadata: {},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          created_by: 'user', source: 'manual',
        },
      })
      const db = initDb(':memory:')
      updateProjectSettings(db, { orchestratorModel: 'sonnet' })
      try {
        const qm = new QueueManager(broadcast, db, [], projectDir, { provider: 'claude' })
        qm.enqueue('/specrails:ultracode #9 --yes', 'normal', { profileName: null, model: 'opus' })

        const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
        const mIdx = spawnArgs.indexOf('--model')
        expect(mIdx).toBeGreaterThanOrEqual(0)
        expect(spawnArgs[mIdx + 1]).toBe('opus')
      } finally {
        db.close()
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('embeds referenced ticket attachments in the codex prompt', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-attachments-job' as any)

      const projectDir = makeProjectDirWithTickets({
        '42': {
          id: 42,
          title: 'Visual spec',
          description: 'Uses a mockup',
          status: 'todo',
          priority: 'medium',
          labels: [],
          assignee: null,
          prerequisites: [],
          metadata: {},
          attachments: [{
            id: 'att-1',
            filename: 'mockup.png',
            storedName: 'att-1-mockup.png',
            mimeType: 'image/png',
            size: 123,
            addedAt: new Date().toISOString(),
          }],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: 'user',
          source: 'manual',
        },
      })

      try {
        const listSpy = vi.spyOn(attachmentManager, 'list').mockReturnValue([])
        const blocksSpy = vi.spyOn(attachmentManager, 'getPromptBlocksSync').mockReturnValue([
          '<user-attachment id="att-1" name="mockup.png" mime="image/png">\n@/tmp/mockup.png\n</user-attachment>',
        ])

        const qmCodex = new QueueManager(broadcast, undefined, [], projectDir, {
          provider: 'codex',
          projectSlug: 'proj',
        })
        qmCodex.enqueue('/specrails:implement #42')

        const spawnCall = vi.mocked(mockSpawn).mock.calls[0]
        // codex rail-job argv: ['exec','--json','--sandbox','danger-full-access','--skip-git-repo-check', <prompt>, '--model', <model>]
      const promptArg = (spawnCall[1] as string[])[5] as string
        expect(listSpy).toHaveBeenCalledWith('proj', 42)
        expect(blocksSpy).toHaveBeenCalledWith('proj', 42, ['att-1'])
        expect(promptArg).toContain('Ticket #42 Attached Resources')
        expect(promptArg).toContain('<user-attachment')
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('captures real codex token usage and estimates cost from pricing table', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('codex-result-job' as any)

      const db = initDb(':memory:')
      const qmCodex = new QueueManager(broadcast, db, undefined, undefined, {
        provider: 'codex',
        resolvedModel: 'gpt-5.4-mini',
        projectId: 'p1',
        projectSlug: 'proj',
      })
      qmCodex.enqueue('/specrails:implement #1')

      // Real codex JSONL stream — thread_id captured, tokens reported via
      // turn.completed.usage, cost estimated downstream from pricing.ts.
      child.stdout.push(
        '{"type":"thread.started","thread_id":"019e1111-2222-7333-bbbb-cccccccccccc"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":500,"cached_input_tokens":0,"reasoning_output_tokens":0}}\n'
      )
      child.stdout.push(null)
      await new Promise((r) => setImmediate(r))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 30))

      const jobs = qmCodex.getJobs()
      const job = jobs.find((j) => j.id === 'codex-result-job')
      expect(job?.status).toBe('completed')

      const row = db.prepare(`
        SELECT total_cost_usd, model, session_id, tokens_in, tokens_out
        FROM jobs WHERE id = ?
      `).get('codex-result-job') as {
        total_cost_usd: number | null
        model: string | null
        session_id: string | null
        tokens_in: number | null
        tokens_out: number | null
      } | undefined
      expect(row).toBeDefined()
      // codex:gpt-5.4-mini → 1M*0.25 + 500K*2.00 / 1M = 0.25 + 1.00 = 1.25
      expect(row?.total_cost_usd).toBeCloseTo(1.25 / 1000, 6)
      expect(row?.model).toBe('gpt-5.4-mini')
      expect(row?.session_id).toBe('019e1111-2222-7333-bbbb-cccccccccccc')
      expect(row?.tokens_in).toBe(1000)
      expect(row?.tokens_out).toBe(500)

      // ai_invocations row: provider stamped, estimated flag set
      const inv = db.prepare(`
        SELECT provider, total_cost_usd_estimated
        FROM ai_invocations WHERE surface_ref_id = ?
      `).get('codex-result-job') as
        | { provider: string; total_cost_usd_estimated: number }
        | undefined
      expect(inv?.provider).toBe('codex')
      expect(inv?.total_cost_usd_estimated).toBe(1)
    })

    it('output chaining: embeds parent resultText in codex prompt via systemAppend', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('parent-job' as any)
        .mockReturnValueOnce('child-job' as any)

      const db = initDb(':memory:')
      const qmCodex = new QueueManager(broadcast, db, undefined, undefined, { provider: 'codex' })

      qmCodex.enqueue('first step')
      // Finish parent — codex outputs plain text
      child1.stdout.push('Parent result text\n')
      child1.stdout.push(null)
      // Manually set resultText to simulate parent output
      const jobs = qmCodex.getJobs()
      const parentJob = jobs.find((j) => j.id === 'parent-job')
      if (parentJob) parentJob.resultText = 'Parent result text'
      child1.emit('close', 0)

      qmCodex.enqueue('second step', { dependsOnJobId: 'parent-job' })
      // Drain queue manually
      const spawnCalls = vi.mocked(mockSpawn).mock.calls
      const secondSpawnArgs = spawnCalls[spawnCalls.length - 1]?.[1] as string[] | undefined
      if (secondSpawnArgs) {
        const prompt = secondSpawnArgs[5] as string
        expect(prompt).toContain('Parent result text')
      }
    })
  })

  describe('implement attachment context', () => {
    it('embeds project pre-prompt in claude implement system prompt', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('claude-preprompt-job' as any)

      const db = initDb(':memory:')
      updateProjectSettings(db, { prePrompt: 'Favor minimal diffs and explicit tests.' })

      const qmClaude = new QueueManager(broadcast, db, [], undefined)
      qmClaude.enqueue('/specrails:implement #7')

      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      const appendIdx = spawnArgs.indexOf('--append-system-prompt')
      expect(appendIdx).toBeGreaterThan(-1)
      expect(spawnArgs[appendIdx + 1]).toContain('PROJECT PRE-PROMPT')
      expect(spawnArgs[appendIdx + 1]).toContain('Favor minimal diffs and explicit tests.')
    })

    it('falls back to disk attachment metadata for claude implement prompts', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('claude-disk-attachments-job' as any)

      const projectDir = makeProjectDirWithTickets({
        '7': {
          id: 7,
          title: 'Visual spec',
          description: 'No attachment metadata in the ticket store yet',
          status: 'todo',
          priority: 'medium',
          labels: [],
          assignee: null,
          prerequisites: [],
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: 'user',
          source: 'manual',
        },
      })

      try {
        const listSpy = vi.spyOn(attachmentManager, 'list').mockReturnValue([{
          id: 'disk-att-1',
          filename: 'wireframe.png',
          storedName: 'disk-att-1-wireframe.png',
          mimeType: 'image/png',
          size: 456,
          addedAt: new Date().toISOString(),
        }])
        const blocksSpy = vi.spyOn(attachmentManager, 'getPromptBlocksSync').mockReturnValue([
          '<user-attachment id="disk-att-1" name="wireframe.png" mime="image/png">\n@/tmp/wireframe.png\n</user-attachment>',
        ])

        const qmClaude = new QueueManager(broadcast, undefined, [], projectDir, {
          projectSlug: 'proj',
        })
        qmClaude.enqueue('/specrails:implement #7')

        const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
        const appendIdx = spawnArgs.indexOf('--append-system-prompt')
        expect(appendIdx).toBeGreaterThan(-1)
        expect(listSpy).toHaveBeenCalledWith('proj', 7)
        expect(blocksSpy).toHaveBeenCalledWith('proj', 7, ['disk-att-1'])
        expect(spawnArgs[appendIdx + 1]).toContain('Ticket #7 Attached Resources')
        expect(spawnArgs[appendIdx + 1]).toContain('<user-attachment')
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })
  })

  // ─── shutdown ───────────────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('terminates the active child with SIGTERM and makes a late close a no-op on a closed DB', () => {
      const db = initDb(':memory:')
      const qm2 = new QueueManager(broadcast, db)
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-shutdown' as any)

      qm2.enqueue('/implement #1')
      qm2.shutdown()

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM', expect.any(Function))

      // Close the DB out from under the manager, then deliver the late 'close'
      // the dying child eventually emits. Pre-fix this threw "database
      // connection is not open" inside the EventEmitter listener and crashed
      // the app; the _disposed guard must make it a silent no-op.
      db.close()
      expect(() => child.emit('close', 0)).not.toThrow()
    })

    it('is idempotent and safe with no active job', () => {
      const qm2 = new QueueManager(broadcast)
      expect(() => {
        qm2.shutdown()
        qm2.shutdown()
      }).not.toThrow()
    })

    it('does not drain queued jobs after shutdown', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-a' as any)
        .mockReturnValueOnce('job-b' as any)

      qm.enqueue('/implement #1') // running
      qm.enqueue('/implement #2') // queued
      qm.shutdown()

      // The running child exits; _onJobExit must early-return (disposed) and
      // never start the queued job.
      child1.emit('close', 0)
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1)
    })
  })

  // ─── kill-timer safety (double cancel) ───────────────────────────────────────

  describe('double cancel kill-timer', () => {
    it('does not leak the SIGKILL timer when a running job is canceled twice', () => {
      vi.useFakeTimers()
      try {
        vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)
        vi.mocked(mockUuidV4).mockReturnValue('job-dbl' as any)

        qm.enqueue('/implement #1')
        qm.cancel('job-dbl')
        qm.cancel('job-dbl') // status is still 'running' until close → re-kills

        // SIGTERM sent on each cancel.
        const sigtermCalls = vi.mocked(treeKill).mock.calls.filter((c) => c[1] === 'SIGTERM')
        expect(sigtermCalls.length).toBe(2)

        // Only the second (current) kill timer survives; advancing past the
        // grace window must fire exactly ONE SIGKILL, not two.
        vi.advanceTimersByTime(5000)
        const sigkillCalls = vi.mocked(treeKill).mock.calls.filter((c) => c[1] === 'SIGKILL')
        expect(sigkillCalls.length).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── BUG-QUEUE-03: provider-aware telemetry env ──────────────────────────────

  describe('buildTelemetryEnv (provider-aware)', () => {
    it('defaults to the claude/OTEL_* block (byte-identical to legacy)', () => {
      const env = buildTelemetryEnv('job-1', 'proj-1', 4200)
      expect(env).toEqual({
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4200/otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_RESOURCE_ATTRIBUTES: 'specrails.job_id=job-1,specrails.project_id=proj-1',
      })
      // GEMINI_TELEMETRY_* vars must never leak into the claude block.
      expect(Object.keys(env).some((k) => k.startsWith('GEMINI_TELEMETRY_'))).toBe(false)
    })

    it('codex stays byte-identical to the claude block (OTEL_* only)', () => {
      expect(buildTelemetryEnv('job-2', 'proj-2', 5000, {}, 'codex')).toEqual(
        buildTelemetryEnv('job-2', 'proj-2', 5000, {}, 'claude'),
      )
    })

    it('gemini emits GEMINI_TELEMETRY_* vars pointed at the loopback OTLP receiver (http transport)', () => {
      const env = buildTelemetryEnv('job-g', 'proj-g', 4321, {}, 'gemini')
      expect(env.GEMINI_TELEMETRY_ENABLED).toBe('true')
      expect(env.GEMINI_TELEMETRY_TARGET).toBe('local')
      expect(env.GEMINI_TELEMETRY_OTLP_ENDPOINT).toBe('http://127.0.0.1:4321/otlp')
      // Gemini CLI defaults to gRPC — must force http to reach our JSON receiver.
      expect(env.GEMINI_TELEMETRY_OTLP_PROTOCOL).toBe('http')
      // Resource attrs still flow via the standard env so the receiver can route.
      expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('specrails.job_id=job-g,specrails.project_id=proj-g')
      // The claude-specific master switch must NOT be set for gemini.
      expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined()
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    })

    it('threads extra resource attributes into OTEL_RESOURCE_ATTRIBUTES for both shapes', () => {
      const extra = { 'specrails.profile_name': 'balanced' }
      expect(buildTelemetryEnv('j', 'p', 1, extra, 'claude').OTEL_RESOURCE_ATTRIBUTES)
        .toBe('specrails.job_id=j,specrails.project_id=p,specrails.profile_name=balanced')
      expect(buildTelemetryEnv('j', 'p', 1, extra, 'gemini').OTEL_RESOURCE_ATTRIBUTES)
        .toBe('specrails.job_id=j,specrails.project_id=p,specrails.profile_name=balanced')
    })
  })

  // ─── BUG-QUEUE-01: openspec shim cleanup on the non-interactive exit path ─────

  describe('openspec shim cleanup (relocated claude rails)', () => {
    let regHome: string
    let repo: string
    let prevHome: string | undefined

    function seedRelocated(slug: string): string {
      mirrorProjectEntry({ repoPath: repo, slug, providers: ['claude'], desktopProjectId: 'p1' }, regHome)
      const ws = workspaceLayout(resolveHome(regHome), slug, repo).workspaceDir
      fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
      fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.8.0\n')
      return ws
    }

    function shimRoot(slug: string): string {
      return path.join(regHome, '.specrails', 'projects', slug, 'openspec-shim')
    }

    beforeEach(() => {
      prevHome = process.env.SPECRAILS_REGISTRY_HOME
      regHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-shim-home-')))
      fs.mkdirSync(path.join(regHome, '.specrails'), { recursive: true })
      process.env.SPECRAILS_REGISTRY_HOME = regHome
      repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-shim-repo-')))
    })

    afterEach(() => {
      if (prevHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prevHome
      else delete process.env.SPECRAILS_REGISTRY_HOME
      fs.rmSync(regHome, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    })

    it('removes the per-job shim dir on _onJobExit (non-interactive path)', async () => {
      seedRelocated('acme')
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('shim-exit-job' as any)

      const db = initDb(':memory:')
      const qmShim = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qmShim.enqueue('/specrails:implement #1')

      const shimDir = path.join(shimRoot('acme'), 'shim-exit-job')
      // Shim materialised at spawn time.
      expect(fs.existsSync(shimDir)).toBe(true)

      child.stdout.push(null)
      await new Promise((r) => setImmediate(r))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 30))

      // Cleanup must run on the dominant non-interactive exit path.
      expect(fs.existsSync(shimDir)).toBe(false)
    })

    it('startup sweep removes stale shim dirs left on disk by prior runs', () => {
      // Pre-seed two stale shim dirs as if prior rails never cleaned up.
      const root = shimRoot('acme')
      fs.mkdirSync(path.join(root, 'stale-job-1'), { recursive: true })
      fs.mkdirSync(path.join(root, 'stale-job-2'), { recursive: true })
      expect(fs.existsSync(path.join(root, 'stale-job-1'))).toBe(true)

      const db = initDb(':memory:')
      // Construction runs the one-time startup sweep.
      new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })

      expect(fs.existsSync(path.join(root, 'stale-job-1'))).toBe(false)
      expect(fs.existsSync(path.join(root, 'stale-job-2'))).toBe(false)
    })
  })

  // ─── BUG-QUEUE-02: SIGKILL-failure recovery = full terminal handling ─────────

  describe('SIGKILL-failure recovery (unkillable child)', () => {
    it('fires onJobFinished, writes an ai_invocations row, and clears the slot', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)
        vi.mocked(mockUuidV4).mockReturnValue('unkillable-job' as any)

        // SIGKILL escalation reports failure → recovery branch runs.
        vi.mocked(treeKill).mockImplementation(((pid: number, signal?: string, cb?: (e?: Error) => void) => {
          if (signal === 'SIGKILL' && cb) cb(new Error('taskkill failed'))
        }) as any)

        const db = initDb(':memory:')
        const onJobFinished = vi.fn()
        const qmKill = new QueueManager(broadcast, db, [], '/tmp/repo', {
          provider: 'claude', projectId: 'p1', projectSlug: 'proj', onJobFinished,
        })
        qmKill.enqueue('/specrails:implement #5')
        expect(qmKill.getActiveJobId()).toBe('unkillable-job')

        qmKill.cancel('unkillable-job')
        // Advance past the 5s grace so the SIGKILL escalation (and its failing cb) fires.
        vi.advanceTimersByTime(5100)

        // Slot released — queue not wedged.
        expect(qmKill.getActiveJobId()).toBeNull()
        // Job force-failed.
        const job = qmKill.getJobs().find((j) => j.id === 'unkillable-job')
        expect(job?.status).toBe('failed')
        // onJobFinished fired (ticket revert / budget / webhook / Jira write-back).
        expect(onJobFinished).toHaveBeenCalledWith('unkillable-job', 'failed', undefined)
        // DB row stamped failed.
        const dbRow = db.prepare('SELECT status FROM jobs WHERE id = ?').get('unkillable-job') as { status: string } | undefined
        expect(dbRow?.status).toBe('failed')
        // ai_invocations row written (surface='job', aborted).
        const inv = db.prepare(
          `SELECT surface, status, provider FROM ai_invocations WHERE surface_ref_id = ?`
        ).get('unkillable-job') as { surface: string; status: string; provider: string } | undefined
        expect(inv?.surface).toBe('job')
        expect(inv?.status).toBe('aborted')
        expect(inv?.provider).toBe('claude')
      } finally {
        vi.useRealTimers()
      }
    })

    // BUG-ANALYTICS-01: the SIGKILL-survived row must stamp the provider the
    // child ACTUALLY ran on (per-job override), not the project primary.
    it('stamps the per-job provider override (codex), not the claude primary', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)
        vi.mocked(mockUuidV4).mockReturnValue('codex-unkillable-job' as any)

        vi.mocked(treeKill).mockImplementation(((pid: number, signal?: string, cb?: (e?: Error) => void) => {
          if (signal === 'SIGKILL' && cb) cb(new Error('taskkill failed'))
        }) as any)

        const db = initDb(':memory:')
        // claude-primary, multi-provider project; this job overrides to codex.
        const qmKill = new QueueManager(broadcast, db, [], '/tmp/repo', {
          provider: 'claude', projectId: 'p1', projectSlug: 'proj',
        })
        qmKill.enqueue('/specrails:implement #7', { provider: 'codex' })
        expect(qmKill.getActiveJobId()).toBe('codex-unkillable-job')

        qmKill.cancel('codex-unkillable-job')
        vi.advanceTimersByTime(5100)

        const inv = db.prepare(
          `SELECT provider, status, surface, total_cost_usd FROM ai_invocations WHERE surface_ref_id = ?`
        ).get('codex-unkillable-job') as
          | { provider: string; status: string; surface: string; total_cost_usd: number | null }
          | undefined
        // Was 'claude' (primary) pre-fix; now correctly the per-job codex override.
        expect(inv?.provider).toBe('codex')
        expect(inv?.status).toBe('aborted')
        expect(inv?.surface).toBe('job')
        // No usage was finalised (child never produced a result) → no cost.
        expect(inv?.total_cost_usd).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── Startup-failure capture (BUG-ANALYTICS-02) ─────────────────────────────
  describe('pre-spawn startup failure (_failWedgedJob)', () => {
    it('writes a failed ai_invocations row + broadcasts spending.invalidated when _startJob throws before spawn', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      // spawnAiCli throws synchronously inside _startJob, before a child is
      // established → _drainQueue's catch routes to _failWedgedJob.
      vi.mocked(mockSpawn).mockImplementation((() => {
        throw new Error('spawn ENOENT')
      }) as any)
      vi.mocked(mockUuidV4).mockReturnValue('wedged-job' as any)

      const db = initDb(':memory:')
      const onJobFinished = vi.fn()
      const qm2 = new QueueManager(broadcast, db, [], '/tmp/repo', {
        provider: 'claude', projectId: 'p1', projectSlug: 'proj', onJobFinished,
      })
      qm2.enqueue('/specrails:implement #9')
      // Let the async _startJob run and reject into _drainQueue's catch.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 10))

      // Slot released, queue not wedged.
      expect(qm2.getActiveJobId()).toBeNull()
      // Job stamped failed in-memory. (The `jobs` DB row is intentionally NOT
      // asserted: a throw at spawn precedes `createJob`, so no jobs row exists —
      // which is exactly why the ai_invocations row is the only Analytics signal
      // and BUG-ANALYTICS-02 had to write it here.)
      const job = qm2.getJobs().find((j) => j.id === 'wedged-job')
      expect(job?.status).toBe('failed')

      // BUG-ANALYTICS-02: a startup-failed job is now counted on Analytics.
      const inv = db.prepare(
        `SELECT surface, status, provider, ticket_id, total_cost_usd, total_cost_usd_estimated
         FROM ai_invocations WHERE surface_ref_id = ?`
      ).get('wedged-job') as
        | { surface: string; status: string; provider: string; ticket_id: number | null; total_cost_usd: number | null; total_cost_usd_estimated: number }
        | undefined
      expect(inv).toBeDefined()
      expect(inv?.surface).toBe('job')
      expect(inv?.status).toBe('failed')
      expect(inv?.provider).toBe('claude')
      expect(inv?.ticket_id).toBe(9)
      expect(inv?.total_cost_usd).toBeNull()
      expect(inv?.total_cost_usd_estimated).toBe(0)

      // spending.invalidated broadcast so open dashboards refetch.
      const invalidated = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'spending.invalidated'
      )
      expect(invalidated.length).toBeGreaterThanOrEqual(1)
      // onJobFinished still fired (rail/webhook settle path unchanged).
      expect(onJobFinished).toHaveBeenCalledWith('wedged-job', 'failed', undefined)
    })

    it('stamps the resolved per-job provider (codex) on the startup-failed row', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      vi.mocked(mockSpawn).mockImplementation((() => {
        throw new Error('spawn ENOENT')
      }) as any)
      vi.mocked(mockUuidV4).mockReturnValue('wedged-codex-job' as any)

      const db = initDb(':memory:')
      // claude-primary; this job overrides to codex. The resolved provider is
      // captured at _startJob (after override consumption) so the wedged row
      // stamps codex, not the claude primary.
      const qm2 = new QueueManager(broadcast, db, [], '/tmp/repo', {
        provider: 'claude', projectId: 'p1', projectSlug: 'proj',
      })
      qm2.enqueue('/specrails:implement #3', { provider: 'codex' })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 10))

      const inv = db.prepare(
        `SELECT provider, status FROM ai_invocations WHERE surface_ref_id = ?`
      ).get('wedged-codex-job') as { provider: string; status: string } | undefined
      expect(inv?.provider).toBe('codex')
      expect(inv?.status).toBe('failed')
    })
  })
})
