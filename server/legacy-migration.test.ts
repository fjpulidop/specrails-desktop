import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isLegacyProject,
  isLegacyMigrationEnabled,
  isProtectedPath,
  buildCleanupManifest,
  migrateProject,
  runLegacyMigrationSweep,
  journalPathFor,
  readJournal,
  type MigrationProject,
} from './legacy-migration'
import { workspacePathFor } from './workspace-manager'

let priorHome: string | undefined
let homeDir: string
let repoDir: string

const project = (): MigrationProject => ({ id: 'proj-1', slug: 'my-app', path: repoDir })

function seedLegacyRepo(): void {
  // Repo-resident core install: version marker + state + framework files +
  // user files planted alongside them.
  fs.mkdirSync(path.join(repoDir, '.specrails', 'profiles'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.specrails', 'specrails-version'), '4.2.0')
  fs.writeFileSync(path.join(repoDir, '.specrails', 'local-tickets.json'), JSON.stringify({
    schema_version: '1.1', next_id: 13, tickets: Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })),
  }))
  fs.writeFileSync(path.join(repoDir, '.specrails', 'profiles', 'default.json'), '{"agents":[]}')

  fs.mkdirSync(path.join(repoDir, '.claude', 'agents'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.claude', 'agents', 'sr-architect.md'), 'framework')
  fs.writeFileSync(path.join(repoDir, '.claude', 'agents', 'sr-merge-resolver.md'), 'retired in 5.x')
  fs.writeFileSync(path.join(repoDir, '.claude', 'agents', 'custom-mine.md'), 'user agent')

  fs.mkdirSync(path.join(repoDir, '.claude', 'commands', 'sr'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.claude', 'commands', 'sr', 'implement.md'), 'legacy ns')
  fs.mkdirSync(path.join(repoDir, '.claude', 'commands', 'specrails'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, '.claude', 'commands', 'openspec'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.claude', 'commands', 'openspec', 'apply.md'), 'openspec-owned')

  fs.mkdirSync(path.join(repoDir, '.claude', 'agent-memory'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.claude', 'agent-memory', 'notes.md'), 'memory')

  fs.mkdirSync(path.join(repoDir, '.claude', 'worktrees', 'wt-1'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'openspec', 'specs'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'openspec', 'specs', 'x.md'), 'spec')
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'user instructions (installer appended)')
  fs.writeFileSync(path.join(repoDir, '.mcp.json'), JSON.stringify({
    mcpServers: { serena: { command: 'uvx' }, myserver: { command: 'mine' } },
  }))
}

function populateWorkspaceOnAssemble(): (p: MigrationProject, provs: string[]) => Promise<void> {
  return async (p) => {
    fs.mkdirSync(path.join(workspacePathFor(p.slug), '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(workspacePathFor(p.slug), '.specrails', 'specrails-version'), '5.0.0')
  }
}

beforeEach(() => {
  priorHome = process.env.SPECRAILS_REGISTRY_HOME
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'))
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-repo-'))
  process.env.SPECRAILS_REGISTRY_HOME = homeDir
  delete process.env.SPECRAILS_LEGACY_MIGRATION
})

afterEach(() => {
  if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = priorHome
  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(repoDir, { recursive: true, force: true })
})

describe('isLegacyProject / kill switch', () => {
  it('legacy = repo version marker present and workspace unpopulated', () => {
    expect(isLegacyProject(project())).toBe(false)
    seedLegacyRepo()
    expect(isLegacyProject(project())).toBe(true)
    fs.mkdirSync(path.join(workspacePathFor('my-app'), '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(workspacePathFor('my-app'), '.specrails', 'specrails-version'), '5.0.0')
    expect(isLegacyProject(project())).toBe(false)
  })

  it('kill switch disables the sweep', async () => {
    process.env.SPECRAILS_LEGACY_MIGRATION = 'false'
    expect(isLegacyMigrationEnabled()).toBe(false)
    seedLegacyRepo()
    const results = await runLegacyMigrationSweep([project()])
    expect(results).toEqual([])
    expect(fs.existsSync(path.join(repoDir, '.specrails', 'specrails-version'))).toBe(true)
  })
})

describe('isProtectedPath', () => {
  it('protects carve-outs and user files', () => {
    expect(isProtectedPath(repoDir, path.join(repoDir, 'openspec', 'specs'))).toBe(true)
    expect(isProtectedPath(repoDir, path.join(repoDir, '.claude', 'worktrees', 'wt-1'))).toBe(true)
    expect(isProtectedPath(repoDir, path.join(repoDir, '.claude', 'agents', 'custom-mine.md'))).toBe(true)
    expect(isProtectedPath(repoDir, path.join(repoDir, 'CLAUDE.md'))).toBe(true)
    expect(isProtectedPath(repoDir, path.join(repoDir, '.mcp.json'))).toBe(true)
    expect(isProtectedPath(repoDir, path.join(repoDir, '..', 'outside'))).toBe(true)
    expect(isProtectedPath(repoDir, path.join(repoDir, '.claude', 'agents', 'sr-architect.md'))).toBe(false)
  })
})

describe('buildCleanupManifest', () => {
  it('targets framework files and historical namespaces, never user files', () => {
    seedLegacyRepo()
    const manifest = buildCleanupManifest(repoDir, homeDir).map((m) => m.path)
    expect(manifest).toContain(path.join(repoDir, '.claude', 'agents', 'sr-architect.md'))
    expect(manifest).toContain(path.join(repoDir, '.claude', 'agents', 'sr-merge-resolver.md'))
    expect(manifest).toContain(path.join(repoDir, '.claude', 'commands', 'sr'))
    expect(manifest).toContain(path.join(repoDir, '.claude', 'commands', 'specrails'))
    expect(manifest).not.toContain(path.join(repoDir, '.claude', 'agents', 'custom-mine.md'))
    expect(manifest).not.toContain(path.join(repoDir, '.claude', 'commands', 'openspec'))
    expect(manifest.some((p) => p.includes('openspec'))).toBe(false)
    expect(manifest.some((p) => p.includes('worktrees'))).toBe(false)
  })
})

describe('migrateProject', () => {
  it('moves state, cleans framework files, preserves user files and carve-outs', async () => {
    seedLegacyRepo()
    const removeMcpKeys = vi.fn(async (repoPath: string, keys: string[]) => {
      const p = path.join(repoPath, '.mcp.json')
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      for (const k of keys) delete data.mcpServers[k]
      fs.writeFileSync(p, JSON.stringify(data))
    })

    const result = await migrateProject(project(), {
      assemble: populateWorkspaceOnAssemble(),
      providers: ['claude'],
      removeMcpKeys,
    })
    expect(result.migrated).toBe(true)

    const ws = workspacePathFor('my-app')
    // Tickets survive (12 tickets readable from the workspace store).
    const store = JSON.parse(fs.readFileSync(path.join(ws, '.specrails', 'local-tickets.json'), 'utf-8'))
    expect(store.tickets).toHaveLength(12)
    expect(fs.existsSync(path.join(ws, '.specrails', 'profiles', 'default.json'))).toBe(true)
    expect(fs.existsSync(path.join(ws, '.claude', 'agent-memory', 'notes.md'))).toBe(true)

    // Repo cleaned of framework artifacts and .specrails residue.
    expect(fs.existsSync(path.join(repoDir, '.specrails'))).toBe(false)
    expect(fs.existsSync(path.join(repoDir, '.claude', 'agents', 'sr-architect.md'))).toBe(false)
    expect(fs.existsSync(path.join(repoDir, '.claude', 'commands', 'sr'))).toBe(false)

    // User files + carve-outs untouched.
    expect(fs.existsSync(path.join(repoDir, '.claude', 'agents', 'custom-mine.md'))).toBe(true)
    expect(fs.existsSync(path.join(repoDir, 'openspec', 'specs', 'x.md'))).toBe(true)
    expect(fs.existsSync(path.join(repoDir, '.claude', 'worktrees', 'wt-1'))).toBe(true)
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf-8')).toContain('user instructions')
    expect(fs.existsSync(path.join(repoDir, '.claude', 'commands', 'openspec', 'apply.md'))).toBe(true)

    // Surgical mcp cleanup: serena removed, user key kept, file valid JSON.
    const mcp = JSON.parse(fs.readFileSync(path.join(repoDir, '.mcp.json'), 'utf-8'))
    expect(mcp.mcpServers.serena).toBeUndefined()
    expect(mcp.mcpServers.myserver).toBeDefined()

    // Journal complete.
    const journal = readJournal(journalPathFor('my-app'))
    expect(journal?.finishedAt).toBeTruthy()
    expect(journal?.entries.every((e) => e.executed)).toBe(true)
  })

  it('skips non-legacy projects', async () => {
    const result = await migrateProject(project(), { assemble: populateWorkspaceOnAssemble(), providers: ['claude'] })
    expect(result.migrated).toBe(false)
    expect(result.skippedReason).toBe('not-legacy')
  })

  it('assemble failure aborts before any journal or deletion (fail-open)', async () => {
    seedLegacyRepo()
    const result = await migrateProject(project(), {
      assemble: async () => { throw new Error('no bundle') },
      providers: ['claude'],
    })
    expect(result.migrated).toBe(false)
    expect(result.error).toMatch(/no bundle/)
    expect(fs.existsSync(path.join(repoDir, '.specrails', 'specrails-version'))).toBe(true)
    expect(readJournal(journalPathFor('my-app'))).toBeNull()
  })

  it('crash mid-cleanup is auditable and resumable (unexecuted entries only)', async () => {
    seedLegacyRepo()
    const removeMcpKeys = vi.fn()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValue(undefined)

    const first = await migrateProject(project(), {
      assemble: populateWorkspaceOnAssemble(),
      providers: ['claude'],
      removeMcpKeys,
    })
    expect(first.migrated).toBe(false)
    const journalAfterFail = readJournal(journalPathFor('my-app'))
    expect(journalAfterFail?.finishedAt).toBeUndefined()
    const failedEntry = journalAfterFail?.entries.find((e) => !e.executed)
    expect(failedEntry?.error).toMatch(/EACCES/)
    const executedBefore = journalAfterFail?.entries.filter((e) => e.executed).length ?? 0

    // Second startup: resumes ONLY the unexecuted remainder.
    const second = await migrateProject(project(), {
      assemble: populateWorkspaceOnAssemble(),
      providers: ['claude'],
      removeMcpKeys,
    })
    expect(second.migrated).toBe(true)
    const journalDone = readJournal(journalPathFor('my-app'))
    expect(journalDone?.finishedAt).toBeTruthy()
    expect(journalDone?.entries.filter((e) => e.executed).length).toBeGreaterThan(executedBefore)
  })
})
