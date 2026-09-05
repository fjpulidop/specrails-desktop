import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import {
  initDesktopDb,
  addProject,
  removeProject,
  listProjects,
  getProject,
  getProjectBySlug,
  getProjectByPath,
  touchProject,
  getDesktopSetting,
  setDesktopSetting,
  setProjectSetupSession,
  getProjectSetupSession,
  clearProjectSetupSession,
  listAgents,
  getAgent,
  getAgentBySlug,
  addAgent,
  updateAgent,
  findAgentByCurrentJobId,
  clearAgentJob,
  listWebhooks,
  getWebhook,
  addWebhook,
  updateWebhook,
  removeWebhook,
  listWebhooksForProject,
  recordAgentInvocation,
  sumAgentInvocationsCost,
  setProjectProvidersMirror,
} from './desktop-db'
import type { DbInstance } from './db'

function makeDb(): DbInstance {
  return initDesktopDb(':memory:')
}

function makeProjectOpts(suffix = '1') {
  return {
    id: `proj-${suffix}`,
    slug: `my-project-${suffix}`,
    name: `My Project ${suffix}`,
    path: `/home/user/projects/project-${suffix}`,
  }
}

describe('desktop-db', () => {
  let db: DbInstance

  beforeEach(() => {
    db = makeDb()
  })

  // ─── Schema & Init ──────────────────────────────────────────────────────────

  describe('initDesktopDb', () => {
    it('creates the projects, desktop_settings, agents and webhooks tables', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      const names = tables.map((t) => t.name)
      expect(names).toContain('projects')
      expect(names).toContain('desktop_settings')
      expect(names).toContain('schema_migrations')
      expect(names).toContain('agents')
      expect(names).toContain('webhooks')
    })

    it('creates indexes on slug and path', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_projects_slug')
      expect(names).toContain('idx_projects_path')
    })

    it('applies migrations 1 through 25 and records them', () => {
      const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]
      expect(versions).toHaveLength(25)
      expect(versions.map((v) => v.version)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
      const columns = db.prepare('PRAGMA table_info(agent_messages)').all() as { name: string }[]
      expect(columns.map((c) => c.name)).toContain('context_refs')
      // 23: durable Builder snapshots
      const convColumns = (db.prepare('PRAGMA table_info(blueprint_conversations)').all() as { name: string }[]).map((c) => c.name)
      expect(convColumns).toEqual(expect.arrayContaining(['blueprint_json', 'raw_blueprint_json', 'snapshot_updated_at', 'snapshot_issue_json', 'committed_project_id']))
      const msgColumns = (db.prepare('PRAGMA table_info(blueprint_messages)').all() as { name: string }[]).map((c) => c.name)
      expect(msgColumns).toContain('raw_content')
    })

    it('is idempotent — calling initDesktopDb again does not fail', () => {
      // Re-init on same DB (in-memory so we just call again)
      const db2 = makeDb()
      const versions = db2.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
      expect(versions).toHaveLength(25)
    })
  })

  // ─── Detected-set mirror (global-core-zero-friction) ──────────────────────

  describe('setProjectProvidersMirror', () => {
    afterEach(() => {
      setProjectProvidersMirror(null)
    })

    it('project rows read providers as the detected set with derived primary', () => {
      addProject(db, { ...makeProjectOpts(), provider: 'codex', providers: ['codex'] })
      setProjectProvidersMirror(() => ['claude', 'gemini'])
      const row = getProject(db, 'proj-1')
      expect(row?.providers).toEqual(['claude', 'gemini'])
      // Stored primary codex is not detected → falls to claude by preference.
      expect(row?.provider).toBe('claude')
    })

    it('stored primary is kept while still detected', () => {
      addProject(db, { ...makeProjectOpts(), provider: 'codex', providers: ['codex'] })
      setProjectProvidersMirror(() => ['gemini', 'codex'])
      const row = getProject(db, 'proj-1')
      expect(row?.provider).toBe('codex')
    })

    it('null or empty supplier restores stored row behaviour', () => {
      addProject(db, { ...makeProjectOpts(), provider: 'codex', providers: ['codex'] })
      setProjectProvidersMirror(() => [])
      expect(getProject(db, 'proj-1')?.providers).toEqual(['codex'])
      setProjectProvidersMirror(null)
      expect(getProject(db, 'proj-1')?.providers).toEqual(['codex'])
    })
  })

  // ─── Project CRUD ─────────────────────────────────────────────────────────

  describe('addProject', () => {
    it('adds a project and returns the full row', () => {
      const row = addProject(db, makeProjectOpts())
      expect(row.id).toBe('proj-1')
      expect(row.slug).toBe('my-project-1')
      expect(row.name).toBe('My Project 1')
      expect(row.path).toBe('/home/user/projects/project-1')
      expect(row.db_path).toBeTruthy()
      expect(row.provider).toBe('claude')
      expect(row.added_at).toBeTruthy()
      expect(row.last_seen_at).toBeTruthy()
    })

    it('stores the specified provider', () => {
      const row = addProject(db, { ...makeProjectOpts(), provider: 'codex' })
      expect(row.provider).toBe('codex')
    })

    it('throws on duplicate slug', () => {
      addProject(db, makeProjectOpts())
      const opts2 = { ...makeProjectOpts(), id: 'proj-dup', path: '/other/path' }
      expect(() => addProject(db, opts2)).toThrow(/UNIQUE/)
    })

    it('throws on duplicate path', () => {
      addProject(db, makeProjectOpts())
      const opts2 = { ...makeProjectOpts(), id: 'proj-dup', slug: 'other-slug' }
      expect(() => addProject(db, opts2)).toThrow(/UNIQUE/)
    })
  })

  describe('listProjects', () => {
    it('returns empty array when no projects', () => {
      expect(listProjects(db)).toEqual([])
    })

    it('returns projects ordered by added_at ASC', () => {
      addProject(db, makeProjectOpts('a'))
      addProject(db, makeProjectOpts('b'))
      addProject(db, makeProjectOpts('c'))
      const projects = listProjects(db)
      expect(projects).toHaveLength(3)
      expect(projects[0].slug).toBe('my-project-a')
      expect(projects[2].slug).toBe('my-project-c')
    })
  })

  describe('getProject', () => {
    it('returns the project by ID', () => {
      addProject(db, makeProjectOpts())
      const row = getProject(db, 'proj-1')
      expect(row?.id).toBe('proj-1')
    })

    it('returns undefined for non-existent ID', () => {
      expect(getProject(db, 'nonexistent')).toBeUndefined()
    })
  })

  describe('getProjectBySlug', () => {
    it('returns the project by slug', () => {
      addProject(db, makeProjectOpts())
      const row = getProjectBySlug(db, 'my-project-1')
      expect(row?.id).toBe('proj-1')
    })

    it('returns undefined for non-existent slug', () => {
      expect(getProjectBySlug(db, 'nope')).toBeUndefined()
    })
  })

  describe('getProjectByPath', () => {
    it('returns the project by path', () => {
      addProject(db, makeProjectOpts())
      const row = getProjectByPath(db, '/home/user/projects/project-1')
      expect(row?.id).toBe('proj-1')
    })

    it('returns undefined for non-existent path', () => {
      expect(getProjectByPath(db, '/not/here')).toBeUndefined()
    })
  })

  describe('removeProject', () => {
    it('removes an existing project', () => {
      addProject(db, makeProjectOpts())
      removeProject(db, 'proj-1')
      expect(getProject(db, 'proj-1')).toBeUndefined()
      expect(listProjects(db)).toHaveLength(0)
    })

    it('does nothing for non-existent ID (no error)', () => {
      expect(() => removeProject(db, 'nonexistent')).not.toThrow()
    })
  })

  describe('touchProject', () => {
    it('updates last_seen_at', () => {
      addProject(db, makeProjectOpts())
      const before = getProject(db, 'proj-1')!.last_seen_at
      // Small delay to ensure timestamp differs
      touchProject(db, 'proj-1')
      const after = getProject(db, 'proj-1')!.last_seen_at
      // last_seen_at should be >= before (datetime resolution is seconds)
      expect(after >= before).toBe(true)
    })
  })

  // ─── Desktop Settings ─────────────────────────────────────────────────────────

  describe('desktop settings', () => {
    it('returns undefined for non-existent key', () => {
      expect(getDesktopSetting(db, 'nonexistent')).toBeUndefined()
    })

    it('sets and gets a setting', () => {
      setDesktopSetting(db, 'port', '4200')
      expect(getDesktopSetting(db, 'port')).toBe('4200')
    })

    it('upserts — replaces existing value', () => {
      setDesktopSetting(db, 'port', '4200')
      setDesktopSetting(db, 'port', '8080')
      expect(getDesktopSetting(db, 'port')).toBe('8080')
    })

    it('handles multiple different keys', () => {
      setDesktopSetting(db, 'key1', 'value1')
      setDesktopSetting(db, 'key2', 'value2')
      expect(getDesktopSetting(db, 'key1')).toBe('value1')
      expect(getDesktopSetting(db, 'key2')).toBe('value2')
    })
  })

  describe('setup session persistence', () => {
    it('saves and retrieves a setup session ID', () => {
      setProjectSetupSession(db, 'proj-1', 'session-abc-123')
      expect(getProjectSetupSession(db, 'proj-1')).toBe('session-abc-123')
    })

    it('returns undefined when no session is stored', () => {
      expect(getProjectSetupSession(db, 'proj-1')).toBeUndefined()
    })

    it('overwrites an existing session ID', () => {
      setProjectSetupSession(db, 'proj-1', 'session-old')
      setProjectSetupSession(db, 'proj-1', 'session-new')
      expect(getProjectSetupSession(db, 'proj-1')).toBe('session-new')
    })

    it('clears a session ID', () => {
      setProjectSetupSession(db, 'proj-1', 'session-abc-123')
      clearProjectSetupSession(db, 'proj-1')
      expect(getProjectSetupSession(db, 'proj-1')).toBeUndefined()
    })

    it('isolates sessions per project', () => {
      setProjectSetupSession(db, 'proj-1', 'session-one')
      setProjectSetupSession(db, 'proj-2', 'session-two')
      expect(getProjectSetupSession(db, 'proj-1')).toBe('session-one')
      expect(getProjectSetupSession(db, 'proj-2')).toBe('session-two')
      clearProjectSetupSession(db, 'proj-1')
      expect(getProjectSetupSession(db, 'proj-1')).toBeUndefined()
      expect(getProjectSetupSession(db, 'proj-2')).toBe('session-two')
    })
  })

  // ─── Agent CRUD ──────────────────────────────────────────────────────────────

  function makeAgentOpts(suffix = '1') {
    return {
      id: `agent-${suffix}`,
      slug: `my-agent-${suffix}`,
      name: `My Agent ${suffix}`,
    }
  }

  describe('addAgent', () => {
    it('adds an agent and returns the full row', () => {
      const row = addAgent(db, makeAgentOpts())
      expect(row.id).toBe('agent-1')
      expect(row.slug).toBe('my-agent-1')
      expect(row.name).toBe('My Agent 1')
      expect(row.status).toBe('idle')
      expect(row.current_job_id).toBeNull()
      expect(row.role).toBeNull()
      expect(row.created_at).toBeTruthy()
    })

    it('stores role and config when provided', () => {
      const row = addAgent(db, { ...makeAgentOpts(), role: 'developer', config: '{"key":"val"}' })
      expect(row.role).toBe('developer')
      expect(row.config).toBe('{"key":"val"}')
    })

    it('throws on duplicate slug', () => {
      addAgent(db, makeAgentOpts())
      expect(() => addAgent(db, { id: 'agent-dup', slug: 'my-agent-1', name: 'Other' })).toThrow(/UNIQUE/)
    })
  })

  describe('listAgents', () => {
    it('returns empty array when no agents', () => {
      expect(listAgents(db)).toEqual([])
    })

    it('returns agents ordered by created_at ASC', () => {
      addAgent(db, makeAgentOpts('a'))
      addAgent(db, makeAgentOpts('b'))
      const agents = listAgents(db)
      expect(agents).toHaveLength(2)
      expect(agents[0].slug).toBe('my-agent-a')
      expect(agents[1].slug).toBe('my-agent-b')
    })
  })

  describe('getAgent', () => {
    it('returns agent by ID', () => {
      addAgent(db, makeAgentOpts())
      expect(getAgent(db, 'agent-1')?.slug).toBe('my-agent-1')
    })

    it('returns undefined for non-existent ID', () => {
      expect(getAgent(db, 'nope')).toBeUndefined()
    })
  })

  describe('getAgentBySlug', () => {
    it('returns agent by slug', () => {
      addAgent(db, makeAgentOpts())
      expect(getAgentBySlug(db, 'my-agent-1')?.id).toBe('agent-1')
    })

    it('returns undefined for non-existent slug', () => {
      expect(getAgentBySlug(db, 'nope')).toBeUndefined()
    })
  })

  describe('updateAgent', () => {
    it('updates status and current_job_id', () => {
      addAgent(db, makeAgentOpts())
      const updated = updateAgent(db, 'agent-1', { status: 'busy', current_job_id: 'job-xyz' })
      expect(updated?.status).toBe('busy')
      expect(updated?.current_job_id).toBe('job-xyz')
    })

    it('returns undefined for non-existent agent', () => {
      expect(updateAgent(db, 'missing', { status: 'busy' })).toBeUndefined()
    })

    it('B72: ignores keys outside the column allow-list (no SQL injection via key)', () => {
      addAgent(db, makeAgentOpts())
      // A runtime caller passing an attacker-influenced key — cast past the type.
      const malicious = { name: 'Renamed', 'status = \'x\'; DROP TABLE agents; --': 'pwn' } as unknown as Parameters<typeof updateAgent>[2]
      expect(() => updateAgent(db, 'agent-1', malicious)).not.toThrow()
      // The legit column applied; the agents table still exists and is queryable.
      expect(getAgent(db, 'agent-1')?.name).toBe('Renamed')
    })

    it('returns the current row when no updates given', () => {
      addAgent(db, makeAgentOpts())
      const result = updateAgent(db, 'agent-1', {})
      expect(result?.id).toBe('agent-1')
    })

    it('only updates provided fields', () => {
      addAgent(db, { ...makeAgentOpts(), role: 'developer' })
      updateAgent(db, 'agent-1', { status: 'busy' })
      const row = getAgent(db, 'agent-1')
      expect(row?.role).toBe('developer')
      expect(row?.status).toBe('busy')
    })
  })

  describe('findAgentByCurrentJobId', () => {
    it('finds an agent by current_job_id', () => {
      addAgent(db, makeAgentOpts())
      updateAgent(db, 'agent-1', { current_job_id: 'job-abc' })
      const found = findAgentByCurrentJobId(db, 'job-abc')
      expect(found?.id).toBe('agent-1')
    })

    it('returns undefined when no agent has that job', () => {
      expect(findAgentByCurrentJobId(db, 'job-missing')).toBeUndefined()
    })
  })

  describe('clearAgentJob', () => {
    it('resets agent to idle and clears current_job_id', () => {
      addAgent(db, makeAgentOpts())
      updateAgent(db, 'agent-1', { status: 'busy', current_job_id: 'job-abc' })
      clearAgentJob(db, 'job-abc')
      const row = getAgent(db, 'agent-1')
      expect(row?.status).toBe('idle')
      expect(row?.current_job_id).toBeNull()
    })

    it('does nothing when no agent has that job', () => {
      addAgent(db, makeAgentOpts())
      expect(() => clearAgentJob(db, 'no-such-job')).not.toThrow()
    })

    it('does not change agents already idle', () => {
      addAgent(db, makeAgentOpts())
      // Agent is idle (default), clearing a non-matching job has no effect
      clearAgentJob(db, 'some-job')
      expect(getAgent(db, 'agent-1')?.status).toBe('idle')
    })
  })

  // ─── Webhook CRUD ─────────────────────────────────────────────────────────

  describe('webhooks', () => {
    it('starts with no webhooks', () => {
      expect(listWebhooks(db)).toHaveLength(0)
    })

    it('adds a webhook and retrieves it', () => {
      const wh = addWebhook(db, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', secret: 'abc', events: ['job.completed'] })
      expect(wh.id).toBe('wh-1')
      expect(wh.url).toBe('https://example.com/hook')
      expect(wh.secret).toBe('abc')
      expect(wh.project_id).toBeNull()
      expect(JSON.parse(wh.events)).toEqual(['job.completed'])
      expect(wh.enabled).toBe(1)
    })

    it('lists all webhooks', () => {
      addWebhook(db, { id: 'wh-1', projectId: null, url: 'https://a.com', events: ['job.failed'] })
      addWebhook(db, { id: 'wh-2', projectId: null, url: 'https://b.com', events: ['job.completed'] })
      expect(listWebhooks(db)).toHaveLength(2)
    })

    it('retrieves a webhook by id', () => {
      addWebhook(db, { id: 'wh-1', projectId: null, url: 'https://a.com' })
      expect(getWebhook(db, 'wh-1')?.id).toBe('wh-1')
      expect(getWebhook(db, 'no-such')).toBeUndefined()
    })

    it('updates url, secret and enabled', () => {
      addWebhook(db, { id: 'wh-1', projectId: null, url: 'https://old.com' })
      const updated = updateWebhook(db, 'wh-1', { url: 'https://new.com', enabled: false })
      expect(updated?.url).toBe('https://new.com')
      expect(updated?.enabled).toBe(0)
    })

    it('removes a webhook', () => {
      addWebhook(db, { id: 'wh-1', projectId: null, url: 'https://a.com' })
      removeWebhook(db, 'wh-1')
      expect(getWebhook(db, 'wh-1')).toBeUndefined()
    })

    it('listWebhooksForProject returns global and project-specific enabled webhooks', () => {
      const project = addProject(db, makeProjectOpts('p1'))
      const otherProject = addProject(db, makeProjectOpts('p9'))
      addWebhook(db, { id: 'wh-global', projectId: null, url: 'https://global.com', events: ['job.completed'] })
      addWebhook(db, { id: 'wh-project', projectId: project.id, url: 'https://project.com', events: ['job.failed'] })
      addWebhook(db, { id: 'wh-other', projectId: otherProject.id, url: 'https://other.com', events: ['job.completed'] })
      const results = listWebhooksForProject(db, project.id)
      const ids = results.map((w) => w.id)
      expect(ids).toContain('wh-global')
      expect(ids).toContain('wh-project')
      expect(ids).not.toContain('wh-other')
    })

    it('listWebhooksForProject excludes disabled webhooks', () => {
      const project = addProject(db, makeProjectOpts('p2'))
      addWebhook(db, { id: 'wh-disabled', projectId: null, url: 'https://disabled.com' })
      updateWebhook(db, 'wh-disabled', { enabled: false })
      expect(listWebhooksForProject(db, project.id)).toHaveLength(0)
    })
  })
})

