// Forced migration of legacy repo-resident specrails-core installs
// (global-core-zero-friction / legacy-install-migration spec).
//
// A "legacy" project has core installed INSIDE the user's repo (the pre-
// relocation layout): `<repo>/.specrails/specrails-version` exists and the
// relocated workspace is not populated. Migration, per project and serialized:
//   1. assemble the relocated workspace from the bundled framework,
//   2. MOVE per-project state from `<repo>/.specrails/` (and provider
//      `agent-memory/`) into the workspace,
//   3. CLEAN the repo with a manifest — exact framework listing (from
//      `~/.specrails/framework/current`) UNION narrow historical patterns
//      (`sr-*` agents, `commands/{sr,specrails,opsx}`, `sr-*`/`specrails-*`
//      skills) that older core versions installed,
//   4. journal every action write-ahead to
//      `~/.specrails/projects/<slug>/migration-log.json` (fail-open, resumable).
//
// NEVER touched: `openspec/**`, `<providerDir>/worktrees/**`, `custom-*` files,
// user instruction files (CLAUDE.md/AGENTS.md/GEMINI.md), user settings, and
// `.mcp.json` keys we do not own (surgical key removal only).
//
// Kill switch: SPECRAILS_LEGACY_MIGRATION=false disables the whole sweep.

import * as fs from 'fs'
import * as path from 'path'
import { listAdapters } from './providers'
import { resolveHome } from './artifact-registry'
import { workspacePathFor } from './workspace-manager'
import { isWorkspacePopulated } from './workspace-resolution'
import { assembleProjectOffline } from './offline-assemble'
import { PluginManager } from './plugin-manager'
import { BUNDLED_PLUGINS } from './plugins'

export function isLegacyMigrationEnabled(): boolean {
  const v = (process.env.SPECRAILS_LEGACY_MIGRATION ?? '').toLowerCase()
  return v !== 'false' && v !== '0' && v !== 'off'
}

export interface MigrationProject {
  id: string
  slug: string
  path: string
}

export interface JournalEntry {
  action: 'move' | 'delete' | 'mcp-key-remove'
  src: string
  dest?: string
  reason: string
  executed: boolean
  error?: string
}

export interface MigrationJournal {
  schemaVersion: 1
  projectId: string
  repoPath: string
  startedAt: string
  finishedAt?: string
  entries: JournalEntry[]
}

export interface MigrationResult {
  projectId: string
  migrated: boolean
  skippedReason?: string
  error?: string
  journalPath?: string
}

export interface MigrationIO {
  /** Workspace assemble seam (defaults to the real offline assemble). */
  assemble?: (project: MigrationProject, providers: string[]) => Promise<void>
  /** Detected providers to assemble for (defaults to every registered adapter id). */
  providers?: string[]
  /** Mcp key removal seam (defaults to PluginManager.removeMcpServers). */
  removeMcpKeys?: (repoPath: string, keys: string[]) => Promise<void>
}

/** True when the project still runs from a repo-resident core install. */
export function isLegacyProject(project: MigrationProject): boolean {
  if (!fs.existsSync(path.join(project.path, '.specrails', 'specrails-version'))) return false
  return !isWorkspacePopulated(workspacePathFor(project.slug))
}

export function journalPathFor(slug: string): string {
  return path.join(resolveHome(), 'projects', slug, 'migration-log.json')
}

// ─── Manifest ────────────────────────────────────────────────────────────────

/** Legacy command namespaces older cores installed (deprecated `sr` included). */
const HISTORICAL_COMMAND_DIRS = ['sr', 'specrails', 'opsx']

function isFrameworkOwnedName(name: string): boolean {
  // Framework naming conventions ONLY — `custom-*`, `openspec-*` and any other
  // user/third-party name can never match.
  return name.startsWith('sr-') || name.startsWith('specrails-')
}

function listFrameworkRelPaths(providerDir: string, home: string): string[] {
  // Exact relative paths (under the provider dir) from the CURRENT framework
  // version — covers files the historical patterns don't (e.g. rules).
  const root = path.join(home, 'framework', 'current', providerDir)
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel)
      else out.push(childRel)
    }
  }
  walk(root, '')
  return out
}

/**
 * The repo paths (absolute) migration is allowed to delete. Exact framework
 * listing ∪ narrow historical patterns. Only existing paths are returned.
 */
