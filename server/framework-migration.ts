import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { frameworkRoot, FrameworkManager } from './framework-manager'
import { assembleWorkspaceFramework, workspacePathFor } from './workspace-manager'
import { withFileLock } from './artifact-registry'
import { getAdapter } from './providers'

/**
 * framework-migration — non-destructively convert a workspace that holds a REAL
 * per-workspace COPY of the framework (the layout the pre-bundled relocate-core
 * produced) into one that SYMLINKS `~/.specrails/framework/current/<provider>/`.
 *
 * Once every workspace links `current`, an app update is a single atomic swap of
 * `current` — no per-workspace work. A migratable copy is detected by hashing the
 * shared static subtrees of the workspace providerDir against
 * `framework/current/<providerDir>/...`. The exact roots are provider-aware:
 * Kimi's `skills/` is deliberately a real merged directory whose framework
 * children are linked per-skill alongside user/OpenSpec skills, so migration
 * never renames or verifies that root as a whole.
 *
 * SAFETY (this module NEVER deletes a user edit):
 *  - Local divergence guard: if ANY shared framework file in the copy differs
 *    from `framework/current` (the user edited it), migration is SKIPPED — the
 *    copy is left exactly as-is and `framework.migration_skipped` is emitted.
 *    `custom-*.md` agents are EXPECTED (user/plugin agents) and are ignored by
 *    the comparison — they survive untouched.
 *  - Backup-before-mutate: the copied subtrees are renamed to `<sub>.pre-symlink.bak`
 *    (never deleted) before re-linking.
 *  - Verify + revert: after re-linking via `assembleWorkspaceFramework`, the new
 *    symlinks are verified to resolve INTO `framework/current`. On success the
 *    `.bak` is deleted; on ANY failure the `.bak` is restored (full revert) and
 *    `framework.migration_skipped` is emitted with the failure reason.
 *  - `agent-memory/` (real, writable per-workspace state) is preserved by
 *    `assembleWorkspaceFramework` (it re-creates it as a real dir and never links
 *    it); we also move it out of the backup into the live layout if needed.
 *
 * Idempotent: a workspace already symlinked is a no-op. Existence-gated: with no
 * bundled core / no materialized `framework/current`, every call no-ops.
 */

export type MigrationBroadcast = (msg: { type: string; [k: string]: unknown }) => void

export interface MigrateOptions {
  home?: string
  /** App-level WS broadcast (no projectId) for observability. */
  broadcast?: MigrationBroadcast
  /** Injectable FrameworkManager (tests). */
  framework?: FrameworkManager
}

export type MigrationOutcome =
  | 'no-bundle' // no bundled core / no framework/current
  | 'already-symlinked' // providerDir already links the framework
  | 'not-a-copy' // not the migratable real-copy layout
  | 'skipped-divergence' // user edited a shared framework file → left as-is
  | 'migrated' // copy → symlink succeeded
  | 'reverted' // verify failed → backup restored

export interface MigrationResult {
  outcome: MigrationOutcome
  /** Path that diverged / failed, for `skipped-divergence` / `reverted`. */
  detail?: string
  /** The subtrees that were backed up (and either kept or restored). */
  backedUp?: string[]
}

/** Whole-directory shared subtrees for the legacy providers. `agent-memory` is
 * intentionally absent — it is real per-workspace state, never compared/linked. */
const SHARED_SUBTREES = ['commands', 'agents', 'skills', 'rules'] as const

/**
 * Roots that core assembles as whole-directory framework links.
 *
 * Kimi is intentionally special: `.kimi-code/skills` remains a REAL directory
 * and core links only the framework-owned children within it. That merged layout
 * is what lets Kimi keep OpenSpec skills and desktop-authored `custom-*` roles
 * as direct children. Treating the root as a copied shared subtree would back it up,
 * expect a root symlink that core will never create, then revert every launch.
 */
function sharedSubtreesFor(provider: string): readonly string[] {
  return provider === 'kimi' ? ['rules'] : SHARED_SUBTREES
}

