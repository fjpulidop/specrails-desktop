import { repositoryLockKey } from './repo-lock'
import { getRailWorktree, isTerminalMergeState, updateRailWorktreeState, type MergeState } from './rail-worktrees-store'
import { removeWorktree, type GitRunner } from './worktree-manager'
import type { DbInstance } from './db'
import * as path from 'path'
import * as fs from 'fs'
import {
  matchesOverlayCleanupEvidence,
  matchesOverlayCleanupEvidenceAtPath,
  fingerprintOverlayCleanupPath,
  type OverlayCleanupEvidence,
} from './worktree-overlay'
import { authenticateWarmNodeModulesLinks } from './worktree-node-modules'

export interface ReleaseRailWorktreesInput {
  db: DbInstance
  git: GitRunner
  repoDir: string
  worktreeIds: string[]
  /** Terminal state to record for non-terminal rows after the worktree is removed. */
  state?: Extract<MergeState, 'released' | 'merged' | 'failed'>
  /** Injectable remover for focused settlement tests. */
  remove?: typeof removeWorktree
  /** Immutable settled HEAD per branch. Automatic cleanup is forbidden without
   * exact evidence for the worktree's recorded branch. */
  expectedHeadByBranch: ReadonlyMap<string, string>
  /** Fingerprinted overlay paths persisted in SQLite at settlement. Each proof
   * is checked against the live worktree before its path can be excluded. */
  overlayEvidenceByBranch: ReadonlyMap<string, readonly OverlayCleanupEvidence[]>
  /** Immutable settlement snapshot of gitignored paths per branch. A live
   * ignored path is release-safe ONLY when covered by this snapshot; absent
   * map/branch = no ignored authorization (legacy rows preserve as before). */
  settlementIgnoredByBranch?: ReadonlyMap<string, readonly string[]>
  /** Injectable live authenticator for the app-created warm-dependency links
   * (`node_modules` symlinks into the base checkout). Production omits it. */
  authenticateWarmLinks?: typeof authenticateWarmNodeModulesLinks
  /** Called exactly once for each persistent quarantine batch root before any
   * overlay is moved beneath it. One durable root discloses every child and
   * remains valid across crashes or later release failure. */
  onSafetyArchive?: (quarantinePath: string) => void | Promise<void>
  /** Deterministic race-test seams around the atomic source→quarantine rename.
   * Production callers omit them. */
  beforeOverlayQuarantine?: (sourcePath: string) => void | Promise<void>
  afterOverlayRename?: (sourcePath: string, quarantinePath: string) => void | Promise<void>
  afterOverlayQuarantine?: (quarantinePath: string) => void | Promise<void>
}

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i

export interface DurableBranchHeadRecord {
  branch: string
  finalSha?: string | null
  overlayExcludes?: string[]
  overlayCleanupEvidence?: OverlayCleanupEvidence[]
  /** Immutable settlement snapshot of gitignored paths (null = no capture). */
  settlementIgnoredPaths?: string[] | null
}

/** Collapse per-unit settlement evidence into one unambiguous immutable HEAD per
 * branch. Conflicting or malformed records intentionally yield no authorization. */
export function durableBranchHeads(records: readonly DurableBranchHeadRecord[]): Map<string, string> {
  const heads = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const record of records) {
    const sha = record.finalSha?.trim().toLowerCase() ?? ''
    if (!record.branch || !COMMIT_SHA_RE.test(sha) || conflicted.has(record.branch)) continue
    const existing = heads.get(record.branch)
    if (existing && existing !== sha) {
      heads.delete(record.branch)
      conflicted.add(record.branch)
      continue
    }
    heads.set(record.branch, sha)
  }
  return heads
}

function safeRelativeOverlayPath(value: string): string | null {
  if (process.platform === 'win32' && value.includes('\\')) return null
  if (value.split('/').includes('..')) return null
  const normalized = path.posix.normalize(value)
  if (
    !normalized || normalized === '.' || normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized) || normalized.includes('\0')
  ) return null
  return normalized
}

/** Collapse persisted overlay fingerprints. Conflicting evidence for the same
 * branch/path grants no exclusion permission. */
