import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'
import type { DbInstance } from './db'
import type { ProviderId } from './providers/types'
import { secureDir, secureDbFile } from './util/secure-fs'

// ─── Types ────────────────────────────────────────────────────────────────────

// Provider id for a project. Open by design: the set of valid ids is owned by
// the provider registry (`server/providers`), not this union — adding a provider
// is one adapter file + one `register()` call, with no type edit here. Runtime
// validation of an actual value goes through `hasAdapter` / `validateRequestedProvider`.
export type CliProvider = ProviderId

export interface ProjectRow {
  id: string
  slug: string
  name: string
  path: string
  db_path: string
  /** Primary / default provider. Single source for single-provider projects and
   *  the fallback when a per-invocation provider override is not supplied. */
  provider: CliProvider
  /** All providers installed for this project. Always contains at least
   *  `provider`. When length === 1 every feature behaves exactly as a
   *  single-provider project. Stored as a JSON array in the `providers` column. */
  providers: CliProvider[]
  added_at: string
  last_seen_at: string
}

/** Raw row shape as SQLite returns it (`providers` is the JSON TEXT column). */
interface ProjectRowRaw extends Omit<ProjectRow, 'providers'> {
  providers: string | null
}

function parseProviders(raw: string | null | undefined, primary: CliProvider): CliProvider[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
        return parsed as CliProvider[]
      }
    } catch {
      /* fall through to single-provider fallback */
    }
  }
  return [primary]
}

function mapProjectRow(raw: ProjectRowRaw | undefined): ProjectRow | undefined {
  if (!raw) return undefined
  const provider = (raw.provider ?? 'claude') as CliProvider
  return { ...raw, provider, providers: parseProviders(raw.providers, provider) }
}

export type AgentStatus = 'idle' | 'busy' | 'offline'

export interface AgentRow {
  id: string
  slug: string
  name: string
  role: string | null
  status: AgentStatus
  current_job_id: string | null
  last_heartbeat_at: string | null
  config: string | null
  created_at: string
}

// ─── Desktop DB path ──────────────────────────────────────────────────────────

export function getDesktopDbPath(): string {
  return path.join(os.homedir(), '.specrails', 'desktop.sqlite')
}

/**
 * Rebrand migration (Specrails Hub → Specrails Desktop): when the legacy
 * `hub.sqlite` exists next to the requested `desktop.sqlite` and the new file
 * does not exist yet, rename it (plus any `-wal`/`-shm` siblings) so user data
 * is preserved across the rename. Legacy filename allowed here only —
 * migration/compat code.
 */
function migrateLegacyDbFile(dbPath: string): void {
  if (dbPath === ':memory:') return
  if (path.basename(dbPath) !== 'desktop.sqlite') return
  const legacyPath = path.join(path.dirname(dbPath), 'hub.sqlite') // legacy (pre-rebrand) filename
  try {
    if (fs.existsSync(legacyPath) && !fs.existsSync(dbPath)) {
      // BUG-SQLITE-05: rename the -wal/-shm sidecars BEFORE the main DB file.
      // SQLite matches a WAL to its database by base filename; if the main file
      // is renamed first, a crash in the (sub-ms) window between renames leaves
      // `desktop.sqlite` with no adjacent WAL -> un-checkpointed commits in the
      // orphaned `hub.sqlite-wal` are silently discarded on next open. Moving the
      // sidecars first means an interrupted migration leaves the WAL/SHM still
      // matched to the legacy main file (the new file does not exist yet, so the
      // guard above re-runs the whole migration on the next launch).
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(legacyPath + suffix)) {
          fs.renameSync(legacyPath + suffix, dbPath + suffix)
        }
      }
      fs.renameSync(legacyPath, dbPath)
    }
  } catch (err) {
    console.warn('[desktop-db] could not migrate legacy hub.sqlite:', err)
  }
}

function getProjectDbPath(slug: string): string {
  return path.join(os.homedir(), '.specrails', 'projects', slug, 'jobs.sqlite')
}

// ─── Schema migrations ────────────────────────────────────────────────────────

