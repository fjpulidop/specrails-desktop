import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { JobRow, EventRow, StatsRow, JobStatus, JobPriority, JobOwner, ChatConversationRow, ChatMessageRow, ActivityItem } from './types'
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
  /** Provider resolved for this concrete run (including any per-job override).
   *  Persisted so crash recovery does not fall back to the project's default. */
  provider?: string | null
  /** Manager that exclusively owns crash recovery for this row. */
  owner?: JobOwner
  /** True when launch-time ticket/rail ownership was durably claimed. False
   *  is reserved for pre-provenance/legacy work. */
  causal_ownership?: boolean
  priority?: JobPriority
  depends_on_job_id?: string | null
  pipeline_id?: string | null
  /** 1 when this is an interactive persistent session (freestyle + the rail's
   *  Interactive toggle); 0/undefined for standard autonomous jobs. */
  interactive?: boolean
}

/** Durable pre-start state. Queued work deliberately lives outside `jobs`:
 * `jobs.started_at` is the execution start timestamp and is NOT NULL for
 * historical rows, so inserting there before spawn would manufacture a start. */
export interface QueuedJobRecord {
  id: string
  command: string
  queue_position: number | null
  priority: JobPriority
  depends_on_job_id?: string | null
  pipeline_id?: string | null
  /** Per-job overrides. Null means use the project/provider default. */
  provider?: string | null
  model?: string | null
  /** `profile_selection_set=false` is default resolution; true + null forces
   * legacy mode; true + string selects that explicit profile. */
  profile_name?: string | null
  profile_selection_set?: boolean
  /** Null is the spawn-time default; 0/1 are explicit false/true overrides. */
  interactive?: boolean | null
  causal_ownership?: boolean
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

/** Backfill only terminal Safe-PR rows whose ticket ownership is unambiguous.
 * Eligibility is intentionally deferred to the outbox drainer, which freezes
 * only candidates still parked at on_review in the external ticket JSON. */
function backfillTerminalRailPrTicketEffects(db: DbInstance): void {
  const terminalRows = db.prepare(`
    SELECT id, ticket_ids, run_ids, decision, is_continuation,
           supersedes_delivery_id, pr_url
      FROM rail_pr_deliveries
     WHERE decision = 'merged'
        OR (decision = 'discarded' AND is_continuation = 0
            AND supersedes_delivery_id IS NULL AND pr_url IS NULL)
  `).all() as Array<{
    id: string
    ticket_ids: string
    run_ids: string
    decision: 'merged' | 'discarded'
    is_continuation: number
    supersedes_delivery_id: string | null
    pr_url: string | null
  }>
  const insertEffect = db.prepare(`
    INSERT OR IGNORE INTO rail_pr_ticket_effects (
      delivery_id, ticket_ids, causal_owners, target_status, jira_action, pr_url
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  const currentOwner = db.prepare(`
    SELECT owner_id FROM ticket_outcome_ownership WHERE ticket_id = ?
  `)
  for (const row of terminalRows) {
    let ticketIds: number[] = []
    let runIds: string[] = []
    try {
      const parsed = JSON.parse(row.ticket_ids) as unknown
      if (Array.isArray(parsed)) {
        ticketIds = [...new Set(
          parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0),
        )]
      }
    } catch { /* malformed historical evidence is not safe to act on */ }
    try {
      const parsed = JSON.parse(row.run_ids) as unknown
      if (Array.isArray(parsed)) {
        runIds = [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      }
    } catch { /* absent causal evidence means the historical effect is unsafe */ }
    if (ticketIds.length === 0 || runIds.length === 0) continue

    const allowedOwners = new Set(runIds)
    const causalOwners: Record<string, string> = {}
    ticketIds = ticketIds.filter((ticketId) => {
      const owner = currentOwner.get(ticketId) as { owner_id: string } | undefined
      if (!owner || !allowedOwners.has(owner.owner_id)) return false
      causalOwners[String(ticketId)] = owner.owner_id
      return true
    })
    if (ticketIds.length === 0) continue
    const merged = row.decision === 'merged'
    insertEffect.run(
      row.id,
      JSON.stringify(ticketIds),
      JSON.stringify(causalOwners),
      merged ? 'done' : 'todo',
      // A v49 fresh discard has lost whether it meant Refine or a real
      // discard. Recover the backlog status without inventing either cause.
      merged ? 'merged' : 'backlog',
      merged ? row.pr_url : null,
    )
  }
}

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
  // freestyle session (the user sends multiple prompts across turns; the job
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

  // Migration 36: rail_pr_deliveries — one row per isolated rail LAUNCH tracking
  // the ask-first PR decision lifecycle (building → on_review → pr_draft →
  // pr_ready → merged | discarded | implementation_failed | pr_failed). The durable single source of
  // truth both decision surfaces (rail row + agent chat) read and write, so a
  // refresh/restart never loses a pending PR decision. `branches` captures the
  // per-unit DeliverBranch records at build-settle (deferred deliverRailAsPr
  // cannot be reconstructed without them); `worktree_ids` links the
  // rail_worktrees ledger rows for discard cleanup. Additive + idempotent.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rail_pr_deliveries (
        id                     TEXT PRIMARY KEY,
        rail_index             INTEGER NOT NULL,
        loop_id                TEXT,
        rail_key               TEXT NOT NULL,
        ticket_ids             TEXT NOT NULL,
        base_branch            TEXT NOT NULL,
        branch                 TEXT,
        pr_url                 TEXT,
        pr_number              INTEGER,
        pr_state               TEXT NOT NULL DEFAULT 'none',
        decision               TEXT NOT NULL DEFAULT 'building',
        branches               TEXT NOT NULL DEFAULT '[]',
        loop_name              TEXT NOT NULL DEFAULT '',
        worktree_ids           TEXT NOT NULL DEFAULT '[]',
        origin_surface         TEXT NOT NULL DEFAULT 'dashboard',
        origin_conversation_id TEXT,
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rail_pr_deliveries_rail ON rail_pr_deliveries(rail_index);
      CREATE INDEX IF NOT EXISTS idx_rail_pr_deliveries_active ON rail_pr_deliveries(decision);
    `)
  },

