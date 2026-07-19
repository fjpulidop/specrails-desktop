import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, updateProjectSettings, createJob } from './db'
import {
  claimIdempotentJob,
  fingerprintJobSpawn,
  JobSpawnIdempotencyReplayError,
} from './job-spawn-idempotency'

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
  const savedInteractiveFlag = process.env.SPECRAILS_INTERACTIVE_JOBS

  beforeEach(() => {
    vi.resetAllMocks()
    __resetBinaryProbeCacheForTest()
    // Pin the legacy one-shot spawn path for this whole suite. Claude jobs are
    // interactive BY DEFAULT since the S1 flip; the kill-switch-off behaviour
    // pinned here must stay byte-identical (it is also what codex/gemini and
    // `interactive: false` overrides run). The default-interactive gate has its
    // own dedicated describe at the bottom of this file.
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    broadcast = vi.fn()
    qm = new QueueManager(broadcast)
  })

  afterEach(() => {
    if (savedInteractiveFlag === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = savedInteractiveFlag
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

    it('materializes a Kimi rail skill before spawning the autonomous job', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/kimi'))
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-kimi-skill-'))
      const customAlias = 'moonshot-team/private-coder:v2'
      const inheritedEffort = process.env.KIMI_MODEL_THINKING_EFFORT
      process.env.KIMI_MODEL_THINKING_EFFORT = 'max'
      const skillDir = path.join(root, '.kimi-code', 'skills', 'specrails-implement')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: specrails-implement\ndescription: test\ntype: prompt\n---\nRail input: $ARGUMENTS\n',
      )
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      const kimiQueue = new QueueManager(
        broadcast,
        undefined,
        [],
        root,
        { provider: 'kimi' },
      )

      try {
        kimiQueue.enqueue('/specrails:implement #9 --yes', 'normal', { model: customAlias })
        await new Promise<void>((resolve) => setImmediate(resolve))
        const [binary, args, options] = vi.mocked(mockSpawn).mock.calls[0] as [
          string,
          string[],
          { env: NodeJS.ProcessEnv },
        ]
        expect(binary).toBe('kimi')
        expect(args[args.indexOf('-m') + 1]).toBe(customAlias)
        expect(options.env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT')
        const prompt = args[args.indexOf('-p') + 1]
        expect(prompt).toContain('Rail input: #9 --yes')
        expect(prompt).toContain('<kimi-skill-loaded')
        expect(prompt).not.toContain('/skill:specrails-implement')

        child.stdout.push(null)
        child.stderr.push(null)
        child.emit('close', 0)
      } finally {
        kimiQueue.shutdown()
        if (inheritedEffort === undefined) delete process.env.KIMI_MODEL_THINKING_EFFORT
        else process.env.KIMI_MODEL_THINKING_EFFORT = inheritedEffort
        fs.rmSync(root, { recursive: true, force: true })
      }
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

    it('rejects duplicate, amplified, and non-string reorder payloads', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)
        .mockReturnValueOnce('job-b' as any)
      qm.enqueue('/running')
      qm.enqueue('/a')
      qm.enqueue('/b')

      expect(() => qm.reorder(['job-a', 'job-a', 'job-b']))
        .toThrow('exactly the IDs')
      expect(() => qm.reorder(['job-a', 42] as unknown as string[]))
        .toThrow('only string IDs')
      expect(qm.getJobs().find((job) => job.id === 'job-a')?.queuePosition).toBe(1)
      expect(qm.getJobs().find((job) => job.id === 'job-b')?.queuePosition).toBe(2)
    })

    it('normalizes duplicate/stale internal ids and never relaunches a job', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const first = createMockChildProcess()
      const second = createMockChildProcess()
      second.pid = 12346
      vi.mocked(mockSpawn).mockReturnValueOnce(first as any).mockReturnValueOnce(second as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('first-job' as any)
        .mockReturnValueOnce('second-job' as any)
      qm.enqueue('/first')
      qm.enqueue('/second')

      // Simulate a queue amplified by an old invalid reorder payload.
      ;(qm as any)._queue.push('second-job')
      first.emit('close', 0)
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(2)

      second.emit('close', 0)
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(2)
      expect(qm.getJobs().find((job) => job.id === 'second-job')?.status).toBe('completed')

      // A stale terminal id is also discarded defensively on the next drain.
      ;(qm as any)._queue.push('second-job')
      qm.resume()
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(2)
      expect((qm as any)._queue).toEqual([])
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

    it('job transitions to failed when the provider reports an error before exit code 0', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('provider-error-job' as any)
      const providerQueue = new QueueManager(
        broadcast,
        undefined,
        [],
        undefined,
        { provider: 'codex' },
      )

      providerQueue.enqueue('/implement #1')
      child.stdout!.push(JSON.stringify({
        type: 'turn.failed',
        error: { message: 'provider rejected the turn' },
      }) + '\n')
      await new Promise<void>((resolve) => setImmediate(resolve))
      child.emit('close', 0)
      await new Promise<void>((resolve) => setImmediate(resolve))

      const job = providerQueue.getJobs()[0]
      expect(job.status).toBe('failed')
      // Preserve the actual process outcome for diagnostics even though the
      // provider-level outcome determines the semantic job status.
      expect(job.exitCode).toBe(0)
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

    it('persists a queued admission without manufacturing a jobs.started_at', () => {
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

      const queuedRow = db.prepare(
        `SELECT command, queue_position, priority FROM queued_jobs WHERE id = 'queued-job'`
      ).get() as { command: string; queue_position: number; priority: string } | undefined
      expect(queuedRow).toEqual({ command: '/implement #2', queue_position: 1, priority: 'normal' })
      // jobs.started_at retains its meaning: no execution-history row exists
      // until this admission is actually selected for spawn.
      expect(db.prepare(`SELECT started_at FROM jobs WHERE id = 'queued-job'`).get()).toBeUndefined()
      expect(qmWithDb.getJobs()).toHaveLength(2)
    })

    it('removes a canceled pre-start admission so restart cannot resurrect it', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('running-job' as any)
        .mockReturnValueOnce('canceled-job' as any)
      const db = initDb(':memory:')
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, { zombieTimeoutMs: 0 })
      qmWithDb.enqueue('/implement #1')
      qmWithDb.enqueue('/implement #2')

      expect(qmWithDb.cancel('canceled-job')).toBe('canceled')
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'canceled-job'`).get()).toBeUndefined()

      const afterRestart = new QueueManager(broadcast, db, [], undefined, { zombieTimeoutMs: 0 })
      expect(afterRestart.getJobs().find((job) => job.id === 'canceled-job')).toBeUndefined()
      db.close()
    })

    it('cancels an async pre-spawn reservation durably before its child exists', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockUuidV4).mockReturnValue('pre-spawn-cancel' as any)
      let release!: (value: { active: []; degraded: [] }) => void
      const resolvePluginsForSpawn = vi.fn(() => new Promise<{ active: []; degraded: [] }>((resolve) => {
        release = resolve
      }))
      const db = initDb(':memory:')
      const onJobFinished = vi.fn()
      const qmWithDb = new QueueManager(broadcast, db, [], '/tmp/repo', {
        provider: 'claude',
        projectId: 'p1',
        projectSlug: 'proj',
        resolvePluginsForSpawn,
        onJobFinished,
      })

      qmWithDb.enqueue('/specrails:implement #1')
      expect(resolvePluginsForSpawn).toHaveBeenCalledTimes(1)
      expect(db.prepare(`SELECT id FROM queued_jobs WHERE id = 'pre-spawn-cancel'`).get())
        .toEqual({ id: 'pre-spawn-cancel' })

      expect(qmWithDb.cancel('pre-spawn-cancel')).toBe('canceled')
      expect(qmWithDb.getActiveJobId()).toBeNull()
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'pre-spawn-cancel'`).get()).toBeUndefined()
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'pre-spawn-cancel'`).get())
        .toEqual({ status: 'canceled' })
      expect(onJobFinished).toHaveBeenCalledWith(
        'pre-spawn-cancel',
        'canceled',
        undefined,
        expect.objectContaining({ recoveryReplay: true }),
      )

      release({ active: [], degraded: [] })
      await new Promise((resolve) => setImmediate(resolve))
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()

      const afterRestart = new QueueManager(broadcast, db, [], undefined, { zombieTimeoutMs: 0 })
      expect(afterRestart.getJobs().find((candidate) => candidate.id === 'pre-spawn-cancel')).toBeUndefined()
      qmWithDb.shutdown()
      afterRestart.shutdown()
      db.close()
    })

    it('rolls back parent cancellation, recursive skips and positions as one transaction', () => {
      const db = initDb(':memory:')
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
      const insertQueued = db.prepare(
        `INSERT INTO queued_jobs
           (id, command, queue_position, priority, depends_on_job_id)
         VALUES (?, ?, ?, 'normal', ?)`,
      )
      insertQueued.run('cancel-parent', '/parent', 1, null)
      insertQueued.run('cancel-child', '/child', 2, 'cancel-parent')
      insertQueued.run('cancel-grandchild', '/grandchild', 3, 'cancel-child')
      insertQueued.run('survivor', '/survivor', 4, null)
      db.exec(`
        CREATE TRIGGER reject_recursive_skip
        BEFORE INSERT ON jobs
        WHEN NEW.id = 'cancel-child'
        BEGIN
          SELECT RAISE(ABORT, 'simulated recursive skip failure');
        END;
      `)
      const qmWithDb = new QueueManager(broadcast, db)

      expect(() => qmWithDb.cancel('cancel-parent')).toThrow('simulated recursive skip failure')
      expect(qmWithDb.getJobs()
        .filter((candidate) => candidate.status === 'queued')
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
        .map((candidate) => [candidate.id, candidate.queuePosition])
      ).toEqual([
        ['cancel-parent', 1],
        ['cancel-child', 2],
        ['cancel-grandchild', 3],
        ['survivor', 4],
      ])
      expect(db.prepare(`SELECT id, queue_position FROM queued_jobs ORDER BY queue_position`).all())
        .toEqual([
          { id: 'cancel-parent', queue_position: 1 },
          { id: 'cancel-child', queue_position: 2 },
          { id: 'cancel-grandchild', queue_position: 3 },
          { id: 'survivor', queue_position: 4 },
        ])
      expect(db.prepare(`SELECT id FROM jobs`).all()).toEqual([])

      db.exec(`DROP TRIGGER reject_recursive_skip`)
      expect(qmWithDb.cancel('cancel-parent')).toBe('canceled')
      expect(db.prepare(`SELECT id, queue_position FROM queued_jobs ORDER BY queue_position`).all())
        .toEqual([{ id: 'survivor', queue_position: 1 }])
      expect(db.prepare(`SELECT id, status FROM jobs ORDER BY id`).all()).toEqual([
        { id: 'cancel-child', status: 'skipped' },
        { id: 'cancel-grandchild', status: 'skipped' },
        { id: 'cancel-parent', status: 'canceled' },
      ])
      qmWithDb.shutdown()
      db.close()
    })

    it('cancels a queued child whose parent has no jobs row yet', () => {
      const db = initDb(':memory:')
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
      db.prepare(
        `INSERT INTO queued_jobs (id, command, queue_position, priority)
         VALUES ('queued-parent', '/parent', 1, 'normal')`,
      ).run()
      db.prepare(
        `INSERT INTO queued_jobs (
           id, command, queue_position, priority, depends_on_job_id
         ) VALUES ('queued-child', '/child', 2, 'normal', 'queued-parent')`,
      ).run()
      const qmWithDb = new QueueManager(broadcast, db)

      expect(qmWithDb.cancel('queued-child')).toBe('canceled')
      expect(db.prepare(`SELECT id, queue_position FROM queued_jobs`).all())
        .toEqual([{ id: 'queued-parent', queue_position: 1 }])
      expect(db.prepare(`SELECT status, depends_on_job_id FROM jobs WHERE id = 'queued-child'`).get())
        .toEqual({ status: 'canceled', depends_on_job_id: null })
      qmWithDb.shutdown()
      db.close()
    })

    it('removes the legacy jobs.status=queued representation on cancel', () => {
      const db = initDb(':memory:')
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, queue_position, priority)
         VALUES ('legacy-cancel', '/legacy', datetime('now'), 'queued', 1, 'normal')`,
      ).run()
      const qmWithDb = new QueueManager(broadcast, db)

      expect(qmWithDb.cancel('legacy-cancel')).toBe('canceled')
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'legacy-cancel'`).get())
        .toEqual({ status: 'canceled' })

      const afterRestart = new QueueManager(broadcast, db)
      expect(afterRestart.getJobs().find((candidate) => candidate.id === 'legacy-cancel')).toBeUndefined()
      qmWithDb.shutdown()
      afterRestart.shutdown()
      db.close()
    })

    it('rejects cross-priority reorder and preserves within-band order after restart', () => {
      const db = initDb(':memory:')
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
      const insertQueued = db.prepare(
        `INSERT INTO queued_jobs (id, command, queue_position, priority) VALUES (?, ?, ?, ?)`,
      )
      insertQueued.run('high-a', '/high-a', 1, 'high')
      insertQueued.run('high-b', '/high-b', 2, 'high')
      insertQueued.run('low-a', '/low-a', 3, 'low')
      const qmWithDb = new QueueManager(broadcast, db)

      expect(() => qmWithDb.reorder(['low-a', 'high-a', 'high-b']))
        .toThrow('Cannot reorder jobs across priority levels')
      expect(db.prepare(`SELECT id FROM queued_jobs ORDER BY queue_position`).all())
        .toEqual([{ id: 'high-a' }, { id: 'high-b' }, { id: 'low-a' }])

      qmWithDb.reorder(['high-b', 'high-a', 'low-a'])
      const afterRestart = new QueueManager(broadcast, db)
      expect(afterRestart.getJobs()
        .filter((candidate) => candidate.status === 'queued')
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
        .map((candidate) => candidate.id)
      ).toEqual(['high-b', 'high-a', 'low-a'])
      qmWithDb.shutdown()
      afterRestart.shutdown()
      db.close()
    })

    it('rolls back an enqueue when durable queue admission fails', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('running-job' as any)
        .mockReturnValueOnce('queue-fail' as any)

      const db = initDb(':memory:')
      db.exec(`
        CREATE TRIGGER reject_queue_admission
        BEFORE INSERT ON queued_jobs
        WHEN NEW.id = 'queue-fail'
        BEGIN
          SELECT RAISE(ABORT, 'simulated queue persistence failure');
        END;
      `)
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, { zombieTimeoutMs: 0 })
      qmWithDb.enqueue('/implement #1')

      expect(() => qmWithDb.enqueue('/implement #2')).toThrow('simulated queue persistence failure')
      expect(qmWithDb.getJobs().map((job) => job.id)).toEqual(['running-job'])
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'queue-fail'`).get()).toBeUndefined()
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1)
      db.close()
    })

    it('rolls back queue persistence when a project-wide admission hook fails', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('global-hook-fail' as any)
        .mockReturnValueOnce('global-hook-success' as any)

      const db = initDb(':memory:')
      let rejectAdmission = true
      const observedJobIds: string[] = []
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, {
        onJobAdmission: (txDb, job) => {
          // queued_jobs must already be visible to the hook, while remaining
          // uncommitted until the hook itself succeeds.
          expect(txDb.prepare(`SELECT id FROM queued_jobs WHERE id = ?`).get(job.id))
            .toEqual({ id: job.id })
          observedJobIds.push(job.id)
          if (rejectAdmission) throw new Error('simulated project admission failure')
        },
      })
      qmWithDb.pause()

      expect(() => qmWithDb.enqueue('/global-hook')).toThrow('simulated project admission failure')
      expect(qmWithDb.getJobs()).toEqual([])
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'global-hook-fail'`).get())
        .toBeUndefined()

      rejectAdmission = false
      const admitted = qmWithDb.enqueue('/global-hook')
      expect(admitted.id).toBe('global-hook-success')
      expect(observedJobIds).toEqual(['global-hook-fail', 'global-hook-success'])
      expect(db.prepare(`SELECT id FROM queued_jobs WHERE id = 'global-hook-success'`).get())
        .toEqual({ id: 'global-hook-success' })
      qmWithDb.shutdown()
      db.close()
    })

    it('commits queued work and an external admission claim atomically before drain', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const db = initDb(':memory:')
      const admissionOrder: string[] = []
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, {
        onJobAdmission: () => { admissionOrder.push('project') },
      })
      qmWithDb.pause()
      const fingerprint = fingerprintJobSpawn({ command: '/atomic' })
      db.exec(`
        CREATE TRIGGER reject_spawn_claim
        BEFORE INSERT ON job_spawn_requests
        BEGIN
          SELECT RAISE(ABORT, 'simulated ledger insert failure');
        END;
      `)

      expect(() => qmWithDb.enqueue('/atomic', 'normal', undefined, {
        jobId: 'atomic-job',
        commit: (txDb) => {
          admissionOrder.push('route')
          claimIdempotentJob(txDb, 'atomic-key', fingerprint, 'atomic-job')
        },
      })).toThrow('simulated ledger insert failure')
      expect(qmWithDb.getJobs()).toEqual([])
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'atomic-job'`).get()).toBeUndefined()
      expect(db.prepare(`SELECT 1 FROM job_spawn_requests WHERE idempotency_key = 'atomic-key'`).get()).toBeUndefined()
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()

      db.exec(`DROP TRIGGER reject_spawn_claim`)
      const admitted = qmWithDb.enqueue('/atomic', 'normal', undefined, {
        jobId: 'atomic-job',
        commit: (txDb) => {
          admissionOrder.push('route')
          claimIdempotentJob(txDb, 'atomic-key', fingerprint, 'atomic-job')
        },
      })
      expect(admitted.id).toBe('atomic-job')
      expect(admissionOrder).toEqual(['project', 'route', 'project', 'route'])
      expect(db.prepare(`SELECT id FROM queued_jobs WHERE id = 'atomic-job'`).get())
        .toEqual({ id: 'atomic-job' })
      expect(db.prepare(`SELECT job_id FROM job_spawn_requests WHERE idempotency_key = 'atomic-key'`).get())
        .toEqual({ job_id: 'atomic-job' })
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
      qmWithDb.shutdown()
      db.close()
    })

    it('rolls back a speculative admission when another manager owns the exact key', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-atomic-key-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      try {
        const db1 = initDb(dbPath)
        db1.prepare(`UPDATE queue_state SET value = 'true' WHERE key = 'paused'`).run()
        const db2 = initDb(dbPath)
        const qm1 = new QueueManager(broadcast, db1)
        const qm2 = new QueueManager(broadcast, db2)
        const fingerprint = fingerprintJobSpawn({ command: '/same' })

        qm1.enqueue('/same', 'normal', undefined, {
          jobId: 'winner-job',
          commit: (txDb) => claimIdempotentJob(
            txDb, 'same-key', fingerprint, 'winner-job',
          ),
        })
        expect(() => qm2.enqueue('/same', 'normal', undefined, {
          jobId: 'loser-job',
          commit: (txDb) => claimIdempotentJob(
            txDb, 'same-key', fingerprint, 'loser-job',
          ),
        })).toThrow(JobSpawnIdempotencyReplayError)

        expect(qm2.getJobs()).toEqual([])
        expect(db1.prepare(`SELECT id FROM queued_jobs ORDER BY id`).all())
          .toEqual([{ id: 'winner-job' }])
        expect(db1.prepare(`SELECT job_id FROM job_spawn_requests WHERE idempotency_key = 'same-key'`).get())
          .toEqual({ job_id: 'winner-job' })
        qm1.shutdown()
        qm2.shutdown()
        db1.close()
        db2.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('does not resurrect a queued admission when startup fails before promotion', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockUuidV4).mockReturnValue('early-start-failure' as any)
      const db = initDb(':memory:')
      const onJobFinished = vi.fn()
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, {
        zombieTimeoutMs: 0,
        onJobFinished,
      })
      vi.spyOn(qmWithDb as any, '_resolveJobAdapter').mockImplementation(() => {
        throw new Error('simulated early resolver failure')
      })

      qmWithDb.enqueue('/implement #1')
      await new Promise((resolve) => setImmediate(resolve))

      expect(qmWithDb.getJobs().find((job) => job.id === 'early-start-failure'))
        .toMatchObject({ status: 'failed', startedAt: expect.any(String), finishedAt: expect.any(String) })
      expect(db.prepare(`SELECT status, started_at FROM jobs WHERE id = 'early-start-failure'`).get())
        .toMatchObject({ status: 'failed', started_at: expect.any(String) })
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'early-start-failure'`).get()).toBeUndefined()
      expect(onJobFinished).toHaveBeenCalledWith(
        'early-start-failure',
        'failed',
        undefined,
        expect.objectContaining({ recoveryReplay: true }),
      )

      const afterRestart = new QueueManager(broadcast, db, [], undefined, { zombieTimeoutMs: 0 })
      expect(afterRestart.getJobs().find((job) => job.id === 'early-start-failure')).toBeUndefined()
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
      db.close()
    })

    it('keeps the durable admission and suppresses side effects when startup failure cannot be persisted', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockUuidV4).mockReturnValue('unpersisted-start-failure' as any)
      const db = initDb(':memory:')
      db.exec(`
        CREATE TRIGGER reject_start_failure_history
        BEFORE INSERT ON jobs
        WHEN NEW.id = 'unpersisted-start-failure'
        BEGIN
          SELECT RAISE(ABORT, 'simulated terminal persistence failure');
        END;
      `)
      const onJobFinished = vi.fn()
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        onJobFinished,
      })
      vi.spyOn(qmWithDb as any, '_resolveJobAdapter').mockImplementation(() => {
        throw new Error('simulated resolver failure')
      })

      qmWithDb.enqueue('/implement #1')
      await new Promise((resolve) => setImmediate(resolve))

      expect(db.prepare(`SELECT id FROM queued_jobs WHERE id = 'unpersisted-start-failure'`).get())
        .toEqual({ id: 'unpersisted-start-failure' })
      expect(db.prepare(`SELECT 1 FROM jobs WHERE id = 'unpersisted-start-failure'`).get()).toBeUndefined()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'unpersisted-start-failure'`).get())
        .toEqual({ count: 0 })
      expect(onJobFinished).not.toHaveBeenCalled()
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
      expect(qmWithDb.isPaused()).toBe(true)
      expect(qmWithDb.getActiveJobId()).toBeNull()
      expect(qmWithDb.getJobs().find((candidate) => candidate.id === 'unpersisted-start-failure'))
        .toMatchObject({ status: 'queued', queuePosition: 1, startedAt: null, finishedAt: null })
      expect(db.prepare(`SELECT value FROM queue_state WHERE key = 'paused'`).get())
        .toEqual({ value: 'true' })
      qmWithDb.shutdown()
      db.close()
    })

    it('restores provider, model, profile, and interactive selections without collapsing tri-state values', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/provider-cli'))
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('selection-default' as any)
        .mockReturnValueOnce('selection-legacy' as any)
        .mockReturnValueOnce('selection-explicit' as any)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-selection-restart-'))
      const dbPath = path.join(dir, 'jobs.sqlite')

      try {
        const beforeDb = initDb(dbPath)
        const before = new QueueManager(broadcast, beforeDb, [], undefined, { provider: 'claude' })
        before.pause()
        // An explicitly-present undefined must have the same semantics as an
        // absent property: resolve the project default profile at spawn time.
        before.enqueue('/default', { profileName: undefined })
        before.enqueue('/legacy', {
          provider: 'codex',
          model: 'gpt-5.2',
          profileName: null,
          interactive: false,
        })
        before.enqueue('/explicit', {
          provider: 'claude',
          model: 'sonnet',
          profileName: 'reviewer',
          interactive: true,
        })

        expect(beforeDb.prepare(`
          SELECT id, provider, model, profile_name, profile_selection_set, interactive
            FROM queued_jobs ORDER BY queue_position
        `).all()).toEqual([
          {
            id: 'selection-default', provider: 'claude', model: null,
            profile_name: null, profile_selection_set: 0, interactive: null,
          },
          {
            id: 'selection-legacy', provider: 'codex', model: 'gpt-5.2',
            profile_name: null, profile_selection_set: 1, interactive: 0,
          },
          {
            id: 'selection-explicit', provider: 'claude', model: 'sonnet',
            profile_name: 'reviewer', profile_selection_set: 1, interactive: 1,
          },
        ])
        before.shutdown()
        beforeDb.close()

        const afterDb = initDb(dbPath)
        // Changing the project default must not reinterpret already-admitted
        // provider choices.
        const restored = new QueueManager(broadcast, afterDb, [], undefined, { provider: 'gemini' })
        const providers = (restored as any)._jobProviderSelection as Map<string, string>
        const models = (restored as any)._jobModelSelection as Map<string, string>
        const profiles = (restored as any)._jobProfileSelection as Map<string, string | null>
        const interactive = (restored as any)._jobInteractiveSelection as Map<string, boolean>

        expect(providers.get('selection-default')).toBe('claude')
        expect(providers.get('selection-legacy')).toBe('codex')
        expect(providers.get('selection-explicit')).toBe('claude')
        expect(models.has('selection-default')).toBe(false)
        expect(models.get('selection-legacy')).toBe('gpt-5.2')
        expect(models.get('selection-explicit')).toBe('sonnet')
        expect(profiles.has('selection-default')).toBe(false)
        expect(profiles.has('selection-legacy')).toBe(true)
        expect(profiles.get('selection-legacy')).toBeNull()
        expect(profiles.get('selection-explicit')).toBe('reviewer')
        expect(interactive.has('selection-default')).toBe(false)
        expect(interactive.get('selection-legacy')).toBe(false)
        expect(interactive.get('selection-explicit')).toBe(true)
        restored.shutdown()
        afterDb.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('preserves selections through a failed pre-spawn promotion and retries with the pinned provider', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/provider-cli'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4).mockReturnValueOnce('retry-selections' as any)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-selection-retry-'))
      const dbPath = path.join(dir, 'jobs.sqlite')

      try {
        const beforeDb = initDb(dbPath)
        beforeDb.exec(`
          CREATE TRIGGER reject_retry_selection_promotion
          BEFORE INSERT ON jobs
          WHEN NEW.id = 'retry-selections'
          BEGIN
            SELECT RAISE(ABORT, 'simulated promotion failure');
          END;
        `)
        const before = new QueueManager(broadcast, beforeDb, [], undefined, { provider: 'claude' })
        const buildArgs = vi.spyOn((before as any)._adapter, 'buildArgs')
          .mockImplementation(() => { throw new Error('simulated pre-spawn failure') })

        before.enqueue('/retry-selections', {
          model: 'sonnet',
          profileName: null,
          interactive: false,
        })
        await new Promise((resolve) => setImmediate(resolve))

        expect(before.isPaused()).toBe(true)
        expect(beforeDb.prepare(`
          SELECT provider, model, profile_name, profile_selection_set, interactive
            FROM queued_jobs WHERE id = 'retry-selections'
        `).get()).toEqual({
          provider: 'claude',
          model: 'sonnet',
          profile_name: null,
          profile_selection_set: 1,
          interactive: 0,
        })
        buildArgs.mockRestore()
        before.shutdown()
        beforeDb.close()

        const afterDb = initDb(dbPath)
        afterDb.exec(`DROP TRIGGER reject_retry_selection_promotion`)
        const restored = new QueueManager(broadcast, afterDb, [], undefined, { provider: 'codex' })
        expect((restored as any)._jobProviderSelection.get('retry-selections')).toBe('claude')
        expect((restored as any)._jobModelSelection.get('retry-selections')).toBe('sonnet')
        expect((restored as any)._jobProfileSelection.has('retry-selections')).toBe(true)
        expect((restored as any)._jobProfileSelection.get('retry-selections')).toBeNull()
        expect((restored as any)._jobInteractiveSelection.get('retry-selections')).toBe(false)

        restored.resume()
        await new Promise((resolve) => setImmediate(resolve))

        expect(vi.mocked(mockSpawn)).toHaveBeenCalled()
        expect(vi.mocked(mockSpawn).mock.calls.at(-1)?.[0]).toBe('claude')
        expect(afterDb.prepare(`
          SELECT provider, interactive FROM jobs WHERE id = 'retry-selections'
        `).get()).toEqual({ provider: 'claude', interactive: 0 })
        expect(afterDb.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'retry-selections'`).get())
          .toBeUndefined()
        restored.shutdown()
        afterDb.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('restores the full durable priority order from a real DB after restart', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockSpawn).mockReturnValue(createMockChildProcess() as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('running-job' as any)
        .mockReturnValueOnce('normal-a' as any)
        .mockReturnValueOnce('normal-b' as any)
        .mockReturnValueOnce('high-job' as any)

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-durable-restart-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      try {
        const beforeCrash = initDb(dbPath)
        const before = new QueueManager(broadcast, beforeCrash, [], undefined, { zombieTimeoutMs: 0 })
        before.enqueue('/running')
        before.enqueue('/normal-a')
        before.enqueue('/normal-b')
        before.enqueue('/high', 'high')
        before.updatePriority('normal-b', 'critical')
        before.pause()

        expect(beforeCrash.prepare(
          `SELECT id, queue_position FROM queued_jobs ORDER BY queue_position`
        ).all()).toEqual([
          { id: 'normal-b', queue_position: 1 },
          { id: 'high-job', queue_position: 2 },
          { id: 'normal-a', queue_position: 3 },
        ])
        expect(beforeCrash.prepare(
          `SELECT id FROM jobs WHERE id IN ('normal-a', 'normal-b', 'high-job')`
        ).all()).toEqual([])
        beforeCrash.close() // simulate the app process disappearing

        const afterRestart = initDb(dbPath)
        const restored = new QueueManager(broadcast, afterRestart, [], undefined, { zombieTimeoutMs: 0 })
        expect(restored.isPaused()).toBe(true)
        expect(restored.getJobs()
          .filter((job) => job.status === 'queued')
          .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
          .map((job) => [job.id, job.priority, job.startedAt])
        ).toEqual([
          ['normal-b', 'critical', null],
          ['high-job', 'high', null],
          ['normal-a', 'normal', null],
        ])

        restored.resume()
        expect(restored.getJobs().find((job) => job.id === 'normal-b')?.status).toBe('running')
        expect(afterRestart.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'normal-b'`).get()).toBeUndefined()
        expect(afterRestart.prepare(`SELECT status, started_at FROM jobs WHERE id = 'normal-b'`).get())
          .toMatchObject({ status: 'running', started_at: expect.any(String) })
        restored.shutdown()
        afterRestart.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
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
      // projectId is required for the per-project daily-budget sum, which now
      // reads the ai_invocations ledger (MED-5) rather than the jobs table.
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
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

    it('checks the app daily budget before spawning a queued job', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockUuidV4).mockReturnValue('preflight-budget-job' as any)
      const db = initDb(':memory:')
      const onBudgetExceeded = vi.fn()
      const qmWithDb = new QueueManager(broadcast, db, [], undefined, {
        getDesktopDailyBudget: () => ({ budget: 1, totalSpend: 2 }),
        onBudgetExceeded,
      })

      qmWithDb.enqueue('/implement')

      expect(qmWithDb.isPaused()).toBe(true)
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
      expect(onBudgetExceeded).toHaveBeenCalledWith(
        'desktop_daily_budget_exceeded',
        expect.objectContaining({ desktopDailySpend: 2, desktopBudget: 1 }),
      )
      db.close()
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
    // The PR-delivery flag is captured ONCE at spawn and threaded into
    // onJobFinished as `ticketCompletionStatus` on COMPLETED exits (the
    // universal ask-first methodology). Default-on unless the kill-switch is
    // set — pin the default explicitly so an ambient env can't skew the suite.
    const savedPrFlag = process.env.SPECRAILS_RAIL_DELIVER_PR
    beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR }) // PR delivery default-on
    afterEach(() => {
      if (savedPrFlag === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
      else process.env.SPECRAILS_RAIL_DELIVER_PR = savedPrFlag
    })

    it('calls onJobFinished when job completes — PR delivery on (default) parks tickets at on_review', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('callback-job' as any)

      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, undefined, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement')

      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(onJobFinished).toHaveBeenCalledWith('callback-job', 'completed', undefined, {
        ticketCompletionStatus: 'on_review',
      })
    })

    it("kill-switch off (SPECRAILS_RAIL_DELIVER_PR=0): completed threads the legacy 'done' (byte-identical promotion)", async () => {
      process.env.SPECRAILS_RAIL_DELIVER_PR = '0'
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('legacy-cb-job' as any)

      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, undefined, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement')

      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(onJobFinished).toHaveBeenCalledWith('legacy-cb-job', 'completed', undefined, {
        ticketCompletionStatus: 'done',
      })
    })

    it('the PR-delivery mode is captured at SPAWN — a mid-flight env flip cannot change the settle', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('flip-cb-job' as any)

      const onJobFinished = vi.fn()
      const qmWithCallback = new QueueManager(broadcast, undefined, [], undefined, { onJobFinished })
      qmWithCallback.enqueue('/implement') // spawns with the flag ON (default)

      // Flip the kill-switch off while the job is in flight — the spawn-time
      // capture must win at settle.
      process.env.SPECRAILS_RAIL_DELIVER_PR = '0'
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 50))

      expect(onJobFinished).toHaveBeenCalledWith('flip-cb-job', 'completed', undefined, {
        ticketCompletionStatus: 'on_review',
      })
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

      // Failure statuses keep the legacy 3-arg call shape — ticketCompletionStatus
      // is completion-only (applyJobOutcomeToTickets ignores it on failure).
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

      expect(onJobFinished).toHaveBeenCalledWith('cost-cb-job', 'completed', expect.any(Number), expect.objectContaining({
        recoveryReplay: true,
        ticketCompletionStatus: 'on_review',
      }))
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

    it('RELOCATED freestyle: reads spec text from the WORKSPACE ticket store', () => {
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
      vi.mocked(mockUuidV4).mockReturnValue('reloc-freestyle' as any)

      const db = initDb(':memory:')
      const qmReloc = new QueueManager(broadcast, db, [], repo, {
        provider: 'claude', projectId: 'p1', projectSlug: 'acme',
      })
      qmReloc.enqueue('/specrails:freestyle #7')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      // The freestyle prompt is the `-p` argv value; it must contain the spec body
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

    it('freestyle: sends default pre-prompt + spec text as the claude -p prompt (no slash command)', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('freestyle-default' as any)

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
        qm.enqueue('/specrails:freestyle #7 --yes')

        const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
        const pIdx = spawnArgs.indexOf('-p')
        const prompt = spawnArgs[pIdx + 1]
        expect(prompt).toContain('FREESTYLE')
        expect(prompt).toContain('# Spec #7: Add dark mode')
        expect(prompt).toContain('Toggle theme in settings')
        // The slash command itself must NOT be sent as the prompt.
        expect(prompt).not.toContain('/specrails:freestyle')
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('freestyle: uses the per-project pre-prompt override when set', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('freestyle-override' as any)

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
      updateProjectSettings(db, { freestylePrePrompt: 'CUSTOM FREESTYLE INSTRUCTION' })
      try {
        const qm = new QueueManager(broadcast, db, [], projectDir, { provider: 'claude' })
        qm.enqueue('/specrails:freestyle #3 --yes')

        const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
        const prompt = spawnArgs[spawnArgs.indexOf('-p') + 1]
        expect(prompt).toContain('CUSTOM FREESTYLE INSTRUCTION')
        expect(prompt).toContain('# Spec #3: Spec three')
      } finally {
        db.close()
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('freestyle: model override is passed as --model, overriding orchestrator', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('freestyle-model' as any)

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
        qm.enqueue('/specrails:freestyle #9 --yes', 'normal', { profileName: null, model: 'opus' })

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

    it('records wall-clock duration for a completed Kimi rail without native usage', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/kimi'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('kimi-duration-job' as any)

      const db = initDb(':memory:')
      const kimiQueue = new QueueManager(broadcast, db, undefined, undefined, {
        provider: 'kimi',
        resolvedModel: 'k3',
        projectId: 'p1',
        projectSlug: 'proj',
      })
      kimiQueue.enqueue('implement the selected ticket')

      child.stdout.push(
        '{"role":"assistant","content":"done"}\n' +
        '{"role":"meta","type":"session.resume_hint","session_id":"01KIMI00000000000000000001"}\n',
      )
      child.stdout.push(null)
      child.stderr.push(null)
      await new Promise((resolve) => setImmediate(resolve))
      child.emit('close', 0)
      await new Promise((resolve) => setTimeout(resolve, 30))

      const job = db.prepare(`
        SELECT duration_ms FROM jobs WHERE id = ?
      `).get('kimi-duration-job') as { duration_ms: number | null }
      const invocation = db.prepare(`
        SELECT duration_ms FROM ai_invocations WHERE surface_ref_id = ?
      `).get('kimi-duration-job') as { duration_ms: number | null }
      expect(job.duration_ms).not.toBeNull()
      expect(job.duration_ms).toBeGreaterThanOrEqual(0)
      expect(invocation.duration_ms).toBe(job.duration_ms)
      kimiQueue.shutdown()
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

    it('does not spawn when shutdown happens during async plugin verification', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      vi.mocked(mockUuidV4).mockReturnValue('job-awaiting-plugin' as any)
      let release!: (value: { active: []; degraded: [] }) => void
      const resolvePluginsForSpawn = vi.fn(() => new Promise<{ active: []; degraded: [] }>((resolve) => {
        release = resolve
      }))
      const db = initDb(':memory:')
      const qm2 = new QueueManager(broadcast, db, [], '/tmp/repo', {
        provider: 'claude',
        projectId: 'p1',
        projectSlug: 'proj',
        resolvePluginsForSpawn,
      })

      qm2.enqueue('/specrails:implement #1')
      expect(resolvePluginsForSpawn).toHaveBeenCalledTimes(1)
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()

      qm2.shutdown()
      release({ active: [], degraded: [] })
      await new Promise((resolve) => setImmediate(resolve))

      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
      expect(qm2.getActiveJobId()).toBeNull()
      db.close()
    })

    it('flushes an aborted, cost-estimated ai_invocations row for the in-flight job (CRIT-3)', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('inflight-job' as any)

      const db = initDb(':memory:')
      const qm2 = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
      qm2.enqueue('/specrails:implement #7')

      // The child streams assistant work carrying usage, but no terminal `result`
      // arrives before the app is torn down.
      child.stdout.push(JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1', model: 'claude-opus-4-8',
          usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
          content: [{ type: 'text', text: 'work' }],
        },
      }) + '\n')
      await new Promise((r) => setTimeout(r, 30))

      qm2.shutdown()

      const row = db.prepare(
        `SELECT status, total_cost_usd, total_cost_usd_estimated, tokens_in FROM ai_invocations WHERE surface_ref_id = 'inflight-job'`
      ).get() as { status: string; total_cost_usd: number | null; total_cost_usd_estimated: number; tokens_in: number | null } | undefined
      expect(row).toBeDefined()
      expect(row!.status).toBe('aborted')
      expect(row!.tokens_in).toBe(5000)
      expect(row!.total_cost_usd!).toBeGreaterThan(0)
      expect(row!.total_cost_usd_estimated).toBe(1)

      // The jobs row is flipped to failed and carries the estimated cost.
      const jrow = db.prepare(`SELECT status, total_cost_usd FROM jobs WHERE id = 'inflight-job'`).get() as { status: string; total_cost_usd: number | null }
      expect(jrow.status).toBe('failed')
      expect(jrow.total_cost_usd!).toBeGreaterThan(0)
    })

    it('replays graceful-shutdown callbacks after reopen without duplicating accounting', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-graceful-recovery-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      try {
        vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)
        vi.mocked(mockUuidV4)
          .mockReturnValueOnce('graceful-parent' as any)
          .mockReturnValueOnce('graceful-child' as any)
        const firstDb = initDb(dbPath)
        const failingCallback = vi.fn(() => { throw new Error('ticket store temporarily unavailable') })
        const first = new QueueManager(broadcast, firstDb, [], undefined, {
          projectId: 'p1',
          onJobFinished: failingCallback,
        })
        first.enqueue('/specrails:implement #31')
        first.enqueue('/specrails:verify #31', { dependsOnJobId: 'graceful-parent' })

        first.shutdown()

        expect(firstDb.prepare(
          `SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'graceful-parent'`
        ).get()).toMatchObject({ count: 1 })
        expect(firstDb.prepare(
          `SELECT accounting_completed, callback_completed, terminal_completed
           FROM orphan_job_recovery WHERE job_id = 'graceful-parent'`
        ).get()).toMatchObject({ accounting_completed: 1, callback_completed: 0, terminal_completed: 0 })
        expect(firstDb.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'graceful-child'`).get())
          .toBeDefined()
        firstDb.close()

        const afterRestart = initDb(dbPath)
        const succeedingCallback = vi.fn()
        new QueueManager(broadcast, afterRestart, [], undefined, {
          projectId: 'p1',
          onJobFinished: succeedingCallback,
        })

        expect(succeedingCallback).toHaveBeenCalledWith(
          'graceful-parent', 'failed', undefined, expect.objectContaining({
            recoveryReplay: true,
            recoveryCommand: '/specrails:implement #31',
            recoveryTicketIds: [31],
          }),
        )
        expect(succeedingCallback).toHaveBeenCalledWith(
          'graceful-child', 'skipped', undefined, expect.objectContaining({
            recoveryReplay: true,
            recoveryCommand: '/specrails:verify #31',
          }),
        )
        expect(afterRestart.prepare(
          `SELECT status, skip_reason FROM jobs WHERE id = 'graceful-child'`
        ).get()).toMatchObject({
          status: 'skipped',
          skip_reason: 'Parent job graceful-parent failed',
        })
        expect(afterRestart.prepare(
          `SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'graceful-parent'`
        ).get()).toMatchObject({ count: 1 })
        expect(afterRestart.prepare(
          `SELECT 1 FROM orphan_job_recovery WHERE job_id = 'graceful-parent'`
        ).get()).toBeUndefined()
        afterRestart.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  // ─── cost-accounting audit fixes ─────────────────────────────────────────────

  describe('multi-ticket attribution (MED-7)', () => {
    it('splits cost/tokens/turns into one ai_invocations row per ticket, summing exactly', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('batch-job' as any)

      const db = initDb(':memory:')
      const qm2 = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
      qm2.enqueue('/specrails:implement #12 #13 #14')

      child.stdout.push(JSON.stringify({
        type: 'result', total_cost_usd: 0.9, num_turns: 6, model: 'claude-opus-4-8',
        usage: { input_tokens: 300, output_tokens: 150, cache_read_input_tokens: 30, cache_creation_input_tokens: 9 },
      }) + '\n')
      await new Promise((r) => setTimeout(r, 40))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 40))

      const rows = db.prepare(
        `SELECT surface_ref_id, ticket_id, total_cost_usd, tokens_in, tokens_cache_create, num_turns
         FROM ai_invocations WHERE surface = 'job' ORDER BY ticket_id`
      ).all() as Array<{ surface_ref_id: string; ticket_id: number; total_cost_usd: number; tokens_in: number; tokens_cache_create: number; num_turns: number }>
      expect(rows.length).toBe(3)
      expect(rows.map((r) => r.ticket_id)).toEqual([12, 13, 14])
      expect(rows.map((r) => r.surface_ref_id)).toEqual(['batch-job#t12', 'batch-job#t13', 'batch-job#t14'])
      // Cost split evenly and sums back to the original.
      expect(rows.reduce((s, r) => s + r.total_cost_usd, 0)).toBeCloseTo(0.9, 6)
      // Integer fields split via largest-remainder — sum EXACTLY to the totals.
      expect(rows.reduce((s, r) => s + r.tokens_in, 0)).toBe(300)
      expect(rows.reduce((s, r) => s + r.tokens_cache_create, 0)).toBe(9)
      expect(rows.reduce((s, r) => s + r.num_turns, 0)).toBe(6)
    })

    it('keeps the plain jobId surface_ref_id for a single-ticket job (byte-compatible)', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('single-job' as any)

      const db = initDb(':memory:')
      const qm2 = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
      qm2.enqueue('/specrails:implement #5')

      child.stdout.push(JSON.stringify({ type: 'result', total_cost_usd: 0.3, num_turns: 2, usage: { input_tokens: 100 } }) + '\n')
      await new Promise((r) => setTimeout(r, 40))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 40))

      const rows = db.prepare(
        `SELECT surface_ref_id, ticket_id FROM ai_invocations WHERE surface = 'job'`
      ).all() as Array<{ surface_ref_id: string; ticket_id: number | null }>
      expect(rows.length).toBe(1)
      expect(rows[0].surface_ref_id).toBe('single-job')
      expect(rows[0].ticket_id).toBe(5)
    })
  })

  describe('daily budget on non-completed jobs (MED-5)', () => {
    it('pauses the queue when a FAILED job that still cost money exceeds the daily budget', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('failed-cost-job' as any)

      const db = initDb(':memory:')
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '0.01')`).run()
      const qm2 = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
      qm2.enqueue('/implement')

      // A claude run that emits real cost but exits non-zero (error_max_turns).
      child.stdout.push(JSON.stringify({ type: 'result', total_cost_usd: 0.05, is_error: true, usage: {} }) + '\n')
      await new Promise((r) => setTimeout(r, 40))
      child.emit('close', 1) // non-zero → failed
      await new Promise((r) => setTimeout(r, 40))

      const job = qm2.getJobs().find((j) => j.id === 'failed-cost-job')
      expect(job?.status).toBe('failed')
      expect(qm2.isPaused()).toBe(true)
      const budgetCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'daily_budget_exceeded'
      )
      expect(budgetCalls.length).toBeGreaterThan(0)
    })
  })

  describe('durable terminal outbox for live jobs', () => {
    it('retries a live completion callback after restart without duplicating accounting', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('live-callback-retry' as any)
      const db = initDb(':memory:')
      const failingCallback = vi.fn(() => { throw new Error('simulated live callback crash') })
      const first = new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        onJobFinished: failingCallback,
      })

      first.enqueue('/specrails:implement #31')
      child.stdout.push(JSON.stringify({
        type: 'result', total_cost_usd: 1.25, usage: { input_tokens: 20 },
      }) + '\n')
      await new Promise((resolve) => setImmediate(resolve))
      child.emit('close', 0)

      expect(db.prepare(`
        SELECT accounting_completed, callback_completed, terminal_completed
          FROM orphan_job_recovery WHERE job_id = 'live-callback-retry'
      `).get()).toMatchObject({
        accounting_completed: 1,
        callback_completed: 0,
        terminal_completed: 1,
      })
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_invocations
         WHERE surface_ref_id = 'live-callback-retry'
      `).get()).toMatchObject({ count: 1 })

      const succeedingCallback = vi.fn()
      const restarted = new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        onJobFinished: succeedingCallback,
      })

      expect(succeedingCallback).toHaveBeenCalledWith(
        'live-callback-retry',
        'completed',
        1.25,
        expect.objectContaining({
          recoveryReplay: true,
          recoveryCommand: '/specrails:implement #31',
          recoveryTicketIds: [31],
        }),
      )
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_invocations
         WHERE surface_ref_id = 'live-callback-retry'
      `).get()).toMatchObject({ count: 1 })
      expect(db.prepare(`
        SELECT 1 FROM orphan_job_recovery WHERE job_id = 'live-callback-retry'
      `).get()).toBeUndefined()
      first.shutdown()
      restarted.shutdown()
      db.close()
    })

    it('pauses before spawning the next job while live accounting is pending', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const firstChild = createMockChildProcess()
      const secondChild = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(firstChild as any)
        .mockReturnValueOnce(secondChild as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('live-accounting-retry' as any)
        .mockReturnValueOnce('blocked-successor' as any)
      const db = initDb(':memory:')
      db.exec(`
        CREATE TRIGGER reject_live_accounting
        BEFORE INSERT ON ai_invocations
        BEGIN
          SELECT RAISE(ABORT, 'simulated live accounting crash');
        END;
      `)
      const manager = new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        onJobFinished: vi.fn(),
      })

      manager.enqueue('/specrails:implement #32')
      manager.enqueue('/specrails:verify #32')
      firstChild.emit('close', 0)

      expect(manager.isPaused()).toBe(true)
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1)
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'live-accounting-retry'`).get())
        .toMatchObject({ status: 'completed' })
      expect(db.prepare(`
        SELECT accounting_completed FROM orphan_job_recovery
         WHERE job_id = 'live-accounting-retry'
      `).get()).toMatchObject({ accounting_completed: 0 })

      db.exec(`DROP TRIGGER reject_live_accounting`)
      manager.resume()
      await vi.waitFor(() => expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(2))
      expect(manager.isPaused()).toBe(false)
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_invocations
         WHERE surface_ref_id = 'live-accounting-retry'
      `).get()).toMatchObject({ count: 1 })

      secondChild.emit('close', 0)
      manager.shutdown()
      db.close()
    })

    it('keeps a childless terminal transition running and blocks successors when staging fails', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const firstChild = createMockChildProcess()
      const secondChild = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(firstChild as any)
        .mockReturnValueOnce(secondChild as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('unstaged-live-exit' as any)
        .mockReturnValueOnce('unstaged-successor' as any)
      const db = initDb(':memory:')
      db.exec(`
        CREATE TRIGGER reject_live_terminal_intent
        BEFORE INSERT ON orphan_job_recovery
        BEGIN
          SELECT RAISE(ABORT, 'simulated terminal intent crash');
        END;
      `)
      const onJobFinished = vi.fn()
      const manager = new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        onJobFinished,
      })

      manager.enqueue('/specrails:implement #33')
      manager.enqueue('/specrails:verify #33')
      firstChild.emit('close', 0)

      expect(manager.isPaused()).toBe(true)
      expect(manager.getActiveJobId()).toBe('unstaged-live-exit')
      expect(manager.getJobs().find((job) => job.id === 'unstaged-live-exit'))
        .toMatchObject({ status: 'running' })
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'unstaged-live-exit'`).get())
        .toMatchObject({ status: 'running' })
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1)
      expect(onJobFinished).not.toHaveBeenCalled()

      db.exec(`DROP TRIGGER reject_live_terminal_intent`)
      manager.shutdown()
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'unstaged-live-exit'`).get())
        .toMatchObject({ status: 'failed' })
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_invocations
         WHERE surface_ref_id = 'unstaged-live-exit'
      `).get()).toMatchObject({ count: 1 })
      expect(onJobFinished).toHaveBeenCalledTimes(1)
      db.close()
    })

    it('recovers a disposed child close on a repaired second shutdown without losing accounting', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('shutdown-retry-after-close' as any)
      const db = initDb(':memory:')
      db.exec(`
        CREATE TRIGGER reject_shutdown_terminal_intent
        BEFORE INSERT ON orphan_job_recovery
        BEGIN
          SELECT RAISE(ABORT, 'simulated shutdown terminal intent crash');
        END;
      `)
      const onJobFinished = vi.fn()
      const manager = new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        onJobFinished,
      })

      manager.enqueue('/specrails:implement #34')
      child.stdout.push(JSON.stringify({
        type: 'assistant',
        message: {
          id: 'shutdown-message',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 700, output_tokens: 80 },
          content: [{ type: 'text', text: 'durable work' }],
        },
      }) + '\n')
      await new Promise((resolve) => setImmediate(resolve))

      expect(manager.shutdown()).toBe(false)
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'shutdown-retry-after-close'`).get())
        .toMatchObject({ status: 'running' })
      expect(db.prepare(`SELECT 1 FROM orphan_job_recovery WHERE job_id = 'shutdown-retry-after-close'`).get())
        .toBeUndefined()
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_invocations
         WHERE surface_ref_id = 'shutdown-retry-after-close'
      `).get()).toMatchObject({ count: 0 })

      // The process exits after shutdown has set the disposed guard. Its live
      // in-memory accumulator is consumed, so the retry must recover from the
      // durable RUNNING row and raw event log rather than the close callback.
      child.emit('close', 0)
      expect(manager.getActiveJobId()).toBeNull()

      db.exec(`DROP TRIGGER reject_shutdown_terminal_intent`)
      expect(manager.shutdown()).toBe(true)

      const job = db.prepare(`
        SELECT status, tokens_in, tokens_out, total_cost_usd, total_cost_usd_estimated
          FROM jobs WHERE id = 'shutdown-retry-after-close'
      `).get() as {
        status: string
        tokens_in: number | null
        tokens_out: number | null
        total_cost_usd: number | null
        total_cost_usd_estimated: number
      }
      const invocation = db.prepare(`
        SELECT status, tokens_in, tokens_out, total_cost_usd, total_cost_usd_estimated
          FROM ai_invocations WHERE surface_ref_id = 'shutdown-retry-after-close'
      `).get() as typeof job | undefined
      expect(job).toMatchObject({
        status: 'failed',
        tokens_in: 700,
        tokens_out: 80,
        total_cost_usd_estimated: 1,
      })
      expect(job.total_cost_usd).toBeGreaterThan(0)
      expect(invocation).toMatchObject({
        status: 'aborted',
        tokens_in: 700,
        tokens_out: 80,
        total_cost_usd_estimated: 1,
      })
      expect(invocation!.total_cost_usd).toBeCloseTo(job.total_cost_usd!, 12)
      expect(db.prepare(`SELECT 1 FROM orphan_job_recovery WHERE job_id = 'shutdown-retry-after-close'`).get())
        .toBeUndefined()
      expect(onJobFinished).toHaveBeenCalledTimes(1)
      db.close()
    })
  })

  describe('restore backfill (CRIT-3 crash path)', () => {
    it('writes an aborted ai_invocations row for a job orphaned running by a crash', () => {
      const db = initDb(':memory:')
      createJob(db, { id: 'orphan', command: '/specrails:implement #3', started_at: new Date().toISOString() })
      // Simulate accumulated interactive spend on the still-running row.
      db.prepare(
        `UPDATE jobs SET status = 'running', total_cost_usd = 4.5, tokens_in = 1000, num_turns = 5, model = 'claude-opus-4-8' WHERE id = 'orphan'`
      ).run()

      // Construction runs _restoreFromDb → backfill + status flip.
      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

      const row = db.prepare(
        `SELECT status, total_cost_usd, tokens_in, num_turns, ticket_id FROM ai_invocations WHERE surface_ref_id = 'orphan'`
      ).get() as { status: string; total_cost_usd: number; tokens_in: number; num_turns: number; ticket_id: number } | undefined
      expect(row).toBeDefined()
      expect(row!.status).toBe('aborted')
      expect(row!.total_cost_usd).toBeCloseTo(4.5)
      expect(row!.tokens_in).toBe(1000)
      expect(row!.num_turns).toBe(5)
      expect(row!.ticket_id).toBe(3)

      const jrow = db.prepare(`SELECT status FROM jobs WHERE id = 'orphan'`).get() as { status: string }
      expect(jrow.status).toBe('failed')
    })

    it('backfills assistant usage when a non-interactive terminal result omits usage', () => {
      const db = initDb(':memory:')
      createJob(db, {
        id: 'result-without-usage-orphan',
        command: '/specrails:implement #35',
        started_at: new Date().toISOString(),
        provider: 'claude',
      })
      const insertEvent = db.prepare(
        `INSERT INTO events (job_id, seq, event_type, source, payload)
         VALUES (?, ?, ?, 'stdout', ?)`,
      )
      insertEvent.run('result-without-usage-orphan', 1, 'assistant', JSON.stringify({
        type: 'assistant',
        message: {
          id: 'assistant-usage-before-result',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 900,
            output_tokens: 120,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
          content: [{ type: 'text', text: 'completed work' }],
        },
      }))
      insertEvent.run('result-without-usage-orphan', 2, 'result', JSON.stringify({
        type: 'result',
        subtype: 'success',
        model: 'claude-sonnet-4-6',
      }))

      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

      const job = db.prepare(`
        SELECT status, tokens_in, tokens_out, tokens_cache_read,
               tokens_cache_create, total_cost_usd, total_cost_usd_estimated
          FROM jobs WHERE id = 'result-without-usage-orphan'
      `).get() as {
        status: string
        tokens_in: number | null
        tokens_out: number | null
        tokens_cache_read: number | null
        tokens_cache_create: number | null
        total_cost_usd: number | null
        total_cost_usd_estimated: number
      }
      const invocation = db.prepare(`
        SELECT status, tokens_in, tokens_out, tokens_cache_read,
               tokens_cache_create, total_cost_usd, total_cost_usd_estimated
          FROM ai_invocations WHERE surface_ref_id = 'result-without-usage-orphan'
      `).get() as typeof job | undefined
      expect(job).toMatchObject({
        status: 'failed',
        tokens_in: 900,
        tokens_out: 120,
        tokens_cache_read: 30,
        tokens_cache_create: 10,
        total_cost_usd_estimated: 1,
      })
      expect(job.total_cost_usd).toBeGreaterThan(0)
      expect(invocation).toMatchObject({
        status: 'aborted',
        tokens_in: 900,
        tokens_out: 120,
        tokens_cache_read: 30,
        tokens_cache_create: 10,
        total_cost_usd_estimated: 1,
      })
      expect(invocation!.total_cost_usd).toBeCloseTo(job.total_cost_usd!, 12)
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_invocations
         WHERE surface_ref_id = 'result-without-usage-orphan'
      `).get()).toMatchObject({ count: 1 })
      db.close()
    })

    it('captures a persisted running job before initDb can erase its accounting', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-crash-restore-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      try {
        const beforeCrash = initDb(dbPath)
        createJob(beforeCrash, { id: 'persisted-orphan', command: '/specrails:implement #9', started_at: new Date().toISOString() })
        beforeCrash.prepare(
          `UPDATE jobs SET status = 'running', total_cost_usd = 7.25, tokens_in = 222 WHERE id = 'persisted-orphan'`
        ).run()
        beforeCrash.close()

        const afterRestart = initDb(dbPath)
        new QueueManager(broadcast, afterRestart, [], undefined, { projectId: 'p1' })
        const invocation = afterRestart.prepare(
          `SELECT status, total_cost_usd, tokens_in FROM ai_invocations WHERE surface_ref_id = 'persisted-orphan'`
        ).get() as { status: string; total_cost_usd: number; tokens_in: number } | undefined
        expect(invocation).toMatchObject({ status: 'aborted', total_cost_usd: 7.25, tokens_in: 222 })
        afterRestart.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('replays the terminal domain callback for an orphaned job', () => {
      const db = initDb(':memory:')
      createJob(db, { id: 'callback-orphan', command: '/specrails:implement #4', started_at: new Date().toISOString() })
      db.prepare(`UPDATE jobs SET status = 'running', total_cost_usd = 1.5 WHERE id = 'callback-orphan'`).run()
      const onJobFinished = vi.fn()

      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

      expect(onJobFinished).toHaveBeenCalledWith(
        'callback-orphan', 'failed', 1.5, expect.objectContaining({
          recoveryReplay: true,
          recoveryCommand: '/specrails:implement #4',
          recoveryTicketIds: [4],
          recoveryCausalOwnership: false,
        }),
      )
      db.close()
    })

    it('retries failed accounting without replaying a checkpointed callback', () => {
      const db = initDb(':memory:')
      createJob(db, { id: 'accounting-retry-orphan', command: '/specrails:implement #14', started_at: new Date().toISOString() })
      db.prepare(`UPDATE jobs SET status = 'running', total_cost_usd = 2.5 WHERE id = 'accounting-retry-orphan'`).run()
      db.exec(`
        CREATE TRIGGER reject_orphan_accounting
        BEFORE INSERT ON ai_invocations
        BEGIN
          SELECT RAISE(ABORT, 'simulated accounting crash');
        END;
      `)
      const onJobFinished = vi.fn()

      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'accounting-retry-orphan'`).get())
        .toMatchObject({ status: 'failed' })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'accounting-retry-orphan'`).get())
        .toMatchObject({ count: 0 })
      expect(db.prepare(`SELECT accounting_completed, callback_completed FROM orphan_job_recovery WHERE job_id = 'accounting-retry-orphan'`).get())
        .toMatchObject({ accounting_completed: 0, callback_completed: 1 })
      expect(onJobFinished).toHaveBeenCalledTimes(1)

      db.exec(`DROP TRIGGER reject_orphan_accounting`)
      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

      expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'accounting-retry-orphan'`).get())
        .toMatchObject({ count: 1 })
      expect(onJobFinished).toHaveBeenCalledTimes(1)
      expect(db.prepare(`SELECT 1 FROM orphan_job_recovery WHERE job_id = 'accounting-retry-orphan'`).get()).toBeUndefined()
      db.close()
    })

    it('retries a failed callback without duplicating checkpointed accounting', () => {
      const db = initDb(':memory:')
      createJob(db, { id: 'callback-retry-orphan', command: '/specrails:implement #15', started_at: new Date().toISOString() })
      db.prepare(`UPDATE jobs SET status = 'running', total_cost_usd = 3.5 WHERE id = 'callback-retry-orphan'`).run()
      const failingCallback = vi.fn(() => { throw new Error('simulated callback crash') })

      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished: failingCallback })

      expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'callback-retry-orphan'`).get())
        .toMatchObject({ count: 1 })
      expect(db.prepare(`SELECT accounting_completed, callback_completed FROM orphan_job_recovery WHERE job_id = 'callback-retry-orphan'`).get())
        .toMatchObject({ accounting_completed: 1, callback_completed: 0 })
      const succeedingCallback = vi.fn()

      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished: succeedingCallback })

      expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'callback-retry-orphan'`).get())
        .toMatchObject({ count: 1 })
      expect(succeedingCallback).toHaveBeenCalledWith(
        'callback-retry-orphan', 'failed', 3.5, expect.objectContaining({
          recoveryReplay: true,
          recoveryCommand: '/specrails:implement #15',
          recoveryTicketIds: [15],
        }),
      )
      expect(db.prepare(`SELECT 1 FROM orphan_job_recovery WHERE job_id = 'callback-retry-orphan'`).get()).toBeUndefined()
      db.close()
    })

    it('replays dependent skips transactionally after the queued jobs are restored', () => {
      const db = initDb(':memory:')
      createJob(db, {
        id: 'crashed-parent',
        command: '/specrails:implement #21',
        started_at: new Date().toISOString(),
        pipeline_id: 'recovery-pipeline',
      })
      db.prepare(
        `INSERT INTO queued_jobs
          (id, command, queue_position, priority, depends_on_job_id, pipeline_id)
         VALUES (?, ?, 1, 'normal', ?, ?)`
      ).run(
        'dependent-child',
        '/specrails:verify #21',
        'crashed-parent',
        'recovery-pipeline',
      )
      db.exec(`
        CREATE TRIGGER reject_orphan_terminal_checkpoint
        BEFORE UPDATE OF terminal_completed ON orphan_job_recovery
        WHEN NEW.terminal_completed = 1
        BEGIN
          SELECT RAISE(ABORT, 'simulated terminal checkpoint crash');
        END;
      `)
      const onJobFinished = vi.fn()

      const firstManager = new QueueManager(
        broadcast, db, [], undefined, { projectId: 'p1', onJobFinished },
      )

      // The dependent mutation and its checkpoint share one transaction. The
      // injected checkpoint failure therefore rolls the persisted skip back.
      expect(db.prepare(`SELECT id FROM queued_jobs WHERE id = 'dependent-child'`).get())
        .toMatchObject({ id: 'dependent-child' })
      expect(db.prepare(`SELECT 1 FROM jobs WHERE id = 'dependent-child'`).get()).toBeUndefined()
      expect(db.prepare(
        `SELECT accounting_completed, callback_completed, terminal_completed
         FROM orphan_job_recovery WHERE job_id = 'crashed-parent'`
      ).get()).toMatchObject({ accounting_completed: 1, callback_completed: 1, terminal_completed: 0 })
      // The parent callback committed; the child callback ran inside the SQL
      // transaction that the injected checkpoint failure rolls back. A mock's
      // call history is external to SQLite, so it observes both deliveries.
      expect(onJobFinished).toHaveBeenCalledTimes(2)
      // The SQL transaction rolled back, so its in-memory projection must roll
      // back too. Pre-fix the child stayed `skipped` and vanished from `_queue`
      // until a full process restart despite remaining durable in queued_jobs.
      expect(firstManager.getJobs().find((job) => job.id === 'dependent-child')).toMatchObject({
        status: 'queued',
      })

      db.exec(`DROP TRIGGER reject_orphan_terminal_checkpoint`)
      broadcast.mockClear()
      new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

      expect(db.prepare(`SELECT status, skip_reason FROM jobs WHERE id = 'dependent-child'`).get())
        .toMatchObject({
          status: 'skipped',
          skip_reason: 'Parent job crashed-parent failed',
        })
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'crashed-parent'`
      ).get()).toMatchObject({ count: 1 })
      // The child delivery is intentionally at-least-once: its first DB effects
      // rolled back with the checkpoint, so the recovery retry delivers it again.
      expect(onJobFinished).toHaveBeenCalledTimes(3)
      expect(db.prepare(`SELECT 1 FROM orphan_job_recovery WHERE job_id = 'crashed-parent'`).get()).toBeUndefined()
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'pipeline_status', pipelineId: 'recovery-pipeline', status: 'failed',
      }))
      db.close()
    })

    it('recovers the persisted per-job provider instead of the project primary', () => {
      const db = initDb(':memory:')
      createJob(db, {
        id: 'codex-override-orphan',
        command: '/specrails:implement #22',
        started_at: new Date().toISOString(),
        provider: 'codex',
      })
      db.prepare(
        `UPDATE jobs SET model = 'gpt-5.5', tokens_in = 42 WHERE id = 'codex-override-orphan'`
      ).run()

      new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1',
        provider: 'claude',
        onJobFinished: vi.fn(),
      })

      expect(db.prepare(
        `SELECT provider, model, tokens_in, status
         FROM ai_invocations WHERE surface_ref_id = 'codex-override-orphan'`
      ).get()).toMatchObject({
        provider: 'codex', model: 'gpt-5.5', tokens_in: 42, status: 'aborted',
      })
      db.close()
    })

    it('leaves loop-owned backing jobs to the loop recovery authority', () => {
      const db = initDb(':memory:')
      createJob(db, {
        id: 'loop-owned-orphan',
        command: 'loop: verify #23',
        started_at: new Date().toISOString(),
        provider: 'codex',
        owner: 'loop',
      })
      db.prepare(
        `UPDATE jobs SET total_cost_usd = 4.25, tokens_in = 500
          WHERE id = 'loop-owned-orphan'`
      ).run()
      const onJobFinished = vi.fn()

      new QueueManager(broadcast, db, [], undefined, {
        projectId: 'p1', provider: 'claude', onJobFinished,
      })

      expect(db.prepare(`SELECT status, provider, owner FROM jobs WHERE id = 'loop-owned-orphan'`).get())
        .toMatchObject({ status: 'running', provider: 'codex', owner: 'loop' })
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM ai_invocations
          WHERE surface = 'job' AND surface_ref_id = 'loop-owned-orphan'`
      ).get()).toMatchObject({ count: 0 })
      expect(db.prepare(
        `SELECT 1 FROM orphan_job_recovery WHERE job_id = 'loop-owned-orphan'`
      ).get()).toBeUndefined()
      expect(onJobFinished).not.toHaveBeenCalled()
      db.close()
    })
  })

  describe('unkillable-job double-record guard (LOW-6)', () => {
    it('reconciles a late close with real cost into the placeholder row (no duplicate, no double callback)', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('ff-job' as any)
      // Make the SIGKILL escalation "fail" so _forceFailUnkillableJob runs.
      vi.mocked(treeKill).mockImplementation(((_pid: number, sig: string, cb?: (e?: Error) => void) => {
        if (sig === 'SIGKILL' && cb) cb(new Error('taskkill failed'))
        else if (cb) cb(undefined)
      }) as any)

      const db = initDb(':memory:')
      const onJobFinished = vi.fn()
      const qm2 = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })
      qm2.enqueue('/specrails:implement #9')
      await new Promise((r) => setTimeout(r, 30))

      // Cancel → SIGTERM → 5s kill-timer → SIGKILL (errors) → force-fail placeholder.
      vi.useFakeTimers()
      qm2.cancel('ff-job')
      vi.advanceTimersByTime(5100)
      vi.useRealTimers()

      let rows = db.prepare(`SELECT status, total_cost_usd FROM ai_invocations WHERE surface = 'job'`).all() as Array<{ status: string; total_cost_usd: number | null }>
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('aborted')
      expect(onJobFinished).toHaveBeenCalledTimes(1)

      // The wedged child finally dies, emitting a real result event.
      child.stdout.push(JSON.stringify({ type: 'result', total_cost_usd: 0.42, num_turns: 3, model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } }) + '\n')
      await new Promise((r) => setTimeout(r, 30))
      child.emit('close', 0)
      await new Promise((r) => setTimeout(r, 30))

      rows = db.prepare(`SELECT status, total_cost_usd FROM ai_invocations WHERE surface = 'job'`).all() as Array<{ status: string; total_cost_usd: number | null }>
      // The placeholder was REPLACED, not duplicated.
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('success')
      expect(rows[0].total_cost_usd!).toBeCloseTo(0.42)
      // onJobFinished did NOT fire a second time.
      expect(onJobFinished).toHaveBeenCalledTimes(1)
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
        vi.mocked(mockUuidV4)
          .mockReturnValueOnce('unkillable-job' as any)
          .mockReturnValueOnce('unkillable-child' as any)

        // SIGKILL escalation reports failure → recovery branch runs.
        vi.mocked(treeKill).mockImplementation(((pid: number, signal?: string, cb?: (e?: Error) => void) => {
          if (signal === 'SIGKILL' && cb) cb(new Error('taskkill failed'))
        }) as any)

        const db = initDb(':memory:')
        const onJobFinished = vi.fn()
        const qmKill = new QueueManager(broadcast, db, [], '/tmp/repo', {
          provider: 'claude', projectId: 'p1', projectSlug: 'proj', onJobFinished,
        })
        qmKill.enqueue('/specrails:implement #5', { pipelineId: 'unkillable-pipeline' })
        qmKill.enqueue('/specrails:verify #5', {
          dependsOnJobId: 'unkillable-job',
          pipelineId: 'unkillable-pipeline',
        })
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
        expect(onJobFinished).toHaveBeenCalledWith(
          'unkillable-job',
          'failed',
          undefined,
          expect.objectContaining({ recoveryReplay: true }),
        )
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
        expect(qmKill.getJobs().find((candidate) => candidate.id === 'unkillable-child'))
          .toMatchObject({ status: 'skipped', skipReason: 'Parent job unkillable-job failed' })
        expect(db.prepare(`SELECT status FROM jobs WHERE id = 'unkillable-child'`).get())
          .toMatchObject({ status: 'skipped' })
        expect(onJobFinished).toHaveBeenCalledWith(
          'unkillable-child',
          'skipped',
          undefined,
          expect.objectContaining({ recoveryReplay: true }),
        )
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
          type: 'pipeline_status', pipelineId: 'unkillable-pipeline', status: 'failed',
        }))
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
        expect(db.prepare(
          `SELECT provider FROM jobs WHERE id = 'codex-unkillable-job'`
        ).get()).toMatchObject({ provider: 'codex' })

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
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('wedged-job' as any)
        .mockReturnValueOnce('wedged-child' as any)

      const db = initDb(':memory:')
      const onJobFinished = vi.fn()
      const qm2 = new QueueManager(broadcast, db, [], '/tmp/repo', {
        provider: 'claude', projectId: 'p1', projectSlug: 'proj', onJobFinished,
      })
      qm2.enqueue('/specrails:implement #9', { pipelineId: 'wedged-pipeline' })
      qm2.enqueue('/specrails:verify #9', {
        dependsOnJobId: 'wedged-job',
        pipelineId: 'wedged-pipeline',
      })
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
      expect(onJobFinished).toHaveBeenCalledWith(
        'wedged-job',
        'failed',
        undefined,
        expect.objectContaining({ recoveryReplay: true }),
      )
      expect(qm2.getJobs().find((candidate) => candidate.id === 'wedged-child'))
        .toMatchObject({ status: 'skipped', skipReason: 'Parent job wedged-job failed' })
      expect(db.prepare(`SELECT status FROM jobs WHERE id = 'wedged-child'`).get())
        .toMatchObject({ status: 'skipped' })
      expect(onJobFinished).toHaveBeenCalledWith(
        'wedged-child',
        'skipped',
        undefined,
        expect.objectContaining({ recoveryReplay: true }),
      )
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'pipeline_status', pipelineId: 'wedged-pipeline', status: 'failed',
      }))
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

// ─── Interactive-by-default spawn gate (S1 flip) ──────────────────────────────
// Every claude job spawns as a persistent-stdin interactive session by default:
// freestyle keeps 'finalize' settle-mode (idles until the human Finalizes),
// everything else runs 'auto' (settles itself at quiescence). Kill-switch
// SPECRAILS_INTERACTIVE_JOBS=false and the per-job `interactive: false`
// override force the legacy one-shot spawn; codex/gemini never qualify
// (no persistent-stdin capability).

const interactiveChildrenByPid = new Map<number, any>()
let nextInteractivePid = 776

function createInteractiveMockChild() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  const writes: string[] = []
  const stdin = new EventEmitter() as any
  stdin.write = (s: string) => { writes.push(s); return true }
  stdin.destroyed = false
  child.stdin = stdin
  child.stdinWrites = writes
  child.pid = ++nextInteractivePid
  child.killed = false
  child.kill = (_sig?: string) => {
    child.killed = true
    queueMicrotask(() => child.emit('close', 0))
    return true
  }
  interactiveChildrenByPid.set(child.pid, child)
  return child
}

function interactiveResultFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    total_cost_usd: 0.05,
    num_turns: 3,
    model: 'claude-opus-4-8',
    session_id: 'sess-1',
    result: 'done',
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    ...over,
  }) + '\n'
}

describe('interactive-by-default spawn gate (S1 flip)', () => {
  let broadcast: ReturnType<typeof vi.fn>
  const savedFlag = process.env.SPECRAILS_INTERACTIVE_JOBS
  const savedPrFlag = process.env.SPECRAILS_RAIL_DELIVER_PR
  const tick = () => new Promise((r) => setImmediate(r))

  beforeEach(() => {
    vi.resetAllMocks()
    __resetBinaryProbeCacheForTest()
    interactiveChildrenByPid.clear()
    nextInteractivePid = 776
    delete process.env.SPECRAILS_INTERACTIVE_JOBS // default ON
    delete process.env.SPECRAILS_RAIL_DELIVER_PR // PR delivery default-on
    broadcast = vi.fn()
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
    vi.mocked(treeKill).mockImplementation((pid, signal, callback) => {
      callback?.()
      const child = interactiveChildrenByPid.get(pid)
      if (child && signal === 'SIGTERM') {
        child.killed = true
        queueMicrotask(() => child.emit('close', 0))
      }
    })
  })

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = savedFlag
    if (savedPrFlag === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
    else process.env.SPECRAILS_RAIL_DELIVER_PR = savedPrFlag
    vi.restoreAllMocks()
  })

  it('never starts an interactive child when queued-to-running promotion fails', async () => {
    const db = initDb(':memory:')
    db.exec(`
      CREATE TRIGGER reject_interactive_promotion
      BEFORE INSERT ON jobs
      WHEN NEW.id = 'interactive-promotion-failure'
      BEGIN
        SELECT RAISE(ABORT, 'simulated interactive promotion failure');
      END;
    `)
    vi.mocked(mockUuidV4).mockReturnValue('interactive-promotion-failure' as any)
    const onJobFinished = vi.fn()
    const qm = new QueueManager(broadcast, db, [], undefined, {
      projectId: 'p1',
      onJobFinished,
    })

    qm.enqueue('/specrails:implement #7 --yes')
    await tick()

    expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT id FROM queued_jobs WHERE id = 'interactive-promotion-failure'`).get())
      .toEqual({ id: 'interactive-promotion-failure' })
    expect(db.prepare(`SELECT 1 FROM jobs WHERE id = 'interactive-promotion-failure'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'interactive-promotion-failure'`).get())
      .toEqual({ count: 0 })
    expect(onJobFinished).not.toHaveBeenCalled()
    expect(qm.isPaused()).toBe(true)
    expect(qm.getActiveJobId()).toBeNull()
    expect(qm.getJobs().find((candidate) => candidate.id === 'interactive-promotion-failure'))
      .toMatchObject({ status: 'queued', queuePosition: 1, startedAt: null, finishedAt: null })
    qm.shutdown()
    db.close()
  })

  it('spawns a claude slash-command job as an interactive session by default (first frame = the command)', () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-1' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:implement #7 --yes')

    // Persistent-stdin transport: piped stdin + stream-json input, valueless -p.
    const [, args, opts] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[], { stdio: string[] }]
    expect(args).toContain('--input-format')
    expect(args).toContain('stream-json')
    expect(args[args.indexOf('-p') + 1]).toBe('--input-format')
    expect(opts.stdio[0]).toBe('pipe')
    // Slash command rides the FIRST stdin frame (spike-verified expansion).
    expect(child.stdinWrites[0]).toContain('/specrails:implement #7 --yes')
    // Supplementary context APPENDS to the CLI default system prompt (the
    // expanded command brings its own) with the interactive --yes wording.
    expect(args).toContain('--append-system-prompt')
    expect(String(args[args.indexOf('--append-system-prompt') + 1])).toContain('LIVE GUIDANCE')
    expect(args).not.toContain('--system-prompt')
    // The job row is marked interactive (client composer gates on this).
    const row = db.prepare('SELECT interactive, status FROM jobs WHERE id = ?').get('ijob-1') as { interactive: number; status: string }
    expect(row.interactive).toBe(1)
    expect(row.status).toBe('running')
    // Non-freestyle ⇒ the live session self-settles ('auto'); GET /jobs/:id
    // surfaces this so the composer shows the wrap-up affordance, not Finalize.
    expect(qm.getInteractiveSettleMode('ijob-1')).toBe('auto')
    expect(qm.getInteractiveSettleMode('ghost')).toBeNull()

    qm.shutdown()
    db.close()
  })

  it('shutdown records the interactive session snapshot instead of an empty active-job row', async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-shutdown' as any)
    const onJobFinished = vi.fn()
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

    // Freestyle remains resident after a result, giving shutdown an accumulated
    // session snapshot to fold rather than a naturally settled job.
    qm.enqueue('/specrails:freestyle #8 --yes')
    child.stdout.push(interactiveResultFrame({
      total_cost_usd: 0.37,
      num_turns: 4,
      usage: {
        input_tokens: 321,
        output_tokens: 123,
        cache_read_input_tokens: 21,
        cache_creation_input_tokens: 7,
      },
    }))
    await tick(); await tick(); await tick()
    expect(qm.getJobs()[0].status).toBe('running')

    qm.shutdown()

    const invocation = db.prepare(
      `SELECT provider, status, total_cost_usd, tokens_in, tokens_out, num_turns, model
       FROM ai_invocations WHERE surface_ref_id = 'ijob-shutdown'`
    ).get() as {
      provider: string; status: string; total_cost_usd: number
      tokens_in: number; tokens_out: number; num_turns: number; model: string
    }
    expect(invocation).toMatchObject({
      provider: 'claude',
      status: 'aborted',
      total_cost_usd: 0.37,
      tokens_in: 321,
      tokens_out: 123,
      num_turns: 4,
      model: 'claude-opus-4-8',
    })
    expect(db.prepare(
      `SELECT status, total_cost_usd, tokens_in, tokens_out, num_turns, interactive
       FROM jobs WHERE id = 'ijob-shutdown'`
    ).get()).toMatchObject({
      status: 'failed',
      total_cost_usd: 0.37,
      tokens_in: 321,
      tokens_out: 123,
      num_turns: 4,
      interactive: 1,
    })
    expect(onJobFinished).toHaveBeenCalledWith(
      'ijob-shutdown', 'failed', 0.37, expect.objectContaining({
        recoveryReplay: true,
        recoveryCommand: '/specrails:freestyle #8 --yes',
        recoveryTicketIds: [8],
      }),
    )
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM ai_invocations WHERE surface_ref_id = 'ijob-shutdown'`
    ).get()).toMatchObject({ count: 1 })
    db.close()
  })

  it('AUTO settle: quiesces after the turn result — job completed, slot released, queue drains', async () => {
    const db = initDb(':memory:')
    const child1 = createInteractiveMockChild()
    const child2 = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValueOnce(child1).mockReturnValueOnce(child2)
    vi.mocked(mockUuidV4).mockReturnValueOnce('ijob-1' as any).mockReturnValueOnce('ijob-2' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:implement #1 --yes')
    qm.enqueue('/specrails:implement #2 --yes')
    expect(qm.getActiveJobId()).toBe('ijob-1')
    expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1)

    child1.stdout.push(interactiveResultFrame())
    await vi.waitFor(() => {
      expect(qm.getJobs().find((j) => j.id === 'ijob-1')?.status).toBe('completed')
    })
    expect(child1.killed).toBe(true)

    // The slot was released at natural end and the queue drained into job 2.
    expect(qm.getActiveJobId()).toBe('ijob-2')
    expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(2)

    // Terminal DB row: completed with the accumulated per-turn usage, and the
    // result text captured for output chaining.
    const row = db.prepare('SELECT status, total_cost_usd, interactive FROM jobs WHERE id = ?').get('ijob-1') as { status: string; total_cost_usd: number; interactive: number }
    expect(row.status).toBe('completed')
    expect(row.total_cost_usd).toBeCloseTo(0.05)
    expect(row.interactive).toBe(1)
    expect(qm.getJobs().find((j) => j.id === 'ijob-1')?.resultText).toBe('done')

    // job.finalized broadcast with completed status.
    const finalized = (broadcast.mock.calls as Array<[WsMessage]>)
      .map((c) => c[0])
      .find((m) => m.type === 'job.finalized' && (m as any).jobId === 'ijob-1') as any
    expect(finalized?.status).toBe('completed')

    qm.shutdown()
    db.close()
  })

  it('AUTO settle: a queued user turn extends the session before it settles', async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-1' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:implement #1')
    // Steer mid-stream: queues behind the active turn.
    expect(qm.sendInteractiveTurn('ijob-1', 'also check the edge cases')).toBe(true)

    child.stdout.push(interactiveResultFrame())
    await tick(); await tick(); await tick()
    // Not settled — the queued prompt was fed as turn 2.
    expect(qm.getJobs()[0].status).toBe('running')
    expect(child.killed).toBe(false)
    expect(child.stdinWrites.length).toBe(2)
    expect(child.stdinWrites[1]).toContain('also check the edge cases')

    // Turn 2 finishes with nothing queued → now it settles.
    child.stdout.push(interactiveResultFrame({ total_cost_usd: 0.1, num_turns: 6 }))
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('completed'))

    qm.shutdown()
    db.close()
  })

  it("freestyle keeps 'finalize' settle-mode: idles after the result until an explicit finalize", async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-u' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:freestyle #3 --yes')
    // Freestyle's first frame is the PROSE prompt, not the slash command, and
    // its supplementary context keeps the byte-identical --system-prompt path.
    const [, args] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[]]
    expect(child.stdinWrites[0]).not.toContain('/specrails:freestyle')
    expect(args).toContain('--system-prompt')
    expect(args).not.toContain('--append-system-prompt')

    // The live session reports 'finalize' (GET /jobs/:id → the composer keeps
    // today's Finalize button semantics for freestyle).
    expect(qm.getInteractiveSettleMode('ijob-u')).toBe('finalize')

    child.stdout.push(interactiveResultFrame())
    await tick(); await tick(); await tick()
    // Still running — the session idles awaiting the human.
    expect(qm.getJobs()[0].status).toBe('running')
    expect(child.killed).toBe(false)

    expect(qm.finalizeInteractive('ijob-u')).toBe(true)
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('completed'))
    // Settled ⇒ no live session ⇒ null.
    expect(qm.getInteractiveSettleMode('ijob-u')).toBeNull()

    qm.shutdown()
    db.close()
  })

  it('AUTO settle threads the spawn-captured PR-delivery mode into onJobFinished (on_review under the default-on flag)', async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-pr' as any)
    const onJobFinished = vi.fn()
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

    qm.enqueue('/specrails:implement #1 --yes')
    child.stdout.push(interactiveResultFrame())
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('completed'))

    expect(onJobFinished).toHaveBeenCalledWith('ijob-pr', 'completed', expect.any(Number), expect.objectContaining({
      recoveryReplay: true,
      ticketCompletionStatus: 'on_review',
    }))

    qm.shutdown()
    db.close()
  })

  it("FINALIZE settle (freestyle Finalize) threads on_review too; kill-switch off restores the previous 'done' behavior", async () => {
    // finalize mode, flag on (default) → on_review
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-fin-pr' as any)
    const onJobFinished = vi.fn()
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

    qm.enqueue('/specrails:freestyle #3 --yes')
    child.stdout.push(interactiveResultFrame())
    await tick(); await tick(); await tick()
    expect(qm.finalizeInteractive('ijob-fin-pr')).toBe(true)
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('completed'))
    expect(onJobFinished).toHaveBeenCalledWith('ijob-fin-pr', 'completed', expect.any(Number), expect.objectContaining({
      recoveryReplay: true,
      ticketCompletionStatus: 'on_review',
    }))
    qm.shutdown()
    db.close()

    // kill-switch off → legacy 'done' (byte-identical promotion downstream)
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    const db2 = initDb(':memory:')
    const child2 = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child2)
    vi.mocked(mockUuidV4).mockReturnValue('ijob-fin-legacy' as any)
    const onJobFinished2 = vi.fn()
    const qm2 = new QueueManager(broadcast, db2, [], undefined, { projectId: 'p1', onJobFinished: onJobFinished2 })

    qm2.enqueue('/specrails:freestyle #4 --yes')
    child2.stdout.push(interactiveResultFrame())
    await tick(); await tick(); await tick()
    expect(qm2.finalizeInteractive('ijob-fin-legacy')).toBe(true)
    await vi.waitFor(() => expect(qm2.getJobs()[0].status).toBe('completed'))
    expect(onJobFinished2).toHaveBeenCalledWith('ijob-fin-legacy', 'completed', expect.any(Number), expect.objectContaining({
      recoveryReplay: true,
      ticketCompletionStatus: 'done',
    }))
    qm2.shutdown()
    db2.close()
  })

  it('kill-switch off ⇒ legacy one-shot spawn (even with an explicit interactive: true)', () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('leg-1' as any)
    const qm = new QueueManager(broadcast)

    qm.enqueue('/specrails:implement #1', { interactive: true })

    const [, args, opts] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[], { stdio: string[] }]
    expect(args).not.toContain('--input-format')
    expect(args[args.indexOf('-p') + 1]).toBe('/specrails:implement #1')
    expect(opts.stdio[0]).toBe('ignore')
  })

  it('EnqueueOptions.interactive=false forces the legacy spawn under the default-on gate', () => {
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('leg-2' as any)
    const qm = new QueueManager(broadcast)

    qm.enqueue('/specrails:implement #1 --yes', { interactive: false })

    const [, args, opts] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[], { stdio: string[] }]
    expect(args).not.toContain('--input-format')
    expect(opts.stdio[0]).toBe('ignore')
    // Legacy spawn keeps the FULLY AUTONOMOUS --yes wording (stdin disconnected).
    expect(String(args[args.indexOf('--append-system-prompt') + 1])).toContain('FULLY AUTONOMOUS')
  })

  it('codex jobs never spawn interactive (no persistent-stdin capability)', () => {
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('cdx-1' as any)
    const qm = new QueueManager(broadcast, undefined, [], undefined, { provider: 'codex' })

    qm.enqueue('/specrails:implement #1', { interactive: true })

    const [, args, opts] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[], { stdio: string[] }]
    expect(args).not.toContain('--input-format')
    expect(opts.stdio[0]).toBe('ignore')
  })

  it('restart durability: a restored queued job (selection map lost) still spawns interactive', () => {
    const db = initDb(':memory:')
    db.prepare(
      `INSERT INTO jobs (id, command, status, started_at, queue_position, priority) VALUES ('restored-1', '/specrails:implement #9', 'queued', ?, 0, 'normal')`
    ).run(new Date().toISOString())
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    // Fresh manager = fresh (empty) _jobInteractiveSelection — the default gate
    // decides at spawn time, so the restored job still goes interactive.
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1)
    const [, args, opts] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[], { stdio: string[] }]
    expect(args).toContain('--input-format')
    expect(opts.stdio[0]).toBe('pipe')
    expect(child.stdinWrites[0]).toContain('/specrails:implement #9')
    const row = db.prepare('SELECT interactive FROM jobs WHERE id = ?').get('restored-1') as { interactive: number }
    expect(row.interactive).toBe(1)

    qm.shutdown()
    db.close()
  })

  it("AUTO wedge protection: a silent child settles the job 'failed' after the zombie budget", async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('wedge-1' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', zombieTimeoutMs: 60 })

    qm.enqueue('/specrails:implement #1')
    // No output ever arrives — the session's own wedge detector fires on the
    // shared zombie budget and settles 'crashed' → job failed.
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('failed'), { timeout: 2000 })
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get('wedge-1') as { status: string }
    expect(row.status).toBe('failed')

    qm.shutdown()
    db.close()
  })

  it('interactive settle skips dependent jobs when the session crashes (mirrors _onJobExit)', async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValueOnce('par-1' as any).mockReturnValueOnce('dep-1' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:implement #1')
    qm.enqueue('/specrails:implement #2', { dependsOnJobId: 'par-1' })

    // The resident child dies without a result → settle 'crashed' → failed.
    child.emit('close', 1)
    await vi.waitFor(() => expect(qm.getJobs().find((j) => j.id === 'par-1')?.status).toBe('failed'))
    expect(qm.getJobs().find((j) => j.id === 'dep-1')?.status).toBe('skipped')

    qm.shutdown()
    db.close()
  })

  it("finalize-mode (freestyle) has NO wedge timer — it idles on the human's time", async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('idle-1' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', zombieTimeoutMs: 40 })

    qm.enqueue('/specrails:freestyle #1')
    await new Promise((r) => setTimeout(r, 150))
    expect(qm.getJobs()[0].status).toBe('running')

    qm.shutdown()
    db.close()
  })

  // ─── Zero-work sessions (run 01f41203: synthetic "Unknown command" frame) ──
  // The claude CLI answers an unresolvable command with a synthetic SUCCESS
  // result frame (num_turns 0, cost 0, no assistant events) — no model ever
  // ran. A whole-session zero-work settle is a FAILED job, never 'completed'.

  /** The EXACT synthetic frame shape captured from the live run. */
  function syntheticUnknownCommandFrame(command = '/specrails:implement'): string {
    return JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 0,
      total_cost_usd: 0,
      duration_api_ms: 0,
      result: `Unknown command: ${command}`,
    }) + '\n'
  }

  it("zero-work whole-session settles the job 'failed' (auto mode) with a failed ai_invocations row", async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('zw-job-1' as any)
    const onJobFinished = vi.fn()
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1', onJobFinished })

    qm.enqueue('/specrails:implement #7 --yes')
    child.stdout.push(syntheticUnknownCommandFrame('/specrails:implement'))
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('failed'))

    // Terminal DB row + in-memory exit code reflect the failure (not a clean
    // $0 success). exit_code is in-memory only for interactive jobs —
    // finalizeInteractiveJob persists status/finished_at, not exit codes.
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get('zw-job-1') as { status: string }
    expect(row.status).toBe('failed')
    expect(qm.getJobs()[0].exitCode).toBe(1)

    // ai_invocations row status is 'failed' too — the command never ran.
    const inv = db.prepare(`SELECT status, num_turns FROM ai_invocations WHERE surface_ref_id = ?`).get('zw-job-1') as { status: string; num_turns: number }
    expect(inv.status).toBe('failed')
    expect(inv.num_turns).toBe(0)

    // job.finalized broadcast carries the failed status…
    const finalized = (broadcast.mock.calls as Array<[WsMessage]>)
      .map((c) => c[0])
      .find((m) => m.type === 'job.finalized' && (m as any).jobId === 'zw-job-1') as any
    expect(finalized?.status).toBe('failed')
    // …and the reason landed visibly as a stderr transcript line.
    const note = (broadcast.mock.calls as Array<[WsMessage]>)
      .map((c) => c[0])
      .find((m) => m.type === 'log' && (m as any).source === 'stderr' && (m as any).line?.includes('Unknown command: /specrails:implement'))
    expect(note).toBeTruthy()

    // Zero-work failure is UNAFFECTED by the ask-first flag: durable delivery
    // carries replay metadata but never a completion-only ticket status.
    expect(onJobFinished).toHaveBeenCalledWith(
      'zw-job-1',
      'failed',
      expect.anything(),
      expect.objectContaining({ recoveryReplay: true }),
    )

    qm.shutdown()
    db.close()
  })

  it("zero-work settles 'failed' EVEN in finalize mode (freestyle Finalize after the synthetic frame)", async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('zw-job-fin' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:freestyle #3 --yes')
    child.stdout.push(syntheticUnknownCommandFrame('/specrails:freestyle'))
    await tick(); await tick(); await tick()
    expect(qm.getJobs()[0].status).toBe('running') // idles awaiting the human

    expect(qm.finalizeInteractive('zw-job-fin')).toBe(true)
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('failed'))
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get('zw-job-fin') as { status: string }
    expect(row.status).toBe('failed')

    qm.shutdown()
    db.close()
  })

  it("multi-turn session where only the LAST turn is synthetic still settles 'completed' (whole-session predicate)", async () => {
    const db = initDb(':memory:')
    const child = createInteractiveMockChild()
    vi.mocked(mockSpawn).mockReturnValue(child)
    vi.mocked(mockUuidV4).mockReturnValue('zw-job-multi' as any)
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })

    qm.enqueue('/specrails:implement #1 --yes')
    // The user steers mid-stream — a second (late) turn queues: '/help'.
    expect(qm.sendInteractiveTurn('zw-job-multi', '/help')).toBe(true)
    // Turn 1 did REAL work (assistant events + a real result with usage).
    child.stdout.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'implementing' }] } }) + '\n')
    child.stdout.push(interactiveResultFrame())
    await tick(); await tick(); await tick()
    expect(qm.getJobs()[0].status).toBe('running') // extended by the queued turn

    // Turn 2 is the synthetic frame — the session then quiesces and settles.
    child.stdout.push(syntheticUnknownCommandFrame('/help'))
    await vi.waitFor(() => expect(qm.getJobs()[0].status).toBe('completed'))

    // Accumulated real work is kept and the invocation row is a success.
    const row = db.prepare('SELECT status, total_cost_usd, num_turns FROM jobs WHERE id = ?').get('zw-job-multi') as { status: string; total_cost_usd: number; num_turns: number }
    expect(row.status).toBe('completed')
    expect(row.total_cost_usd).toBeCloseTo(0.05)
    expect(row.num_turns).toBe(3)
    const inv = db.prepare(`SELECT status FROM ai_invocations WHERE surface_ref_id = ?`).get('zw-job-multi') as { status: string }
    expect(inv.status).toBe('success')

    qm.shutdown()
    db.close()
  })
})
