import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import { createLoopRun, finishLoopRun } from './loop-runs-store'
import {
  MIN_DURATION_SAMPLES,
  getJobCommandDurationRange,
  getLoopDurationRange,
  jobCommandShape,
  percentileMs,
  rangeFromSamples,
} from './run-duration-stats'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

function loopRun(loopId: string, durationMs: number, projectId = 'proj', finished = true): string {
  const run = createLoopRun(db, {
    id: `run-${Math.random().toString(36).slice(2)}`,
    projectId,
    loopId,
    loopName: 'L',
    iterationLimit: 1,
    startedAt: new Date().toISOString(),
  })
  if (finished) {
    finishLoopRun(db, run.id, {
      outcome: 'success',
      finishedAt: new Date().toISOString(),
      counters: { totalDurationMs: durationMs },
    })
  }
  else db.prepare('UPDATE loop_runs SET total_duration_ms = ? WHERE id = ?').run(durationMs, run.id)
  return run.id
}

function job(command: string, durationMs: number, status = 'completed'): void {
  db.prepare(`
    INSERT INTO jobs (id, command, status, duration_ms, started_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(`job-${Math.random().toString(36).slice(2)}`, command, status, durationMs)
}

describe('percentileMs (nearest-rank, never interpolated)', () => {
  it('returns a value that actually occurs in the sample', () => {
    const sample = [10, 20, 30, 40]
    expect(sample).toContain(percentileMs(sample, 0.5))
    expect(sample).toContain(percentileMs(sample, 0.25))
    expect(sample).toContain(percentileMs(sample, 0.75))
  })

  it('picks documented ranks', () => {
    const sample = [100, 200, 300, 400, 500]
    expect(percentileMs(sample, 0.25)).toBe(200)
    expect(percentileMs(sample, 0.5)).toBe(300)
    expect(percentileMs(sample, 0.75)).toBe(400)
  })

  it('clamps the extremes', () => {
    expect(percentileMs([5, 7], 0)).toBe(5)
    expect(percentileMs([5, 7], 1)).toBe(7)
  })

  it('is 0 for an empty sample', () => {
    expect(percentileMs([], 0.5)).toBe(0)
  })
})

describe('rangeFromSamples', () => {
  it('returns null below the sample floor', () => {
    expect(rangeFromSamples([1, 2, 3, 4])).toBeNull()
    expect(MIN_DURATION_SAMPLES).toBe(5)
  })

  it('returns a band at exactly the floor', () => {
    expect(rangeFromSamples([1, 2, 3, 4, 5])).toMatchObject({ sampleCount: 5 })
  })

  it('drops zero, negative and non-finite samples before counting', () => {
    // 5 raw values but only 4 usable → still below the floor.
    expect(rangeFromSamples([0, -1, NaN, 10, 20, 30, 40])).toBeNull()
    expect(rangeFromSamples([0, 10, 20, 30, 40, 50])).toMatchObject({ sampleCount: 5 })
  })

  it('is order-independent', () => {
    const asc = rangeFromSamples([1, 2, 3, 4, 5])
    const desc = rangeFromSamples([5, 4, 3, 2, 1])
    expect(desc).toEqual(asc)
  })

  it('keeps p25 <= median <= p75', () => {
    const range = rangeFromSamples([90, 10, 50, 30, 70, 110])!
    expect(range.p25Ms).toBeLessThanOrEqual(range.medianMs)
    expect(range.medianMs).toBeLessThanOrEqual(range.p75Ms)
  })
})

describe('getLoopDurationRange', () => {
  it('returns null while history is sparse (renders nothing, never a guess)', () => {
    for (let i = 0; i < 4; i++) loopRun('factory:implement', 60_000)
    expect(getLoopDurationRange(db, 'proj', 'factory:implement')).toBeNull()
  })

  it('returns the measured band once the floor is met', () => {
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) loopRun('factory:implement', ms)
    expect(getLoopDurationRange(db, 'proj', 'factory:implement')).toEqual({
      p25Ms: 20_000, medianMs: 30_000, p75Ms: 40_000, sampleCount: 5,
    })
  })

  it('is scoped per loop id', () => {
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) loopRun('factory:implement', ms)
    for (const ms of [1_000, 2_000]) loopRun('factory:batch', ms)
    expect(getLoopDurationRange(db, 'proj', 'factory:batch')).toBeNull()
    expect(getLoopDurationRange(db, 'proj', 'factory:implement')?.sampleCount).toBe(5)
  })

  it('is scoped per project', () => {
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) loopRun('factory:implement', ms, 'other')
    expect(getLoopDurationRange(db, 'proj', 'factory:implement')).toBeNull()
  })

  it('ignores unfinished runs', () => {
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) loopRun('factory:implement', ms, 'proj', false)
    expect(getLoopDurationRange(db, 'proj', 'factory:implement')).toBeNull()
  })

  it('ignores zero-duration finished runs', () => {
    for (let i = 0; i < 5; i++) loopRun('factory:implement', 0)
    expect(getLoopDurationRange(db, 'proj', 'factory:implement')).toBeNull()
  })

  it('is null for an unknown loop id', () => {
    expect(getLoopDurationRange(db, 'proj', 'nope')).toBeNull()
  })
})

describe('jobCommandShape', () => {
  it('collapses per-run loop ids to a single shape', () => {
    expect(jobCommandShape('loop:9f2c-abcd')).toBe('loop:')
    expect(jobCommandShape('loop:other-id')).toBe('loop:')
  })

  it('keeps the leading token for slash commands and drops arguments', () => {
    expect(jobCommandShape('/specrails:implement #12 #13')).toBe('/specrails:implement')
  })

  it('tolerates padding and empty input', () => {
    expect(jobCommandShape('  /specrails:batch-implement  ')).toBe('/specrails:batch-implement')
    expect(jobCommandShape('')).toBe('')
  })
})

describe('getJobCommandDurationRange', () => {
  it('groups by command SHAPE, not the literal command', () => {
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) job(`loop:${ms}-uuid`, ms)
    expect(getJobCommandDurationRange(db, 'loop:')).toEqual({
      p25Ms: 20_000, medianMs: 30_000, p75Ms: 40_000, sampleCount: 5,
    })
  })

  it('returns null below the floor', () => {
    for (const ms of [1_000, 2_000, 3_000, 4_000]) job('/specrails:implement #1', ms)
    expect(getJobCommandDurationRange(db, '/specrails:implement')).toBeNull()
  })

  it('ignores non-completed jobs', () => {
    for (const ms of [1_000, 2_000, 3_000, 4_000, 5_000]) job('/specrails:implement #1', ms, 'failed')
    expect(getJobCommandDurationRange(db, '/specrails:implement')).toBeNull()
  })

  it('does not mix shapes', () => {
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) job('/specrails:implement #1', ms)
    for (const ms of [1_000, 2_000]) job('loop:x', ms)
    expect(getJobCommandDurationRange(db, 'loop:')).toBeNull()
  })
})