  // Migration 37: file_story_contributions — per-intervention "construction
  // story" data for the Code/Files explorer. One row per file_provenance row
  // that had a collectable patch: line stats (added/removed), a ~4KB patch
  // excerpt (the full patch stays in file_provenance_diffs), and a nullable
  // plain-language AI `summary` of what that spec contributed to the file
  // (generated on demand, budget-gated — see file-story-manager.ts). Written
  // inside recordProvenanceForJob's transaction so EVERY provenance producer
  // (queue-manager jobs AND the loop-run seam) gets stats for free. Additive.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_story_contributions (
        provenance_id        INTEGER PRIMARY KEY,
        job_id               TEXT,
        file_path            TEXT NOT NULL,
        added_lines          INTEGER NOT NULL DEFAULT 0,
        removed_lines        INTEGER NOT NULL DEFAULT 0,
        patch_excerpt        TEXT,
        summary              TEXT,
        summary_model        TEXT,
        summary_generated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_file_story_contributions_path ON file_story_contributions(file_path);
    `)
  },

  // Migration 38: rail_pr_deliveries.run_ids — JSON string[] of the loop-run
  // ids an isolated rail launch fanned out (order matches ticket order; a
  // scope='all' launch has exactly one). Persisted right after allocation so
  // the PR decision surfaces (agent-chat card + dashboard strip) can render a
  // per-run "View log" chip with live vitals that survives refresh/restart.
  // Additive + idempotent (guarded by PRAGMA table_info, mirroring 18–36).
  (db) => {
    const cols = (db.prepare(`PRAGMA table_info(rail_pr_deliveries)`).all() as { name: string }[]).map((r) => r.name)
    if (!cols.includes('run_ids')) {
      db.exec(`ALTER TABLE rail_pr_deliveries ADD COLUMN run_ids TEXT NOT NULL DEFAULT '[]'`)
    }
  },

  // Migration 39: seed the three BASE rails (indices 0-2) into rail_meta.
  // Dynamic rails make rail_meta the EXISTENCE authority (a rail exists iff it
  // has a rail_meta identity row or leftover ticket rows) — seeding once here,
  // instead of re-seeding on every read, lets a user genuinely delete a base
  // rail (the router still guards: never the last one, never a non-empty or
  // active one). INSERT OR IGNORE keeps any existing renamed-rail rows intact.
  (db) => {
    db.exec(`
      INSERT OR IGNORE INTO rail_meta (rail_index, name) VALUES (0, NULL), (1, NULL), (2, NULL);
    `)
  },

  // Migration 40: durable idempotency ledger for billable job spawns. Clients
  // can safely retry a timed-out POST (or double-submit) without enqueueing a
  // second job. Entries are deliberately short-lived and pruned by the route;
  // the ledger is not job history and therefore has no foreign key to jobs.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_spawn_requests (
        idempotency_key TEXT PRIMARY KEY,
        fingerprint     TEXT NOT NULL,
        job_id          TEXT NOT NULL,
        created_at_ms   INTEGER NOT NULL,
        expires_at_ms   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_spawn_requests_expires
        ON job_spawn_requests(expires_at_ms);
    `)
  },

  // Migration 41: durable outbox for jobs left RUNNING by an ungraceful
  // process exit. QueueManager atomically snapshots each orphan here before it
  // flips the job to failed, then checkpoints accounting and the terminal
  // domain callback independently. A second crash can therefore resume either
  // step without duplicating the ai_invocations ledger or losing the callback.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orphan_job_recovery (
        job_id               TEXT PRIMARY KEY,
        payload              TEXT NOT NULL,
        accounting_completed INTEGER NOT NULL DEFAULT 0 CHECK (accounting_completed IN (0, 1)),
        callback_completed   INTEGER NOT NULL DEFAULT 0 CHECK (callback_completed IN (0, 1)),
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_orphan_job_recovery_pending
        ON orphan_job_recovery(accounting_completed, callback_completed);
    `)
  },

  // Migration 42: persist the provider actually selected for each job and add
  // a third durable recovery checkpoint for queue/pipeline terminal invariants.
  // Both ALTERs are guarded so developer databases that already applied the
  // unreleased orphan-outbox migration can advance safely.
  (db) => {
    const jobCols = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((r) => r.name)
    if (!jobCols.includes('provider')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN provider TEXT`)
    }

    const recoveryCols = (db.prepare(`PRAGMA table_info(orphan_job_recovery)`).all() as { name: string }[]).map((r) => r.name)
    if (!recoveryCols.includes('terminal_completed')) {
      db.exec(`
        ALTER TABLE orphan_job_recovery
        ADD COLUMN terminal_completed INTEGER NOT NULL DEFAULT 0
          CHECK (terminal_completed IN (0, 1))
      `)
    }
  },

  // Migration 43: durable pre-start queue. This is intentionally separate from
  // jobs: a queue admission is not an execution and therefore has no truthful
  // jobs.started_at value. createJob atomically promotes a row out of this table
  // when the provider process actually starts.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS queued_jobs (
        id                TEXT PRIMARY KEY,
        command           TEXT NOT NULL,
        queue_position    INTEGER,
        priority          TEXT NOT NULL DEFAULT 'normal',
        depends_on_job_id TEXT,
        pipeline_id       TEXT,
        provider          TEXT,
        model             TEXT,
        profile_name      TEXT,
        profile_selection_set INTEGER NOT NULL DEFAULT 0
          CHECK (profile_selection_set IN (0, 1)),
        interactive       INTEGER CHECK (interactive IN (0, 1)),
        causal_ownership  INTEGER NOT NULL DEFAULT 0
          CHECK (causal_ownership IN (0, 1)),
        enqueued_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_queued_jobs_position
        ON queued_jobs(queue_position);
    `)
  },

  // Migration 44: persist which manager owns terminal recovery for each jobs
  // row. Before this boundary QueueManager swept every RUNNING row, including
  // LoopRunManager's backing rows, and recorded their already-accounted step
  // spend again as surface='job'. Existing loop rows are classified by their
  // durable loop_runs identity; every other historical job remains queue-owned.
  (db) => {
    const jobCols = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((r) => r.name)
    if (!jobCols.includes('owner')) {
      db.exec(`
        ALTER TABLE jobs
        ADD COLUMN owner TEXT NOT NULL DEFAULT 'queue'
          CHECK (owner IN ('queue', 'loop'))
      `)
    }
    db.exec(`
      UPDATE jobs
         SET owner = 'loop',
             provider = COALESCE(
               jobs.provider,
               (SELECT loop_runs.provider FROM loop_runs WHERE loop_runs.id = jobs.id)
             )
       WHERE EXISTS (SELECT 1 FROM loop_runs WHERE loop_runs.id = jobs.id);
      CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner, status);
    `)
  },

  // Migration 45: crash-consistent loop terminal/accounting outboxes and
  // causal ownership for rail/ticket effects.  `loop_runs.ticket_ids_json`
  // replaces the old startup heuristic ("one active run means scope=all") with
  // the exact launch set.  The recovery tables intentionally have no FK to
  // jobs: terminal history is independently deletable while recovery effects
  // still have to finish.
  (db) => {
    const loopCols = (db.prepare(`PRAGMA table_info(loop_runs)`).all() as { name: string }[]).map((r) => r.name)
    if (!loopCols.includes('ticket_ids_json')) {
      db.exec(`ALTER TABLE loop_runs ADD COLUMN ticket_ids_json TEXT NOT NULL DEFAULT '[]'`)
    }
    if (!loopCols.includes('ticket_completion_status')) {
      db.exec(`
        ALTER TABLE loop_runs
        ADD COLUMN ticket_completion_status TEXT NOT NULL DEFAULT 'done'
          CHECK (ticket_completion_status IN ('done', 'on_review'))
      `)
    }
    if (!loopCols.includes('causal_ownership')) {
      db.exec(`
        ALTER TABLE loop_runs
        ADD COLUMN causal_ownership INTEGER NOT NULL DEFAULT 0
          CHECK (causal_ownership IN (0, 1))
      `)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS loop_terminal_recovery (
        run_id             TEXT PRIMARY KEY,
        payload            TEXT NOT NULL,
        callback_completed INTEGER NOT NULL DEFAULT 0
          CHECK (callback_completed IN (0, 1)),
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS loop_step_recovery (
        run_id         TEXT NOT NULL,
        step_key       TEXT NOT NULL,
        invocation_id  TEXT NOT NULL UNIQUE,
        payload        TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS idx_loop_step_recovery_run
        ON loop_step_recovery(run_id);

      CREATE TABLE IF NOT EXISTS rail_ticket_ownership (
        rail_index INTEGER NOT NULL,
        ticket_id  INTEGER NOT NULL,
        owner_id   TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (rail_index, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rail_ticket_owner
        ON rail_ticket_ownership(owner_id);

      CREATE TABLE IF NOT EXISTS ticket_outcome_ownership (
        ticket_id   INTEGER PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        generation  INTEGER NOT NULL DEFAULT 1,
        claimed_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_outcome_owner
        ON ticket_outcome_ownership(owner_id);

      -- Builds from the pre-owner WIP may already have captured loop backing
      -- rows in QueueManager's outbox, or even checkpointed the resulting
      -- surface='job' invocation.  Those rows are unambiguously wrong: a jobs
      -- id that is also a loop_runs id is exclusively loop-owned.
      DELETE FROM orphan_job_recovery
       WHERE job_id IN (SELECT id FROM loop_runs);
      DELETE FROM ai_invocations
       WHERE surface = 'job'
         AND EXISTS (
           SELECT 1 FROM loop_runs
            WHERE ai_invocations.surface_ref_id = loop_runs.id
               OR ai_invocations.surface_ref_id LIKE loop_runs.id || '#t%'
         );
    `)
  },

  // Migration 46: preserve every pre-spawn semantic override across restart.
  // Nullable provider/model/interactive encode "use the spawn-time default";
  // profile needs a separate presence bit because NULL itself means the
  // deliberate force-legacy selection when the bit is set.
  (db) => {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(queued_jobs)`).all() as { name: string }[])
        .map((row) => row.name),
    )
    if (!cols.has('provider')) {
      db.exec(`ALTER TABLE queued_jobs ADD COLUMN provider TEXT`)
    }
    if (!cols.has('model')) {
      db.exec(`ALTER TABLE queued_jobs ADD COLUMN model TEXT`)
    }
    if (!cols.has('profile_name')) {
      db.exec(`ALTER TABLE queued_jobs ADD COLUMN profile_name TEXT`)
    }
    if (!cols.has('profile_selection_set')) {
      db.exec(`
        ALTER TABLE queued_jobs
        ADD COLUMN profile_selection_set INTEGER NOT NULL DEFAULT 0
          CHECK (profile_selection_set IN (0, 1))
      `)
    }
    if (!cols.has('interactive')) {
      db.exec(`
        ALTER TABLE queued_jobs
        ADD COLUMN interactive INTEGER CHECK (interactive IN (0, 1))
      `)
    }

    if (!cols.has('causal_ownership')) {
      db.exec(`
        ALTER TABLE queued_jobs
        ADD COLUMN causal_ownership INTEGER NOT NULL DEFAULT 0
          CHECK (causal_ownership IN (0, 1))
      `)
    }

    const jobCols = new Set(
      (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[])
        .map((row) => row.name),
    )
    if (!jobCols.has('causal_ownership')) {
      db.exec(`
        ALTER TABLE jobs
        ADD COLUMN causal_ownership INTEGER NOT NULL DEFAULT 0
          CHECK (causal_ownership IN (0, 1))
      `)
    }
  },

  // Migration 47: crash recovery reads the bounded newest provider frontier;
  // this composite index avoids sorting/scanning an unbounded transcript while
  // the queue is fail-stopped during startup.
  (db) => {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_job_seq ON events(job_id, seq)`)
  },

  // Migration 48: truthful Safe-PR settlement. Execution truth, delivery
  // readiness, continuation ownership and decision-operation ownership are
  // independent durable facts; the old decision/pr_state pair cannot explain
  // a successful run whose commit/ref/push later failed. Before enforcing the
  // intended one-active-generation-per-rail invariant, terminalize historical
  // duplicate rows deterministically (newest rowid wins) so an older iteration
  // can never resurface after the current one closes.
  (db) => {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(rail_pr_deliveries)`).all() as { name: string }[])
        .map((row) => row.name),
    )
    const add = (name: string, ddl: string): void => {
      if (!cols.has(name)) db.exec(`ALTER TABLE rail_pr_deliveries ADD COLUMN ${ddl}`)
    }
    add('implementation_outcome', `implementation_outcome TEXT NOT NULL DEFAULT 'unknown'`)
    add('delivery_outcome', `delivery_outcome TEXT NOT NULL DEFAULT 'unknown'`)
    add('status_code', `status_code TEXT`)
    add('status_detail', `status_detail TEXT`)
    add('delivery_sha', `delivery_sha TEXT`)
    add('is_continuation', `is_continuation INTEGER NOT NULL DEFAULT 0 CHECK (is_continuation IN (0, 1))`)
    add('supersedes_delivery_id', `supersedes_delivery_id TEXT`)
    add('operation', `operation TEXT`)
    add('operation_token', `operation_token TEXT`)
    add('operation_started_at_ms', `operation_started_at_ms INTEGER`)
    add('cleanup_warnings', `cleanup_warnings TEXT NOT NULL DEFAULT '[]'`)

    db.exec(`
      UPDATE rail_pr_deliveries
         SET implementation_outcome = CASE decision
           WHEN 'building' THEN 'running'
           WHEN 'implementation_failed' THEN 'failed'
           WHEN 'on_review' THEN 'succeeded'
           WHEN 'pr_draft' THEN 'succeeded'
           WHEN 'pr_ready' THEN 'succeeded'
           WHEN 'pr_failed' THEN 'succeeded'
           WHEN 'merged' THEN 'succeeded'
           ELSE implementation_outcome
         END
       WHERE implementation_outcome = 'unknown';

      UPDATE rail_pr_deliveries
         SET delivery_outcome = CASE decision
           WHEN 'building' THEN 'pending'
           WHEN 'implementation_failed' THEN 'not_started'
           WHEN 'on_review' THEN 'ready'
           WHEN 'pr_draft' THEN 'delivered'
           WHEN 'pr_ready' THEN 'delivered'
           WHEN 'pr_failed' THEN 'retryable_failure'
           WHEN 'merged' THEN 'delivered'
           ELSE delivery_outcome
         END
       WHERE delivery_outcome = 'unknown';

      UPDATE rail_pr_deliveries
         SET status_code = CASE decision
           WHEN 'building' THEN 'implementation_running'
           WHEN 'implementation_failed' THEN 'implementation_failed'
           WHEN 'on_review' THEN 'ready_for_review'
           WHEN 'pr_draft' THEN 'pr_draft_ready'
           WHEN 'pr_ready' THEN 'pr_ready'
           WHEN 'pr_failed' THEN 'delivery_failed'
           WHEN 'merged' THEN 'merged'
           ELSE status_code
         END
       WHERE status_code IS NULL;

      UPDATE rail_pr_deliveries
         SET decision = 'superseded',
             status_code = 'superseded',
             updated_at = datetime('now')
       WHERE decision NOT IN ('merged', 'discarded', 'superseded')
         AND rowid NOT IN (
           SELECT MAX(rowid)
             FROM rail_pr_deliveries
            WHERE decision NOT IN ('merged', 'discarded', 'superseded')
            GROUP BY rail_index
         );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_pr_deliveries_one_active_per_rail
        ON rail_pr_deliveries(rail_index)
        WHERE decision NOT IN ('merged', 'discarded', 'superseded');
    `)
  },

  // Migration 49: repair the exact legacy false-failure shape that motivated
  // the orthogonal lifecycle. Older settlement code could write
  // decision='implementation_failed' after every loop had durably succeeded,
  // solely because commit/ref delivery failed. Reclassify only rows whose full
  // run set is present and terminal; ambiguous rows remain conservative. This
  // migration also makes truthful no-change acknowledgement (`completed`) a
  // terminal generation for the one-active-per-rail invariant.
  (db) => {
    const legacyRows = db.prepare(`
      SELECT id, run_ids, branches
        FROM rail_pr_deliveries
       WHERE decision = 'implementation_failed'
    `).all() as Array<{ id: string; run_ids: string; branches: string }>

    const update = db.prepare(`
      UPDATE rail_pr_deliveries
         SET decision = 'pr_failed',
             implementation_outcome = ?,
             delivery_outcome = 'blocked',
             status_code = 'settlement_interrupted',
             status_detail = ?,
             branches = ?,
             updated_at = datetime('now')
       WHERE id = ? AND decision = 'implementation_failed'
    `)

    for (const row of legacyRows) {
      let runIds: string[] = []
      try {
        const parsed = JSON.parse(row.run_ids) as unknown
        if (Array.isArray(parsed)) {
          runIds = [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))]
        }
      } catch { /* malformed legacy evidence stays conservative */ }
      if (runIds.length === 0) continue

      const placeholders = runIds.map(() => '?').join(',')
      const runs = db.prepare(`
        SELECT id, status, final_outcome
          FROM loop_runs
         WHERE id IN (${placeholders})
      `).all(...runIds) as Array<{ id: string; status: string; final_outcome: string | null }>
      if (runs.length !== runIds.length || runs.some((run) => run.status !== 'completed')) continue
      const outcomes = new Map(runs.map((run) => [run.id, run.final_outcome]))
      const succeeded = runIds.filter((runId) => outcomes.get(runId) === 'success').length
      if (succeeded === 0) continue

      let branches: unknown[] = []
      try {
        const parsed = JSON.parse(row.branches) as unknown
        if (Array.isArray(parsed)) branches = parsed
      } catch { /* retain an empty evidence set rather than malformed JSON */ }
      const repairedBranches = branches.map((value, index) => {
        if (!value || typeof value !== 'object') return value
        const unit = value as Record<string, unknown>
        const runId = runIds[index]
        const implementationSucceeded = runId ? outcomes.get(runId) === 'success' : succeeded === runIds.length
        return {
          ...unit,
          ...(runId ? { runId } : {}),
          implementationOutcome: implementationSucceeded ? 'succeeded' : 'failed',
          deliveryOutcome: implementationSucceeded ? 'blocked' : 'not_started',
          ...(implementationSucceeded ? { failureCode: 'settlement_interrupted' } : {}),
        }
      })
      update.run(
        succeeded === runIds.length ? 'succeeded' : 'partially_succeeded',
        'Recovered the successful implementation result from durable run logs; legacy delivery settlement was interrupted.',
        JSON.stringify(repairedBranches),
        row.id,
      )
    }

    db.exec(`
      DROP INDEX IF EXISTS idx_rail_pr_deliveries_one_active_per_rail;
      CREATE UNIQUE INDEX idx_rail_pr_deliveries_one_active_per_rail
        ON rail_pr_deliveries(rail_index)
        WHERE decision NOT IN ('completed', 'merged', 'discarded', 'superseded');
    `)
  },

  // Migration 50: terminal Safe-PR decisions and their ticket-file mutation
  // cross SQLite/JSON boundaries. Persist an idempotent outbox row in the same
  // transaction as the terminal decision so a crash can never leave tickets
  // parked on_review with no legal action left to replay.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rail_pr_ticket_effects (
        delivery_id        TEXT PRIMARY KEY,
        ticket_ids         TEXT NOT NULL,
        causal_owners      TEXT NOT NULL DEFAULT '{}',
        applied_ticket_ids TEXT,
        target_status      TEXT NOT NULL CHECK (target_status IN ('todo', 'done')),
        jira_action        TEXT NOT NULL CHECK (jira_action IN ('discard', 'merged', 'completed', 'refine', 'backlog')),
        pr_url             TEXT,
        attempts           INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        tickets_applied_at TEXT,
        jira_enqueued_at   TEXT,
        completed_at       TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rail_pr_ticket_effects_pending
        ON rail_pr_ticket_effects(completed_at)
        WHERE completed_at IS NULL;
    `)

    // Keep the migration restart-safe for development DBs that may have run an
    // earlier migration-50 draft before these phase columns were added. Shipped
    // migrations remain atomic, but additive guards make local upgrade testing
    // deterministic as well.
    const effectCols = new Set(
      (db.prepare(`PRAGMA table_info(rail_pr_ticket_effects)`).all() as { name: string }[])
        .map((row) => row.name),
    )
    if (!effectCols.has('applied_ticket_ids')) {
      db.exec(`ALTER TABLE rail_pr_ticket_effects ADD COLUMN applied_ticket_ids TEXT`)
    }
    if (!effectCols.has('tickets_applied_at')) {
      db.exec(`ALTER TABLE rail_pr_ticket_effects ADD COLUMN tickets_applied_at TEXT`)
    }
    if (!effectCols.has('jira_enqueued_at')) {
      db.exec(`ALTER TABLE rail_pr_ticket_effects ADD COLUMN jira_enqueued_at TEXT`)
    }
    if (!effectCols.has('causal_owners')) {
      db.exec(`ALTER TABLE rail_pr_ticket_effects ADD COLUMN causal_owners TEXT NOT NULL DEFAULT '{}'`)
    }
  },

  // Migration 51: a development build briefly shipped migration 50 without
  // phase columns and with a CHECK that allowed only discard/merged. A DB that
  // already records version 50 will never rerun its edited body, so rebuild the
  // table once, preserve every row, and install the complete action contract.
  // Migration 52 owns the causal historical backfill after both schemas exist.
  (db) => {
    const table = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'rail_pr_ticket_effects'
    `).get() as { sql: string | null } | undefined

    const createFullTable = (name: string): void => {
      db.exec(`
        CREATE TABLE ${name} (
          delivery_id        TEXT PRIMARY KEY,
          ticket_ids         TEXT NOT NULL,
          causal_owners      TEXT NOT NULL DEFAULT '{}',
          applied_ticket_ids TEXT,
          target_status      TEXT NOT NULL CHECK (target_status IN ('todo', 'done')),
          jira_action        TEXT NOT NULL CHECK (jira_action IN ('discard', 'merged', 'completed', 'refine', 'backlog')),
          pr_url             TEXT,
          attempts           INTEGER NOT NULL DEFAULT 0,
          last_error         TEXT,
          tickets_applied_at TEXT,
          jira_enqueued_at   TEXT,
          completed_at       TEXT,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }

    if (!table) {
      createFullTable('rail_pr_ticket_effects')
    } else {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(rail_pr_ticket_effects)`).all() as { name: string }[])
          .map((row) => row.name),
      )
      const sql = table.sql ?? ''
      const complete = ['causal_owners', 'applied_ticket_ids', 'tickets_applied_at', 'jira_enqueued_at']
        .every((column) => cols.has(column)) &&
        ['completed', 'refine', 'backlog'].every((action) => sql.includes(`'${action}'`))

      if (!complete) {
        db.exec(`DROP TABLE IF EXISTS rail_pr_ticket_effects_v51`)
        createFullTable('rail_pr_ticket_effects_v51')
        const value = (column: string, fallback: string): string => cols.has(column) ? column : fallback
        db.exec(`
          INSERT INTO rail_pr_ticket_effects_v51 (
            delivery_id, ticket_ids, causal_owners, applied_ticket_ids, target_status,
            jira_action, pr_url, attempts, last_error, tickets_applied_at,
            jira_enqueued_at, completed_at, created_at, updated_at
          )
          SELECT
            ${value('delivery_id', "''")},
            ${value('ticket_ids', "'[]'")},
            ${value('causal_owners', "'{}'")},
            ${value('applied_ticket_ids', 'NULL')},
            ${value('target_status', "'todo'")},
            ${value('jira_action', "'backlog'")},
            ${value('pr_url', 'NULL')},
            ${value('attempts', '0')},
            ${value('last_error', 'NULL')},
            ${value('tickets_applied_at', 'NULL')},
            ${value('jira_enqueued_at', 'NULL')},
            ${value('completed_at', 'NULL')},
            ${value('created_at', "datetime('now')")},
            ${value('updated_at', "datetime('now')")}
          FROM rail_pr_ticket_effects;

          DROP TABLE rail_pr_ticket_effects;
          ALTER TABLE rail_pr_ticket_effects_v51 RENAME TO rail_pr_ticket_effects;
        `)
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rail_pr_ticket_effects_pending
        ON rail_pr_ticket_effects(completed_at)
        WHERE completed_at IS NULL
    `)
  },

  // Migration 52: bind every ticket effect to the SQLite ticket-generation
  // owner that created it. Historical terminal rows are backfilled only when
  // their run_ids still own the ticket; an old merge/discard can therefore
  // never mutate a newer iteration merely because it is also on_review.
  (db) => {
    // Some development builds recorded migration 45 before its ownership
    // table was added. Repair that incomplete historical shape before the
    // causal backfill so one damaged project DB cannot prevent app startup.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_outcome_ownership (
        ticket_id   INTEGER PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        generation  INTEGER NOT NULL DEFAULT 1,
        claimed_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_outcome_owner
        ON ticket_outcome_ownership(owner_id);
    `)
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(rail_pr_ticket_effects)`).all() as { name: string }[])
        .map((row) => row.name),
    )
    if (!cols.has('causal_owners')) {
      db.exec(`ALTER TABLE rail_pr_ticket_effects ADD COLUMN causal_owners TEXT NOT NULL DEFAULT '{}'`)
    }
    backfillTerminalRailPrTicketEffects(db)
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

  // Orphan sweep: cancel any in-flight proposals from a previous server session
  db.prepare(
    "UPDATE proposals SET status = 'cancelled', updated_at = ? WHERE status IN ('exploring', 'refining')"
  ).run(new Date().toISOString())

  return db
}

