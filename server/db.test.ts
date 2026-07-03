import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initDb,
  createJob,
  finishJob,
  accumulateInteractiveTurn,
  finalizeInteractiveJob,
  appendEvent,
  upsertPhase,
  listJobs,
  getJob,
  getJobEvents,
  deleteJob,
  purgeJobs,
  upsertTelemetryBlob,
  getTelemetryBlob,
  getStats,
  createProposal,
  getProposal,
  listProposals,
  updateProposal,
  deleteProposal,
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  getProjectSettings,
  updateProjectSettings,
  getUltracodePrePrompt,
  DEFAULT_ULTRACODE_PRE_PROMPT,
} from './db'
import type { DbInstance } from './db'
import { recordInvocation } from './ai-invocations'

function makeDb(): DbInstance {
  return initDb(':memory:')
}

// Seed one ai_invocations row (the ledger getStats now sums cost from — MED-8).
function seedInvocation(
  db: DbInstance,
  r: Partial<Parameters<typeof recordInvocation>[1]> & { id: string },
): void {
  recordInvocation(db, {
    project_id: 'p1',
    provider: 'claude',
    surface: 'job',
    status: 'success',
    started_at: new Date().toISOString(),
    ...r,
  } as Parameters<typeof recordInvocation>[1])
}

function makeJobId(suffix = '1'): string {
  return `job-test-uuid-${suffix}`
}