/** Map a provider id to its providerDir name (mirrors core). */
export function providerDirFor(provider: string): string {
  try {
    return getAdapter(provider).projectDirName
  } catch {
    return '.claude'
  }
}

/** sha256 of a file's bytes, or null when unreadable. */
function hashFile(p: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}

/** True when `p` is a symbolic link. */
function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** True when `p` is a real (non-symlink) directory. */
function isRealDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/** Recursively list relative file paths under `dir` (dirs flattened to files). */
function listFilesRel(dir: string, base = dir): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue // a symlink inside a copy is not a real file to compare
    if (e.isDirectory()) {
      out.push(...listFilesRel(abs, base))
    } else if (e.isFile()) {
      out.push(path.relative(base, abs))
    }
  }
  return out
}

/** A file is a user/plugin custom agent (expected, never part of the framework). */
function isCustomAgent(rel: string): boolean {
  return path.basename(rel).startsWith('custom-')
}

interface CompareResult {
  /** True when EVERY shared framework file in the copy matches `current`. */
  matches: boolean
  /** The first diverged/missing file (relative to the providerDir), when any. */
  diverged?: string
  /** True when the providerDir actually held at least one shared real subtree. */
  hadSharedSubtree: boolean
}

/**
 * Compare the workspace providerDir's shared subtrees against
 * `framework/current/<providerDir>/...`. A file present in the copy that differs
 * from (or is missing in) `current` — excluding `custom-*` agents — counts as
 * local divergence.
 */
function compareSharedSubtrees(
  workspaceProviderDir: string,
  fwProviderDir: string,
  subtrees: readonly string[],
): CompareResult {
  let hadSharedSubtree = false
  for (const sub of subtrees) {
    const copyDir = path.join(workspaceProviderDir, sub)
    if (!isRealDir(copyDir)) continue
    hadSharedSubtree = true
    const fwSub = path.join(fwProviderDir, sub)
    for (const rel of listFilesRel(copyDir)) {
      if (sub === 'agents' && isCustomAgent(rel)) continue // expected, ignore
      const copyHash = hashFile(path.join(copyDir, rel))
      const fwHash = hashFile(path.join(fwSub, rel))
      if (copyHash === null || fwHash === null || copyHash !== fwHash) {
        return { matches: false, diverged: path.join(sub, rel), hadSharedSubtree }
      }
    }
  }
  return { matches: hadSharedSubtree, hadSharedSubtree }
}

/** Resolve a symlink target absolutely (or null). */
function readlinkAbs(p: string): string | null {
  try {
    const t = fs.readlinkSync(p)
    return path.isAbsolute(t) ? t : path.resolve(path.dirname(p), t)
  } catch {
    return null
  }
}

/** True when `linkPath` resolves into `<frameworkCurrent>/...`. */
function linkResolvesIntoFramework(linkPath: string, fwCurrent: string): boolean {
  if (!isSymlink(linkPath)) return false
  const target = readlinkAbs(linkPath)
  if (!target) return false
  const norm = path.resolve(target)
  const base = path.resolve(fwCurrent) + path.sep
  return norm === path.resolve(fwCurrent) || norm.startsWith(base)
}

const BAK_SUFFIX = '.pre-symlink.bak'

/**
 * Convert a workspace's per-workspace framework COPY into symlinks to
 * `framework/current`. See the module docstring for the full safety contract.
 *
 * Runs the whole detect → backup → re-link → verify → cleanup/revert sequence
 * under the registry file-lock so it never races a concurrent framework swap.
 */
export function migrateWorkspaceToSymlinks(
  slug: string,
  projectPath: string,
  provider: string,
  opts: MigrateOptions = {},
): MigrationResult {
  const fm = opts.framework ?? new FrameworkManager({ home: opts.home })
  const fwCurrent = path.join(frameworkRoot(opts.home), 'current')

  // Existence-gate: with no bundled core OR no materialized `current`, no-op.
  if (!fm.isAvailable() || !fs.existsSync(fwCurrent)) {
    return { outcome: 'no-bundle' }
  }

  return withFileLock(opts.home, () =>
    runMigration(slug, projectPath, provider, fwCurrent, fm, opts),
  )
}