export function buildCleanupManifest(repoPath: string, home = resolveHome()): Array<{ path: string; reason: string }> {
  const out: Array<{ path: string; reason: string }> = []
  const seen = new Set<string>()
  const add = (abs: string, reason: string) => {
    if (seen.has(abs)) return
    if (!fs.existsSync(abs)) return
    if (isProtectedPath(repoPath, abs)) return
    seen.add(abs)
    out.push({ path: abs, reason })
  }

  for (const adapter of listAdapters()) {
    const pd = path.join(repoPath, adapter.projectDirName)
    if (!fs.existsSync(pd)) continue

    // Historical pattern: framework agents.
    const agentsDir = path.join(pd, 'agents')
    try {
      for (const f of fs.readdirSync(agentsDir)) {
        if (isFrameworkOwnedName(f) && f.endsWith('.md')) {
          add(path.join(agentsDir, f), 'framework agent (sr-*)')
        }
      }
    } catch { /* no agents dir */ }

    // Historical pattern: framework command namespaces (whole dirs).
    for (const ns of HISTORICAL_COMMAND_DIRS) {
      add(path.join(pd, 'commands', ns), `framework command namespace (${ns})`)
    }

    // Historical pattern: framework skills (per-child, never openspec-*/custom-*).
    const skillsDir = path.join(pd, 'skills')
    try {
      for (const child of fs.readdirSync(skillsDir)) {
        if (isFrameworkOwnedName(child)) {
          add(path.join(skillsDir, child), 'framework skill (sr-*/specrails-*)')
        }
      }
    } catch { /* no skills dir */ }

    // Exact current-framework listing (covers rules and anything pattern-less).
    for (const rel of listFrameworkRelPaths(adapter.projectDirName, home)) {
      add(path.join(pd, rel), 'exact framework listing match')
    }
  }

  return out
}

/** Hard exclusions — checked even though the manifest never generates them. */
export function isProtectedPath(repoPath: string, abs: string): boolean {
  const rel = path.relative(repoPath, abs)
  if (rel.startsWith('..')) return true // outside the repo — never
  const parts = rel.split(path.sep)
  if (parts[0] === 'openspec') return true
  if (parts.includes('worktrees')) return true
  const base = path.basename(abs)
  if (base.startsWith('custom-')) return true
  if (base.startsWith('openspec')) return true
  if (['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'].includes(base)) return true
  if (base === 'settings.json' || base === 'settings.local.json') return true
  if (base === '.mcp.json') return true // handled surgically, never deleted
  return false
}

// ─── State move ──────────────────────────────────────────────────────────────

const STATE_ENTRIES = [
  'profiles',
  'local-tickets.json',
  'backlog-config.json',
  'state',
  'file-summaries',
  'plugins',
]

function planStateMoves(repoPath: string, workspace: string): Array<{ src: string; dest: string; reason: string }> {
  const moves: Array<{ src: string; dest: string; reason: string }> = []
  const repoSpecrails = path.join(repoPath, '.specrails')
  for (const entry of STATE_ENTRIES) {
    const src = path.join(repoSpecrails, entry)
    if (fs.existsSync(src)) {
      moves.push({ src, dest: path.join(workspace, '.specrails', entry), reason: `per-project state (${entry})` })
    }
  }
  // Provider agent-memory (real per-project state, never framework).
  for (const adapter of listAdapters()) {
    const src = path.join(repoPath, adapter.projectDirName, 'agent-memory')
    if (fs.existsSync(src)) {
      moves.push({ src, dest: path.join(workspace, adapter.projectDirName, 'agent-memory'), reason: 'agent memory' })
    }
  }
  return moves
}

