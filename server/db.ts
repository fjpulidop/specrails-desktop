import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { JobRow, EventRow, StatsRow, JobStatus, JobPriority, ChatConversationRow, ChatMessageRow, ActivityItem } from './types'
import { secureDir, secureDbFile } from './util/secure-fs'

// ─── Proposal types ───────────────────────────────────────────────────────────

export interface ProposalRow {
  id: string
  idea: string
  session_id: string | null
  status: string
  result_markdown: string | null
  issue_url: string | null
  created_at: string
  updated_at: string
}

export type DbInstance = InstanceType<typeof Database>

// ─── Internal types ──────────────────────────────────────────────────────────

export interface NewJob {
  id: string
  command: string
  started_at: string
  priority?: JobPriority
  depends_on_job_id?: string | null
  pipeline_id?: string | null
  /** 1 when this is an interactive persistent session (ultracode + the rail's
   *  Interactive toggle); 0/undefined for standard autonomous jobs. */
  interactive?: boolean
}

/** Per-turn usage delta accumulated into an interactive job's row as each turn
 *  settles. Every field is the REAL provider-reported usage for that one turn. */
export interface InteractiveTurnUsage {
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_create: number
  total_cost_usd: number
  num_turns: number
  model?: string | null
  session_id?: string | null
  /** 1/true when this turn's cost is a pricing-table estimate rather than the
   *  provider's native `total_cost_usd` (e.g. an in-flight turn folded at
   *  finalize — CRIT-4). Sticky: once any folded turn is estimated the jobs
   *  row stays flagged so Job Detail / StatusBar can badge it with `~`. */
  estimated?: boolean
}

export interface JobResult {
  exit_code: number
  status: JobStatus
  tokens_in?: number
  tokens_out?: number
  tokens_cache_read?: number
  tokens_cache_create?: number
  total_cost_usd?: number
  /** 1/true when total_cost_usd is a pricing-table estimate (codex) rather
   *  than a provider-billed figure (claude). Persisted to
   *  jobs.total_cost_usd_estimated so app surfaces can badge it. */
  total_cost_usd_estimated?: boolean
  num_turns?: number
  model?: string
  duration_ms?: number
  duration_api_ms?: number
  session_id?: string
}

export interface AppEvent {
  event_type: string
  source?: string | null
  payload: string
}

export interface ListJobsOpts {
  limit?: number
  offset?: number
  status?: string
  from?: string
  to?: string
}

// ─── Migrations ──────────────────────────────────────────────────────────────

type Migration = (db: DbInstance) => void

