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
  getFreestylePrePrompt,
  DEFAULT_FREESTYLE_PRE_PROMPT,
  JobRecoveryPendingError,
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

    it('creates the durable job spawn idempotency ledger', () => {
      const db = makeDb()
      const cols = (db.prepare('PRAGMA table_info(job_spawn_requests)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toEqual(expect.arrayContaining([
        'idempotency_key', 'fingerprint', 'job_id', 'created_at_ms', 'expires_at_ms',
      ]))
    })

    it('creates the durable orphan recovery outbox', () => {
      const db = makeDb()
      const cols = (db.prepare('PRAGMA table_info(orphan_job_recovery)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toEqual(expect.arrayContaining([
        'job_id', 'payload', 'accounting_completed', 'callback_completed', 'terminal_completed', 'created_at',
      ]))
      const jobCols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name)
      expect(jobCols).toContain('provider')
      expect(jobCols).toContain('owner')
    })

    it('creates a durable pre-start queue without overloading jobs.started_at', () => {
      const db = makeDb()
      const cols = (db.prepare('PRAGMA table_info(queued_jobs)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'command', 'queue_position', 'priority', 'depends_on_job_id',
        'pipeline_id', 'provider', 'model', 'profile_name',
        'profile_selection_set', 'interactive', 'causal_ownership', 'enqueued_at',
      ]))
      const jobCols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name)
      expect(jobCols).toContain('causal_ownership')
    })

    it('migration 48 adds truthful delivery fields and repairs duplicate active generations before enforcing uniqueness', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pr-delivery-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.exec(`DROP INDEX idx_rail_pr_deliveries_one_active_per_rail`)
        const insert = db.prepare(`
          INSERT INTO rail_pr_deliveries (
            id, rail_index, rail_key, ticket_ids, base_branch, loop_name, decision
          ) VALUES (?, 0, ?, '[1]', 'main', 'Implement', ?)
        `)
        insert.run('older', '0-old', 'pr_ready')
        insert.run('newer', '0-new', 'building')
        db.prepare(`DELETE FROM schema_migrations WHERE version = 48`).run()
        db.close()
        db = initDb(dbPath)

        const cols = (db.prepare(`PRAGMA table_info(rail_pr_deliveries)`).all() as { name: string }[]).map((c) => c.name)
        expect(cols).toEqual(expect.arrayContaining([
          'implementation_outcome', 'delivery_outcome', 'status_code', 'status_detail',
          'delivery_sha', 'is_continuation', 'supersedes_delivery_id', 'operation',
          'operation_token', 'operation_started_at_ms', 'cleanup_warnings',
          'restored_from_delivery_id',
        ]))
        expect(db.prepare(`SELECT decision FROM rail_pr_deliveries WHERE id = 'older'`).get())
          .toEqual({ decision: 'superseded' })
        expect(db.prepare(`SELECT decision FROM rail_pr_deliveries WHERE id = 'newer'`).get())
          .toEqual({ decision: 'building' })
        const insertAfter = db.prepare(`
          INSERT INTO rail_pr_deliveries (
            id, rail_index, rail_key, ticket_ids, base_branch, loop_name, decision
          ) VALUES (?, 0, ?, '[1]', 'main', 'Implement', ?)
        `)
        expect(() => insertAfter.run('third', '0-third', 'on_review')).toThrow(/UNIQUE/)
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 49 repairs legacy false implementation failures and treats completed no-change rows as terminal', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pr-delivery-truth-repair-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.prepare(`
          INSERT INTO loop_runs (
            id, project_id, loop_id, status, final_outcome, iteration_limit,
            started_at, finished_at
          ) VALUES ('run-success', 'p1', 'loop-1', 'completed', 'success', 1, ?, ?)
        `).run('2026-07-10T10:00:00.000Z', '2026-07-10T10:01:00.000Z')
        db.prepare(`
          INSERT INTO rail_pr_deliveries (
            id, rail_index, loop_id, rail_key, ticket_ids, base_branch, loop_name,
            decision, implementation_outcome, delivery_outcome, status_code,
            run_ids, branches
          ) VALUES (
            'legacy-false-failure', 0, 'loop-1', '0-loop-1', '[1]', 'main', 'Implement',
            'implementation_failed', 'failed', 'not_started', 'implementation_failed',
            '["run-success"]', '[{"ticketId":1,"branch":"feat/1","succeeded":false}]'
          )
        `).run()
        db.prepare('DELETE FROM schema_migrations WHERE version = 49').run()
        db.close()
        db = initDb(dbPath)

        const repaired = db.prepare(`
          SELECT decision, implementation_outcome, delivery_outcome, status_code, branches
            FROM rail_pr_deliveries WHERE id = 'legacy-false-failure'
        `).get() as {
          decision: string
          implementation_outcome: string
          delivery_outcome: string
          status_code: string
          branches: string
        }
        expect(repaired).toMatchObject({
          decision: 'pr_failed',
          implementation_outcome: 'succeeded',
          delivery_outcome: 'blocked',
          status_code: 'settlement_interrupted',
        })
        expect(JSON.parse(repaired.branches)).toEqual([expect.objectContaining({
          runId: 'run-success',
          implementationOutcome: 'succeeded',
          deliveryOutcome: 'blocked',
          failureCode: 'settlement_interrupted',
        })])

        db.prepare(`UPDATE rail_pr_deliveries SET decision = 'completed' WHERE id = 'legacy-false-failure'`).run()
        expect(() => db.prepare(`
          INSERT INTO rail_pr_deliveries (
            id, rail_index, rail_key, ticket_ids, base_branch, loop_name, decision
          ) VALUES ('next-generation', 0, '0-next', '[1]', 'main', 'Implement', 'building')
        `).run()).not.toThrow()
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 50 backfills only unambiguous terminal ticket effects from a v49 database', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pr-ticket-effect-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        const insert = db.prepare(`
          INSERT INTO rail_pr_deliveries (
            id, rail_index, rail_key, ticket_ids, run_ids, base_branch, loop_name,
            decision, is_continuation, pr_url
          ) VALUES (?, ?, ?, ?, ?, 'main', 'Implement', ?, ?, ?)
        `)
        insert.run('merged-continuation', 0, '0-merged', '[1,2,2]', '["run-merged"]', 'merged', 1, 'https://example.test/pr/1')
        insert.run('fresh-discard', 1, '1-discard', '[3,4]', '["run-discard"]', 'discarded', 0, null)
        insert.run('continuation-discard', 2, '2-discard', '[5]', '["run-continuation"]', 'discarded', 1, 'https://example.test/pr/3')
        insert.run('fresh-completed', 3, '3-completed', '[6]', '["run-completed"]', 'completed', 0, null)
        insert.run('still-active', 4, '4-active', '[7]', '["run-active"]', 'on_review', 0, null)
        insert.run('malformed-merged', 5, '5-malformed', 'not-json', '["run-malformed"]', 'merged', 0, null)
        insert.run('stale-owner-merge', 6, '6-stale-owner', '[8]', '["run-old"]', 'merged', 0, 'https://example.test/pr/8')
        const seedOwner = db.prepare(`
          INSERT INTO ticket_outcome_ownership (ticket_id, owner_id)
          VALUES (?, ?)
        `)
        seedOwner.run(1, 'run-merged')
        seedOwner.run(2, 'run-merged')
        seedOwner.run(3, 'run-discard')
        seedOwner.run(4, 'run-discard')
        seedOwner.run(8, 'run-newer-generation')

        // Exact v49 shape: deliveries exist, but migration 50 and its outbox do
        // not. Reopening must create intents without guessing continuation
        // ownership or acting on malformed evidence.
        db.exec(`DROP TABLE rail_pr_ticket_effects`)
        db.prepare(`DELETE FROM schema_migrations WHERE version IN (50, 51, 52)`).run()
        db.close()
        db = initDb(dbPath)

        const cols = (db.prepare(`PRAGMA table_info(rail_pr_ticket_effects)`).all() as { name: string }[])
          .map((column) => column.name)
        expect(cols).toEqual(expect.arrayContaining([
          'applied_ticket_ids', 'tickets_applied_at', 'jira_enqueued_at', 'completed_at',
        ]))
        expect(db.prepare(`
          SELECT delivery_id, ticket_ids, target_status, jira_action, pr_url,
                 applied_ticket_ids, tickets_applied_at, jira_enqueued_at, completed_at
            FROM rail_pr_ticket_effects
           ORDER BY delivery_id
        `).all()).toEqual([
          {
            delivery_id: 'fresh-discard',
            ticket_ids: '[3,4]',
            target_status: 'todo',
            jira_action: 'backlog',
            pr_url: null,
            applied_ticket_ids: null,
            tickets_applied_at: null,
            jira_enqueued_at: null,
            completed_at: null,
          },
          {
            delivery_id: 'merged-continuation',
            ticket_ids: '[1,2]',
            target_status: 'done',
            jira_action: 'merged',
            pr_url: 'https://example.test/pr/1',
            applied_ticket_ids: null,
            tickets_applied_at: null,
            jira_enqueued_at: null,
            completed_at: null,
          },
        ])
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 51 upgrades an already-marked v50 draft table without losing rows', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pr-ticket-effect-v51-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.prepare(`
          INSERT INTO rail_pr_deliveries (
            id, rail_index, rail_key, ticket_ids, run_ids, base_branch, loop_name,
            decision, is_continuation, pr_url
          ) VALUES ('v50-missed-merge', 20, '20-merged', '[9]', '["run-v50"]', 'main', 'Implement',
                    'merged', 0, 'https://example.test/pr/9')
        `).run()
        db.prepare(`
          INSERT INTO ticket_outcome_ownership (ticket_id, owner_id)
          VALUES (9, 'run-v50')
        `).run()
        db.exec(`
          DROP TABLE rail_pr_ticket_effects;
          CREATE TABLE rail_pr_ticket_effects (
            delivery_id   TEXT PRIMARY KEY,
            ticket_ids    TEXT NOT NULL,
            target_status TEXT NOT NULL CHECK (target_status IN ('todo', 'done')),
            jira_action   TEXT NOT NULL CHECK (jira_action IN ('discard', 'merged')),
            pr_url        TEXT,
            attempts      INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT,
            completed_at  TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO rail_pr_ticket_effects (
            delivery_id, ticket_ids, target_status, jira_action, pr_url, attempts, last_error
          ) VALUES ('preserved-effect', '[8]', 'todo', 'discard', NULL, 2, 'retry me');
        `)
        // Simulate a DB that has committed the draft v50 and therefore will not
        // rerun migration 50 even though its body has since evolved.
        expect(db.prepare(`SELECT version FROM schema_migrations WHERE version = 50`).get())
          .toEqual({ version: 50 })
        db.prepare(`DELETE FROM schema_migrations WHERE version IN (51, 52)`).run()
        db.close()
        db = initDb(dbPath)

        expect(db.prepare(`
          SELECT delivery_id, ticket_ids, target_status, jira_action, attempts, last_error,
                 applied_ticket_ids, tickets_applied_at, jira_enqueued_at, completed_at
            FROM rail_pr_ticket_effects WHERE delivery_id = 'preserved-effect'
        `).get()).toEqual({
          delivery_id: 'preserved-effect',
          ticket_ids: '[8]',
          target_status: 'todo',
          jira_action: 'discard',
          attempts: 2,
          last_error: 'retry me',
          applied_ticket_ids: null,
          tickets_applied_at: null,
          jira_enqueued_at: null,
          completed_at: null,
        })
        expect(db.prepare(`
          SELECT target_status, jira_action, pr_url
            FROM rail_pr_ticket_effects WHERE delivery_id = 'v50-missed-merge'
        `).get()).toEqual({
          target_status: 'done',
          jira_action: 'merged',
          pr_url: 'https://example.test/pr/9',
        })

        const insert = db.prepare(`
          INSERT INTO rail_pr_ticket_effects (
            delivery_id, ticket_ids, target_status, jira_action, pr_url
          ) VALUES (?, '[1]', ?, ?, NULL)
        `)
        expect(() => insert.run('accept-completed', 'done', 'completed')).not.toThrow()
        expect(() => insert.run('accept-refine', 'todo', 'refine')).not.toThrow()
        expect(() => insert.run('accept-backlog', 'todo', 'backlog')).not.toThrow()
        expect(db.prepare(`SELECT version FROM schema_migrations WHERE version = 51`).get())
          .toEqual({ version: 51 })
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 53 adds explicit allocation-rollback lineage to delivery rows', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pr-restoration-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.exec(`ALTER TABLE rail_pr_deliveries DROP COLUMN restored_from_delivery_id`)
        db.prepare(`DELETE FROM schema_migrations WHERE version = 53`).run()
        db.close()
        db = initDb(dbPath)

        const cols = (db.prepare(`PRAGMA table_info(rail_pr_deliveries)`).all() as { name: string }[])
          .map((column) => column.name)
        expect(cols).toContain('restored_from_delivery_id')
        expect(db.prepare(`SELECT version FROM schema_migrations WHERE version = 53`).get())
          .toEqual({ version: 53 })
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 54 adds durable safety archive storage to delivery rows', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pr-safety-archives-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.exec(`ALTER TABLE rail_pr_deliveries DROP COLUMN safety_archives`)
        db.prepare(`DELETE FROM schema_migrations WHERE version = 54`).run()
        db.close()
        db = initDb(dbPath)

        const column = (db.prepare(`PRAGMA table_info(rail_pr_deliveries)`).all() as Array<{
          name: string
          dflt_value: string | null
        }>).find((entry) => entry.name === 'safety_archives')
        expect(column?.dflt_value).toBe("'[]'")
        expect(db.prepare(`SELECT version FROM schema_migrations WHERE version = 54`).get())
          .toEqual({ version: 54 })
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 55 scopes Agent Studio history by provider and preserves legacy rows as Claude', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-agent-provider-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.exec(`
          DROP TABLE agent_versions;
          CREATE TABLE agent_versions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_name   TEXT    NOT NULL,
            version      INTEGER NOT NULL,
            body         TEXT    NOT NULL,
            created_at   INTEGER NOT NULL,
            UNIQUE (agent_name, version)
          );
          INSERT INTO agent_versions (agent_name, version, body, created_at)
            VALUES ('custom-shared', 1, 'legacy body', 1000);

          DROP TABLE agent_tests;
          CREATE TABLE agent_tests (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_name     TEXT    NOT NULL,
            draft_hash     TEXT    NOT NULL,
            sample_task_id TEXT,
            tokens         INTEGER,
            duration_ms    INTEGER,
            output         TEXT,
            created_at     INTEGER NOT NULL
          );
          INSERT INTO agent_tests (agent_name, draft_hash, output, created_at)
            VALUES ('custom-shared', 'hash', 'legacy test', 1000);
        `)
        db.prepare(`DELETE FROM schema_migrations WHERE version = 55`).run()
        db.close()
        db = initDb(dbPath)

        expect(db.prepare(
          `SELECT provider, agent_name, version, body FROM agent_versions`,
        ).all()).toEqual([{
          provider: 'claude',
          agent_name: 'custom-shared',
          version: 1,
          body: 'legacy body',
        }])
        expect(db.prepare(
          `SELECT provider, agent_name, output FROM agent_tests`,
        ).all()).toEqual([{
          provider: 'claude',
          agent_name: 'custom-shared',
          output: 'legacy test',
        }])
        expect(() => db.prepare(`
          INSERT INTO agent_versions (provider, agent_name, version, body, created_at)
          VALUES ('kimi', 'custom-shared', 1, 'kimi body', 1001)
        `).run()).not.toThrow()
        expect(db.prepare(`SELECT version FROM schema_migrations WHERE version = 55`).get())
          .toEqual({ version: 55 })
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 44 classifies legacy loop jobs and backfills their provider', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-job-owner-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.prepare(`
          INSERT INTO loop_runs (
            id, project_id, loop_id, provider, iteration_limit, started_at
          ) VALUES ('legacy-loop', 'p1', 'l1', 'codex', 3, ?)
        `).run(new Date().toISOString())
        createJob(db, {
          id: 'legacy-loop', command: 'loop: legacy', started_at: new Date().toISOString(),
        })
        // Re-run just the additive migration as if this DB came from the build
        // immediately before ownership was persisted.
        db.prepare('DELETE FROM schema_migrations WHERE version = 44').run()
        db.close()
        db = initDb(dbPath)

        expect(getJob(db, 'legacy-loop')).toMatchObject({
          owner: 'loop', provider: 'codex', status: 'running',
        })
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migration 45 removes pre-owner loop intents and double-counted job invocations', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-loop-recovery-migration-'))
      const dbPath = path.join(dir, 'jobs.sqlite')
      let db = initDb(dbPath)
      try {
        db.prepare(`
          INSERT INTO loop_runs (id, project_id, loop_id, provider, iteration_limit, started_at)
          VALUES ('wip-loop', 'p1', 'l1', 'claude', 3, ?)
        `).run(new Date().toISOString())
        createJob(db, { id: 'wip-loop', command: 'loop: wip', started_at: new Date().toISOString() })
        db.prepare(`INSERT INTO orphan_job_recovery (job_id, payload) VALUES ('wip-loop', '{}')`).run()
        seedInvocation(db, {
          id: 'wrong-job-ledger', surface: 'job', surface_ref_id: 'wip-loop',
          status: 'aborted', total_cost_usd: 2,
        })
        db.prepare('DELETE FROM schema_migrations WHERE version IN (44, 45)').run()
        db.close()
        db = initDb(dbPath)

        expect(getJob(db, 'wip-loop')).toMatchObject({ owner: 'loop' })
        expect(db.prepare(`SELECT 1 FROM orphan_job_recovery WHERE job_id = 'wip-loop'`).get()).toBeUndefined()
        expect(db.prepare(`SELECT 1 FROM ai_invocations WHERE id = 'wrong-job-ledger'`).get()).toBeUndefined()
        expect((db.prepare(`PRAGMA table_info(loop_runs)`).all() as Array<{ name: string }>).map((c) => c.name))
          .toEqual(expect.arrayContaining(['ticket_ids_json', 'ticket_completion_status', 'causal_ownership']))
      } finally {
        try { db.close() } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true })
      }
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
      createJob(db, { id: 'int', command: '/specrails:freestyle #1', started_at: now, interactive: true })
      expect(getJob(db, 'std')!.interactive).toBe(0)
      expect(getJob(db, 'int')!.interactive).toBe(1)
    })

    it('persists the provider and exclusive recovery owner', () => {
      const db = makeDb()
      const now = new Date().toISOString()
      createJob(db, {
        id: 'loop-owned', command: 'loop: verify', started_at: now,
        provider: 'codex', owner: 'loop',
      })
      expect(getJob(db, 'loop-owned')).toMatchObject({
        provider: 'codex', owner: 'loop', status: 'running',
      })
      createJob(db, { id: 'queue-owned', command: '/implement', started_at: now })
      expect(getJob(db, 'queue-owned')).toMatchObject({ owner: 'queue' })
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
      createJob(db, { id: 'j', command: '/specrails:freestyle #1', started_at: now, interactive: true })
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
      createJob(db, { id: 'j', command: '/specrails:freestyle #1', started_at: now, interactive: true })
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
      createJob(db, { id: 'j', command: '/specrails:freestyle #1', started_at: now, interactive: true })
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

    it('exposes unavailable cost coverage for Kimi invocations', () => {
      const db = makeDb()
      const today = new Date().toISOString()
      seedInvocation(db, {
        id: 'kimi-stats',
        provider: 'kimi',
        surface: 'job',
        total_cost_usd: null,
        started_at: today,
      })

      expect(getStats(db)).toMatchObject({
        totalCostUsd: 0,
        costToday: 0,
        pricedRuns: 0,
        unpricedRuns: 1,
        pricedTodayRuns: 0,
        unpricedTodayRuns: 1,
      })
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

describe('project settings — freestyle pre-prompt', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('defaults freestylePrePrompt to empty string', () => {
    expect(getProjectSettings(db).freestylePrePrompt).toBe('')
  })

  it('persists and clears the freestylePrePrompt override', () => {
    updateProjectSettings(db, { freestylePrePrompt: 'Be bold.' })
    expect(getProjectSettings(db).freestylePrePrompt).toBe('Be bold.')
    updateProjectSettings(db, { freestylePrePrompt: '   ' })
    expect(getProjectSettings(db).freestylePrePrompt).toBe('')
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

  it('getFreestylePrePrompt falls back to the default when unset', () => {
    expect(getFreestylePrePrompt(db)).toBe(DEFAULT_FREESTYLE_PRE_PROMPT)
  })

  it('getFreestylePrePrompt returns the trimmed override when set', () => {
    updateProjectSettings(db, { freestylePrePrompt: '  Custom instruction.  ' })
    expect(getFreestylePrePrompt(db)).toBe('Custom instruction.')
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

    it('blocks delete and excludes purge while loop step recovery needs job/events', () => {
      const now = new Date().toISOString()
      createJob(db, { id: 'recovering-loop', command: 'loop: pending', started_at: now, owner: 'loop' })
      finishJob(db, 'recovering-loop', { status: 'failed', exit_code: -1 })
      appendEvent(db, 'recovering-loop', 0, { event_type: 'assistant', source: 'stdout', payload: '{}' })
      db.prepare(`
        INSERT INTO loop_step_recovery (run_id, step_key, invocation_id, payload)
        VALUES ('recovering-loop', 'ai:1', 'stable-invocation', '{}')
      `).run()

      expect(() => deleteJob(db, 'recovering-loop')).toThrow(JobRecoveryPendingError)
      expect(purgeJobs(db)).toBe(0)
      expect(getJob(db, 'recovering-loop')).toBeDefined()
      expect(getJobEvents(db, 'recovering-loop')).toHaveLength(1)
    })

    it('blocks delete and purge while queue terminal recovery owns the job', () => {
      createJob(db, { id: 'recovering-queue', command: '/implement #1', started_at: now })
      finishJob(db, 'recovering-queue', { status: 'failed', exit_code: -1 })
      appendEvent(db, 'recovering-queue', 0, {
        event_type: 'assistant', source: 'stdout', payload: '{}',
      })
      db.prepare(`
        INSERT INTO orphan_job_recovery (job_id, payload)
        VALUES ('recovering-queue', '{}')
      `).run()

      expect(() => deleteJob(db, 'recovering-queue')).toThrow(JobRecoveryPendingError)
      expect(purgeJobs(db)).toBe(0)
      expect(getJob(db, 'recovering-queue')).toBeDefined()
      expect(getJobEvents(db, 'recovering-queue')).toHaveLength(1)
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
