import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getProjectMetrics } from './metrics'
import { initDb } from '../../../db'
import type { DbInstance } from '../../../db'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(jobs: Array<{ status: string; finishedAt?: string; command?: string }>): DbInstance {
  const db = initDb(':memory:')
  for (const job of jobs) {
    db.prepare(`
      INSERT INTO jobs (id, command, status, started_at, finished_at, total_cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, 0, 1000)
    `).run(
      crypto.randomUUID(),
      job.command ?? 'implement',
      job.status,
      new Date().toISOString(),
      job.finishedAt ?? new Date().toISOString()
    )
  }
  return db
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getProjectMetrics', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/specrails-metrics-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('coverage reading', () => {
    it('returns null coverage when no coverage file exists', () => {
      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.coverage.pct).toBeNull()
      expect(result.coverage.lines).toBeNull()
      expect(result.coverage.source).toBeNull()
    })

    it('reads coverage from coverage-summary.json', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(
        path.join(coverageDir, 'coverage-summary.json'),
        JSON.stringify({
          total: {
            lines: { pct: 85 },
            statements: { pct: 82 },
            functions: { pct: 90 },
            branches: { pct: 75 },
          },
        })
      )

      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.coverage.pct).toBe(85)
      expect(result.coverage.lines).toBe(85)
      expect(result.coverage.statements).toBe(82)
      expect(result.coverage.functions).toBe(90)
      expect(result.coverage.branches).toBe(75)
      expect(result.coverage.source).toBe('coverage/coverage-summary.json')
    })

    it('falls back to coverage-final.json when summary is missing', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(
        path.join(coverageDir, 'coverage-final.json'),
        JSON.stringify({
          total: {
            lines: { pct: 72 },
            statements: { pct: 70 },
            functions: { pct: 80 },
            branches: { pct: 65 },
          },
        })
      )

      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.coverage.pct).toBe(72)
      expect(result.coverage.source).toBe('coverage/coverage-final.json')
    })

    it('returns null coverage for malformed JSON', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'coverage-summary.json'), 'not-json{{{')

      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.coverage.pct).toBeNull()
    })

    it('returns null coverage when total key is missing', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(
        path.join(coverageDir, 'coverage-summary.json'),
        JSON.stringify({ 'src/foo.ts': { lines: { pct: 80 } } })
      )

      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.coverage.pct).toBeNull()
    })
  })

  describe('pipeline status', () => {
    it('returns null pipeline when no completed jobs exist', () => {
      const db = makeDb([{ status: 'running' }])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.pipeline.lastJobId).toBeNull()
      expect(result.pipeline.lastJobStatus).toBeNull()
    })

    it('returns last completed job', () => {
      const db = makeDb([
        { status: 'completed', command: 'implement' },
        { status: 'failed', command: 'review' },
      ])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.pipeline.lastJobStatus).not.toBeNull()
      expect(['completed', 'failed']).toContain(result.pipeline.lastJobStatus)
    })

    it('recognizes completed status as healthy pipeline', () => {
      const finishedAt = new Date().toISOString()
      const db = makeDb([{ status: 'completed', finishedAt }])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.pipeline.lastJobStatus).toBe('completed')
      expect(result.healthFactors.pipelineHealthy).toBe(true)
    })

    it('recognizes failed status as unhealthy pipeline', () => {
      const db = makeDb([{ status: 'failed' }])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.healthFactors.pipelineHealthy).toBe(false)
    })
  })

  describe('health score computation', () => {
    it('returns 0 score for empty project with no coverage or pipeline', () => {
      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      // No coverage (0pts), no pipeline (0pts), no recent activity (0pts)
      expect(result.healthScore).toBe(0)
      expect(result.healthFactors.hasCoverage).toBe(false)
      expect(result.healthFactors.coverageGood).toBe(false)
      expect(result.healthFactors.pipelineHealthy).toBe(false)
    })

    it('adds 35pts for healthy pipeline', () => {
      const db = makeDb([{ status: 'completed' }])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.healthScore).toBeGreaterThanOrEqual(35)
      expect(result.healthFactors.pipelineHealthy).toBe(true)
    })

    it('adds 15pts for any coverage and 25pts more for coverage >= 70%', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(
        path.join(coverageDir, 'coverage-summary.json'),
        JSON.stringify({ total: { lines: { pct: 80 }, statements: { pct: 80 }, functions: { pct: 80 }, branches: { pct: 80 } } })
      )
      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      // hasCoverage=15pts + coverageGood=25pts = 40pts (no pipeline, no recent activity)
      expect(result.healthScore).toBe(40)
      expect(result.healthFactors.hasCoverage).toBe(true)
      expect(result.healthFactors.coverageGood).toBe(true)
    })

    it('adds only 15pts for coverage below 70%', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(
        path.join(coverageDir, 'coverage-summary.json'),
        JSON.stringify({ total: { lines: { pct: 50 }, statements: { pct: 50 }, functions: { pct: 50 }, branches: { pct: 50 } } })
      )
      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.healthScore).toBe(15)
      expect(result.healthFactors.hasCoverage).toBe(true)
      expect(result.healthFactors.coverageGood).toBe(false)
    })

    it('caps score at 100', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(
        path.join(coverageDir, 'coverage-summary.json'),
        JSON.stringify({ total: { lines: { pct: 95 }, statements: { pct: 95 }, functions: { pct: 95 }, branches: { pct: 95 } } })
      )
      const db = makeDb([{ status: 'completed' }])
      // Full score: 15+25+35+25=100 (if recent activity also counted)
      const result = getProjectMetrics(tmpDir, db)
      expect(result.healthScore).toBeLessThanOrEqual(100)
    })
  })

  describe('git commits', () => {
    it('returns empty commits array for non-git directory', () => {
      const db = makeDb([])
      const result = getProjectMetrics('/tmp/definitely-not-a-git-repo-xyz', db)
      expect(result.recentCommits).toEqual([])
    })

    it('returns empty array and hasRecentActivity false with no commits', () => {
      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result.recentCommits).toEqual([])
      expect(result.healthFactors.hasRecentActivity).toBe(false)
    })
  })

  describe('return shape', () => {
    it('returns all required fields', () => {
      const db = makeDb([])
      const result = getProjectMetrics(tmpDir, db)
      expect(result).toHaveProperty('coverage')
      expect(result).toHaveProperty('healthScore')
      expect(result).toHaveProperty('healthFactors')
      expect(result).toHaveProperty('recentCommits')
      expect(result).toHaveProperty('pipeline')
      expect(result).toHaveProperty('failurePatterns')
    })
  })

  describe('failure pattern detection', () => {
    function insertJob(db: ReturnType<typeof initDb>, opts: {
      command: string
      status: string
      startedAt?: string
    }) {
      db.prepare(
        'INSERT INTO jobs (id, command, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        crypto.randomUUID(),
        opts.command,
        opts.status,
        opts.startedAt ?? new Date().toISOString(),
        new Date().toISOString()
      )
    }

    it('returns empty array when no failures exist', () => {
      const db = initDb(':memory:')
      insertJob(db, { command: '/specrails:health-check', status: 'completed' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toEqual([])
    })

    it('returns empty array when failures are below threshold (< 3)', () => {
      const db = initDb(':memory:')
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toEqual([])
    })

    it('detects pattern when same command fails 3 times this week', () => {
      const db = initDb(':memory:')
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toHaveLength(1)
      expect(result.failurePatterns[0].command).toBe('/specrails:health-check')
      expect(result.failurePatterns[0].count).toBe(3)
    })

    it('groups commands by base command, ignoring arguments', () => {
      const db = initDb(':memory:')
      insertJob(db, { command: '/specrails:implement #5', status: 'failed' })
      insertJob(db, { command: '/specrails:implement #6', status: 'failed' })
      insertJob(db, { command: '/specrails:implement #7', status: 'failed' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toHaveLength(1)
      expect(result.failurePatterns[0].command).toBe('/specrails:implement')
      expect(result.failurePatterns[0].count).toBe(3)
    })

    it('ignores failures older than 7 days', () => {
      const db = initDb(':memory:')
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      insertJob(db, { command: '/specrails:health-check', status: 'failed', startedAt: oldDate })
      insertJob(db, { command: '/specrails:health-check', status: 'failed', startedAt: oldDate })
      insertJob(db, { command: '/specrails:health-check', status: 'failed', startedAt: oldDate })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toEqual([])
    })

    it('counts only failed jobs, not completed or canceled', () => {
      const db = initDb(':memory:')
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'completed' })
      insertJob(db, { command: '/specrails:health-check', status: 'canceled' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toEqual([])
    })

    it('returns multiple patterns sorted by failure count descending', () => {
      const db = initDb(':memory:')
      // 4 failures for health-check
      for (let i = 0; i < 4; i++) insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      // 3 failures for typecheck
      for (let i = 0; i < 3; i++) insertJob(db, { command: '/specrails:typecheck', status: 'failed' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns).toHaveLength(2)
      expect(result.failurePatterns[0].command).toBe('/specrails:health-check')
      expect(result.failurePatterns[0].count).toBe(4)
      expect(result.failurePatterns[1].command).toBe('/specrails:typecheck')
      expect(result.failurePatterns[1].count).toBe(3)
    })

    it('includes lastFailedAt timestamp in result', () => {
      const db = initDb(':memory:')
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      insertJob(db, { command: '/specrails:health-check', status: 'failed' })
      const result = getProjectMetrics(tmpDir, db)
      expect(result.failurePatterns[0].lastFailedAt).toBeTruthy()
    })
  })
})