const MIGRATIONS: Migration[] = [
  // Migration 1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id                   TEXT    PRIMARY KEY,
        command              TEXT    NOT NULL,
        started_at           TEXT    NOT NULL,
        finished_at          TEXT,
        status               TEXT    NOT NULL DEFAULT 'running',
        exit_code            INTEGER,
        tokens_in            INTEGER,
        tokens_out           INTEGER,
        tokens_cache_read    INTEGER,
        tokens_cache_create  INTEGER,
        total_cost_usd       REAL,
        num_turns            INTEGER,
        model                TEXT,
        duration_ms          INTEGER,
        duration_api_ms      INTEGER,
        session_id           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_started_at ON jobs(started_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        event_type  TEXT    NOT NULL,
        source      TEXT,
        payload     TEXT    NOT NULL,
        timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id);

      CREATE TABLE IF NOT EXISTS job_phases (
        job_id      TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        phase       TEXT    NOT NULL,
        state       TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        PRIMARY KEY (job_id, phase)
      );
    `)
  },

  // Migration 2: add queue_position column to jobs
  (db) => {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN queue_position INTEGER;
    `)
  },

  // Migration 3: add queue_state table for persisting queue config (e.g., paused)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO queue_state (key, value) VALUES ('paused', 'false');
    `)
  },

  // Migration 4: chat conversations and messages
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id           TEXT PRIMARY KEY,
        title        TEXT,
        model        TEXT NOT NULL DEFAULT 'sonnet',
        session_id   TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id);
    `)
  },

  // Migration 5: proposals table
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id              TEXT    PRIMARY KEY,
        idea            TEXT    NOT NULL,
        session_id      TEXT,
        status          TEXT    NOT NULL DEFAULT 'input',
        result_markdown TEXT,
        issue_url       TEXT,
        created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at);
    `)
  },

  // Migration 6: job templates
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_templates (
        id          TEXT NOT NULL PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        commands    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_job_templates_created_at ON job_templates(created_at);
    `)
  },

  // Migration 7: add priority column to jobs
  (db) => {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
    `)
  },

  // Migration 8: job dependencies and pipelines
  (db) => {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN depends_on_job_id TEXT REFERENCES jobs(id);
      ALTER TABLE jobs ADD COLUMN pipeline_id TEXT;
      ALTER TABLE jobs ADD COLUMN skip_reason TEXT;
      CREATE INDEX IF NOT EXISTS idx_jobs_depends_on ON jobs(depends_on_job_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_id ON jobs(pipeline_id);
    `)
  },

  // Migration 9: rails table for Rails board job integration
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rails (
        rail_index  INTEGER NOT NULL,
        ticket_id   INTEGER NOT NULL,
        position    INTEGER NOT NULL,
        mode        TEXT    NOT NULL DEFAULT 'implement',
        PRIMARY KEY (rail_index, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rails_rail_index ON rails(rail_index);
    `)
  },

  // Migration 10: pipeline telemetry blob and summary tables.
  // The pipelineTelemetryEnabled flag reuses the existing queue_state key-value
  // store (key = 'config.pipeline_telemetry_enabled') so no schema change needed
  // for settings; only the raw-data tables are new.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_blobs (
        jobId      TEXT    PRIMARY KEY,
        path       TEXT,
        byteSize   INTEGER NOT NULL DEFAULT 0,
        startedAt  INTEGER,
        endedAt    INTEGER,
        state      TEXT    NOT NULL DEFAULT 'active'
                           CHECK(state IN ('active','compacted','expired'))
      );

      CREATE TABLE IF NOT EXISTS telemetry_summaries (
        jobId        TEXT    NOT NULL,
        phase        TEXT    NOT NULL,
        durationMs   INTEGER,
        tokensInput  INTEGER,
        tokensOutput INTEGER,
        tokensCache  INTEGER,
        toolCalls    TEXT,
        apiErrors    INTEGER,
        costUsd      REAL,
        PRIMARY KEY (jobId, phase)
      );
    `)
  },

  // Migration 11: agent profiles — per-rail profile snapshots, custom agent
  // version history, and sandboxed "test agent" run records. These back the
  // Agents section (profiles + studio) added by add-agents-profiles.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_profiles (
        job_id        TEXT    PRIMARY KEY,
        profile_name  TEXT    NOT NULL,
        profile_json  TEXT    NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_job_profiles_name ON job_profiles(profile_name);

      CREATE TABLE IF NOT EXISTS agent_versions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name   TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        body         TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE (agent_name, version)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_versions_name ON agent_versions(agent_name);

      CREATE TABLE IF NOT EXISTS agent_tests (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name     TEXT    NOT NULL,
        draft_hash     TEXT    NOT NULL,
        sample_task_id TEXT,
        tokens         INTEGER,
        duration_ms    INTEGER,
        output         TEXT,
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_tests_name ON agent_tests(agent_name);
    `)
  },

  // Migration 12: remember per-rail agent profile selection across launches.
  (db) => {
    try {
      db.exec(`ALTER TABLE rails ADD COLUMN profile_name TEXT`)
    } catch {
      // Column may already exist (partially-migrated DB); no-op.
    }
  },

  // Migration 13: agent_refine_sessions — in-flight AI Edit sessions for
  // custom agents. Distinct from agent_versions (which is committed history);
  // rows here are drafts in progress that may or may not be applied.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_refine_sessions (
        id              TEXT    PRIMARY KEY,
        agent_id        TEXT    NOT NULL,
        session_id      TEXT,
        base_version    INTEGER NOT NULL,
        base_body_hash  TEXT    NOT NULL,
        draft_body      TEXT,
        history_json    TEXT    NOT NULL DEFAULT '[]',
        phase           TEXT    NOT NULL DEFAULT 'idle',
        status          TEXT    NOT NULL DEFAULT 'idle',
        auto_test       INTEGER NOT NULL DEFAULT 1,
        last_test_at    INTEGER,
        last_test_hash  TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_refine_sessions_agent
        ON agent_refine_sessions(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_refine_sessions_updated
        ON agent_refine_sessions(updated_at);
    `)
  },

  // Migration 14: terminal_settings_override — per-project key/value override
  // for app-wide terminal settings. Absence of a row means "inherit app default".
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_settings_override (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  },

  // Migration 15: terminal_command_marks — per-session record of completed
  // commands derived from OSC 133 prompt marks. FIFO-capped at 1000 rows per
  // session by the marks store.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_command_marks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        exit_code    INTEGER,
        command      TEXT,
        cwd          TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_marks_session_started
        ON terminal_command_marks(session_id, started_at);
    `)
  },

  // Migration 16: ai_invocations — unified per-project AI CLI invocation
  // tracking across surfaces (job, quick-spec, explore-spec, ai-edit).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_invocations (
        id                   TEXT    PRIMARY KEY,
        project_id           TEXT    NOT NULL,
        surface              TEXT    NOT NULL,
        surface_ref_id       TEXT,
        ticket_id            INTEGER,
        conversation_id      TEXT,
        model                TEXT,
        status               TEXT    NOT NULL,
        started_at           TEXT    NOT NULL,
        finished_at          TEXT,
        duration_ms          INTEGER,
        duration_api_ms      INTEGER,
        tokens_in            INTEGER,
        tokens_out           INTEGER,
        tokens_cache_read    INTEGER,
        tokens_cache_create  INTEGER,
        total_cost_usd       REAL,
        num_turns            INTEGER,
        session_id           TEXT,
        created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ai_inv_project_started
        ON ai_invocations(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_inv_project_surface
        ON ai_invocations(project_id, surface);
      CREATE INDEX IF NOT EXISTS idx_ai_inv_project_ticket
        ON ai_invocations(project_id, ticket_id) WHERE ticket_id IS NOT NULL;
    `)
  },

  // Migration 17: chat_conversations.kind — distinguishes Explore conversations
  // (kind='explore') from sidebar chat (kind='sidebar'). Capture for ai_invocations
  // is gated on kind='explore'.
  (db) => {
    db.exec(`
      ALTER TABLE chat_conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'sidebar';
    `)
  },

  // Migration 18: chat_conversations.context_scope — per-conversation JSON
  // freezing the Add Spec context scope at creation time. NULL means "legacy
  // behavior" so existing rows behave unchanged.
  //
  // Idempotent: a parallel WIP branch shipped this column under migration #20,
  // so on machines where it already exists we swallow the duplicate-column
  // error rather than crash on a re-run.
  (db) => {
    try {
      db.exec(`ALTER TABLE chat_conversations ADD COLUMN context_scope TEXT;`)
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (!/duplicate column name/i.test(msg)) throw err
    }
  },

  // Migration 19: ai_invocations.provider — provider id stamped at insert.
  // Existing rows backfill to 'claude' since pre-migration that was the only
  // path. New rows MUST be populated from the resolved adapter's id (see
  // openspec/changes/add-multi-provider-support/specs/project-spending/spec.md).
  //
  // Idempotent: same dual-WIP concern — multi-provider branch originally
  // numbered this #18, so on machines that ran the pre-merge multi-provider
  // build the column already exists.
  (db) => {
    try {
      db.exec(`ALTER TABLE ai_invocations ADD COLUMN provider TEXT;`)
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (!/duplicate column name/i.test(msg)) throw err
    }
    db.exec(`UPDATE ai_invocations SET provider = 'claude' WHERE provider IS NULL;`)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_inv_project_provider
        ON ai_invocations(project_id, provider);
    `)
  },

  // Migration 20: ai_invocations.total_cost_usd_estimated — 1 when the cost
  // came from server/pricing.ts (estimated fallback for non-native-cost
  // providers); 0 when authoritative from the provider's terminal event.
  //
  // Idempotent for the same reason as #18/#19.
  (db) => {
    try {
      db.exec(`
        ALTER TABLE ai_invocations
          ADD COLUMN total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0;
      `)
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (!/duplicate column name/i.test(msg)) throw err
    }
  },

  // Migration 21: self-heal `ai_invocations.provider` and
  // `ai_invocations.total_cost_usd_estimated` for projects whose
  // `schema_migrations` table marked versions 19 / 20 as applied without the
  // corresponding ALTER actually running (parallel WIP branches reshuffled
  // migration indices during development, leaving some on-disk DBs with the
  // applied row but no column). Uses `PRAGMA table_info` so we only ALTER
  // when the column is genuinely missing — safe to re-run.
  (db) => {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(ai_invocations)`).all() as { name: string }[])
        .map((r) => r.name),
    )
    if (!cols.has('provider')) {
      db.exec(`ALTER TABLE ai_invocations ADD COLUMN provider TEXT;`)
      db.exec(`UPDATE ai_invocations SET provider = 'claude' WHERE provider IS NULL;`)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_inv_project_provider
          ON ai_invocations(project_id, provider);
      `)
    }
    if (!cols.has('total_cost_usd_estimated')) {
      db.exec(`
        ALTER TABLE ai_invocations
          ADD COLUMN total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0;
      `)
    }
  },

  // Migration 22: file_provenance — per-project file ⇄ ticket tracking,
  // populated by the QueueManager post-job hook and consumed by the Code
  // Explorer router + TicketDetailModal.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_provenance (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path   TEXT    NOT NULL,
        ticket_id   INTEGER,
        job_id      TEXT,
        kind        TEXT    NOT NULL CHECK(kind IN ('created','modified','deleted')),
        at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fp_path   ON file_provenance(file_path);
      CREATE INDEX IF NOT EXISTS idx_fp_ticket ON file_provenance(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_fp_at     ON file_provenance(at DESC);
    `)
  },

  // Migration 23: optional per-job file patch storage for Code Explorer
  // provenance. Older provenance rows remain valid without a patch.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_provenance_diffs (
        provenance_id INTEGER PRIMARY KEY REFERENCES file_provenance(id) ON DELETE CASCADE,
        patch         TEXT NOT NULL,
        truncated     INTEGER NOT NULL DEFAULT 0
      );
    `)
  },

  // Migration 24: chat_conversations.provider — per-conversation AI engine for
  // multi-provider projects. NULL means "fall back to the project's primary
  // provider" (single-provider projects never set it, so behaviour is
  // unchanged). Set at conversation creation from the Add Spec AI Engine
  // selector; resume turns reuse it so the right CLI binary is spawned.
  (db) => {
    db.exec(`ALTER TABLE chat_conversations ADD COLUMN provider TEXT;`)
  },

  // Migration 25: rails.ai_engine — per-rail AI engine override for
  // multi-provider projects. NULL means "use the project's primary provider".
  // Stored on every rail row alongside profile_name; getRail reads the first
  // row's value.
  (db) => {
    db.exec(`ALTER TABLE rails ADD COLUMN ai_engine TEXT;`)
  },

  // Migration 26: self-heal the multi-provider columns. An earlier WIP of the
  // multi-provider feature consumed migration versions 24 and 25 on some
  // databases with DIFFERENT meaning — those DBs already record v24/v25 so
  // Migrations 24/25 above are skipped, leaving `rails.ai_engine` (and possibly
  // `chat_conversations.provider`) missing. This higher-numbered migration is
  // guarded by column checks: a no-op on DBs where the columns already exist,
  // and an additive repair everywhere else. (Mirrors the #18/#19 self-heal
  // precedent in this file.)
  (db) => {
    const convCols = (db.prepare("PRAGMA table_info(chat_conversations)").all() as { name: string }[]).map((c) => c.name)
    if (!convCols.includes('provider')) {
      db.exec(`ALTER TABLE chat_conversations ADD COLUMN provider TEXT;`)
    }
    const railCols = (db.prepare("PRAGMA table_info(rails)").all() as { name: string }[]).map((c) => c.name)
    if (!railCols.includes('ai_engine')) {
      db.exec(`ALTER TABLE rails ADD COLUMN ai_engine TEXT;`)
    }
  },

  // Migration 27: jobs.total_cost_usd_estimated — 1 when jobs.total_cost_usd
  // came from server/pricing.ts (estimated fallback for non-native-cost
  // providers like codex); 0 when authoritative from the provider's terminal
  // event. Mirrors the ai_invocations column (migration 20) so the app
  // dashboard, budget enforcement, and webhook can distinguish a rate-card
  // estimate from a provider-billed figure. Additive + idempotent.
  (db) => {
    const cols = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((r) => r.name)
    if (!cols.includes('total_cost_usd_estimated')) {
      db.exec(`
        ALTER TABLE jobs
          ADD COLUMN total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0;
      `)
    }
  },

  // Migration 28: rail_meta — per-rail display name, keyed by rail_index.
  // The `rails` table stores name-less ticket rows (and has NO rows for an
  // empty rail), so a rail's user-given name can't live there — a renamed but
  // empty rail would lose its name. rail_meta is a separate, ticket-independent
  // store so every rail (0/1/2) keeps its name regardless of assignments.
  // NULL name = client falls back to the default "Rail N" label. This backs the
  // desktop ⇄ mobile rail-name sync (broadcast via rail.updated).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rail_meta (
        rail_index  INTEGER PRIMARY KEY,
        name        TEXT
      );
    `)
  },

  // Migration 29: Jira integration (per-project). Each project syncs with its
  // own Jira board, so every Jira table lives here in the per-project jobs.sqlite
  // and is keyed by nothing but its own rows. See docs/jira-integration-plan.md.
  //   - jira_connection: one row, the connection config (token stored encrypted).
  //   - jira_links: spec↔issue map keyed on the IMMUTABLE Jira numeric id.
  //   - jira_outbox: durable transactional write-back queue (status + comments).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jira_connection (
        project_id        TEXT PRIMARY KEY,
        base_url          TEXT NOT NULL,
        deployment        TEXT NOT NULL,
        api_version       TEXT NOT NULL,
        auth_scheme       TEXT NOT NULL,
        account_email     TEXT,
        jira_project_key  TEXT NOT NULL,
        jira_project_id   TEXT NOT NULL,
        encrypted_token   TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        status_map        TEXT,
        high_water_ms     INTEGER,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS jira_links (
        local_id          INTEGER PRIMARY KEY,
        jira_issue_id     TEXT NOT NULL UNIQUE,
        jira_key          TEXT,
        jira_project_id   TEXT NOT NULL,
        deployment        TEXT NOT NULL,
        status_category   TEXT,
        state             TEXT NOT NULL DEFAULT 'linked',
        tombstoned        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_jira_links_issue ON jira_links(jira_issue_id);

      CREATE TABLE IF NOT EXISTS jira_outbox (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        jira_issue_id     TEXT NOT NULL,
        op_type           TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL UNIQUE,
        payload           TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'pending',
        attempts          INTEGER NOT NULL DEFAULT 0,
        next_attempt_at   TEXT,
        last_error        TEXT,
        dead_reason       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_jira_outbox_state ON jira_outbox(state);
      CREATE INDEX IF NOT EXISTS idx_jira_outbox_issue ON jira_outbox(jira_issue_id);
    `)
  },

  // Migration 30: Jira sprint custom-field id. The field that holds an issue's
  // sprint(s) is a custom field whose id varies per instance; we discover it
  // (schema com.pyxis.greenhopper.jira:gh-sprint) and cache it here. NULL =
  // not yet checked, 'none' = checked and no sprint field exists, '<id>' = found.
  (db) => {
    try {
      db.exec(`ALTER TABLE jira_connection ADD COLUMN sprint_field_id TEXT`)
    } catch {
      // Column may already exist on a partially-migrated DB — no-op.
    }
  },

  // Migration 31: Jira discard target status. The user-configured status name to
  // which a discarded spec's issue is transitioned (instead of being deleted) in
  // a Jira-synced project. NULL/empty = not configured (delete behaves normally).
  (db) => {
    try {
      db.exec(`ALTER TABLE jira_connection ADD COLUMN discard_status TEXT`)
    } catch {
      // Column may already exist on a partially-migrated DB — no-op.
    }
  },

  // Migration 32: jobs.interactive — 1 when the job is an interactive persistent
  // ultracode session (the user sends multiple prompts across turns; the job
  // stays 'running' until an explicit finalize, at which point every turn's real
  // tokens/cost/num_turns are already summed into the row and status flips to
  // 'completed'); 0 (default) for standard autonomous jobs. Additive + idempotent
  // (guarded by PRAGMA table_info, mirroring migrations 18–26).
  (db) => {
    const cols = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((r) => r.name)
    if (!cols.includes('interactive')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0`)
    }
  },

  // Migration 33: loop_runs — per-project record of an executed Loop (the Loops
  // feature). A loop DEFINITION is global (desktop.sqlite `loops`); a RUN happens
  // in a project, bound to a rail + spec. Powers loop analytics (iterations,
  // final outcome, success rate, totals) alongside the per-step ai_invocations
  // rows (surface='loop', linked via loop_run_id). "Running" loop state is
  // derived from rows here with status='running'.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        loop_id           TEXT NOT NULL,
        loop_name         TEXT,
        rail_index        INTEGER,
        ticket_id         INTEGER,
        provider          TEXT,
        model             TEXT,
        reasoning_effort  TEXT,
        status            TEXT NOT NULL DEFAULT 'running',
        final_outcome     TEXT,
        iteration_limit   INTEGER NOT NULL DEFAULT 0,
        iteration_count   INTEGER NOT NULL DEFAULT 0,
        total_cost_usd    REAL NOT NULL DEFAULT 0,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at        TEXT NOT NULL,
        finished_at       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_project_started ON loop_runs(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_outcome ON loop_runs(project_id, final_outcome);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_loop ON loop_runs(loop_id);
    `)
  },

  // Migration 34: ai_invocations.loop_run_id — links a loop's per-iteration AI
  // invocations (AI Step + Loop Decider, surface='loop') to their loop_runs row
  // for run-level rollups. NULL for every non-loop invocation. Additive +
  // idempotent (guarded by PRAGMA table_info, mirroring migrations 18–32).
  (db) => {
    const cols = (db.prepare(`PRAGMA table_info(ai_invocations)`).all() as { name: string }[]).map((r) => r.name)
    if (!cols.includes('loop_run_id')) {
      db.exec(`ALTER TABLE ai_invocations ADD COLUMN loop_run_id TEXT`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_ai_invocations_loop_run ON ai_invocations(loop_run_id) WHERE loop_run_id IS NOT NULL`
      )
    }
  },

  // Migration 35: rail_worktrees — per-(rail launch, ticket) ledger for parallel
  // worktree isolation + merge-back. Lets a restarted server reconcile orphaned
  // worktrees and lets the UI render integration state. Additive + idempotent.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rail_worktrees (
        id            TEXT PRIMARY KEY,
        rail_index    INTEGER NOT NULL,
        ticket_id     INTEGER NOT NULL,
        run_id        TEXT,
        branch        TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        overlay_path  TEXT,
        merge_state   TEXT NOT NULL DEFAULT 'building',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rail_worktrees_state ON rail_worktrees(merge_state);
      CREATE INDEX IF NOT EXISTS idx_rail_worktrees_rail ON rail_worktrees(rail_index);
    `)
  },
]

function applyMigrations(db: DbInstance): void {
  // Ensure the migrations table exists (migration 1 creates it, but we need
  // it before we can read from it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version)
  )

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1
    if (!appliedVersions.has(version)) {
      // M8: run each migration body and its version INSERT atomically. SQLite DDL
      // is transactional, so a crash/failure mid-migration now rolls back the
      // whole body instead of leaving a half-applied schema with the version
      // unrecorded — which under the old code re-ran a bare `ALTER TABLE ADD
      // COLUMN` on next startup and bricked it forever with 'duplicate column
      // name'. With this, a failed migration leaves nothing applied and re-runs
      // cleanly. (Pre-existing half-applied DBs are contained by the per-project
      // load isolation in project-registry.ts — one bad DB no longer kills the app.)
      const tx = db.transaction(() => {
        MIGRATIONS[i](db)
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version)
      })
      tx()
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function initDb(dbPath: string): DbInstance {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath)
    fs.mkdirSync(dir, { recursive: true })
    secureDir(dir) // H-13: owner-only data dir
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Under load, QueueManager / ChatManager / FileSummaryManager write the same
  // per-project DB concurrently with /analytics reads. Wait up to 5s on a lock
  // instead of throwing SQLITE_BUSY, and cap the WAL so a long checkpoint can't
  // grow it without bound.
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_size_limit = 10000000') // ~10 MB

  applyMigrations(db)

  // H-13: restrict the db + its WAL sidecars to 0600 (jobs.sqlite holds chat
  // transcripts and verbatim terminal command history). After migrations the
  // WAL/SHM files exist, so this covers them too.
  secureDbFile(dbPath)

  // Orphan sweep: mark any running jobs as failed on startup
  db.prepare(
    "UPDATE jobs SET status = 'failed', finished_at = ? WHERE status = 'running'"
  ).run(new Date().toISOString())

  // Orphan sweep: cancel any in-flight proposals from a previous server session
  db.prepare(
    "UPDATE proposals SET status = 'cancelled', updated_at = ? WHERE status IN ('exploring', 'refining')"
  ).run(new Date().toISOString())

  return db
}