// NOTE: existing migrations below intentionally keep the legacy `hub_settings`
// table name — they are append-only history and must stay byte-identical for
// already-migrated databases. Migration 13 renames the table to
// `desktop_settings`; fresh databases run 1→13 in order and converge on the
// new name. Legacy identifiers allowed here only — migration/compat code.
function applyDesktopMigrations(db: DbInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version)
  )

  const migrations: Array<() => void> = [
    // Migration 1: projects and hub_settings tables
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id           TEXT PRIMARY KEY,
          slug         TEXT NOT NULL UNIQUE,
          name         TEXT NOT NULL,
          path         TEXT NOT NULL UNIQUE,
          db_path      TEXT NOT NULL,
          added_at     TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
        CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

        CREATE TABLE IF NOT EXISTS hub_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    },
    // Migration 2: agents table
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id                 TEXT PRIMARY KEY,
          slug               TEXT NOT NULL UNIQUE,
          name               TEXT NOT NULL,
          role               TEXT,
          status             TEXT NOT NULL DEFAULT 'idle',
          current_job_id     TEXT,
          last_heartbeat_at  TEXT,
          config             TEXT,
          created_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug);
        CREATE INDEX IF NOT EXISTS idx_agents_current_job_id ON agents(current_job_id);
      `)
    },
    // Migration 3: add provider column to projects
    () => {
      db.exec(`ALTER TABLE projects ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`)
    },
    // Migration 4: webhooks table
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id         TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          url        TEXT NOT NULL,
          secret     TEXT NOT NULL DEFAULT '',
          events     TEXT NOT NULL DEFAULT '["job.completed","job.failed"]',
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_webhooks_project_id ON webhooks(project_id);
      `)
    },
    // Migration 5: seed terminal-settings defaults under reserved settings keys.
    // Idempotent — uses INSERT OR IGNORE so re-running never overwrites a user's
    // chosen value. See server/terminal-settings.ts for the typed access layer.
    () => {
      const seed = db.prepare('INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)')
      seed.run('terminal.fontFamily', "'DM Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace")
      seed.run('terminal.fontSize', '12')
      seed.run('terminal.renderMode', 'auto')
      seed.run('terminal.copyOnSelect', 'false')
      seed.run('terminal.shellIntegrationEnabled', 'true')
      seed.run('terminal.notifyOnCompletion', 'true')
      seed.run('terminal.imageRendering', 'true')
      seed.run('terminal.longCommandThresholdMs', '60000')
    },
    // Migration 6: seed browserShortcutUrl default for the new Browser shortcut button.
    () => {
      db.prepare('INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)').run(
        'terminal.browserShortcutUrl', 'https://specrails.dev',
      )
    },
    // Migration 7: seed quickScript default for the Quick Script shortcut button.
    // Uses the OS username so the default greets you by name.
    () => {
      let username = 'friend'
      try { username = os.userInfo().username || 'friend' } catch { /* keep fallback */ }
      const value = `echo "Wake up, ${username} (edit this snippet in settings to help your local development)"`
      db.prepare('INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)').run(
        'terminal.quickScript', value,
      )
    },
    // Migration 8: seed default ui_theme for the app-wide theme system.
    // Allow-list enforced at the route layer (server/desktop-router.ts) and the
    // client (client/src/lib/themes.ts).
    () => {
      db.prepare('INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)').run(
        'ui_theme', 'specrails',
      )
    },
    // Migration 9: seed code-explorer app settings — summary language + monthly
    // budget cap. Enforced by FileSummaryManager + desktop-router.
    () => {
      const seed = db.prepare('INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)')
      seed.run('summary_language', 'en')
      seed.run('summary_monthly_budget_usd', '5.00')
    },
    // Migration 10: multi-provider per project. Add a `providers` JSON-array
    // column alongside the existing primary `provider` column and backfill it
    // from the current single provider so legacy projects become
    // providers=["<provider>"] (length 1 → behaves exactly as before).
    () => {
      db.exec(`ALTER TABLE projects ADD COLUMN providers TEXT NOT NULL DEFAULT '[]'`)
      db.exec(`UPDATE projects SET providers = json_array(provider) WHERE providers IS NULL OR providers = '[]'`)
    },
    // Migration 11: self-heal the `providers` column. An earlier WIP of the
    // multi-provider feature also numbered a migration #10 but used different
    // column names (`installed_engines` / `default_engine`). On a DB that ran
    // that variant, version 10 is already recorded so Migration 10 above is
    // skipped and `providers` is missing — addProject's INSERT then fails. This
    // higher-numbered migration is guarded by a column check so it is a no-op on
    // fresh DBs (where #10 already added the column) and repairs the orphaned-
    // WIP DBs, backfilling from `installed_engines` when present else `provider`.
    () => {
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
      if (!cols.includes('providers')) {
        db.exec(`ALTER TABLE projects ADD COLUMN providers TEXT NOT NULL DEFAULT '[]'`)
      }
      const hasInstalledEngines = cols.includes('installed_engines')
      const rows = db.prepare(
        `SELECT id, provider, providers${hasInstalledEngines ? ', installed_engines' : ''} FROM projects`,
      ).all() as { id: string; provider: string | null; providers: string | null; installed_engines?: string | null }[]
      const upd = db.prepare('UPDATE projects SET providers = ? WHERE id = ?')
      for (const r of rows) {
        if (r.providers && r.providers !== '[]') continue
        let value: string | null = null
        if (hasInstalledEngines && r.installed_engines) {
          try {
            const parsed = JSON.parse(r.installed_engines)
            if (Array.isArray(parsed) && parsed.length > 0) value = JSON.stringify(parsed)
          } catch {
            /* fall through to provider-based backfill */
          }
        }
        if (!value) value = JSON.stringify([r.provider ?? 'claude'])
        upd.run(value, r.id)
      }
    },
    // Migration 12: mobile companion devices. Each paired phone/tablet gets a
    // hashed per-device bearer token (never the master server token), scoped to
    // `companion`, bound to the gateway cert fingerprint active at pair time
    // (rotating the cert revokes every device), with a sliding-expiry last_seen
    // and a one-tap revoke (revoked_at). See server/mobile/* for the gateway.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mobile_devices (
          id               TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          platform         TEXT NOT NULL,
          token_hash       TEXT NOT NULL,
          scopes           TEXT NOT NULL DEFAULT 'companion',
          cert_fingerprint TEXT NOT NULL,
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at     TEXT,
          last_ip          TEXT,
          revoked_at       TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_mobile_devices_token ON mobile_devices(token_hash);
      `)
    },
    // Migration 13: Specrails Hub → Specrails Desktop rebrand. Renames the
    // legacy `hub_settings` table to `desktop_settings` (guard: skip if a
    // future code path ever created `desktop_settings` directly), migrates the
    // `hub_daily_budget_usd` settings key to `desktop_daily_budget_usd`, and
    // rewrites stored webhook event subscriptions from
    // `hub_daily_budget_exceeded` to `desktop_daily_budget_exceeded`.
    // Legacy identifiers allowed here only — migration/compat code.
    () => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((t) => t.name)
      if (tables.includes('hub_settings') && !tables.includes('desktop_settings')) {
        db.exec('ALTER TABLE hub_settings RENAME TO desktop_settings')
      }
      db.prepare(
        "UPDATE OR IGNORE desktop_settings SET key = 'desktop_daily_budget_usd' WHERE key = 'hub_daily_budget_usd'"
      ).run()
      const hooks = db.prepare(
        "SELECT id, events FROM webhooks WHERE events LIKE '%hub_daily_budget_exceeded%'"
      ).all() as { id: string; events: string }[]
      const upd = db.prepare('UPDATE webhooks SET events = ? WHERE id = ?')
      for (const h of hooks) {
        upd.run(h.events.split('hub_daily_budget_exceeded').join('desktop_daily_budget_exceeded'), h.id)
      }
    },
    // Migration 14: loops — global, cross-project library of visual automation
    // loop definitions (the Loops feature). Stored app-level (NOT per-project):
    // a loop is a reusable recipe used from any project's rail. `graph` is the
    // JSON node-graph (see server/loop-graph.ts); `status` is the Draft/Published
    // lifecycle. "Running" is NOT stored here — it is derived from active
    // per-project loop_runs at query time.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS loops (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          status      TEXT NOT NULL DEFAULT 'draft',
          graph       TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status);
      `)
    },
    // 15: global, cross-loop constants library. Draggable into loop steps as
    // `{{const:NAME}}` tokens, resolved at run time by the engine. Shared by every
    // loop (like the loops table itself); built-in sentinels live in code, not here.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS loop_constants (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          value      TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
    },
    // 16: seed a few EDITABLE starter constants so the library isn't bare — common
    // loop-authoring conventions the user can edit or delete (templates don't
    // auto-use them; only the read-only VERIFICATION_PASS/FAIL built-ins are wired
    // into templates). Runs once: deleting a seed is permanent (migration won't
    // re-insert). INSERT OR IGNORE so a pre-existing same-name user constant wins.
    () => {
      db.exec(`
        INSERT OR IGNORE INTO loop_constants (id, name, value) VALUES
          ('seed-main-branch',  'MAIN_BRANCH',  'main'),
          ('seed-pkg-manager',  'PKG_MANAGER',  'npm'),
          ('seed-min-coverage', 'MIN_COVERAGE', '80');
      `)
    },
    // 17: app-global agent chat (design D2). The agent chat lives ABOVE projects,
    // so its conversations are stored in the app registry DB (not any per-project
    // jobs.sqlite). `pinned_project_id` records the Cursor-style selector target
    // (NULL = Home / app-global); `tier_level` records the Shift+Tab ladder.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
          id                TEXT PRIMARY KEY,
          title             TEXT,
          provider          TEXT NOT NULL DEFAULT 'claude',
          model             TEXT,
          session_id        TEXT,
          pinned_project_id TEXT,
          tier_level        INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_messages (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          role            TEXT NOT NULL,
          content         TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id, created_at);
      `)
    },
    // 18: persist the per-turn attachment id list on user messages so historical
    // agent turns re-render pills/thumbnails after refresh (design D20). Nullable
    // JSON array of attachment ids; NULL/absent = text-only turn (all old rows).
    () => {
      db.exec(`ALTER TABLE agent_messages ADD COLUMN attachment_ids TEXT;`)
    },
    // 19: per-conversation reasoning effort for agent spawns. NULL = the app
    // default ("medium"); validated against the provider's effort catalog at the
    // router (claude: low…xhigh, codex: minimal…high, gemini: none).
    () => {
      db.exec(`ALTER TABLE agent_conversations ADD COLUMN reasoning_effort TEXT;`)
    },
    // 20: agent-chat cost accounting (COST-ACCOUNTING-AUDIT HIGH-3). The Desktop
    // Agent Chat / Mission Control operator turns are billable app-driving AI
    // invocations, but they live ABOVE projects (desktop.sqlite) so there was
    // nowhere to record them — the per-project `ai_invocations` table (in each
    // jobs.sqlite) does not fit an app-global turn. This mirrors ai_invocations'
    // columns but keeps `project_id` NULLABLE (the pinned project id when one is
    // set at turn time, else NULL for Home / app-global) and fixes
    // `surface = 'agent-chat'`. One row per agent-chat turn (all providers), cost
    // native-or-estimated via finaliseInvocationResult.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_invocations (
          id                       TEXT    PRIMARY KEY,
          conversation_id          TEXT,
          project_id               TEXT,
          provider                 TEXT,
          surface                  TEXT    NOT NULL DEFAULT 'agent-chat',
          model                    TEXT,
          status                   TEXT    NOT NULL,
          started_at               TEXT    NOT NULL,
          finished_at              TEXT,
          duration_ms              INTEGER,
          duration_api_ms          INTEGER,
          tokens_in                INTEGER,
          tokens_out               INTEGER,
          tokens_cache_read        INTEGER,
          tokens_cache_create      INTEGER,
          total_cost_usd           REAL,
          total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0,
          num_turns                INTEGER,
          session_id               TEXT,
          created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_agent_inv_started ON agent_invocations(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_inv_conv ON agent_invocations(conversation_id);
      `)
    },
    // 21: structured context refs selected in the Agent Composer (`@`, `#`, `/`,
    // and the `+` palette). Persisted with the user row so conversation bubbles
    // can re-render exact chips after refresh without guessing from text.
    () => {
      db.exec(`ALTER TABLE agent_messages ADD COLUMN context_refs TEXT;`)
    },
    // 22: Project Builder day-0 conversations (add-project-builder D1). The
    // Builder runs BEFORE any project exists, so its conversations live in the
    // app registry DB — same shape as agent_conversations but a separate pair
    // of tables: the Builder has no tier ladder and no pinned project, and its
    // lifecycle (discarded after commit or abandoned) should never mix with
    // agent-chat history.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blueprint_conversations (
          id         TEXT PRIMARY KEY,
          title      TEXT,
          provider   TEXT NOT NULL DEFAULT 'claude',
          model      TEXT,
          session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS blueprint_messages (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES blueprint_conversations(id) ON DELETE CASCADE,
          role            TEXT NOT NULL,
          content         TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_blueprint_messages_conv ON blueprint_messages(conversation_id, created_at);
      `)
    },
  ]

  for (let i = 0; i < migrations.length; i++) {
    const version = i + 1
    if (!appliedVersions.has(version)) {
      // Run each migration body and its version INSERT atomically (mirrors
      // db.ts applyMigrations). SQLite DDL is transactional, so a crash/failure
      // mid-migration rolls back the whole body instead of leaving a half-applied
      // schema with the version unrecorded — which previously re-ran a bare
      // `ALTER TABLE ADD COLUMN` on next startup and bricked app launch forever
      // with 'duplicate column name'.
      const tx = db.transaction(() => {
        migrations[i]()
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version)
      })
      tx()
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initDesktopDb(dbPath: string = getDesktopDbPath()): DbInstance {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  if (dbPath !== ':memory:') secureDir(dir) // H-13: owner-only ~/.specrails

  // Rebrand compat: pick up a pre-rename hub.sqlite before opening.
  migrateLegacyDbFile(dbPath)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Wait up to 5s on a lock instead of throwing SQLITE_BUSY, and cap the WAL.
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_size_limit = 10000000') // ~10 MB

  applyDesktopMigrations(db)

  // H-13: desktop.sqlite stores webhook HMAC secrets in plaintext — restrict it
  // (and its WAL sidecars) to owner read/write.
  if (dbPath !== ':memory:') secureDbFile(dbPath)
  return db
}

export function listProjects(db: DbInstance): ProjectRow[] {
  return (db.prepare(
    'SELECT * FROM projects ORDER BY added_at ASC'
  ).all() as ProjectRowRaw[]).map((r) => mapProjectRow(r)!)
}

export function getProject(db: DbInstance, id: string): ProjectRow | undefined {
  return mapProjectRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRowRaw | undefined)
}

export function getProjectBySlug(db: DbInstance, slug: string): ProjectRow | undefined {
  return mapProjectRow(db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRowRaw | undefined)
}

export function getProjectByPath(db: DbInstance, projectPath: string): ProjectRow | undefined {
  return mapProjectRow(db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath) as ProjectRowRaw | undefined)
}

export function addProject(
  db: DbInstance,
  project: {
    id: string
    slug: string
    name: string
    path: string
    provider?: CliProvider
    providers?: CliProvider[]
  }
): ProjectRow {
  const dbPath = getProjectDbPath(project.slug)
  const providers =
    project.providers && project.providers.length > 0
      ? project.providers
      : [project.provider ?? 'claude']
  // Primary provider = explicit override, else the first selected provider.
  const provider = project.provider ?? providers[0]
  db.prepare(`
    INSERT INTO projects (id, slug, name, path, db_path, provider, providers)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(project.id, project.slug, project.name, project.path, dbPath, provider, JSON.stringify(providers))
  return getProject(db, project.id) as ProjectRow
}

