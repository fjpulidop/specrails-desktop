import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import { createLoopRun, finishLoopRun, stageLoopStepRecovery, updateLoopStepActivityCheckpoint } from './loop-runs-store'
import {
  STUCK_FLOOR_MS,
  StuckRunDetector,
  findStuckCandidates,
  resolveStuckThresholdMs,
} from './stuck-run-detector'
import type { JobStuckMessage } from './types'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const NOW = 1_800_000_000_000

function runWithStep(
  runId: string,
  stepKey: string,
  lastActivityAtMs: number,
  opts: { projectId?: string; finished?: boolean } = {},
): void {
  const projectId = opts.projectId ?? 'proj'
  createLoopRun(db, {
    id: runId, projectId, loopId: 'factory:implement', loopName: 'Implement',
    iterationLimit: 1, startedAt: new Date(lastActivityAtMs).toISOString(),
  })
  if (opts.finished) {
    finishLoopRun(db, runId, { outcome: 'success', finishedAt: new Date(NOW).toISOString() })
  }
  stageLoopStepRecovery(db, {
    version: 1, runId, stepKey, invocationId: `inv-${runId}-${stepKey}`, projectId,
    provider: 'claude', model: 'sonnet', surfaceRefId: runId, ticketIds: [1],
    startedAt: new Date(lastActivityAtMs).toISOString(),
    baseline: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0, totalCostUsd: 0, numTurns: 0 },
    completedEventSeq: 0, providerCostBaseline: 0, providerTurnsBaseline: 0,
    loopDurationBaseline: 0, completedDurationMs: 0,
  })
  updateLoopStepActivityCheckpoint(db, runId, stepKey, lastActivityAtMs, lastActivityAtMs)
}

describe('resolveStuckThresholdMs', () => {
  it('defaults to the 10-minute floor', () => {
    expect(resolveStuckThresholdMs({} as NodeJS.ProcessEnv)).toBe(STUCK_FLOOR_MS)
    expect(STUCK_FLOOR_MS).toBe(600_000)
  })

  it('disables detection on 0/false/off', () => {
    for (const raw of ['0', 'false', 'off', 'OFF', ' False ']) {
      expect(resolveStuckThresholdMs({ SPECRAILS_STUCK_THRESHOLD_MS: raw } as NodeJS.ProcessEnv)).toBeNull()
    }
  })

  it('raises the threshold but never lowers it below the floor', () => {
    expect(resolveStuckThresholdMs({ SPECRAILS_STUCK_THRESHOLD_MS: '1800000' } as NodeJS.ProcessEnv)).toBe(1_800_000)
    expect(resolveStuckThresholdMs({ SPECRAILS_STUCK_THRESHOLD_MS: '1000' } as NodeJS.ProcessEnv)).toBe(STUCK_FLOOR_MS)
  })

  it('falls back to the floor on nonsense values', () => {
    expect(resolveStuckThresholdMs({ SPECRAILS_STUCK_THRESHOLD_MS: 'soon' } as NodeJS.ProcessEnv)).toBe(STUCK_FLOOR_MS)
    expect(resolveStuckThresholdMs({ SPECRAILS_STUCK_THRESHOLD_MS: '-5' } as NodeJS.ProcessEnv)).toBe(STUCK_FLOOR_MS)
    expect(resolveStuckThresholdMs({ SPECRAILS_STUCK_THRESHOLD_MS: '' } as NodeJS.ProcessEnv)).toBe(STUCK_FLOOR_MS)
  })
})

describe('findStuckCandidates', () => {
  const io = (over = {}) => ({ db, now: () => NOW, thresholdMs: STUCK_FLOOR_MS, ...over })

  it('flags a step whose last activity is older than the threshold', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    const found = findStuckCandidates(io())
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ runId: 'run-1', stepKey: 'step-1', projectId: 'proj' })
    expect(found[0].staleMs).toBeGreaterThan(STUCK_FLOOR_MS)
  })

  it('ignores a step still within the threshold', () => {
    runWithStep('run-1', 'step-1', NOW - 60_000)
    expect(findStuckCandidates(io())).toEqual([])
  })

  it('ignores exactly-at-threshold (strictly older only)', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS + 1)
    expect(findStuckCandidates(io())).toEqual([])
  })

  it('ignores steps of runs that are no longer running (orphan checkpoints)', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000, { finished: true })
    expect(findStuckCandidates(io())).toEqual([])
  })

  it('returns nothing when detection is disabled', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    expect(findStuckCandidates(io({ thresholdMs: null }))).toEqual([])
  })

  it('carries the payload projectId so the broadcast can be scoped', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000, { projectId: 'other' })
    expect(findStuckCandidates(io())[0].projectId).toBe('other')
  })

  it('skips checkpoints with no recorded activity at all', () => {
    createLoopRun(db, {
      id: 'run-1', projectId: 'proj', loopId: 'l', iterationLimit: 1,
      startedAt: new Date(NOW).toISOString(),
    })
    stageLoopStepRecovery(db, {
      version: 1, runId: 'run-1', stepKey: 's', invocationId: 'i', projectId: 'proj',
      provider: 'claude', model: null, surfaceRefId: 'run-1', ticketIds: [],
      startedAt: new Date(NOW).toISOString(),
      baseline: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0, totalCostUsd: 0, numTurns: 0 },
      completedEventSeq: 0, providerCostBaseline: 0, providerTurnsBaseline: 0,
      loopDurationBaseline: 0, completedDurationMs: 0,
    })
    expect(findStuckCandidates(io())).toEqual([])
  })

  it('tolerates a malformed payload without throwing', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    db.prepare('UPDATE loop_step_recovery SET payload = ?').run('{broken')
    expect(findStuckCandidates(io())).toEqual([])
  })

  it('tolerates a throwing liveness probe', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    expect(findStuckCandidates(io({ isRunActive: () => { throw new Error('db gone') } }))).toEqual([])
  })

  it('finds several stalled steps across runs', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    runWithStep('run-2', 'step-1', NOW - STUCK_FLOOR_MS - 2_000)
    expect(findStuckCandidates(io())).toHaveLength(2)
  })
})