export function createJob(db: DbInstance, job: NewJob): void {
  // INSERT OR IGNORE handles the case where the job row already exists (restored from DB
  // after server restart). The UPDATE that follows always sets status and started_at.
  db.prepare(
    'INSERT OR IGNORE INTO jobs (id, command, started_at, status, priority, depends_on_job_id, pipeline_id, interactive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(job.id, job.command, job.started_at, 'running', job.priority ?? 'normal', job.depends_on_job_id ?? null, job.pipeline_id ?? null, job.interactive ? 1 : 0)
  db.prepare(
    'UPDATE jobs SET status = ?, started_at = ?, interactive = ? WHERE id = ?'
  ).run('running', job.started_at, job.interactive ? 1 : 0, job.id)
}

/**
 * Add one completed interactive turn's REAL usage into the job row. Token/cost/
 * turn columns accumulate (COALESCE so the first turn starts from a clean base);
 * model + session_id are stamped from the first turn that reports them. The job
 * stays 'running' — only finalizeInteractiveJob flips the terminal status. This
 * keeps the live Job Detail totals honest (sum of completed turns, never an
 * estimate) between turns.
 */
export function accumulateInteractiveTurn(
  db: DbInstance,
  jobId: string,
  turn: InteractiveTurnUsage,
): void {
  db.prepare(`
    UPDATE jobs SET
      tokens_in           = COALESCE(tokens_in, 0) + ?,
      tokens_out          = COALESCE(tokens_out, 0) + ?,
      tokens_cache_read   = COALESCE(tokens_cache_read, 0) + ?,
      tokens_cache_create = COALESCE(tokens_cache_create, 0) + ?,
      total_cost_usd      = COALESCE(total_cost_usd, 0) + ?,
      num_turns           = COALESCE(num_turns, 0) + ?,
      total_cost_usd_estimated = CASE WHEN ? = 1 THEN 1 ELSE total_cost_usd_estimated END,
      model               = COALESCE(model, ?),
      session_id          = COALESCE(?, session_id)
    WHERE id = ?
  `).run(
    turn.tokens_in,
    turn.tokens_out,
    turn.tokens_cache_read,
    turn.tokens_cache_create,
    turn.total_cost_usd,
    turn.num_turns,
    turn.estimated ? 1 : 0,
    turn.model ?? null,
    turn.session_id ?? null,
    jobId,
  )
}

/**
 * Flip an interactive job to its terminal status (completed on finalize, failed
 * on crash) and stamp finished_at. Token/cost/turn columns are left untouched —
 * they were already accumulated turn-by-turn via accumulateInteractiveTurn.
 */
export function finalizeInteractiveJob(
  db: DbInstance,
  jobId: string,
  status: JobStatus,
): void {
  db.prepare(
    'UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?'
  ).run(status, new Date().toISOString(), jobId)
}

export function finishJob(
  db: DbInstance,
  jobId: string,
  result: JobResult
): void {
  db.prepare(`
    UPDATE jobs SET
      status              = ?,
      exit_code           = ?,
      finished_at         = ?,
      tokens_in           = ?,
      tokens_out          = ?,
      tokens_cache_read   = ?,
      tokens_cache_create = ?,
      total_cost_usd      = ?,
      total_cost_usd_estimated = ?,
      num_turns           = ?,
      model               = ?,
      duration_ms         = ?,
      duration_api_ms     = ?,
      session_id          = ?
    WHERE id = ?
  `).run(
    result.status,
    result.exit_code,
    new Date().toISOString(),
    result.tokens_in ?? null,
    result.tokens_out ?? null,
    result.tokens_cache_read ?? null,
    result.tokens_cache_create ?? null,
    result.total_cost_usd ?? null,
    result.total_cost_usd_estimated ? 1 : 0,
    result.num_turns ?? null,
    result.model ?? null,
    result.duration_ms ?? null,
    result.duration_api_ms ?? null,
    result.session_id ?? null,
    jobId,
  )
}

export function appendEvent(
  db: DbInstance,
  jobId: string,
  seq: number,
  event: AppEvent
): void {
  db.prepare(
    'INSERT INTO events (job_id, seq, event_type, source, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(jobId, seq, event.event_type, event.source ?? null, event.payload)
}

export function upsertPhase(
  db: DbInstance,
  jobId: string,
  phase: string,
  state: string
): void {
  db.prepare(
    'INSERT OR REPLACE INTO job_phases (job_id, phase, state, updated_at) VALUES (?, ?, ?, ?)'
  ).run(jobId, phase, state, new Date().toISOString())
}

export function listJobs(
  db: DbInstance,
  opts: ListJobsOpts
): { jobs: JobRow[]; total: number } {
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0

  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.status) {
    conditions.push('status = ?')
    params.push(opts.status)
  }
  if (opts.from) {
    conditions.push('started_at >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    conditions.push('started_at <= ?')
    params.push(opts.to)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM jobs ${where}`)
    .get(...params) as { count: number }

  const jobs = db
    .prepare(
      `SELECT jobs.*, jp.profile_name AS profile_name
       FROM jobs LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
       ${where}
       ORDER BY started_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as JobRow[]

  return { jobs, total: countRow.count }
}

export function getJob(
  db: DbInstance,
  jobId: string
): JobRow | undefined {
  return db
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined
}

export function getJobEvents(
  db: DbInstance,
  jobId: string
): EventRow[] {
  return db
    .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq ASC')
    .all(jobId) as EventRow[]
}

export function deleteJob(db: DbInstance, jobId: string): void {
  // M7: jobs.depends_on_job_id REFERENCES jobs(id) with no ON DELETE action and
  // foreign_keys=ON, so deleting a pipeline parent throws 'FOREIGN KEY
  // constraint failed' and the job becomes undeletable from the UI. Clear inbound
  // references first, in the same transaction as the delete, so it always
  // succeeds (children keep running; they just lose the now-irrelevant pointer).
  const tx = db.transaction((id: string) => {
    db.prepare('UPDATE jobs SET depends_on_job_id = NULL WHERE depends_on_job_id = ?').run(id)
    // B41: events/job_phases cascade on the jobs FK, but telemetry_blobs/
    // telemetry_summaries (keyed `jobId`), job_profiles and file_provenance
    // (keyed `job_id`) have no FK — without these they accumulate forever. (The
    // on-disk .ndjson.gz blob is reclaimed by the 7-day startup compactor.)
    db.prepare('DELETE FROM telemetry_blobs WHERE jobId = ?').run(id)
    db.prepare('DELETE FROM telemetry_summaries WHERE jobId = ?').run(id)
    db.prepare('DELETE FROM job_profiles WHERE job_id = ?').run(id)
    db.prepare('DELETE FROM file_provenance WHERE job_id = ?').run(id)
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  })
  tx(jobId)
}

export function purgeJobs(
  db: DbInstance,
  opts?: { from?: string; to?: string }
): number {
  const conditions: string[] = ["status IN ('completed', 'failed', 'canceled', 'zombie_terminated', 'skipped')"]
  const params: unknown[] = []

  if (opts?.from) {
    conditions.push('started_at >= ?')
    params.push(opts.from)
  }
  if (opts?.to) {
    conditions.push('started_at <= ?')
    params.push(opts.to)
  }

  const where = conditions.join(' AND ')

  // M6: run the whole purge atomically. Previously these statements ran without a
  // transaction, so when the final `DELETE FROM jobs` aborted on the
  // depends_on_job_id FK (a purged job still referenced by a non-purged one), the
  // events/phases deletes had already committed — destroying log history while
  // deleting zero job rows, and a misleading 500. The transaction rolls back on
  // any failure, and NULL-ing inbound references first makes the delete succeed.
  const tx = db.transaction(() => {
    const sel = `SELECT id FROM jobs WHERE ${where}`
    db.prepare(`DELETE FROM events WHERE job_id IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM job_phases WHERE job_id IN (${sel})`).run(...params)
    // B41: also purge the no-FK orphan tables for the same jobs.
    db.prepare(`DELETE FROM telemetry_blobs WHERE jobId IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM telemetry_summaries WHERE jobId IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM job_profiles WHERE job_id IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM file_provenance WHERE job_id IN (${sel})`).run(...params)
    // Clear inbound FK references from NON-purged jobs to purged jobs.
    db.prepare(`UPDATE jobs SET depends_on_job_id = NULL WHERE depends_on_job_id IN (${sel})`).run(...params)
    return db.prepare(`DELETE FROM jobs WHERE ${where}`).run(...params).changes
  })
  return tx() as number
}

// ─── Activity feed ────────────────────────────────────────────────────────────

export interface ActivityQueryOpts {
  limit: number
  before?: string
}

export function getProjectActivity(db: DbInstance, opts: ActivityQueryOpts): ActivityItem[] {
  const limit = Math.min(opts.limit, 100)
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.before) {
    conditions.push('started_at < ?')
    params.push(opts.before)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const jobs = db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as JobRow[]

  return jobs.map((j) => {
    const isTerminal = j.status === 'completed' || j.status === 'failed' || j.status === 'canceled' || j.status === 'zombie_terminated'
    const type: ActivityItem['type'] =
      j.status === 'completed' ? 'job_completed'
      : j.status === 'failed' ? 'job_failed'
      : (j.status === 'canceled' || j.status === 'zombie_terminated') ? 'job_canceled'
      : 'job_started'
    const timestamp = isTerminal && j.finished_at ? j.finished_at : j.started_at
    const shortCmd = j.command.length > 60 ? j.command.slice(0, 57) + '...' : j.command
    const summary =
      type === 'job_started' ? `Job started: ${shortCmd}`
      : type === 'job_completed' ? `Job completed: ${shortCmd}`
      : type === 'job_failed' ? `Job failed: ${shortCmd}`
      : j.status === 'zombie_terminated' ? `Job auto-terminated (zombie): ${shortCmd}`
      : `Job canceled: ${shortCmd}`
    return {
      id: j.id,
      type,
      jobId: j.id,
      jobCommand: j.command,
      timestamp,
      summary,
      costUsd: isTerminal ? (j.total_cost_usd ?? null) : null,
    }
  })
}

// ─── Chat DB functions ────────────────────────────────────────────────────────

export function createConversation(
  db: DbInstance,
  opts: { id: string; model: string; kind?: 'sidebar' | 'explore'; contextScope?: unknown; provider?: string | null }
): void {
  const scopeJson = opts.contextScope != null ? JSON.stringify(opts.contextScope) : null
  db.prepare(
    'INSERT INTO chat_conversations (id, model, kind, context_scope, provider) VALUES (?, ?, ?, ?, ?)'
  ).run(opts.id, opts.model, opts.kind ?? 'sidebar', scopeJson, opts.provider ?? null)
}

export function listConversations(db: DbInstance): ChatConversationRow[] {
  return db.prepare(
    'SELECT * FROM chat_conversations ORDER BY updated_at DESC'
  ).all() as ChatConversationRow[]
}

export function getConversation(db: DbInstance, id: string): ChatConversationRow | undefined {
  return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ChatConversationRow | undefined
}

export function deleteConversation(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
}

export function updateConversation(
  db: DbInstance,
  id: string,
  patch: { title?: string; session_id?: string; model?: string }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.session_id !== undefined) { sets.push('session_id = ?'); params.push(patch.session_id) }
  if (patch.model !== undefined) { sets.push('model = ?'); params.push(patch.model) }
  params.push(id)
  db.prepare(`UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function addMessage(
  db: DbInstance,
  msg: { conversation_id: string; role: 'user' | 'assistant'; content: string }
): ChatMessageRow {
  const result = db.prepare(
    'INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(msg.conversation_id, msg.role, msg.content)
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(result.lastInsertRowid)) as ChatMessageRow
}

export function getMessages(db: DbInstance, conversationId: string): ChatMessageRow[] {
  return db.prepare(
    'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conversationId) as ChatMessageRow[]
}

// ─── Proposal DB functions ────────────────────────────────────────────────────

export function createProposal(db: DbInstance, opts: { id: string; idea: string }): void {
  db.prepare(
    'INSERT INTO proposals (id, idea, status) VALUES (?, ?, ?)'
  ).run(opts.id, opts.idea, 'input')
}

export function getProposal(db: DbInstance, id: string): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined
}

export function listProposals(
  db: DbInstance,
  opts?: { limit?: number; offset?: number }
): { proposals: ProposalRow[]; total: number } {
  const limit = Math.min(opts?.limit ?? 20, 100)
  const offset = opts?.offset ?? 0

  const countRow = db
    .prepare('SELECT COUNT(*) as count FROM proposals')
    .get() as { count: number }

  const proposals = db
    .prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as ProposalRow[]

  return { proposals, total: countRow.count }
}

export function updateProposal(
  db: DbInstance,
  id: string,
  patch: {
    status?: string
    session_id?: string
    result_markdown?: string
    issue_url?: string
  }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.session_id !== undefined) { sets.push('session_id = ?'); params.push(patch.session_id) }
  if (patch.result_markdown !== undefined) { sets.push('result_markdown = ?'); params.push(patch.result_markdown) }
  if (patch.issue_url !== undefined) { sets.push('issue_url = ?'); params.push(patch.issue_url) }
  params.push(id)
  db.prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function deleteProposal(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM proposals WHERE id = ?').run(id)
}

// ─── Job Template DB functions ────────────────────────────────────────────────

export interface JobTemplateRow {
  id: string
  name: string
  description: string | null
  commands: string  // JSON-encoded string[]
  created_at: string
  updated_at: string
}

export function createTemplate(
  db: DbInstance,
  t: { id: string; name: string; description?: string; commands: string[] }
): void {
  db.prepare(
    'INSERT INTO job_templates (id, name, description, commands) VALUES (?, ?, ?, ?)'
  ).run(t.id, t.name, t.description ?? null, JSON.stringify(t.commands))
}

export function listTemplates(db: DbInstance): JobTemplateRow[] {
  return db.prepare('SELECT * FROM job_templates ORDER BY created_at DESC').all() as JobTemplateRow[]
}

export function getTemplate(db: DbInstance, id: string): JobTemplateRow | undefined {
  return db.prepare('SELECT * FROM job_templates WHERE id = ?').get(id) as JobTemplateRow | undefined
}

export function updateTemplate(
  db: DbInstance,
  id: string,
  patch: { name?: string; description?: string | null; commands?: string[] }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.commands !== undefined) { sets.push('commands = ?'); params.push(JSON.stringify(patch.commands)) }
  params.push(id)
  db.prepare(`UPDATE job_templates SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function deleteTemplate(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM job_templates WHERE id = ?').run(id)
}

export function skipJob(db: DbInstance, jobId: string, reason: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'skipped', skip_reason = ?, finished_at = ? WHERE id = ?`
  ).run(reason, new Date().toISOString(), jobId)
}

export function getPipelineJobs(db: DbInstance, pipelineId: string): JobRow[] {
  return db.prepare(
    'SELECT * FROM jobs WHERE pipeline_id = ? ORDER BY queue_position ASC, started_at ASC'
  ).all(pipelineId) as JobRow[]
}

export function getStats(db: DbInstance): StatsRow {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  // Job-COUNT metrics (totalJobs / failedJobs / jobsToday / avgDurationMs) are
  // genuinely about pipeline jobs, so they stay on the jobs table.
  const totalRow = db.prepare(`
    SELECT
      COUNT(*) as totalJobs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedJobs,
      AVG(duration_ms) as avgDurationMs
    FROM jobs
  `).get() as { totalJobs: number; failedJobs: number | null; avgDurationMs: number | null }

  const jobsTodayRow = db.prepare(`
    SELECT COUNT(*) as jobsToday
    FROM jobs
    WHERE strftime('%Y-%m-%d', started_at) = ?
  `).get(today) as { jobsToday: number }

  // MED-8: cost SUMs come from ai_invocations — ALL billable surfaces (job,
  // explore-spec, chat-sidebar, quick-spec, ai-edit, agent-studio, spec-launcher,
  // proposal, setup, smash, file-summary, loop), not just the jobs table — across
  // every status, mirroring server/desktop-analytics.ts + server/spending.ts so
  // the per-project StatusBar reconciles with /analytics and /budget for the same
  // project. A killed/failed run's rate-card estimate now counts (it billed real
  // tokens) instead of vanishing; estimatedCost* is the portion sourced from the
  // rate card so the StatusBar can badge the total with `~`.
  const costSum = `COALESCE(SUM(total_cost_usd), 0)`
  const estSum = `COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0)`

  const costRow = db.prepare(`
    SELECT ${costSum} as totalCostUsd, ${estSum} as estimatedCostUsd
    FROM ai_invocations
  `).get() as { totalCostUsd: number; estimatedCostUsd: number }

  const costTodayRow = db.prepare(`
    SELECT ${costSum} as costToday, ${estSum} as estimatedCostToday
    FROM ai_invocations
    WHERE strftime('%Y-%m-%d', started_at) = ?
  `).get(today) as { costToday: number; estimatedCostToday: number }

  return {
    totalJobs: totalRow.totalJobs,
    failedJobs: totalRow.failedJobs ?? 0,
    jobsToday: jobsTodayRow.jobsToday,
    totalCostUsd: costRow.totalCostUsd,
    costToday: costTodayRow.costToday,
    estimatedCostUsd: costRow.estimatedCostUsd,
    estimatedCostToday: costTodayRow.estimatedCostToday,
    avgDurationMs: totalRow.avgDurationMs,
  }
}

// ─── Project settings ─────────────────────────────────────────────────────────

/**
 * Default pre-prompt used by Ultracode (Claude-only rails) when the project
 * has no per-project override. Ultracode skips the OpenSpec pipeline entirely:
 * it hands Claude the spec text plus this instruction and lets it work
 * autonomously end-to-end.
 */
export const DEFAULT_ULTRACODE_PRE_PROMPT = [
  'You are operating in ULTRACODE: fully autonomous, end-to-end implementation.',
  'Implement the following spec COMPLETELY in this repository. You have full access to the codebase and tools.',
  'Work independently until the feature is done: write the code, the tests, update docs as needed, and make sure everything builds and the test suite passes.',
  'Do NOT follow any structured architect/developer/reviewer pipeline — use your own judgement and the repo conventions.',
  'Never ask for confirmation; there is no human to answer. Choose the recommended option and proceed.',
].join('\n')

export interface ProjectSettings {
  pipelineTelemetryEnabled: boolean
  orchestratorModel: string
  prePrompt: string
  /** Per-project Ultracode pre-prompt override. Empty string = use
   *  DEFAULT_ULTRACODE_PRE_PROMPT at spawn time. */
  ultraPrePrompt: string
}

export function getProjectSettings(db: DbInstance): ProjectSettings {
  const telemetryRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.pipeline_telemetry_enabled'`
  ).get() as { value: string } | undefined
  const modelRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.orchestrator_model'`
  ).get() as { value: string } | undefined
  const prePromptRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.pre_prompt'`
  ).get() as { value: string } | undefined
  const ultraPrePromptRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.ultracode_pre_prompt'`
  ).get() as { value: string } | undefined
  return {
    pipelineTelemetryEnabled: telemetryRow?.value === 'true',
    orchestratorModel: modelRow?.value ?? 'sonnet',
    prePrompt: prePromptRow?.value ?? '',
    ultraPrePrompt: ultraPrePromptRow?.value ?? '',
  }
}