export function removeProject(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  // No FK on agent_conversations.pinned_project_id — unpin so orphaned agent
  // conversations fold into Home instead of dangling on a dead project id.
  db.prepare('UPDATE agent_conversations SET pinned_project_id = NULL WHERE pinned_project_id = ?').run(id)
}

export function touchProject(db: DbInstance, id: string): void {
  db.prepare(
    "UPDATE projects SET last_seen_at = datetime('now') WHERE id = ?"
  ).run(id)
}

export function getDesktopSetting(db: DbInstance, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM desktop_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setDesktopSetting(db: DbInstance, key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO desktop_settings (key, value) VALUES (?, ?)'
  ).run(key, value)
}

// ─── Setup session persistence ────────────────────────────────────────────────

export function setProjectSetupSession(db: DbInstance, projectId: string, sessionId: string): void {
  setDesktopSetting(db, `setup_session:${projectId}`, sessionId)
}

export function getProjectSetupSession(db: DbInstance, projectId: string): string | undefined {
  return getDesktopSetting(db, `setup_session:${projectId}`)
}

export function clearProjectSetupSession(db: DbInstance, projectId: string): void {
  db.prepare('DELETE FROM desktop_settings WHERE key = ?').run(`setup_session:${projectId}`)
}

// ─── Agent-chat invocations (cost accounting, HIGH-3) ───────────────────────────