function emit(broadcast: MigrationBroadcast | undefined, type: string, extra: Record<string, unknown>): void {
  try {
    broadcast?.({ type, ...extra })
  } catch {
    /* observability is best-effort */
  }
}

function runMigration(
  slug: string,
  projectPath: string,
  provider: string,
  fwCurrent: string,
  fm: FrameworkManager,
  opts: MigrateOptions,
): MigrationResult {
  const providerDir = providerDirFor(provider)
  const ws = workspacePathFor(slug, opts.home)
  const wsProviderDir = path.join(ws, providerDir)
  const fwProviderDir = path.join(fwCurrent, providerDir)
  const sharedSubtrees = sharedSubtreesFor(provider)

  // Idempotent: if any shared subtree is already a symlink into `current`, the
  // workspace is migrated — no-op.
  for (const sub of sharedSubtrees) {
    if (linkResolvesIntoFramework(path.join(wsProviderDir, sub), fwCurrent)) {
      return { outcome: 'already-symlinked' }
    }
  }

  // Detect the migratable real-copy layout + the local-divergence guard.
  const cmp = compareSharedSubtrees(wsProviderDir, fwProviderDir, sharedSubtrees)
  if (!cmp.hadSharedSubtree) {
    return { outcome: 'not-a-copy' }
  }
  if (!cmp.matches) {
    emit(opts.broadcast, 'framework.migration_skipped', { slug, provider, reason: 'local-divergence', path: cmp.diverged })
    return { outcome: 'skipped-divergence', detail: cmp.diverged }
  }

  // ── Backup the copied shared subtrees (never delete). ──────────────────────
  const backedUp: Array<{ live: string; bak: string }> = []
  for (const sub of sharedSubtrees) {
    const live = path.join(wsProviderDir, sub)
    if (!isRealDir(live)) continue
    const bak = live + BAK_SUFFIX
    try {
      // Clear a stale backup from a prior aborted run.
      if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      fs.renameSync(live, bak)
      backedUp.push({ live, bak })
    } catch (err) {
      // Could not back up — revert anything already moved and bail (no mutation).
      restoreBackups(backedUp)
      emit(opts.broadcast, 'framework.migration_skipped', { slug, provider, reason: 'backup-failed', path: sub, error: (err as Error).message })
      return { outcome: 'skipped-divergence', detail: `backup-failed:${sub}` }
    }
  }

  // ── Re-link via core's offline assemble (re-creates symlinks + agent-memory). ─
  let assembled = false
  try {
    const res = assembleWorkspaceFramework(slug, projectPath, provider, {
      home: opts.home,
      framework: fm,
      _skipMigrate: true,
    })
    assembled = res.assembled && !res.error
  } catch {
    assembled = false
  }

  // ── Preserve agent-memory: if a real agent-memory survived only in a backup,
  // move it into the live layout (assemble seeds an empty one; the user's
  // existing memory must win). ────────────────────────────────────────────────
  preserveAgentMemory(wsProviderDir, backedUp)

  // ── Verify the new symlinks resolve INTO framework/current. ────────────────
  // Use `.every()` (not `.some()`): EVERY shared subtree that was backed up must
  // re-link into `current` before we trust the migration. With `.some()` a single
  // linked subtree passed verify while siblings could be broken/missing, yet the
  // unconditional cleanup below would still delete their byte-identical backups.
  // Only consider the subtrees we actually backed up (a workspace need not hold
  // all four) — a `.some`-vs-`.every` distinction only matters across those.
  const verified =
    assembled &&
    backedUp.every(({ live }) => linkResolvesIntoFramework(live, fwCurrent))

  if (!verified) {
    // REVERT: remove any freshly-created (broken) symlinks/dirs, restore backups.
    for (const { live } of backedUp) {
      try {
        if (fs.existsSync(live) || isSymlink(live)) fs.rmSync(live, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* best-effort */
      }
    }
    restoreBackups(backedUp)
    emit(opts.broadcast, 'framework.migration_skipped', { slug, provider, reason: 'verify-failed' })
    return { outcome: 'reverted', detail: 'verify-failed', backedUp: backedUp.map((b) => b.live) }
  }

  // ── Success cleanup. The shared framework files in each backup were proven
  // byte-identical to `current` by the divergence guard, so deleting them loses
  // nothing. EXCEPTION: a backup may also carry `custom-*` agent files (user /
  // plugin agents that are NOT part of the framework and were ignored by the
  // guard). The live `agents` is now a symlink into the read-only framework, so
  // those custom files have no home there — we must NOT delete them. We retain
  // any backup that holds custom-* content under `<sub>.custom.preserved/` and
  // surface a `framework.custom_agents_preserved` event for observability;
  // backups with only shared framework files are deleted. ──────────────────────
  const preservedCustom: string[] = []
  for (const { live, bak } of backedUp) {
    const customs = listFilesRel(bak).filter(isCustomAgent)
    if (customs.length > 0) {
      const preserved = live + '.custom.preserved'
      try {
        if (fs.existsSync(preserved)) fs.rmSync(preserved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        fs.renameSync(bak, preserved)
        preservedCustom.push(...customs.map((c) => path.basename(c)))
      } catch {
        /* keep the .bak as-is if we cannot rename — still non-destructive */
      }
    } else if (linkResolvesIntoFramework(live, fwCurrent)) {
      // Defense-in-depth: only delete a backup once its corresponding live path
      // is a VERIFIED symlink into `current`. The `.every()` verify above already
      // proves this for every backed-up subtree, but re-checking per-`.bak` here
      // means a future regression that leaves one subtree un-linked can never
      // drop that subtree's recoverable backup — the stale `.bak` is retained.
      try {
        fs.rmSync(bak, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* leaving a stale .bak is harmless; never fail the migration on cleanup */
      }
    }
    /* else: live is NOT a verified link — retain the .bak (recoverable). */
  }
  if (preservedCustom.length > 0) {
    emit(opts.broadcast, 'framework.custom_agents_preserved', { slug, provider, files: preservedCustom })
  }
  emit(opts.broadcast, 'framework.migrated', { slug, provider, version: fm.bundledVersion() })
  return { outcome: 'migrated', backedUp: backedUp.map((b) => b.live) }
}

/** Restore each `<sub>.pre-symlink.bak` back to its live path (revert). */
function restoreBackups(backedUp: Array<{ live: string; bak: string }>): void {
  for (const { live, bak } of backedUp) {
    try {
      if (!fs.existsSync(bak)) continue
      if (fs.existsSync(live) || isSymlink(live)) fs.rmSync(live, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      fs.renameSync(bak, live)
    } catch {
      /* best-effort revert — a surviving .bak is recoverable by hand */
    }
  }
}

/**
 * Ensure the live `agent-memory/` holds the user's existing memory. If the
 * post-assemble layout has an empty/absent agent-memory but a backup carried a
 * populated one, move the backup's agent-memory into the live layout. Never
 * overwrites a non-empty live agent-memory.
 */
function preserveAgentMemory(wsProviderDir: string, backedUp: Array<{ bak: string }>): void {
  const liveMem = path.join(wsProviderDir, 'agent-memory')
  // agent-memory was NOT one of the backed-up shared subtrees (it's not in
  // SHARED_SUBTREES), so a copy-layout's agent-memory still sits at the live
  // path untouched. Nothing to move in the common case. This guard only handles
  // a future layout where agent-memory lived under a backed-up subtree.
  for (const { bak } of backedUp) {
    const bakMem = path.join(bak, 'agent-memory')
    if (!isRealDir(bakMem)) continue
    try {
      if (!fs.existsSync(liveMem)) {
        fs.renameSync(bakMem, liveMem)
      }
    } catch {
      /* best-effort */
    }
  }
}