/** Resolve the effective Ultracode pre-prompt: the per-project override when
 *  set, otherwise the built-in default. */
export function getUltracodePrePrompt(db: DbInstance): string {
  const override = getProjectSettings(db).ultraPrePrompt.trim()
  return override || DEFAULT_ULTRACODE_PRE_PROMPT
}

export function updateProjectSettings(db: DbInstance, patch: Partial<ProjectSettings>): void {
  if (patch.pipelineTelemetryEnabled !== undefined) {
    db.prepare(
      `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.pipeline_telemetry_enabled', ?)`
    ).run(patch.pipelineTelemetryEnabled ? 'true' : 'false')
  }
  if (patch.orchestratorModel !== undefined) {
    db.prepare(
      `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.orchestrator_model', ?)`
    ).run(patch.orchestratorModel)
  }
  if (patch.prePrompt !== undefined) {
    if (patch.prePrompt.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.pre_prompt'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.pre_prompt', ?)`
      ).run(patch.prePrompt)
    }
  }
  if (patch.ultraPrePrompt !== undefined) {
    if (patch.ultraPrePrompt.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.ultracode_pre_prompt'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.ultracode_pre_prompt', ?)`
      ).run(patch.ultraPrePrompt)
    }
  }
}

// ─── Explore Spec acceleration ────────────────────────────────────────────────