export type AgentInvocationStatus = 'success' | 'failed' | 'aborted'

/** One agent-chat turn's billable accounting. App-global — `project_id` is the
 *  pinned project id when the turn ran project-scoped, else NULL (Home). Cost is
 *  native when the provider reports it, else estimated (from the pricing table);
 *  `total_cost_usd_estimated` flags which. */
export interface AgentInvocationInput {
  id: string
  conversation_id: string
  project_id?: string | null
  provider: string
  model?: string | null
  status: AgentInvocationStatus
  started_at: string
  finished_at?: string | null
  duration_ms?: number | null
  duration_api_ms?: number | null
  tokens_in?: number | null
  tokens_out?: number | null
  tokens_cache_read?: number | null
  tokens_cache_create?: number | null
  total_cost_usd?: number | null
  total_cost_usd_estimated?: boolean
  num_turns?: number | null
  session_id?: string | null
}

export interface AgentInvocationRow {
  id: string
  conversation_id: string | null
  project_id: string | null
  provider: string | null
  surface: string
  model: string | null
  status: AgentInvocationStatus
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  duration_api_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_create: number | null
  total_cost_usd: number | null
  total_cost_usd_estimated: number
  num_turns: number | null
  session_id: string | null
  created_at: string
}

export function recordAgentInvocation(db: DbInstance, input: AgentInvocationInput): void {
  db.prepare(`
    INSERT INTO agent_invocations (
      id, conversation_id, project_id, provider, surface, model, status,
      started_at, finished_at, duration_ms, duration_api_ms,
      tokens_in, tokens_out, tokens_cache_read, tokens_cache_create,
      total_cost_usd, total_cost_usd_estimated, num_turns, session_id
    ) VALUES (?, ?, ?, ?, 'agent-chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.conversation_id,
    input.project_id ?? null,
    input.provider,
    input.model ?? null,
    input.status,
    input.started_at,
    input.finished_at ?? null,
    input.duration_ms ?? null,
    input.duration_api_ms ?? null,
    input.tokens_in ?? null,
    input.tokens_out ?? null,
    input.tokens_cache_read ?? null,
    input.tokens_cache_create ?? null,
    input.total_cost_usd ?? null,
    input.total_cost_usd_estimated ? 1 : 0,
    input.num_turns ?? null,
    input.session_id ?? null,
  )
}

/**
 * Sum of all agent-chat turn costs, optionally since an ISO instant (inclusive).
 * Read helper for the analytics package so app-level surfaces (HOME, StatusBar,
 * exports) can include the previously-invisible orchestration spend. NULL costs
 * (a spawn-fail / no-usage turn) contribute 0.
 */
export function sumAgentInvocationsCost(db: DbInstance, sinceIso?: string): number {
  const row = (sinceIso
    ? db.prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM agent_invocations WHERE started_at >= ?'
      ).get(sinceIso)
    : db.prepare('SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM agent_invocations').get()
  ) as { total: number }
  return row.total
}

// ─── Agent CRUD ───────────────────────────────────────────────────────────────

export function listAgents(db: DbInstance): AgentRow[] {
  return db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[]
}

export function getAgent(db: DbInstance, id: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
}

export function getAgentBySlug(db: DbInstance, slug: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE slug = ?').get(slug) as AgentRow | undefined
}

export function addAgent(
  db: DbInstance,
  agent: { id: string; slug: string; name: string; role?: string; config?: string }
): AgentRow {
  db.prepare(`
    INSERT INTO agents (id, slug, name, role, config)
    VALUES (?, ?, ?, ?, ?)
  `).run(agent.id, agent.slug, agent.name, agent.role ?? null, agent.config ?? null)
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as AgentRow
}

// B72: column names are interpolated into the SET clause below. TS restricts the
// keys at compile time, but a runtime caller passing an attacker-influenced
// object would otherwise inject SQL via the key. Gate on an explicit allow-list.
const UPDATABLE_AGENT_COLUMNS = new Set<string>([
  'name', 'role', 'status', 'current_job_id', 'last_heartbeat_at', 'config',
])

export function updateAgent(
  db: DbInstance,
  id: string,
  updates: Partial<Pick<AgentRow, 'name' | 'role' | 'status' | 'current_job_id' | 'last_heartbeat_at' | 'config'>>
): AgentRow | undefined {
  const fields = (Object.keys(updates) as (keyof typeof updates)[])
    .filter((f) => UPDATABLE_AGENT_COLUMNS.has(f as string))
  if (fields.length === 0) return getAgent(db, id)

  const setClauses = fields.map((f) => `${f} = ?`).join(', ')
  const values = fields.map((f) => updates[f] ?? null)
  db.prepare(`UPDATE agents SET ${setClauses} WHERE id = ?`).run(...values, id)
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
}

export function findAgentByCurrentJobId(db: DbInstance, jobId: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE current_job_id = ?').get(jobId) as AgentRow | undefined
}

export function clearAgentJob(db: DbInstance, jobId: string): void {
  db.prepare(
    "UPDATE agents SET status = 'idle', current_job_id = NULL WHERE current_job_id = ? AND status != 'idle'"
  ).run(jobId)
}

// ─── Webhook CRUD ─────────────────────────────────────────────────────────────

export type WebhookEvent = 'job.completed' | 'job.failed' | 'job.canceled' | 'daily_budget_exceeded' | 'desktop_daily_budget_exceeded'

export interface WebhookRow {
  id: string
  project_id: string | null
  url: string
  secret: string
  events: string // JSON array of WebhookEvent
  enabled: number // 1 = enabled, 0 = disabled
  created_at: string
  updated_at: string
}

export function listWebhooks(db: DbInstance): WebhookRow[] {
  return db.prepare('SELECT * FROM webhooks ORDER BY created_at ASC').all() as WebhookRow[]
}

export function listWebhooksForProject(db: DbInstance, projectId: string): WebhookRow[] {
  return db.prepare(
    'SELECT * FROM webhooks WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY created_at ASC'
  ).all(projectId) as WebhookRow[]
}

export function getWebhook(db: DbInstance, id: string): WebhookRow | undefined {
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined
}

export function addWebhook(
  db: DbInstance,
  webhook: { id: string; projectId: string | null; url: string; secret?: string; events?: WebhookEvent[] }
): WebhookRow {
  const events = JSON.stringify(webhook.events ?? ['job.completed', 'job.failed'])
  db.prepare(`
    INSERT INTO webhooks (id, project_id, url, secret, events)
    VALUES (?, ?, ?, ?, ?)
  `).run(webhook.id, webhook.projectId ?? null, webhook.url, webhook.secret ?? '', events)
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhook.id) as WebhookRow
}

export function updateWebhook(
  db: DbInstance,
  id: string,
  updates: { url?: string; secret?: string; events?: WebhookEvent[]; enabled?: boolean }
): WebhookRow | undefined {
  const fields: string[] = []
  const values: unknown[] = []
  if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url) }
  if (updates.secret !== undefined) { fields.push('secret = ?'); values.push(updates.secret) }
  if (updates.events !== undefined) { fields.push('events = ?'); values.push(JSON.stringify(updates.events)) }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0) }
  if (fields.length === 0) return getWebhook(db, id)
  fields.push("updated_at = datetime('now')")
  db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined
}

export function removeWebhook(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id)
}