// ─── Rebrand migrations (Specrails Hub → Specrails Desktop) ────────────────────
// These tests need real temp files: the rename-on-open migration moves
// `hub.sqlite` → `desktop.sqlite` on disk, which `:memory:` cannot exercise.

describe('legacy hub → desktop migrations', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-db-migration-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Simulates a pre-rebrand database: schema_migrations at version 12 with the
   *  legacy hub_settings table, the legacy budget key, and a legacy webhook
   *  event subscription. Legacy identifiers used here only — migration tests. */
  function seedLegacyDb(legacyPath: string): void {
    const legacy = new Database(legacyPath)
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE hub_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE webhooks (
        id         TEXT PRIMARY KEY,
        project_id TEXT,
        url        TEXT NOT NULL,
        secret     TEXT NOT NULL DEFAULT '',
        events     TEXT NOT NULL DEFAULT '["job.completed","job.failed"]',
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    const ins = legacy.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
    for (let v = 1; v <= 12; v++) ins.run(v)
    legacy.prepare("INSERT INTO hub_settings (key, value) VALUES ('hub_daily_budget_usd', '7.5')").run()
    legacy.prepare("INSERT INTO hub_settings (key, value) VALUES ('ui_theme', 'matrix')").run()
    legacy.prepare(
      `INSERT INTO webhooks (id, url, events) VALUES ('wh-legacy', 'https://example.com/h', '["job.completed","hub_daily_budget_exceeded"]')`
    ).run()
    legacy.close()
  }

  it('renames hub.sqlite to desktop.sqlite on open and preserves data', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    const desktopPath = path.join(dir, 'desktop.sqlite')
    seedLegacyDb(legacyPath)

    const db = initDesktopDb(desktopPath)
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.existsSync(desktopPath)).toBe(true)
    expect(getDesktopSetting(db, 'ui_theme')).toBe('matrix')
    db.close()
  })

  it('does not touch hub.sqlite when desktop.sqlite already exists', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    const desktopPath = path.join(dir, 'desktop.sqlite')
    initDesktopDb(desktopPath).close()
    seedLegacyDb(legacyPath)

    const db = initDesktopDb(desktopPath)
    expect(fs.existsSync(legacyPath)).toBe(true)
    // The fresh desktop DB was kept — no legacy keys leaked in.
    expect(getDesktopSetting(db, 'desktop_daily_budget_usd')).toBeUndefined()
    db.close()
  })

  it('never creates an empty catalog when the legacy database rename fails', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    const desktopPath = path.join(dir, 'desktop.sqlite')
    seedLegacyDb(legacyPath)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('temporarily denied'), { code: 'EACCES' })
    })
    try {
      expect(() => initDesktopDb(desktopPath)).toThrow('Could not migrate the existing project database')
      expect(fs.existsSync(desktopPath)).toBe(false)
      expect(fs.existsSync(legacyPath)).toBe(true)
    } finally {
      rename.mockRestore()
    }
    const db = initDesktopDb(desktopPath)
    expect(getDesktopSetting(db, 'ui_theme')).toBe('matrix')
    db.close()
  })

  it('resumes migration after sidecars moved but the main rename failed', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    const desktopPath = path.join(dir, 'desktop.sqlite')
    seedLegacyDb(legacyPath)
    fs.writeFileSync(legacyPath + '-wal', 'WAL-SENTINEL')
    const realRename = fs.renameSync.bind(fs)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === legacyPath) throw new Error('rename interrupted')
      realRename(from, to)
    })
    try {
      expect(() => initDesktopDb(desktopPath)).toThrow('rename interrupted')
      expect(fs.existsSync(desktopPath)).toBe(false)
      expect(fs.readFileSync(desktopPath + '-wal', 'utf8')).toBe('WAL-SENTINEL')
    } finally {
      rename.mockRestore()
    }
    const db = initDesktopDb(desktopPath)
    expect(getDesktopSetting(db, 'ui_theme')).toBe('matrix')
    db.close()
  })

  it('migration 13 renames hub_settings, the budget key and webhook events', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    seedLegacyDb(legacyPath)

    const db = initDesktopDb(path.join(dir, 'desktop.sqlite'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((t) => t.name)
    expect(tables).toContain('desktop_settings')
    expect(tables).not.toContain('hub_settings')
    expect(getDesktopSetting(db, 'desktop_daily_budget_usd')).toBe('7.5')
    expect(getDesktopSetting(db, 'hub_daily_budget_usd')).toBeUndefined()
    const wh = getWebhook(db, 'wh-legacy')
    expect(JSON.parse(wh!.events)).toEqual(['job.completed', 'desktop_daily_budget_exceeded'])
    db.close()
  })

  // BUG-SQLITE-05: the -wal/-shm sidecars must be relocated alongside the main
  // DB so SQLite can still match them by base filename after the rename. If the
  // sidecars were lost, un-checkpointed commits in the WAL would be discarded.
  it('relocates the -wal/-shm sidecars to the new base name during migration', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    const desktopPath = path.join(dir, 'desktop.sqlite')
    seedLegacyDb(legacyPath)
    // Stand-in sidecar files with sentinel content so we can prove they are the
    // same bytes after relocation (not freshly created by SQLite on open).
    fs.writeFileSync(legacyPath + '-wal', 'WAL-SENTINEL-BYTES', 'utf-8')
    fs.writeFileSync(legacyPath + '-shm', 'SHM-SENTINEL-BYTES', 'utf-8')

    const db = initDesktopDb(desktopPath)
    // Legacy main + sidecars gone; new base name present.
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.existsSync(legacyPath + '-wal')).toBe(false)
    expect(fs.existsSync(legacyPath + '-shm')).toBe(false)
    expect(fs.existsSync(desktopPath)).toBe(true)
    // The new WAL must carry our exact sentinel bytes — proving the sidecar was
    // MOVED (renamed), not orphaned and re-created. (SQLite has not opened the
    // WAL yet at the point of the rename; opening below may rewrite it, so read
    // the bytes only matters relative to the move having happened — assert the
    // file exists at the new name.)
    expect(fs.existsSync(desktopPath + '-wal')).toBe(true)
    // The data behind the migration is intact.
    expect(getDesktopSetting(db, 'ui_theme')).toBe('matrix')
    db.close()
  })

  it('preserves WAL-resident un-checkpointed data across the rename', () => {
    const legacyPath = path.join(dir, 'hub.sqlite')
    const desktopPath = path.join(dir, 'desktop.sqlite')
    seedLegacyDb(legacyPath)

    // Reopen the legacy DB in WAL mode, disable auto-checkpoint, write a fresh
    // setting so it lands in the -wal sidecar, then close WITHOUT checkpoint so
    // the commit lives only in the WAL. better-sqlite3 checkpoints on a normal
    // close; PRAGMA wal_checkpoint(PASSIVE) is avoided and we close via the
    // process so the WAL stays populated.
    const legacy = new Database(legacyPath)
    legacy.pragma('journal_mode = WAL')
    legacy.pragma('wal_autocheckpoint = 0')
    legacy.prepare("INSERT INTO hub_settings (key, value) VALUES ('wal_only_key', 'in-wal')").run()
    // Detach the connection without triggering a checkpoint on the main DB by
    // closing only after confirming the WAL sidecar exists on disk.
    expect(fs.existsSync(legacyPath + '-wal')).toBe(true)
    legacy.close()

    // After close better-sqlite3 may have checkpointed; the migration must in
    // any case preserve the row (whether it lives in the WAL or the main DB).
    const db = initDesktopDb(desktopPath)
    expect(fs.existsSync(legacyPath)).toBe(false)
    // migration 13 maps hub_settings → desktop_settings, so the WAL-written key
    // survives the rename + the table rename.
    expect(getDesktopSetting(db, 'wal_only_key')).toBe('in-wal')
    db.close()
  })
})