/**
 * Per-project last-used value for the Quick mode Contract Refine toggle in
 * the Add Spec modal. Default `false` when never set.
 */
export function getQuickContractRefineLast(db: DbInstance): boolean {
  const row = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.add_spec_quick_contract_refine_last'`
  ).get() as { value: string } | undefined
  return row?.value === 'true'
}

export function hasQuickContractRefineLast(db: DbInstance): boolean {
  const row = db.prepare(
    `SELECT 1 FROM queue_state WHERE key = 'config.add_spec_quick_contract_refine_last'`
  ).get() as { 1: number } | undefined
  return !!row
}

export function setQuickContractRefineLast(db: DbInstance, enabled: boolean): void {
  db.prepare(
    `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.add_spec_quick_contract_refine_last', ?)`
  ).run(enabled ? 'true' : 'false')
}

// ─── Telemetry DB functions ───────────────────────────────────────────────────

export interface TelemetryBlobRow {
  jobId: string
  path: string | null
  byteSize: number
  startedAt: number | null
  endedAt: number | null
  state: 'active' | 'compacted' | 'expired'
}

export interface TelemetrySummaryRow {
  jobId: string
  phase: string
  durationMs: number | null
  tokensInput: number | null
  tokensOutput: number | null
  tokensCache: number | null
  toolCalls: string | null
  apiErrors: number | null
  costUsd: number | null
}