function moveOverwriting(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  // Repo state is the REAL user data — it wins over freshly-seeded workspace
  // defaults (e.g. the seeded default profile).
  fs.rmSync(dest, { recursive: true, force: true })
  try {
    fs.renameSync(src, dest)
  } catch {
    // Cross-device fallback. JS traversal avoids Node 22's native Unicode copy
    // failure on Windows (nodejs/node#61878); non-forced clone mode protects file
    // overwrites too, before removing the source state.
    fs.cpSync(src, dest, { recursive: true, filter: () => true, mode: fs.constants.COPYFILE_FICLONE })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

// ─── Journal ─────────────────────────────────────────────────────────────────

function writeJournal(journalPath: string, journal: MigrationJournal): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true })
  const tmp = `${journalPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2), 'utf-8')
  fs.renameSync(tmp, journalPath)
}

export function readJournal(journalPath: string): MigrationJournal | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as MigrationJournal
    return parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.entries) ? parsed : null
  } catch {
    return null
  }
}

// ─── Per-project migration ───────────────────────────────────────────────────

export async function migrateProject(project: MigrationProject, io?: MigrationIO): Promise<MigrationResult> {
  const journalPath = journalPathFor(project.slug)

  // Resume path: a prior crash left unexecuted entries — re-attempt those only.
  const prior = readJournal(journalPath)
  const resuming = prior !== null && !prior.finishedAt && prior.entries.some((e) => !e.executed)

  if (!resuming && !isLegacyProject(project)) {
    return { projectId: project.id, migrated: false, skippedReason: 'not-legacy' }
  }

  const workspace = workspacePathFor(project.slug)

  // 1. Ensure the relocated workspace exists (idempotent, continue-on-error —
  //    the state move below is what flips the activation gate).
  if (!isWorkspacePopulated(workspace)) {
    const providers = io?.providers ?? listAdapters().map((a) => a.id)
    const assemble = io?.assemble
      ?? (async (p: MigrationProject, provs: string[]) => {
        await assembleProjectOffline({
          projectPath: p.path,
          slug: p.slug,
          desktopProjectId: p.id,
          providers: provs,
          continueOnError: true,
        })
      })
    try {
      await assemble(project, providers)
    } catch (err) {
      return {
        projectId: project.id,
        migrated: false,
        error: `workspace assemble failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // 2+3. Plan (write-ahead) then execute.
  const journal: MigrationJournal = resuming
    ? (prior as MigrationJournal)
    : {
        schemaVersion: 1,
        projectId: project.id,
        repoPath: project.path,
        startedAt: new Date().toISOString(),
        entries: [],
      }

  if (!resuming) {
    for (const m of planStateMoves(project.path, workspace)) {
      journal.entries.push({ action: 'move', src: m.src, dest: m.dest, reason: m.reason, executed: false })
    }
    for (const d of buildCleanupManifest(project.path)) {
      journal.entries.push({ action: 'delete', src: d.path, reason: d.reason, executed: false })
    }
    // The now-empty app-owned `.specrails/` residue (version marker etc.) —
    // fully ours by the reserved-paths contract.
    journal.entries.push({
      action: 'delete',
      src: path.join(project.path, '.specrails'),
      reason: 'app-owned .specrails residue',
      executed: false,
    })
    // Surgical .mcp.json cleanup: only bundled-plugin-owned keys.
    const ownedKeys = BUNDLED_PLUGINS.flatMap((p) => p.manifest.owns.mcpServers ?? [])
    if (ownedKeys.length > 0 && fs.existsSync(path.join(project.path, '.mcp.json'))) {
      journal.entries.push({
        action: 'mcp-key-remove',
        src: path.join(project.path, '.mcp.json'),
        reason: `plugin-owned mcp keys (${ownedKeys.join(', ')})`,
        executed: false,
      })
    }
    writeJournal(journalPath, journal) // write-ahead: plan on disk BEFORE deleting
  }

  const removeMcpKeys = io?.removeMcpKeys
    ?? (async (repoPath: string, keys: string[]) => {
      await PluginManager.removeMcpServers(repoPath, keys, 'claude')
    })

  for (const entry of journal.entries) {
    if (entry.executed) continue
    try {
      if (entry.action === 'move' && entry.dest) {
        if (fs.existsSync(entry.src)) moveOverwriting(entry.src, entry.dest)
      } else if (entry.action === 'delete') {
        if (isProtectedPath(project.path, entry.src)) throw new Error(`protected path: ${entry.src}`)
        fs.rmSync(entry.src, { recursive: true, force: true })
      } else if (entry.action === 'mcp-key-remove') {
        const ownedKeys = BUNDLED_PLUGINS.flatMap((p) => p.manifest.owns.mcpServers ?? [])
        await removeMcpKeys(project.path, ownedKeys)
      }
      entry.executed = true
      writeJournal(journalPath, journal)
    } catch (err) {
      // Fail-open: abort the remaining cleanup for this project. State already
      // moved keeps working (the activation gate prefers the workspace).
      entry.error = err instanceof Error ? err.message : String(err)
      writeJournal(journalPath, journal)
      return {
        projectId: project.id,
        migrated: false,
        error: `migration halted at ${entry.action} ${entry.src}: ${entry.error}`,
        journalPath,
      }
    }
  }

  journal.finishedAt = new Date().toISOString()
  writeJournal(journalPath, journal)
  return { projectId: project.id, migrated: true, journalPath }
}

// ─── Startup sweep ───────────────────────────────────────────────────────────

/**
 * Serialized background sweep over registered projects. Never throws; each
 * project's outcome is logged, failures surface once as a console warning
 * (non-blocking by design — the project keeps working either way).
 */
export async function runLegacyMigrationSweep(
  projects: MigrationProject[],
  io?: MigrationIO,
): Promise<MigrationResult[]> {
  if (!isLegacyMigrationEnabled()) return []
  const results: MigrationResult[] = []
  for (const project of projects) {
    try {
      const result = await migrateProject(project, io)
      results.push(result)
      if (result.migrated) {
        console.log(`[legacy-migration] migrated ${project.slug} (journal: ${result.journalPath})`)
      } else if (result.error) {
        console.warn(`[legacy-migration] ${project.slug}: ${result.error}`)
      }
    } catch (err) {
      results.push({
        projectId: project.id,
        migrated: false,
        error: err instanceof Error ? err.message : String(err),
      })
      console.warn(`[legacy-migration] ${project.slug} threw:`, err)
    }
  }
  return results
}