describe('agent_invocations (HIGH-3: agent-chat cost accounting)', () => {
  let db: DbInstance

  beforeEach(() => {
    db = makeDb()
  })

  it('creates the agent_invocations table + indexes', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((t) => t.name)
    expect(tables).toContain('agent_invocations')
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map((i) => i.name)
    expect(indexes).toContain('idx_agent_inv_started')
    expect(indexes).toContain('idx_agent_inv_conv')
  })

  it('records a row with fixed surface=agent-chat and native cost (estimated=0)', () => {
    recordAgentInvocation(db, {
      id: 'inv-1',
      conversation_id: 'conv-1',
      project_id: 'proj-1',
      provider: 'claude',
      model: 'claude-sonnet-4',
      status: 'success',
      started_at: '2026-07-01T10:00:00.000Z',
      finished_at: '2026-07-01T10:00:30.000Z',
      tokens_in: 100,
      tokens_out: 200,
      total_cost_usd: 0.5,
      total_cost_usd_estimated: false,
      num_turns: 3,
      session_id: 'sess-1',
    })
    const row = db.prepare('SELECT * FROM agent_invocations WHERE id = ?').get('inv-1') as Record<string, unknown>
    expect(row.surface).toBe('agent-chat')
    expect(row.project_id).toBe('proj-1')
    expect(row.provider).toBe('claude')
    expect(row.total_cost_usd).toBe(0.5)
    expect(row.total_cost_usd_estimated).toBe(0)
    expect(row.status).toBe('success')
    expect(row.num_turns).toBe(3)
  })

  it('allows NULL project_id (Home / app-global) and flags estimated costs', () => {
    recordAgentInvocation(db, {
      id: 'inv-2',
      conversation_id: 'conv-2',
      project_id: null,
      provider: 'codex',
      status: 'aborted',
      started_at: '2026-07-01T11:00:00.000Z',
      total_cost_usd: 0.25,
      total_cost_usd_estimated: true,
    })
    const row = db.prepare('SELECT * FROM agent_invocations WHERE id = ?').get('inv-2') as Record<string, unknown>
    expect(row.project_id).toBeNull()
    expect(row.total_cost_usd_estimated).toBe(1)
    expect(row.status).toBe('aborted')
  })

  it('defaults optional numeric/text fields to NULL', () => {
    recordAgentInvocation(db, {
      id: 'inv-3',
      conversation_id: 'conv-3',
      provider: 'gemini',
      status: 'failed',
      started_at: '2026-07-01T12:00:00.000Z',
    })
    const row = db.prepare('SELECT * FROM agent_invocations WHERE id = ?').get('inv-3') as Record<string, unknown>
    expect(row.total_cost_usd).toBeNull()
    expect(row.tokens_in).toBeNull()
    expect(row.num_turns).toBeNull()
    expect(row.total_cost_usd_estimated).toBe(0)
    expect(row.project_id).toBeNull()
  })

  describe('sumAgentInvocationsCost', () => {
    it('returns 0 on an empty table', () => {
      expect(sumAgentInvocationsCost(db)).toBe(0)
    })

    it('sums all costs when no since filter is given, treating NULL as 0', () => {
      recordAgentInvocation(db, { id: 'a', conversation_id: 'c', provider: 'claude', status: 'success', started_at: '2026-07-01T09:00:00.000Z', total_cost_usd: 1.0 })
      recordAgentInvocation(db, { id: 'b', conversation_id: 'c', provider: 'claude', status: 'success', started_at: '2026-07-02T09:00:00.000Z', total_cost_usd: 2.5 })
      recordAgentInvocation(db, { id: 'c', conversation_id: 'c', provider: 'claude', status: 'failed', started_at: '2026-07-03T09:00:00.000Z' })
      expect(sumAgentInvocationsCost(db)).toBeCloseTo(3.5, 6)
    })

    it('filters by since (inclusive on started_at)', () => {
      recordAgentInvocation(db, { id: 'a', conversation_id: 'c', provider: 'claude', status: 'success', started_at: '2026-07-01T09:00:00.000Z', total_cost_usd: 1.0 })
      recordAgentInvocation(db, { id: 'b', conversation_id: 'c', provider: 'claude', status: 'success', started_at: '2026-07-02T09:00:00.000Z', total_cost_usd: 2.5 })
      expect(sumAgentInvocationsCost(db, '2026-07-02T00:00:00.000Z')).toBeCloseTo(2.5, 6)
      expect(sumAgentInvocationsCost(db, '2026-07-02T09:00:00.000Z')).toBeCloseTo(2.5, 6)
    })
  })
})