export function getTelemetryBlob(db: DbInstance, jobId: string): TelemetryBlobRow | undefined {
  return db.prepare('SELECT * FROM telemetry_blobs WHERE jobId = ?').get(jobId) as TelemetryBlobRow | undefined
}

export function upsertTelemetryBlob(db: DbInstance, row: TelemetryBlobRow): void {
  db.prepare(`
    INSERT INTO telemetry_blobs (jobId, path, byteSize, startedAt, endedAt, state)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jobId) DO UPDATE SET
      path = excluded.path,
      byteSize = excluded.byteSize,
      startedAt = COALESCE(telemetry_blobs.startedAt, excluded.startedAt),
      endedAt = excluded.endedAt,
      state = excluded.state
  `).run(row.jobId, row.path ?? null, row.byteSize, row.startedAt ?? null, row.endedAt ?? null, row.state)
}

export function listActiveTelemetryBlobs(db: DbInstance): TelemetryBlobRow[] {
  return db.prepare(
    `SELECT * FROM telemetry_blobs WHERE state = 'active'`
  ).all() as TelemetryBlobRow[]
}

export function setTelemetryBlobCompacted(db: DbInstance, jobId: string): void {
  db.prepare(
    `UPDATE telemetry_blobs SET state = 'compacted', path = NULL WHERE jobId = ?`
  ).run(jobId)
}