export function createJob(db: DbInstance, job: NewJob): void {
  // Promotion is atomic: after a crash the job is either still replayable in
  // queued_jobs or is a running jobs row, never absent from both. INSERT OR
  // IGNORE preserves idempotency for legacy/restored jobs that already exist.
  const promote = db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO jobs (id, command, started_at, status, provider, owner, priority, depends_on_job_id, pipeline_id, interactive, causal_ownership) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(job.id, job.command, job.started_at, 'running', job.provider ?? null, job.owner ?? 'queue', job.priority ?? 'normal', job.depends_on_job_id ?? null, job.pipeline_id ?? null, job.interactive ? 1 : 0, job.causal_ownership ? 1 : 0)
    db.prepare(
      'UPDATE jobs SET status = ?, started_at = ?, provider = ?, owner = ?, interactive = ?, causal_ownership = ? WHERE id = ?'
    ).run('running', job.started_at, job.provider ?? null, job.owner ?? 'queue', job.interactive ? 1 : 0, job.causal_ownership ? 1 : 0, job.id)
    db.prepare('DELETE FROM queued_jobs WHERE id = ?').run(job.id)
  })
  promote()
}

/** Idempotently persist a job that has been admitted but has not started. */
export function upsertQueuedJob(db: DbInstance, job: QueuedJobRecord): void {
  db.prepare(`
    INSERT INTO queued_jobs (
      id, command, queue_position, priority, depends_on_job_id, pipeline_id,
      provider, model, profile_name, profile_selection_set, interactive,
      causal_ownership
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      command = excluded.command,
      queue_position = excluded.queue_position,
      priority = excluded.priority,
      depends_on_job_id = excluded.depends_on_job_id,
      pipeline_id = excluded.pipeline_id,
      provider = excluded.provider,
      model = excluded.model,
      profile_name = excluded.profile_name,
      profile_selection_set = excluded.profile_selection_set,
      interactive = excluded.interactive,
      causal_ownership = excluded.causal_ownership
  `).run(
    job.id,
    job.command,
    job.queue_position,
    job.priority,
    job.depends_on_job_id ?? null,
    job.pipeline_id ?? null,
    job.provider ?? null,
    job.model ?? null,
    job.profile_name ?? null,
    job.profile_selection_set ? 1 : 0,
    job.interactive == null ? null : (job.interactive ? 1 : 0),
    job.causal_ownership ? 1 : 0,
  )
}