export function durableOverlayCleanupEvidence(
  records: readonly DurableBranchHeadRecord[],
): Map<string, readonly OverlayCleanupEvidence[]> {
  const byBranch = new Map<string, Map<string, OverlayCleanupEvidence>>()
  const conflicted = new Map<string, Set<string>>()
  for (const record of records) {
    if (!record.branch || !Array.isArray(record.overlayCleanupEvidence)) continue
    const branchEvidence = byBranch.get(record.branch) ?? new Map<string, OverlayCleanupEvidence>()
    const branchConflicts = conflicted.get(record.branch) ?? new Set<string>()
    for (const value of record.overlayCleanupEvidence) {
      if (!value || typeof value.path !== 'string' || typeof value.digest !== 'string') continue
      if (value.kind !== 'symlink' && value.kind !== 'file' && value.kind !== 'directory') continue
      const safe = safeRelativeOverlayPath(value.path)
      if (!safe || !/^[0-9a-f]{64}$/.test(value.digest) || branchConflicts.has(safe)) continue
      const normalized = { path: safe, kind: value.kind, digest: value.digest }
      const existing = branchEvidence.get(safe)
      if (existing && (existing.kind !== normalized.kind || existing.digest !== normalized.digest)) {
        branchEvidence.delete(safe)
        branchConflicts.add(safe)
        continue
      }
      branchEvidence.set(safe, normalized)
    }
    byBranch.set(record.branch, branchEvidence)
    conflicted.set(record.branch, branchConflicts)
  }
  return new Map([...byBranch].map(([branch, values]) => [branch, [...values.values()]]))
}

/** Collapse persisted settlement ignored-path snapshots per branch. The same
 * conservative rules as overlay evidence: malformed paths, a failed capture
 * (null), or conflicting per-branch snapshots grant NO authorization. */
export function durableSettlementIgnoredPaths(
  records: readonly DurableBranchHeadRecord[],
): Map<string, readonly string[]> {
  const byBranch = new Map<string, string[] | null>()
  for (const record of records) {
    if (!record.branch || record.settlementIgnoredPaths === undefined) continue
    const prior = byBranch.get(record.branch)
    if (prior === null) continue // already poisoned
    if (record.settlementIgnoredPaths === null) { byBranch.set(record.branch, null); continue }
    if (!Array.isArray(record.settlementIgnoredPaths)) { byBranch.set(record.branch, null); continue }
    const safe: string[] = []
    let valid = true
    for (const value of record.settlementIgnoredPaths) {
      const normalized = typeof value === 'string' ? safeRelativeOverlayPath(value.replace(/\/$/, '')) : null
      if (!normalized) { valid = false; break }
      safe.push(normalized)
    }
    if (!valid) { byBranch.set(record.branch, null); continue }
    const sorted = [...new Set(safe)].sort()
    if (prior === undefined) { byBranch.set(record.branch, sorted); continue }
    if (prior.join('\0') !== sorted.join('\0')) byBranch.set(record.branch, null)
  }
  return new Map(
    [...byBranch].flatMap(([branch, paths]) => (paths === null ? [] : [[branch, paths] as const])),
  )
}

function coveredBySnapshot(livePath: string, snapshot: readonly string[]): boolean {
  const live = livePath.replace(/\/$/, '')
  return snapshot.some((entry) => live === entry || live.startsWith(`${entry}/`))
}

interface VerifiedReleaseEvidence {
  failure: string | null
  overlayEntries: OverlayCleanupEvidence[]
  /** True when Git could not inspect the worktree AND the path is absent from
   * the filesystem — the mount was removed externally; nothing to preserve. */
  gone?: boolean
}