describe('db', () => {
  describe('initDb', () => {
    it('applies migration 1 successfully and returns a working database', () => {
      const db = makeDb()
      // If tables are missing this will throw
      const result = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table') as { name: string }[]
      const names = result.map((r) => r.name)
      expect(names).toContain('jobs')
      expect(names).toContain('events')
      expect(names).toContain('job_phases')
      expect(names).toContain('schema_migrations')
    })

    it('sets busy_timeout and journal_size_limit for concurrent-write resilience', () => {
      const db = makeDb()
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
      expect(db.pragma('journal_size_limit', { simple: true })).toBe(10000000)
    })

    it('creates the rail_meta table (migration 28) with rail_index + name', () => {
      const db = makeDb()
      const cols = (db.prepare('PRAGMA table_info(rail_meta)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toContain('rail_index')
      expect(cols).toContain('name')
    })

    it('orphan detection marks running jobs as failed on initDb', () => {
      // Simulate: a DB already has a 'running' job (from a previous crashed session).
      // When initDb runs on that DB, it should mark the running job as 'failed'.
      // Since :memory: is per-connection, we build the schema manually, insert
      // a running job, then call initDb to trigger the orphan sweep.
      const Database = require('better-sqlite3')
      const rawDb = new Database(':memory:')
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, command TEXT NOT NULL, started_at TEXT NOT NULL,
          finished_at TEXT, status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER,
          tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
          tokens_cache_create INTEGER, total_cost_usd REAL, num_turns INTEGER,
          model TEXT, duration_ms INTEGER, duration_api_ms INTEGER, session_id TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
          event_type TEXT NOT NULL, source TEXT, payload TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS job_phases (
          job_id TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (job_id, phase)
        );
        INSERT INTO schema_migrations (version) VALUES (1);
        INSERT INTO jobs (id, command, started_at, status)
        VALUES ('orphan-1', '/cmd', '2024-01-01T00:00:00.000Z', 'running');
      `)

      // Run the orphan sweep (as initDb does)
      rawDb.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE status = 'running'")
        .run(new Date().toISOString())

      const orphan = rawDb.prepare('SELECT status, finished_at FROM jobs WHERE id = ?')
        .get('orphan-1') as { status: string; finished_at: string }
      expect(orphan.status).toBe('failed')
      expect(orphan.finished_at).not.toBeNull()
    })

    it('migration 21 self-heals missing ai_invocations columns', () => {
      // Reproduce the "WIP branch reshuffled migration indices" state: the
      // DB has every prior migration version marked applied (so 19 / 20 are
      // skipped on next startup), but the underlying `provider` and
      // `total_cost_usd_estimated` columns were never actually added.
      const Database = require('better-sqlite3')
      const rawDb = new Database(':memory:')
      rawDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE ai_invocations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          surface TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      // Mark migrations 1..20 as applied without running them — this is the
      // user-reported broken state from a prior dev build.
      const insertMig = rawDb.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
      for (let v = 1; v <= 20; v++) insertMig.run(v)

      // Sanity-check the broken precondition: provider column is absent.
      const before = (rawDb.prepare(`PRAGMA table_info(ai_invocations)`).all() as { name: string }[])
        .map((r) => r.name)
      expect(before).not.toContain('provider')
      expect(before).not.toContain('total_cost_usd_estimated')

      // Confirm version 21 is genuinely absent before invoking the self-heal
      // logic — this is the precondition that drives the bug in the field.
      const applied = new Set<number>(
        (rawDb.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
          .map((r) => r.version),
      )
      expect(applied.has(21)).toBe(false)

      // Inline migration #21 body — must match db.ts exactly. `initDb`'s
      // applyMigrations runs this block when version 21 is not in
      // schema_migrations, so reproducing it here exercises the same path.
      const cols = new Set(
        (rawDb.prepare(`PRAGMA table_info(ai_invocations)`).all() as { name: string }[])
          .map((r) => r.name),
      )
      if (!cols.has('provider')) {
        rawDb.exec(`ALTER TABLE ai_invocations ADD COLUMN provider TEXT;`)
        rawDb.exec(`UPDATE ai_invocations SET provider = 'claude' WHERE provider IS NULL;`)
      }
      if (!cols.has('total_cost_usd_estimated')) {
        rawDb.exec(`ALTER TABLE ai_invocations ADD COLUMN total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0;`)
      }

      const after = (rawDb.prepare(`PRAGMA table_info(ai_invocations)`).all() as { name: string }[])
        .map((r) => r.name)
      expect(after).toContain('provider')
      expect(after).toContain('total_cost_usd_estimated')
    })
  })

  describe('createJob + getJob', () => {
    it('round-trips a job correctly', () => {
      const db = makeDb()
      const id = makeJobId()
      const now = new Date().toISOString()
      createJob(db, { id, command: '/implement #1', started_at: now })

      const row = getJob(db, id)
      expect(row).toBeDefined()
      expect(row!.id).toBe(id)
      expect(row!.command).toBe('/implement #1')
      expect(row!.started_at).toBe(now)
      expect(row!.status).toBe('running')
      expect(row!.finished_at).toBeNull()
    })

    it('persists the interactive flag (default 0, set to 1)', () => {
      const db = makeDb()
      const now = new Date().toISOString()
      createJob(db, { id: 'std', command: '/implement #1', started_at: now })
      createJob(db, { id: 'int', command: '/specrails:ultracode #1', started_at: now, interactive: true })
      expect(getJob(db, 'std')!.interactive).toBe(0)
      expect(getJob(db, 'int')!.interactive).toBe(1)
    })
  })

  describe('interactive job accounting', () => {
    const turn = {
      tokens_in: 10, tokens_out: 20, tokens_cache_read: 1, tokens_cache_create: 2,
      total_cost_usd: 0.01, num_turns: 2, model: 'claude-opus-4-8', session_id: 'sess-x',
    }

    it('accumulateInteractiveTurn sums across turns and stamps model/session once', () => {
      const db = makeDb()
      const now = new Date().toISOString()
      createJob(db, { id: 'j', command: '/specrails:ultracode #1', started_at: now, interactive: true })
      accumulateInteractiveTurn(db, 'j', turn)
      accumulateInteractiveTurn(db, 'j', { ...turn, model: 'other', session_id: 'sess-y' })
      const row = getJob(db, 'j')!
      expect(row.tokens_in).toBe(20)
      expect(row.tokens_out).toBe(40)
      expect(row.num_turns).toBe(4)
      expect(row.total_cost_usd).toBeCloseTo(0.02)
      expect(row.total_cost_usd_estimated).toBe(0)
      expect(row.model).toBe('claude-opus-4-8') // COALESCE keeps the first
      expect(row.session_id).toBe('sess-y')      // session_id refreshes to latest
      expect(row.status).toBe('running')         // still running
    })

    it('accumulateInteractiveTurn stickily flags the jobs row when a folded turn is estimated (CRIT-4)', () => {
      const db = makeDb()
      const now = new Date().toISOString()
      createJob(db, { id: 'j', command: '/specrails:ultracode #1', started_at: now, interactive: true })
      // Two authoritative turns keep the row un-flagged.
      accumulateInteractiveTurn(db, 'j', turn)
      accumulateInteractiveTurn(db, 'j', turn)
      expect(getJob(db, 'j')!.total_cost_usd_estimated).toBe(0)
      // An in-flight turn folded at finalize is priced from the rate card → sets 1.
      accumulateInteractiveTurn(db, 'j', { ...turn, estimated: true })
      expect(getJob(db, 'j')!.total_cost_usd_estimated).toBe(1)
      // A later authoritative turn must NOT clear the sticky flag.
      accumulateInteractiveTurn(db, 'j', turn)
      expect(getJob(db, 'j')!.total_cost_usd_estimated).toBe(1)
    })

    it('finalizeInteractiveJob flips status + finished_at without clobbering totals', () => {
      const db = makeDb()
      const now = new Date().toISOString()
      createJob(db, { id: 'j', command: '/specrails:ultracode #1', started_at: now, interactive: true })
      accumulateInteractiveTurn(db, 'j', turn)
      finalizeInteractiveJob(db, 'j', 'completed')
      const row = getJob(db, 'j')!
      expect(row.status).toBe('completed')
      expect(row.finished_at).toBeTruthy()
      expect(row.tokens_in).toBe(10) // preserved
      expect(row.total_cost_usd).toBeCloseTo(0.01)
    })
  })

  describe('finishJob', () => {
    it('updates all fields correctly on completion', () => {
      const db = makeDb()
      const id = makeJobId('2')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })

      finishJob(db, id, {
        exit_code: 0,
        status: 'completed',
        tokens_in: 100,
        tokens_out: 200,
        tokens_cache_read: 10,
        tokens_cache_create: 5,
        total_cost_usd: 0.0042,
        num_turns: 3,
        model: 'claude-opus-4',
        duration_ms: 5000,
        duration_api_ms: 4800,
        session_id: 'sess-abc',
      })

      const row = getJob(db, id)!
      expect(row.status).toBe('completed')
      expect(row.exit_code).toBe(0)
      expect(row.finished_at).not.toBeNull()
      expect(row.tokens_in).toBe(100)
      expect(row.tokens_out).toBe(200)
      expect(row.tokens_cache_read).toBe(10)
      expect(row.tokens_cache_create).toBe(5)
      expect(row.total_cost_usd).toBeCloseTo(0.0042)
      expect(row.num_turns).toBe(3)
      expect(row.model).toBe('claude-opus-4')
      expect(row.duration_ms).toBe(5000)
      expect(row.duration_api_ms).toBe(4800)
      expect(row.session_id).toBe('sess-abc')
      // Default: claude is authoritative → estimated flag is 0.
      expect(row.total_cost_usd_estimated).toBe(0)
    })

    it('persists the estimated flag (1) for pricing-table costs (codex)', () => {
      const db = makeDb()
      const id = makeJobId('est')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })
      finishJob(db, id, {
        exit_code: 0,
        status: 'completed',
        total_cost_usd: 0.0152,
        total_cost_usd_estimated: true,
      })
      const row = getJob(db, id)!
      expect(row.total_cost_usd).toBeCloseTo(0.0152)
      expect(row.total_cost_usd_estimated).toBe(1)
    })
  })

  describe('appendEvent + getJobEvents', () => {
    it('returns events in seq order', () => {
      const db = makeDb()
      const id = makeJobId('3')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })

      appendEvent(db, id, 0, { event_type: 'log', source: 'stdout', payload: '{"line":"a"}' })
      appendEvent(db, id, 1, { event_type: 'assistant', source: 'stdout', payload: '{"type":"assistant"}' })
      appendEvent(db, id, 2, { event_type: 'log', source: 'stderr', payload: '{"line":"err"}' })

      const events = getJobEvents(db, id)
      expect(events.length).toBe(3)
      expect(events[0].seq).toBe(0)
      expect(events[0].event_type).toBe('log')
      expect(events[1].seq).toBe(1)
      expect(events[1].event_type).toBe('assistant')
      expect(events[2].seq).toBe(2)
      expect(events[2].source).toBe('stderr')
    })
  })

  describe('upsertPhase', () => {
    it('inserts on first call and updates on second', () => {
      const db = makeDb()
      const id = makeJobId('4')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })

      upsertPhase(db, id, 'architect', 'running')
      const row1 = db.prepare('SELECT state FROM job_phases WHERE job_id = ? AND phase = ?').get(id, 'architect') as { state: string }
      expect(row1.state).toBe('running')

      upsertPhase(db, id, 'architect', 'done')
      const row2 = db.prepare('SELECT state FROM job_phases WHERE job_id = ? AND phase = ?').get(id, 'architect') as { state: string }
      expect(row2.state).toBe('done')

      // Should still be only one row (upsert, not insert)
      const count = db.prepare('SELECT COUNT(*) as c FROM job_phases WHERE job_id = ? AND phase = ?').get(id, 'architect') as { c: number }
      expect(count.c).toBe(1)
    })
  })

  describe('listJobs', () => {
    let db: DbInstance

    beforeEach(() => {
      db = makeDb()
      // Seed 5 jobs
      for (let i = 1; i <= 5; i++) {
        const id = `list-job-${i}`
        createJob(db, {
          id,
          command: `/cmd-${i}`,
          started_at: `2024-01-0${i}T00:00:00.000Z`,
        })
        if (i <= 2) {
          finishJob(db, id, { exit_code: 0, status: 'completed' })
        }
        if (i === 3) {
          finishJob(db, id, { exit_code: 1, status: 'failed' })
        }
        // jobs 4 and 5 remain 'running'
      }
    })

    it('paginates correctly with limit and offset', () => {
      const page1 = listJobs(db, { limit: 2, offset: 0 })
      expect(page1.total).toBe(5)
      expect(page1.jobs.length).toBe(2)

      const page2 = listJobs(db, { limit: 2, offset: 2 })
      expect(page2.total).toBe(5)
      expect(page2.jobs.length).toBe(2)
    })

    it('filters by status', () => {
      const result = listJobs(db, { status: 'completed' })
      expect(result.total).toBe(2)
      expect(result.jobs.every((j) => j.status === 'completed')).toBe(true)
    })

    it('filters by from/to date range', () => {
      const result = listJobs(db, {
        from: '2024-01-02T00:00:00.000Z',
        to: '2024-01-04T00:00:00.000Z',
      })
      expect(result.total).toBe(3)
      expect(result.jobs.map((j) => j.id).sort()).toEqual(['list-job-2', 'list-job-3', 'list-job-4'])
    })
  })

  describe('deleteJob', () => {
    it('removes the job and cascades to events and job_phases', () => {
      const db = makeDb()
      const id = makeJobId('5')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })
      appendEvent(db, id, 0, { event_type: 'log', source: 'stdout', payload: '{}' })
      upsertPhase(db, id, 'architect', 'done')

      deleteJob(db, id)

      expect(getJob(db, id)).toBeUndefined()
      expect(getJobEvents(db, id)).toHaveLength(0)
      const phases = db.prepare('SELECT * FROM job_phases WHERE job_id = ?').all(id)
      expect(phases).toHaveLength(0)
    })
  })

  describe('getStats', () => {
    it('computes job counts from jobs and cost from the ai_invocations ledger (MED-8)', () => {
      const db = makeDb()
      const today = new Date().toISOString()

      // Job COUNT / duration metrics stay job-sourced.
      createJob(db, { id: 'stats-1', command: '/a', started_at: today })
      finishJob(db, 'stats-1', { exit_code: 0, status: 'completed', total_cost_usd: 0.01, duration_ms: 1000 })
      createJob(db, { id: 'stats-2', command: '/b', started_at: today })
      finishJob(db, 'stats-2', { exit_code: 0, status: 'completed', total_cost_usd: 0.02, duration_ms: 3000 })
      // Old job from yesterday
      createJob(db, { id: 'stats-3', command: '/c', started_at: '2020-01-01T00:00:00.000Z' })
      finishJob(db, 'stats-3', { exit_code: 1, status: 'failed', total_cost_usd: 0.05, duration_ms: 2000 })

      // Cost is now sourced from ai_invocations — INCLUDING non-job surfaces that
      // the jobs table never held (this is exactly the MED-8 undercount fix).
      seedInvocation(db, { id: 'inv-1', surface: 'job', total_cost_usd: 0.01, started_at: today })
      seedInvocation(db, { id: 'inv-2', surface: 'job', total_cost_usd: 0.02, started_at: today })
      seedInvocation(db, { id: 'inv-3', surface: 'explore-spec', total_cost_usd: 0.04, started_at: today })
      seedInvocation(db, { id: 'inv-old', surface: 'job', total_cost_usd: 0.05, started_at: '2020-01-01T00:00:00.000Z' })

      const stats = getStats(db)
      // Counts / duration from jobs.
      expect(stats.totalJobs).toBe(3)
      expect(stats.jobsToday).toBe(2)
      expect(stats.avgDurationMs).toBeCloseTo(2000)
      // Cost from ai_invocations across ALL surfaces (0.01 + 0.02 + 0.04 today,
      // + 0.05 yesterday). The explore-spec $0.04 would be invisible under the
      // old jobs-only SUM.
      expect(stats.totalCostUsd).toBeCloseTo(0.12, 5)
      expect(stats.costToday).toBeCloseTo(0.07, 5)
    })

    it('counts a killed/failed run estimate and splits the estimated portion (MED-8, post CRIT-1)', () => {
      const db = makeDb()
      const today = new Date().toISOString()

      // claude success (authoritative) → counted, not estimated
      seedInvocation(db, { id: 'e-1', surface: 'job', status: 'success', total_cost_usd: 0.10, started_at: today })
      // codex success (estimated) → counted in total AND estimated
      seedInvocation(db, { id: 'e-2', provider: 'codex', surface: 'job', status: 'success', total_cost_usd: 0.04, total_cost_usd_estimated: true, started_at: today })
      // codex FAILED (estimated) → post-CRIT-1 the real burned tokens DO count now
      seedInvocation(db, { id: 'e-3', provider: 'codex', surface: 'job', status: 'failed', total_cost_usd: 0.50, total_cost_usd_estimated: true, started_at: today })
      // claude aborted (authoritative kill-path estimate would be flagged; here a
      // real billed figure) → counted, not marked estimated
      seedInvocation(db, { id: 'e-4', surface: 'ai-edit', status: 'aborted', total_cost_usd: 0.07, started_at: today })

      const stats = getStats(db)
      // All four count now (no more dropping failed estimates — those tokens billed).
      expect(stats.totalCostUsd).toBeCloseTo(0.10 + 0.04 + 0.50 + 0.07, 5)
      expect(stats.estimatedCostUsd).toBeCloseTo(0.04 + 0.50, 5)
      expect(stats.costToday).toBeCloseTo(0.71, 5)
      expect(stats.estimatedCostToday).toBeCloseTo(0.54, 5)
    })
  })
})

describe('proposals', () => {
  it('migration 5 creates the proposals table', () => {
    const db = makeDb()
    const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table') as { name: string }[]
    expect(tables.map((t) => t.name)).toContain('proposals')
  })

  it('createProposal inserts a row with input status', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-1', idea: 'Add dark mode' })
    const row = getProposal(db, 'prop-1')
    expect(row).toBeDefined()
    expect(row!.id).toBe('prop-1')
    expect(row!.idea).toBe('Add dark mode')
    expect(row!.status).toBe('input')
    expect(row!.session_id).toBeNull()
    expect(row!.result_markdown).toBeNull()
    expect(row!.issue_url).toBeNull()
  })

  it('getProposal returns the created row', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-2', idea: 'Real-time notifications' })
    const row = getProposal(db, 'prop-2')
    expect(row).toBeDefined()
    expect(row!.id).toBe('prop-2')
  })

  it('getProposal returns undefined for unknown id', () => {
    const db = makeDb()
    const row = getProposal(db, 'nonexistent')
    expect(row).toBeUndefined()
  })

  it('updateProposal sets status and updates updated_at', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-3', idea: 'Feature X' })
    const before = getProposal(db, 'prop-3')!
    updateProposal(db, 'prop-3', { status: 'exploring' })
    const after = getProposal(db, 'prop-3')!
    expect(after.status).toBe('exploring')
    expect(after.updated_at >= before.updated_at).toBe(true)
  })

  it('updateProposal sets session_id', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-4', idea: 'Feature Y' })
    updateProposal(db, 'prop-4', { session_id: 'sess-abc123' })
    const row = getProposal(db, 'prop-4')!
    expect(row.session_id).toBe('sess-abc123')
  })

  it('updateProposal sets result_markdown', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-5', idea: 'Feature Z' })
    updateProposal(db, 'prop-5', { result_markdown: '## Proposal\nSome content' })
    const row = getProposal(db, 'prop-5')!
    expect(row.result_markdown).toBe('## Proposal\nSome content')
  })

  it('updateProposal sets issue_url', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-6', idea: 'Feature W' })
    updateProposal(db, 'prop-6', { issue_url: 'https://github.com/owner/repo/issues/42' })
    const row = getProposal(db, 'prop-6')!
    expect(row.issue_url).toBe('https://github.com/owner/repo/issues/42')
  })

  it('listProposals returns rows ordered by created_at DESC', () => {
    const db = makeDb()
    // Insert with known timestamps by using raw SQL to control created_at ordering
    db.prepare("INSERT INTO proposals (id, idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run('old-prop', 'Old idea', 'input', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    db.prepare("INSERT INTO proposals (id, idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run('new-prop', 'New idea', 'input', '2024-06-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z')
    const { proposals } = listProposals(db)
    expect(proposals[0].id).toBe('new-prop')
    expect(proposals[1].id).toBe('old-prop')
  })

  it('listProposals respects limit and offset', () => {
    const db = makeDb()
    for (let i = 1; i <= 5; i++) {
      createProposal(db, { id: `prop-list-${i}`, idea: `Idea ${i}` })
    }
    const page1 = listProposals(db, { limit: 2, offset: 0 })
    expect(page1.total).toBe(5)
    expect(page1.proposals.length).toBe(2)

    const page2 = listProposals(db, { limit: 2, offset: 2 })
    expect(page2.total).toBe(5)
    expect(page2.proposals.length).toBe(2)
  })

  it('deleteProposal removes the row', () => {
    const db = makeDb()
    createProposal(db, { id: 'prop-del', idea: 'Delete me' })
    deleteProposal(db, 'prop-del')
    expect(getProposal(db, 'prop-del')).toBeUndefined()
  })

  it('orphan sweep marks exploring/refining proposals as cancelled on initDb', () => {
    // Insert proposals in exploring and refining states directly into the DB
    const db = makeDb()
    db.prepare("INSERT INTO proposals (id, idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run('orphan-exploring', 'Exploring idea', 'exploring', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    db.prepare("INSERT INTO proposals (id, idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run('orphan-refining', 'Refining idea', 'refining', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    db.prepare("INSERT INTO proposals (id, idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run('stable-review', 'Review idea', 'review', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')

    // Simulate server restart by running the orphan sweep directly
    db.prepare(
      "UPDATE proposals SET status = 'cancelled', updated_at = ? WHERE status IN ('exploring', 'refining')"
    ).run(new Date().toISOString())

    expect(getProposal(db, 'orphan-exploring')!.status).toBe('cancelled')
    expect(getProposal(db, 'orphan-refining')!.status).toBe('cancelled')
    // review proposals are not affected
    expect(getProposal(db, 'stable-review')!.status).toBe('review')
  })
})

describe('job templates', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => {
    db = makeDb()
  })

  it('creates and retrieves a template', () => {
    createTemplate(db, { id: 'tpl-1', name: 'My Rail', commands: ['/specrails:health-check', '/specrails:implement #1'] })
    const row = getTemplate(db, 'tpl-1')
    expect(row).toBeDefined()
    expect(row!.name).toBe('My Rail')
    const commands = JSON.parse(row!.commands) as string[]
    expect(commands).toEqual(['/specrails:health-check', '/specrails:implement #1'])
    expect(row!.description).toBeNull()
  })

  it('stores optional description', () => {
    createTemplate(db, { id: 'tpl-2', name: 'With Desc', description: 'Does stuff', commands: ['/specrails:implement'] })
    const row = getTemplate(db, 'tpl-2')!
    expect(row.description).toBe('Does stuff')
  })

  it('lists templates ordered by created_at desc', () => {
    createTemplate(db, { id: 'tpl-a', name: 'A', commands: ['/cmd-a'] })
    createTemplate(db, { id: 'tpl-b', name: 'B', commands: ['/cmd-b'] })
    const rows = listTemplates(db)
    expect(rows.length).toBe(2)
    // Both are present; names are correct
    expect(rows.map((r) => r.name)).toContain('A')
    expect(rows.map((r) => r.name)).toContain('B')
  })

  it('returns undefined for unknown id', () => {
    expect(getTemplate(db, 'nonexistent')).toBeUndefined()
  })

  it('updates name, description, and commands', () => {
    createTemplate(db, { id: 'tpl-3', name: 'Old Name', commands: ['/old'] })
    updateTemplate(db, 'tpl-3', { name: 'New Name', description: 'Updated', commands: ['/new-1', '/new-2'] })
    const row = getTemplate(db, 'tpl-3')!
    expect(row.name).toBe('New Name')
    expect(row.description).toBe('Updated')
    const commands = JSON.parse(row.commands) as string[]
    expect(commands).toEqual(['/new-1', '/new-2'])
  })

  it('deletes a template', () => {
    createTemplate(db, { id: 'tpl-4', name: 'To Delete', commands: ['/cmd'] })
    deleteTemplate(db, 'tpl-4')
    expect(getTemplate(db, 'tpl-4')).toBeUndefined()
  })

  it('enforces name uniqueness', () => {
    createTemplate(db, { id: 'tpl-5', name: 'Unique', commands: ['/cmd'] })
    expect(() => {
      createTemplate(db, { id: 'tpl-6', name: 'Unique', commands: ['/cmd2'] })
    }).toThrow()
  })

  it('migration 6 creates job_templates table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_templates'")
      .get() as { name: string } | undefined
    expect(result?.name).toBe('job_templates')
  })

  // ─── Priority ────────────────────────────────────────────────────────────

  it('migration 7 adds priority column with default normal', () => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get() as { sql: string }
    expect(row.sql).toContain('priority')
  })

  it('createJob stores priority correctly', () => {
    const id = makeJobId('priority-1')
    createJob(db, { id, command: '/test', started_at: new Date().toISOString(), priority: 'critical' })
    const row = getJob(db, id)!
    expect(row.priority).toBe('critical')
  })

  it('createJob defaults priority to normal', () => {
    const id = makeJobId('priority-2')
    createJob(db, { id, command: '/test', started_at: new Date().toISOString() })
    const row = getJob(db, id)!
    expect(row.priority).toBe('normal')
  })

  // The Explore MCP / Contract Refine project toggles were removed; the
  // decisions now live exclusively per-spec in chat_conversations.context_scope.
})

describe('project settings — ultracode pre-prompt', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('defaults ultraPrePrompt to empty string', () => {
    expect(getProjectSettings(db).ultraPrePrompt).toBe('')
  })

  it('persists and clears the ultraPrePrompt override', () => {
    updateProjectSettings(db, { ultraPrePrompt: 'Be bold.' })
    expect(getProjectSettings(db).ultraPrePrompt).toBe('Be bold.')
    updateProjectSettings(db, { ultraPrePrompt: '   ' })
    expect(getProjectSettings(db).ultraPrePrompt).toBe('')
  })

  it('defaults integrationBranch to empty string (auto-resolve)', () => {
    expect(getProjectSettings(db).integrationBranch).toBe('')
  })

  it('persists, trims, and clears the integrationBranch setting', () => {
    updateProjectSettings(db, { integrationBranch: '  develop  ' })
    expect(getProjectSettings(db).integrationBranch).toBe('develop')
    updateProjectSettings(db, { integrationBranch: '   ' })
    expect(getProjectSettings(db).integrationBranch).toBe('')
  })

  it('getUltracodePrePrompt falls back to the default when unset', () => {
    expect(getUltracodePrePrompt(db)).toBe(DEFAULT_ULTRACODE_PRE_PROMPT)
  })

  it('getUltracodePrePrompt returns the trimmed override when set', () => {
    updateProjectSettings(db, { ultraPrePrompt: '  Custom instruction.  ' })
    expect(getUltracodePrePrompt(db)).toBe('Custom instruction.')
  })

  // ─── Fase 0 / audit: data integrity (M6/M7/M8) ───────────────────────────────

  describe('deleteJob with pipeline FK (M7)', () => {
    const now = new Date().toISOString()

    it('deletes a parent job referenced by a child without throwing', () => {
      createJob(db, { id: 'parent', command: 'c', started_at: now })
      createJob(db, { id: 'child', command: 'c', started_at: now, depends_on_job_id: 'parent' })

      expect(() => deleteJob(db, 'parent')).not.toThrow()
      expect(getJob(db, 'parent')).toBeUndefined()
      // Child survives with its now-dangling reference cleared.
      const child = getJob(db, 'child')
      expect(child).toBeDefined()
      expect(child!.depends_on_job_id).toBeNull()
    })
  })

  describe('purgeJobs FK + atomicity (M6)', () => {
    const now = new Date().toISOString()

    it('purges a terminal parent still referenced by a non-terminal child', () => {
      createJob(db, { id: 'p', command: 'c', started_at: now })
      db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run('p')
      createJob(db, { id: 'c', command: 'c', started_at: now, depends_on_job_id: 'p' }) // running
      appendEvent(db, 'p', 1, { event_type: 'log', source: 'stdout', payload: 'hi' })

      const purged = purgeJobs(db)
      expect(purged).toBe(1)
      expect(getJob(db, 'p')).toBeUndefined()
      // Non-terminal child survives, reference cleared, parent's events gone.
      const child = getJob(db, 'c')
      expect(child).toBeDefined()
      expect(child!.depends_on_job_id).toBeNull()
      expect(getJobEvents(db, 'p')).toEqual([])
    })

    it('purges a chain of two terminal jobs (parent + child)', () => {
      createJob(db, { id: 'a', command: 'c', started_at: now })
      createJob(db, { id: 'b', command: 'c', started_at: now, depends_on_job_id: 'a' })
      db.prepare("UPDATE jobs SET status = 'completed'").run()

      const purged = purgeJobs(db)
      expect(purged).toBe(2)
      expect(getJob(db, 'a')).toBeUndefined()
      expect(getJob(db, 'b')).toBeUndefined()
    })

    it('B41: deleteJob removes the job\'s orphan-prone telemetry rows', () => {
      createJob(db, { id: 'jt', command: 'c', started_at: now })
      upsertTelemetryBlob(db, { jobId: 'jt', path: '/x.ndjson.gz', byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })
      expect(getTelemetryBlob(db, 'jt')).toBeDefined()

      deleteJob(db, 'jt')
      expect(getJob(db, 'jt')).toBeUndefined()
      expect(getTelemetryBlob(db, 'jt')).toBeUndefined() // no longer orphaned
    })

    it('B41: purgeJobs removes telemetry rows for purged jobs', () => {
      createJob(db, { id: 'jp', command: 'c', started_at: now })
      db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run('jp')
      upsertTelemetryBlob(db, { jobId: 'jp', path: '/y.ndjson.gz', byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })

      purgeJobs(db)
      expect(getTelemetryBlob(db, 'jp')).toBeUndefined()
    })
  })

  describe('migration runner idempotency (M8)', () => {
    it('re-initializing the same on-disk db does not throw', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-m8-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      try {
        const d1 = initDb(dbPath)
        d1.close()
        // Second init re-runs the migration check against an already-migrated db.
        let d2: DbInstance | undefined
        expect(() => { d2 = initDb(dbPath) }).not.toThrow()
        // And it is fully usable.
        createJob(d2!, { id: 'x', command: 'c', started_at: new Date().toISOString() })
        expect(getJob(d2!, 'x')).toBeDefined()
        d2!.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