describe('StuckRunDetector', () => {
  function detector(over = {}) {
    const sent: JobStuckMessage[] = []
    const broadcast = vi.fn((message: JobStuckMessage) => { sent.push(message) })
    const det = new StuckRunDetector('proj', { db, now: () => NOW, thresholdMs: STUCK_FLOOR_MS, ...over }, broadcast)
    return { det, broadcast, sent }
  }

  it('emits one project-scoped message for a stall', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    const { det, sent } = detector()
    expect(det.sweep()).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'job.stuck', projectId: 'proj', jobId: 'run-1', stepKey: 'step-1',
      // Actionable: the client offers "Stop run" through the existing cancel route.
      actions: ['stop'],
    })
    expect(sent[0].timestamp).toBe(new Date(NOW).toISOString())
  })

  it('never notifies twice for the SAME stall episode', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    const { det, broadcast } = detector()
    det.sweep()
    det.sweep()
    det.sweep()
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('re-arms after fresh activity: a later stall notifies again', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    const { det, broadcast } = detector()
    det.sweep()
    expect(broadcast).toHaveBeenCalledTimes(1)

    // Activity resumes, then the step stalls again at a NEW timestamp.
    updateLoopStepActivityCheckpoint(db, 'run-1', 'step-1', undefined, NOW - 1_000)
    const later = new StuckRunDetector(
      'proj',
      { db, now: () => NOW + STUCK_FLOOR_MS + 5_000, thresholdMs: STUCK_FLOOR_MS },
      broadcast,
    )
    expect(later.sweep()).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('forgets an episode once the stall ends so memory cannot grow forever', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    const { det, broadcast } = detector()
    det.sweep()
    db.prepare('DELETE FROM loop_step_recovery').run()
    det.sweep() // stall gone → episode forgotten
    runWithStep('run-2', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    det.sweep()
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('a failed broadcast is retried on the next sweep', () => {
    runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
    const broadcast = vi.fn()
      .mockImplementationOnce(() => { throw new Error('ws down') })
      .mockImplementation(() => {})
    const det = new StuckRunDetector('proj', { db, now: () => NOW, thresholdMs: STUCK_FLOOR_MS }, broadcast)
    expect(det.sweep()).toHaveLength(0)
    expect(det.sweep()).toHaveLength(1)
  })

  it('start() is a no-op when detection is disabled, and stop() is idempotent', () => {
    const { det } = detector({ thresholdMs: null })
    det.start(10)
    det.stop()
    det.stop()
    expect(true).toBe(true)
  })

  it('start() sweeps on the interval and stop() halts it', () => {
    vi.useFakeTimers()
    try {
      runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
      const { det, broadcast } = detector()
      det.start(1_000)
      vi.advanceTimersByTime(3_500)
      expect(broadcast).toHaveBeenCalledTimes(1) // same episode deduped
      det.stop()
      db.prepare('DELETE FROM loop_step_recovery').run()
      runWithStep('run-2', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
      vi.advanceTimersByTime(5_000)
      expect(broadcast).toHaveBeenCalledTimes(1) // stopped → no further sweeps
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() twice does not double-schedule', () => {
    vi.useFakeTimers()
    try {
      runWithStep('run-1', 'step-1', NOW - STUCK_FLOOR_MS - 1_000)
      const { det, broadcast } = detector()
      det.start(1_000)
      det.start(1_000)
      vi.advanceTimersByTime(1_100)
      expect(broadcast).toHaveBeenCalledTimes(1)
      det.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