async function verifyReleaseEvidence(
  input: ReleaseRailWorktreesInput,
  worktree: NonNullable<ReturnType<typeof getRailWorktree>>,
): Promise<VerifiedReleaseEvidence> {
  const expected = input.expectedHeadByBranch.get(worktree.branch)?.toLowerCase()
  if (!expected || !COMMIT_SHA_RE.test(expected)) {
    return { failure: 'no durable settled HEAD is recorded for its branch', overlayEntries: [] }
  }
  const persistedEntries = (input.overlayEvidenceByBranch.get(worktree.branch) ?? [])
    .filter((entry) => matchesOverlayCleanupEvidence(worktree.worktree_path, entry))
  // Warm-dependency links are authenticated LIVE against the base repo, on top
  // of whatever was persisted. Two reasons this is derived and not persisted-
  // only: a repo's ordinary `node_modules/` DIRECTORY ignore pattern does not
  // ignore a SYMLINK of that name, so the link reads as untracked dirt and
  // permanently blocked release (and therefore branch checkout); and worktrees
  // that settled before the links carried evidence are stuck at `needs-review`
  // where no persisted fix could ever reach them. The proof is identical to the
  // persisted one — a symlink resolving to the base checkout's identically-
  // named dependency directory — so nothing weaker is being accepted here.
  const warmEntries = (input.authenticateWarmLinks ?? authenticateWarmNodeModulesLinks)(
    input.repoDir,
    worktree.worktree_path,
  )
  const seenPaths = new Set(persistedEntries.map((entry) => entry.path))
  const overlayEntries = [
    ...persistedEntries,
    ...warmEntries.filter((entry) => !seenPaths.has(entry.path)),
  ]
  const overlayExcludes = overlayEntries.map((entry) => entry.path)

  try {
    const status = await input.git.run(
      [
        'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', '.',
        ...overlayExcludes.map((entry) => `:(top,exclude,literal)${entry}`),
      ],
      worktree.worktree_path,
    )
    if (status.code !== 0) {
      if (!pathStillExists(worktree.worktree_path)) return { failure: null, overlayEntries: [], gone: true }
      return { failure: 'Git could not verify worktree cleanliness', overlayEntries: [] }
    }
    // Partition: tracked/untracked entries are unconditional dirt (unchanged
    // strictness); gitignored entries are release-safe ONLY when the immutable
    // settlement snapshot already contained them — run-created build caches
    // release cleanly, anything ignored that APPEARED after settlement (a
    // user-parked file) preserves the worktree exactly as before.
    const statusLines = status.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean)
    const dirtyLines = statusLines.filter((line) => !line.startsWith('!! '))
    if (dirtyLines.length > 0) return { failure: 'the worktree contains changes made after settlement', overlayEntries: [] }
    const ignoredPaths = statusLines.filter((line) => line.startsWith('!! ')).map((line) => line.slice(3))
    if (ignoredPaths.length > 0) {
      const snapshot = input.settlementIgnoredByBranch?.get(worktree.branch)
      if (!snapshot) {
        return { failure: 'the worktree contains ignored paths and no settlement snapshot authorizes them', overlayEntries: [] }
      }
      const uncovered = ignoredPaths.filter((livePath) => !coveredBySnapshot(livePath, snapshot))
      if (uncovered.length > 0) {
        return { failure: `the worktree contains ignored paths that appeared after settlement (${uncovered.slice(0, 3).join(', ')})`, overlayEntries: [] }
      }
      // A snapshot records names, not bytes. Files under an existing ignored
      // directory may have been edited or added since settlement. Git's
      // non-force worktree removal still deletes ignored content, so preserve
      // every authorized ignored root in the same lossless quarantine used
      // for overlays before releasing the mount.
      for (const ignoredPath of ignoredPaths) {
        const relative = safeRelativeOverlayPath(ignoredPath.replace(/\/$/, ''))
        if (!relative) return { failure: 'Git reported an unsafe ignored path', overlayEntries: [] }
        const target = path.join(worktree.worktree_path, ...relative.split('/'))
        if (!pathStillExists(target)) continue
        const fingerprint = fingerprintOverlayCleanupPath(target)
        if (!fingerprint) return { failure: `could not preserve ignored path ${relative}`, overlayEntries: [] }
        overlayEntries.push({ path: relative, ...fingerprint })
      }
    }

    const [head, branchRef] = await Promise.all([
      input.git.run(['rev-parse', '--verify', 'HEAD'], worktree.worktree_path),
      input.git.run(['rev-parse', '--verify', `refs/heads/${worktree.branch}`], input.repoDir),
    ])
    const headSha = head.code === 0 ? head.stdout.trim().toLowerCase() : ''
    const branchSha = branchRef.code === 0 ? branchRef.stdout.trim().toLowerCase() : ''
    if (!COMMIT_SHA_RE.test(headSha) || !COMMIT_SHA_RE.test(branchSha)) {
      return { failure: 'Git could not verify the worktree HEAD and recorded branch ref', overlayEntries: [] }
    }
    if (headSha !== expected || branchSha !== expected) {
      return { failure: `HEAD/ref moved after settlement (expected ${expected.slice(0, 12)})`, overlayEntries: [] }
    }
    return { failure: null, overlayEntries }
  } catch (err) {
    if (!pathStillExists(worktree.worktree_path)) return { failure: null, overlayEntries: [], gone: true }
    return { failure: `verification failed: ${err instanceof Error ? err.message : String(err)}`, overlayEntries: [] }
  }
}

function pathStillExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

interface QuarantinedOverlayEntry {
  sourcePath: string
  quarantinePath: string
  evidence: OverlayCleanupEvidence
}

interface OverlayQuarantineResult {
  failure: string | null
  entries: QuarantinedOverlayEntry[]
}