/** Remove a queued admission after cancellation/skip. Idempotent.
 *
 * Migration 43 deliberately keeps a read fallback for pre-migration builds
 * that represented queued work in `jobs`. Remove that legacy representation
 * too, but only while it is still queued: promotion changes the status to
 * running before calling this helper, and terminal history must never be
 * deleted here. */
export function deleteQueuedJob(db: DbInstance, jobId: string): void {
  db.prepare('DELETE FROM queued_jobs WHERE id = ?').run(jobId)
  db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'queued'").run(jobId)
}

/**
 * Flip a job row's `interactive` flag AFTER creation. Used by the loop engine
 * when an ai-step upgrades the run's backing job to a resident interactive
 * session — the row was created at run start (before the step's provider
 * capability/kill-switch gate is consulted), so the flag lands lazily at the
 * first interactive step spawn. Idempotent.
 */
export function markJobInteractive(db: DbInstance, jobId: string): void {
  db.prepare('UPDATE jobs SET interactive = 1 WHERE id = ?').run(jobId)
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

export class JobRecoveryPendingError extends Error {
  constructor(public readonly jobId: string) {
    super('Job recovery is still pending; retry deletion after recovery completes')
    this.name = 'JobRecoveryPendingError'
  }
}

export function deleteJob(db: DbInstance, jobId: string): void {
  // M7: jobs.depends_on_job_id REFERENCES jobs(id) with no ON DELETE action and
  // foreign_keys=ON, so deleting a pipeline parent throws 'FOREIGN KEY
  // constraint failed' and the job becomes undeletable from the UI. Clear inbound
  // references first, in the same transaction as the delete, so it always
  // succeeds (children keep running; they just lose the now-irrelevant pointer).
  const tx = db.transaction((id: string) => {
    const pendingLoopStep = db.prepare(`SELECT 1 FROM loop_step_recovery WHERE run_id = ? LIMIT 1`).get(id)
    const pendingQueueRecovery = db.prepare(
      `SELECT 1 FROM orphan_job_recovery WHERE job_id = ? LIMIT 1`,
    ).get(id)
    if (pendingLoopStep || pendingQueueRecovery) {
      throw new JobRecoveryPendingError(id)
    }
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
  const conditions: string[] = [
    "status IN ('completed', 'failed', 'canceled', 'zombie_terminated', 'skipped')",
    'NOT EXISTS (SELECT 1 FROM loop_step_recovery WHERE loop_step_recovery.run_id = jobs.id)',
    'NOT EXISTS (SELECT 1 FROM orphan_job_recovery WHERE orphan_job_recovery.job_id = jobs.id)',
  ]
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
 * Default pre-prompt used by Freestyle (Claude-only rails) when the project
 * has no per-project override. Freestyle skips the OpenSpec pipeline entirely:
 * it hands Claude the spec text plus this instruction and lets it work
 * autonomously end-to-end.
 */
export const DEFAULT_FREESTYLE_PRE_PROMPT = [
  'You are operating in FREESTYLE: fully autonomous, end-to-end implementation.',
  'Implement the following spec COMPLETELY in this repository. You have full access to the codebase and tools.',
  'Work independently until the feature is done: write the code, the tests, update docs as needed, and make sure everything builds and the test suite passes.',
  'Do NOT follow any structured architect/developer/reviewer pipeline — use your own judgement and the repo conventions.',
  'Never ask for confirmation; there is no human to answer. Choose the recommended option and proceed.',
].join('\n')

export interface ProjectSettings {
  pipelineTelemetryEnabled: boolean
  orchestratorModel: string
  prePrompt: string
  /** Per-project Freestyle pre-prompt override. Empty string = use
   *  DEFAULT_FREESTYLE_PRE_PROMPT at spawn time. */
  freestylePrePrompt: string
  /** Designated integration branch that mutating loops branch worktrees from and
   *  target draft PRs at. Empty string = auto-resolve (repo default → HEAD) via
   *  `resolveIntegrationBranch`. */
  integrationBranch: string
  /** Environment variable names to explicitly pass through to project jobs and
   *  isolated loop worktrees. Values are read from the server process env at
   *  spawn time and are never stored in SQLite. */
  worktreeEnvPassthrough: string[]
}

export const WORKTREE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WORKTREE_ENV_MAX_NAMES = 64
const WORKTREE_ENV_MAX_NAME_LENGTH = 128

export function normalizeWorktreeEnvPassthrough(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('worktreeEnvPassthrough must be an array of environment variable names')
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('worktreeEnvPassthrough entries must be strings')
    const name = raw.trim()
    if (!name) continue
    if (name.length > WORKTREE_ENV_MAX_NAME_LENGTH) throw new Error(`environment variable name is too long: ${name.slice(0, 24)}...`)
    if (!WORKTREE_ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name: ${name}`)
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length > WORKTREE_ENV_MAX_NAMES) throw new Error(`worktreeEnvPassthrough can contain at most ${WORKTREE_ENV_MAX_NAMES} names`)
  }
  return out
}

function parseWorktreeEnvPassthrough(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    return normalizeWorktreeEnvPassthrough(JSON.parse(raw))
  } catch {
    return []
  }
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
  const freestylePrePromptRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.freestyle_pre_prompt'`
  ).get() as { value: string } | undefined
  const integrationBranchRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.integration_branch'`
  ).get() as { value: string } | undefined
  const worktreeEnvPassthroughRow = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.worktree_env_passthrough'`
  ).get() as { value: string } | undefined
  return {
    pipelineTelemetryEnabled: telemetryRow?.value === 'true',
    orchestratorModel: modelRow?.value ?? 'sonnet',
    prePrompt: prePromptRow?.value ?? '',
    freestylePrePrompt: freestylePrePromptRow?.value ?? '',
    integrationBranch: integrationBranchRow?.value ?? '',
    worktreeEnvPassthrough: parseWorktreeEnvPassthrough(worktreeEnvPassthroughRow?.value),
  }
}

/** Resolve the effective Freestyle pre-prompt: the per-project override when
 *  set, otherwise the built-in default. */
export function getFreestylePrePrompt(db: DbInstance): string {
  const override = getProjectSettings(db).freestylePrePrompt.trim()
  return override || DEFAULT_FREESTYLE_PRE_PROMPT
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
  if (patch.freestylePrePrompt !== undefined) {
    if (patch.freestylePrePrompt.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.freestyle_pre_prompt'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.freestyle_pre_prompt', ?)`
      ).run(patch.freestylePrePrompt)
    }
  }
  if (patch.integrationBranch !== undefined) {
    if (patch.integrationBranch.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.integration_branch'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.integration_branch', ?)`
      ).run(patch.integrationBranch.trim())
    }
  }
  if (patch.worktreeEnvPassthrough !== undefined) {
    const names = normalizeWorktreeEnvPassthrough(patch.worktreeEnvPassthrough)
    if (names.length === 0) {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.worktree_env_passthrough'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.worktree_env_passthrough', ?)`
      ).run(JSON.stringify(names))
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
