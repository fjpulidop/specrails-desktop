import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { initDb } from './db'
import type { DbInstance } from './db'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('./ids', () => ({
  newId: vi.fn(() => 'test-uuid'),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

vi.mock('./hooks', () => ({
  resetPhases: vi.fn(),
  setActivePhases: vi.fn(),
}))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import { newId as mockUuidV4 } from './ids'
import { InvalidJobDependencyError, QueueManager } from './queue-manager'
import type { WsMessage } from './types'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  return child
}

describe('Job Dependencies', () => {
  let qm: QueueManager
  let broadcast: ReturnType<typeof vi.fn>
  const savedInteractiveFlag = process.env.SPECRAILS_INTERACTIVE_JOBS

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
    // Pin the legacy one-shot spawn path (claude jobs are interactive by
    // default since the S1 flip; the interactive dependency/pipeline flow is
    // covered in queue-manager.test.ts's dedicated describe).
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    broadcast = vi.fn()
  })

  afterEach(() => {
    if (savedInteractiveFlag === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = savedInteractiveFlag
    vi.restoreAllMocks()
  })

  describe('enqueue with dependencies', () => {
    it('creates a job with dependency fields', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValueOnce('job-a' as any)

      qm = new QueueManager(broadcast)
      const job = qm.enqueue('/implement #1', {
        dependsOnJobId: 'parent-123',
        pipelineId: 'pipe-1',
      })

      expect(job.dependsOnJobId).toBe('parent-123')
      expect(job.pipelineId).toBe('pipe-1')
      expect(job.skipReason).toBeNull()
    })

    it('defaults dependency fields to null when not provided', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      qm = new QueueManager(broadcast)
      const job = qm.enqueue('/implement #1')

      expect(job.dependsOnJobId).toBeNull()
      expect(job.pipelineId).toBeNull()
    })
  })

  describe('dependency-aware queue drain', () => {
    it('skips a queued job whose dependency is still running', () => {
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast)

      // job-1 starts running immediately
      qm.enqueue('/health-check')
      // job-2 depends on job-1, stays queued
      qm.enqueue('/implement', { dependsOnJobId: 'job-1' })
      // job-3 has no dependency, but job-1 is still active so it stays queued too
      qm.enqueue('/review')

      const jobs = qm.getJobs()
      const job1 = jobs.find((j) => j.id === 'job-1')!
      const job2 = jobs.find((j) => j.id === 'job-2')!
      const job3 = jobs.find((j) => j.id === 'job-3')!

      expect(job1.status).toBe('running')
      expect(job2.status).toBe('queued')
      expect(job3.status).toBe('queued')
    })

    it('starts dependent job after parent completes', () => {
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, undefined, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check')
      qm.enqueue('/implement', { dependsOnJobId: 'job-1' })

      // job-1 completes successfully
      child1.emit('close', 0)

      const jobs = qm.getJobs()
      const job2 = jobs.find((j) => j.id === 'job-2')!

      expect(job2.status).toBe('running')
    })

    it('skips dependent job when parent fails', () => {
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValueOnce(child1 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, undefined, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check')
      qm.enqueue('/implement', { dependsOnJobId: 'job-1' })

      // job-1 fails
      child1.emit('close', 1)

      const jobs = qm.getJobs()
      const job2 = jobs.find((j) => j.id === 'job-2')!

      expect(job2.status).toBe('skipped')
      expect(job2.skipReason).toContain('job-1')
    })

    it('cascades skip when dependent of skipped job is also queued', () => {
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValueOnce(child1 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, undefined, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check')                                // job-1 → running
      qm.enqueue('/implement', { dependsOnJobId: 'job-1' })      // job-2 → queued (depends on job-1)
      qm.enqueue('/ship', { dependsOnJobId: 'job-2' })           // job-3 → queued (depends on job-2)

      // job-1 fails → job-2 skipped → job-3 also skipped
      child1.emit('close', 1)

      const jobs = qm.getJobs()
      expect(jobs.find((j) => j.id === 'job-2')!.status).toBe('skipped')
      expect(jobs.find((j) => j.id === 'job-3')!.status).toBe('skipped')
      expect(jobs.find((j) => j.id === 'job-3')!.skipReason).toContain('skipped')
    })

    it('picks next non-dependent job when dependent cannot run', () => {
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, undefined, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      // job-1 starts, job-2 depends on unresolved "external-job", job-3 has no dep
      qm.enqueue('/health-check')                                        // job-1 → running
      qm.enqueue('/implement', { dependsOnJobId: 'nonexistent-parent' }) // job-2 → queued
      qm.enqueue('/review')                                              // job-3 → queued

      // job-1 completes → drain should pick job-2 (nonexistent parent = ready)
      child1.emit('close', 0)

      const jobs = qm.getJobs()
      // When parent is nonexistent (not in memory or DB), we treat as ready
      expect(jobs.find((j) => j.id === 'job-2')!.status).toBe('running')
    })

    it('rejects malformed dependency ids at the manager boundary', () => {
      qm = new QueueManager(broadcast)

      expect(() => qm.enqueue('/implement', {
        dependsOnJobId: { typo: true } as unknown as string,
      })).toThrow(InvalidJobDependencyError)
      expect(qm.getJobs()).toEqual([])
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })

    it('rejects a terminal failed parent instead of queueing forever', () => {
      const db = initDb(':memory:')
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, finished_at, status)
         VALUES ('failed-parent', '/parent', datetime('now'), datetime('now'), 'failed')`,
      ).run()
      qm = new QueueManager(broadcast, db)

      expect(() => qm.enqueue('/child', { dependsOnJobId: 'failed-parent' }))
        .toThrow('Cannot depend on job failed-parent because it is failed')
      expect(db.prepare(`SELECT 1 FROM queued_jobs WHERE id = 'test-uuid'`).get()).toBeUndefined()
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
      db.close()
    })

    it('allows an already-completed parent and starts the child', () => {
      const db = initDb(':memory:')
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, finished_at, status)
         VALUES ('completed-parent', '/parent', datetime('now'), datetime('now'), 'completed')`,
      ).run()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('completed-child' as any)
      qm = new QueueManager(broadcast, db)

      const job = qm.enqueue('/child', { dependsOnJobId: 'completed-parent' })

      expect(job.status).toBe('running')
      expect(db.prepare(`SELECT status, depends_on_job_id FROM jobs WHERE id = 'completed-child'`).get())
        .toEqual({ status: 'running', depends_on_job_id: 'completed-parent' })
      db.close()
    })
  })

  describe('cancel with dependents', () => {
    it('skips dependent jobs when a queued parent is canceled', () => {
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValueOnce(child1 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast)

      qm.enqueue('/health-check')                              // job-1 → running
      qm.enqueue('/implement', { dependsOnJobId: 'job-1' })    // job-2 → queued
      qm.enqueue('/ship', { dependsOnJobId: 'job-2' })         // job-3 → queued

      // Cancel job-2 (which is queued)
      qm.cancel('job-2')

      const jobs = qm.getJobs()
      expect(jobs.find((j) => j.id === 'job-2')!.status).toBe('canceled')
      expect(jobs.find((j) => j.id === 'job-3')!.status).toBe('skipped')
    })
  })

  describe('pipeline status', () => {
    it('broadcasts pipeline_status completed when all jobs complete', () => {
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, undefined, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check', { pipelineId: 'pipe-1' })
      qm.enqueue('/implement', { dependsOnJobId: 'job-1', pipelineId: 'pipe-1' })

      // job-1 completes
      child1.emit('close', 0)

      // job-2 should now be running. Complete it.
      child2.emit('close', 0)

      const pipelineMsgs = broadcast.mock.calls
        .map((args: unknown[]) => args[0] as WsMessage)
        .filter((msg) => msg.type === 'pipeline_status')

      expect(pipelineMsgs.length).toBe(1)
      expect(pipelineMsgs[0]).toMatchObject({
        type: 'pipeline_status',
        pipelineId: 'pipe-1',
        status: 'completed',
      })
    })

    it('broadcasts pipeline_status failed when a job fails', () => {
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValueOnce(child1 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, undefined, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check', { pipelineId: 'pipe-1' })
      qm.enqueue('/implement', { dependsOnJobId: 'job-1', pipelineId: 'pipe-1' })

      // job-1 fails → job-2 skipped → pipeline failed
      child1.emit('close', 1)

      const pipelineMsgs = broadcast.mock.calls
        .map((args: unknown[]) => args[0] as WsMessage)
        .filter((msg) => msg.type === 'pipeline_status')

      expect(pipelineMsgs.length).toBe(1)
      expect(pipelineMsgs[0]).toMatchObject({
        type: 'pipeline_status',
        pipelineId: 'pipe-1',
        status: 'failed',
      })
    })
  })

  describe('DB persistence', () => {
    it('persists dependency fields to database', () => {
      const db = initDb(':memory:')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, db, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check', { pipelineId: 'pipe-1' })
      qm.enqueue('/implement', { dependsOnJobId: 'job-1', pipelineId: 'pipe-1' })

      // Check DB has the dependency fields on the queued job
      const row = db.prepare('SELECT depends_on_job_id, pipeline_id FROM jobs WHERE id = ?').get('job-1') as any
      expect(row.pipeline_id).toBe('pipe-1')

      db.close()
    })

    it('restores queued jobs with dependency fields on restart', () => {
      const db = initDb(':memory:')

      // Insert parent job first (FK constraint)
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES (?, ?, ?, ?)`
      ).run('parent-job', '/health-check', new Date().toISOString(), 'completed')
      // Insert a queued job with dependency
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, queue_position, depends_on_job_id, pipeline_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('dep-job', '/implement', new Date().toISOString(), 'queued', 1, 'parent-job', 'pipe-x')

      // Create QM which will restore from DB
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      qm = new QueueManager(broadcast, db)

      const jobs = qm.getJobs()
      const restored = jobs.find((j) => j.id === 'dep-job')!

      expect(restored.dependsOnJobId).toBe('parent-job')
      expect(restored.pipelineId).toBe('pipe-x')
      // Parent is completed → dependency met → job auto-starts on restore
      expect(restored.status).toBe('running')

      db.close()
    })

    it('marks dependent jobs as skipped in DB when parent fails', () => {
      const db = initDb(':memory:')
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValueOnce(child1 as any)

      let uuidCounter = 0
      vi.mocked(mockUuidV4).mockImplementation(() => `job-${++uuidCounter}` as any)

      qm = new QueueManager(broadcast, db, undefined, undefined, {
        zombieTimeoutMs: 0,
      })

      qm.enqueue('/health-check')
      qm.enqueue('/implement', { dependsOnJobId: 'job-1' })

      // job-1 fails
      child1.emit('close', 1)

      const row = db.prepare('SELECT status, skip_reason FROM jobs WHERE id = ?').get('job-2') as any
      expect(row.status).toBe('skipped')
      expect(row.skip_reason).toContain('job-1')
      expect(db.prepare('SELECT 1 FROM queued_jobs WHERE id = ?').get('job-2')).toBeUndefined()

      db.close()
    })
  })

  describe('DB helper functions', () => {
    it('getPipelineJobs returns jobs for a pipeline', async () => {
      const { getPipelineJobs } = await import('./db')
      const db = initDb(':memory:')

      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id, queue_position) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('p1', '/health', new Date().toISOString(), 'completed', 'pipe-1', 1)
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id, queue_position) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('p2', '/impl', new Date().toISOString(), 'queued', 'pipe-1', 2)
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id, queue_position) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('p3', '/other', new Date().toISOString(), 'completed', 'pipe-2', 1)

      const result = getPipelineJobs(db, 'pipe-1')
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('p1')
      expect(result[1].id).toBe('p2')

      db.close()
    })

    it('skipJob updates status and skip_reason in DB', async () => {
      const { skipJob } = await import('./db')
      const db = initDb(':memory:')

      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES (?, ?, ?, ?)`
      ).run('s1', '/impl', new Date().toISOString(), 'queued')

      skipJob(db, 's1', 'Parent failed')

      const row = db.prepare('SELECT status, skip_reason, finished_at FROM jobs WHERE id = ?').get('s1') as any
      expect(row.status).toBe('skipped')
      expect(row.skip_reason).toBe('Parent failed')
      expect(row.finished_at).toBeTruthy()

      db.close()
    })
  })
})