function quarantineLocationNotes(entries: readonly QuarantinedOverlayEntry[]): string[] {
  return entries
    .filter((entry) => pathStillExists(entry.quarantinePath))
    .map((entry) => `overlay data is preserved at ${entry.quarantinePath}`)
}

/** Atomically move fingerprint-matching, untracked overlay roots out of the
 * worktree. Quarantine is a unique sibling on the same filesystem. It is never
 * automatically deleted or restored: writes through an already-open fd after
 * rename remain recoverable, and a concurrently recreated source can never be
 * overwritten by rollback. */
async function quarantineVerifiedOverlayEntries(
  input: ReleaseRailWorktreesInput,
  worktree: NonNullable<ReturnType<typeof getRailWorktree>>,
  evidence: readonly OverlayCleanupEvidence[],
): Promise<OverlayQuarantineResult> {
  const removable: OverlayCleanupEvidence[] = []
  for (const entry of evidence) {
    const target = path.join(worktree.worktree_path, ...entry.path.split('/'))
    if (!pathStillExists(target)) continue
    const tracked = await input.git.run(
      ['ls-files', '--error-unmatch', '--', entry.path],
      worktree.worktree_path,
    )
    if (tracked.code === 0) continue
    if (tracked.code !== 1) {
      return { failure: `Git could not verify ownership of overlay path ${entry.path}`, entries: [] }
    }
    if (!matchesOverlayCleanupEvidence(worktree.worktree_path, entry)) {
      return { failure: `overlay path ${entry.path} changed after cleanup verification`, entries: [] }
    }
    removable.push(entry)
  }

  const cleanupRoots: OverlayCleanupEvidence[] = []
  for (const entry of [...removable].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (cleanupRoots.some((root) => root.kind === 'directory' && entry.path.startsWith(`${root.path}/`))) continue
    cleanupRoots.push(entry)
  }
  if (cleanupRoots.length === 0) return { failure: null, entries: [] }

  let quarantineRoot: string
  try {
    // mkdtemp creates the batch directory atomically beside the worktree. The
    // ensuing rename therefore remains within one filesystem.
    quarantineRoot = fs.mkdtempSync(`${worktree.worktree_path}.specrails-overlay-quarantine-`)
  } catch (err) {
    return {
      failure: `could not create overlay quarantine beside ${worktree.worktree_path}: ${err instanceof Error ? err.message : String(err)}`,
      entries: [],
    }
  }

  try {
    await input.onSafetyArchive?.(quarantineRoot)
  } catch (err) {
    return {
      failure: `could not record safety archive ${quarantineRoot}: ${err instanceof Error ? err.message : String(err)}`,
      entries: [],
    }
  }

  const quarantined: QuarantinedOverlayEntry[] = []
  for (const entry of cleanupRoots) {
    const sourcePath = path.join(worktree.worktree_path, ...entry.path.split('/'))
    if (!pathStillExists(sourcePath)) continue
    if (!matchesOverlayCleanupEvidenceAtPath(sourcePath, entry)) {
      return { failure: `overlay path ${entry.path} changed before quarantine`, entries: quarantined }
    }
    const quarantinePath = path.join(quarantineRoot, ...entry.path.split('/'))
    try {
      fs.mkdirSync(path.dirname(quarantinePath), { recursive: true })
      await input.beforeOverlayQuarantine?.(sourcePath)
      fs.renameSync(sourcePath, quarantinePath)
    } catch (err) {
      return {
        failure: `could not quarantine overlay path ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
        entries: quarantined,
      }
    }
    const moved = { sourcePath, quarantinePath, evidence: entry }
    quarantined.push(moved)
    try {
      await input.afterOverlayRename?.(sourcePath, quarantinePath)
    } catch (err) {
      return {
        failure: `overlay post-rename hook failed at ${quarantinePath}: ${err instanceof Error ? err.message : String(err)}`,
        entries: quarantined,
      }
    }
    if (!matchesOverlayCleanupEvidenceAtPath(quarantinePath, entry)) {
      return {
        failure: `overlay path ${entry.path} changed during atomic quarantine at ${quarantinePath}`,
        entries: quarantined,
      }
    }
    try {
      await input.afterOverlayQuarantine?.(quarantinePath)
    } catch (err) {
      return {
        failure: `overlay quarantine hook failed at ${quarantinePath}: ${err instanceof Error ? err.message : String(err)}`,
        entries: quarantined,
      }
    }
  }
  return { failure: null, entries: quarantined }
}

/** Remove Specrails-managed linked worktrees while keeping their local branches.
 *  PR deliveries use this once the work has a durable remote branch/PR: the
 *  branch remains available for local checkout, but the internal worktree stops
 *  blocking `git switch <branch>` in the user's main checkout. */
export async function releaseRailWorktrees(input: ReleaseRailWorktreesInput): Promise<string[]> {
  const state = input.state ?? 'released'
  const remove = input.remove ?? removeWorktree
  const warnings: string[] = []
  for (const wtId of input.worktreeIds) {
    const wt = getRailWorktree(input.db, wtId)
    if (!wt) continue
    if (wt.repository_path && repositoryLockKey(wt.repository_path) !== repositoryLockKey(input.repoDir)) {
      warnings.push(`worktree ${wtId} belongs to a different repository; preserved`)
      continue
    }
    const recordRemoved = (): void => {
      input.db.transaction(() => {
        updateRailWorktreeState(input.db, wt.id, state)
        // Revisions can borrow the same mount under a new ledger id. Once Git
        // proves that mount removed, older records must not pin membership forever.
        input.db.prepare(`UPDATE rail_worktrees SET merge_state = 'released', updated_at = datetime('now')
          WHERE id <> ? AND worktree_path = ? AND repository_id IS ?
            AND merge_state IN ('building','built','merging','needs-review')`).run(wt.id, wt.worktree_path, wt.repository_id ?? null)
      })()
    }
    // Successful removal already terminalized these rows. Re-running `git
    // worktree remove` against their now-missing paths turns ordinary Publish /
    // Poll / Discard follow-ups into false cleanup_incomplete warnings.
    if (wt.merge_state !== 'needs-review' && isTerminalMergeState(wt.merge_state)) continue
    const evidence = await verifyReleaseEvidence(input, wt)
    // The mount is already GONE (the user ran `git worktree remove` manually,
    // or an external prune cleaned it): Git could not even inspect the path
    // AND the filesystem confirms it is absent. There are no bytes left to
    // preserve — failing verification forever would permanently block Checkout
    // on a branch that is actually free. Prune the stale registration
    // (best-effort; prune only drops entries whose dir is missing) and
    // terminalize the ledger row honestly.
    if (evidence.gone) {
      try { await input.git.run(['worktree', 'prune'], input.repoDir) } catch { /* a leftover registration surfaces at checkout with git's own error */ }
      recordRemoved()
      continue
    }
    if (evidence.failure) {
      updateRailWorktreeState(input.db, wt.id, 'needs-review')
      const warning = `worktree ${wt.worktree_path}: preserved because ${evidence.failure}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] ${warning}`)
      continue
    }
    const quarantine = await quarantineVerifiedOverlayEntries(input, wt, evidence.overlayEntries)
    if (quarantine.failure) {
      updateRailWorktreeState(input.db, wt.id, 'needs-review')
      const warning = `worktree ${wt.worktree_path}: preserved because ${[
        quarantine.failure,
        ...quarantineLocationNotes(quarantine.entries),
      ].join('; ')}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] ${warning}`)
      continue
    }
    // Quarantining changes the worktree. Re-prove both cleanliness and HEAD/ref
    // identity immediately before asking Git for its final non-force guard.
    const finalEvidence = await verifyReleaseEvidence(input, wt)
    if (finalEvidence.failure) {
      updateRailWorktreeState(input.db, wt.id, 'needs-review')
      const warning = `worktree ${wt.worktree_path}: preserved because ${[
        finalEvidence.failure,
        ...quarantineLocationNotes(quarantine.entries),
      ].join('; ')}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] ${warning}`)
      continue
    }
    try {
      await remove(input.git, {
        repoDir: input.repoDir,
        worktreePath: wt.worktree_path,
        branch: wt.branch,
        deleteBranch: false,
        force: false,
      })
    } catch (err) {
      const current = getRailWorktree(input.db, wt.id)
      if (current && current.merge_state !== 'needs-review' && isTerminalMergeState(current.merge_state)) {
        continue
      }
      updateRailWorktreeState(input.db, wt.id, 'needs-review')
      const warning = `worktree ${wt.worktree_path}: ${[
        err instanceof Error ? err.message : String(err),
        ...quarantineLocationNotes(quarantine.entries),
      ].join('; ')}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] failed to remove ${warning}`)
      continue
    }
    if (wt.merge_state === 'needs-review' || !isTerminalMergeState(wt.merge_state)) {
      recordRemoved()
    }
  }
  return warnings
}