export function insertTelemetrySummary(db: DbInstance, row: TelemetrySummaryRow): void {
  db.prepare(`
    INSERT OR REPLACE INTO telemetry_summaries
      (jobId, phase, durationMs, tokensInput, tokensOutput, tokensCache, toolCalls, apiErrors, costUsd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.jobId, row.phase,
    row.durationMs ?? null, row.tokensInput ?? null, row.tokensOutput ?? null,
    row.tokensCache ?? null, row.toolCalls ?? null, row.apiErrors ?? null, row.costUsd ?? null
  )
}

export function getTelemetrySummaries(db: DbInstance, jobId: string): TelemetrySummaryRow[] {
  return db.prepare('SELECT * FROM telemetry_summaries WHERE jobId = ?').all(jobId) as TelemetrySummaryRow[]
}

export function deleteTelemetryForJob(db: DbInstance, jobId: string): void {
  db.prepare('DELETE FROM telemetry_blobs WHERE jobId = ?').run(jobId)
  db.prepare('DELETE FROM telemetry_summaries WHERE jobId = ?').run(jobId)
}

/** Returns a Set of jobIds that have active or compacted telemetry blobs. */
export function getJobsWithTelemetry(db: DbInstance): Set<string> {
  const rows = db.prepare(
    `SELECT jobId FROM telemetry_blobs WHERE state IN ('active','compacted')`
  ).all() as Array<{ jobId: string }>
  return new Set(rows.map((r) => r.jobId))
}

/** True iff the job has an active or compacted telemetry blob row. */
export function hasJobTelemetry(db: DbInstance, jobId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM telemetry_blobs WHERE jobId = ? AND state IN ('active','compacted') LIMIT 1`
  ).get(jobId)
  return row !== undefined
}
