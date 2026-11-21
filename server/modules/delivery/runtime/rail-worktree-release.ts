import { repositoryLockKey } from '../../../repo-lock'
import { getRailWorktree, isTerminalMergeState, updateRailWorktreeState, type MergeState } from './rail-worktrees-store'
import { removeWorktree, type GitRunner } from '../../../worktree-manager'
import type { DbInstance } from '../../../db'
import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import {
  MANAGED_LOCAL_SETTINGS,
  OVERLAY_MANIFEST,
  isSpecrailsOnlyLocalSettings,
  matchesOverlayCleanupEvidence,
  matchesOverlayCleanupEvidenceAtPath,
  matchesOverlayManifestRecord,
  fingerprintOverlayCleanupPath,
  parseOverlayManifest,
  type OverlayCleanupEvidence,
  type OverlayManifestRecord,
} from '../../../worktree-overlay'
import { authenticateWarmNodeModulesLinks } from '../../../worktree-node-modules'
import { copiedEnvFilePaths } from '../../../worktree-env-files'
import { reapWorktreeLeftovers } from '../../terminals/runtime/worktree-process-reaper'
import { ignoredPathIsSafeCopy } from './ignored-copy-identity'
import { inspectIndexLock } from '../../../util/git-index-lock'

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
  /** Injectable reader of the env-file copies Specrails made. Production omits it. */
  copiedEnvFiles?: typeof copiedEnvFilePaths
  /** Called exactly once for each persistent quarantine batch root, before
   * anything that must be KEPT is moved beneath it. Never called when release
   * only removed Specrails's own unchanged kit (no folder survives then). One
   * durable root discloses every child and remains valid across crashes or
   * later release failure. */
  onSafetyArchive?: (quarantinePath: string) => void | Promise<void>
  /** Deterministic race-test seams around the atomic source→quarantine rename.
   * Production callers omit them. */
  beforeOverlayQuarantine?: (sourcePath: string) => void | Promise<void>
  afterOverlayRename?: (sourcePath: string, quarantinePath: string) => void | Promise<void>
  afterOverlayQuarantine?: (quarantinePath: string) => void | Promise<void>
  /** Retained-worktree cleanup (a person confirmed it) only: an ignored path
   * that is a link, or byte-identical to the same path in `repoDir`, loses
   * nothing and needs no snapshot authorization. Re-proven live here. */
  acceptIgnoredBaseCopies?: boolean
  /** Retained-worktree cleanup only: also remove a row already in a terminal
   * state whose mount is still on disk (an earlier removal failed). Such a row
   * keeps its recorded state; only the mount goes. */
  reclaimTerminalMounts?: boolean
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

/** Package-manager installs (`node_modules`, at any depth) are reproducible
 * from the committed lockfile: never user work. Local verification installs
 * them in every worktree, so they must not hold a delivered worktree hostage
 * when no settlement snapshot names them (CI-loop generations, legacy rows). */
export function isRegenerableIgnoredPath(livePath: string): boolean {
  return livePath.replace(/\/$/, '').split('/').includes('node_modules')
}

function coveredBySnapshot(livePath: string, snapshot: readonly string[]): boolean {
  const live = livePath.replace(/\/$/, '')
  return snapshot.some((entry) => live === entry || live.startsWith(`${entry}/`))
}

/** Why one path is provably Specrails's own unchanged kit, re-checked on the
 * live path and again on the moved copy before it is deleted. */
type DiscardProof =
  /** SQLite-persisted allocation fingerprint (source-authenticated at allocation and settlement). */
  | { via: 'evidence'; evidence: OverlayCleanupEvidence }
  /** What the overlay recorded writing (manifest v2), or a v1 link into a Specrails source. */
  | { via: 'record'; record: OverlayManifestRecord }
  /** v1 managed local settings holding nothing but Specrails-owned entries. */
  | { via: 'settings' }
  /** A copy of the person's env file (setting `worktreeEnvFiles`): deleted with
   * the worktree, never archived, whatever the run did to it. */
  | { via: 'env-copy' }

function proofHolds(target: string, rel: string, proof: DiscardProof): boolean {
  if (proof.via === 'evidence') return matchesOverlayCleanupEvidenceAtPath(target, proof.evidence)
  if (proof.via === 'record') return matchesOverlayManifestRecord(target, rel, proof.record)
  if (proof.via === 'env-copy') {
    try { return fs.lstatSync(target).isFile() } catch { return false }
  }
  return isSpecrailsOnlyLocalSettings(target)
}

interface VerifiedReleaseEvidence {
  failure: string | null
  /** Roots to clear out of the worktree before Git's non-force removal. */
  overlayEntries: OverlayCleanupEvidence[]
  /** Paths (roots or descendants) that are provably regenerable kit: removed, not archived. */
  discardable?: Map<string, DiscardProof>
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
  const discardable = new Map<string, DiscardProof>(overlayEntries.map((entry) => [entry.path, { via: 'evidence', evidence: entry }]))
  for (const entry of overlayEntries) seenPaths.add(entry.path)
  // Env-file copies (opt-in): the person's own files hold the bytes, and a
  // secret must never land in the safety archive, so they are discarded.
  for (const rel of (input.copiedEnvFiles ?? copiedEnvFilePaths)(worktree.worktree_path)) {
    if (seenPaths.has(rel)) continue
    const fingerprint = fingerprintOverlayCleanupPath(path.join(worktree.worktree_path, ...rel.split('/')))
    if (!fingerprint) continue
    overlayEntries.push({ path: rel, ...fingerprint })
    discardable.set(rel, { via: 'env-copy' })
    seenPaths.add(rel)
  }
  // Overlay paths whose allocation proof was revoked (the agent edited
  // CLAUDE.md, a source changed mid-run, a link was replaced): they never
  // reach the PR (commit exclusions), so they must not hold the worktree
  // hostage either. Only an UNCHANGED manifest (its own SQLite fingerprint
  // still matches) may name them; each is kept in the safety archive unless
  // the manifest's record proves it is still exactly what the overlay wrote.
  const revoked = await revokedOverlayPaths(input, worktree, persistedEntries, seenPaths)
  if (revoked.failure) return { failure: revoked.failure, overlayEntries: [] }
  for (const entry of revoked.entries) {
    overlayEntries.push(entry.root)
    if (entry.proof) discardable.set(entry.root.path, entry.proof)
  }
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
    if (dirtyLines.length > 0) {
      // The injected runner already waited for a live index.lock; one still
      // present means a writer is stuck or crashed mid-staging, so the dirt
      // may be a half-written index rather than new work. Say so.
      const lock = await inspectIndexLock(worktree.worktree_path)
      const lockNote = lock ? ` (Git's index is locked at ${lock.path}; a Git process may still be writing there, or crashed)` : ''
      return { failure: `the worktree contains changes made after settlement${lockNote}`, overlayEntries: [] }
    }
    // Regenerable dependency installs release without authorization and are
    // not quarantined (Git's worktree removal deletes them).
    let ignoredPaths = statusLines.filter((line) => line.startsWith('!! ')).map((line) => line.slice(3))
      .filter((livePath) => !isRegenerableIgnoredPath(livePath))
    if (input.acceptIgnoredBaseCopies && ignoredPaths.length > 0) {
      const safe = await Promise.all(ignoredPaths.map((livePath) => ignoredPathIsSafeCopy(worktree.worktree_path, input.repoDir, livePath)))
      ignoredPaths = ignoredPaths.filter((_livePath, index) => !safe[index])
    }
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
    return { failure: null, overlayEntries, discardable }
  } catch (err) {
    if (!pathStillExists(worktree.worktree_path)) return { failure: null, overlayEntries: [], gone: true }
    return { failure: `verification failed: ${err instanceof Error ? err.message : String(err)}`, overlayEntries: [] }
  }
}

const PROVIDER_DIRS = ['.claude', '.codex', '.gemini', '.kimi-code'] as const

/** The project's Specrails workspace (`<home>/.specrails/projects/<slug>/workspace`)
 * for a worktree beneath `<…>/projects/<slug>/worktrees/…`. Null otherwise. */
export function specrailsWorkspaceOf(worktreePath: string): string | null {
  const parts = path.resolve(worktreePath).split(path.sep)
  for (let index = parts.length - 2; index >= 3; index--) {
    if (parts[index] === 'worktrees' && parts[index - 2] === 'projects' && parts[index - 3] === '.specrails') {
      return [...parts.slice(0, index), 'workspace'].join(path.sep) || null
    }
  }
  return null
}

/** True when `target` lies inside a provider dir of one of the Specrails
 * overlay sources (the project workspace or the base checkout). */
function insideOverlaySource(target: string, sources: readonly string[]): boolean {
  return sources.some((source) => PROVIDER_DIRS.some((dir) => {
    const relative = path.relative(path.join(source, dir), target)
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  }))
}

/** Every component between the worktree and `rel` is a real directory, so a
 * rename of `rel` can never act through a link outside the worktree. */
function reachedWithoutLinks(worktreePath: string, rel: string): boolean {
  const parts = rel.split('/')
  let current = worktreePath
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    } catch {
      return false
    }
  }
  return true
}

interface RevokedOverlayPath { root: OverlayCleanupEvidence; proof: DiscardProof | null }

async function revokedOverlayPaths(
  input: ReleaseRailWorktreesInput,
  worktree: NonNullable<ReturnType<typeof getRailWorktree>>,
  persistedEntries: readonly OverlayCleanupEvidence[],
  claimed: ReadonlySet<string>,
): Promise<{ failure: string | null; entries: RevokedOverlayPath[] }> {
  const manifestEvidence = persistedEntries.find((entry) => entry.path === OVERLAY_MANIFEST && entry.kind === 'file')
  if (!manifestEvidence) return { failure: null, entries: [] }
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(path.join(worktree.worktree_path, OVERLAY_MANIFEST))
  } catch {
    return { failure: null, entries: [] }
  }
  // Trust exactly the bytes being parsed: same digest as the allocation proof.
  const digest = createHash('sha256').update('file\0').update(bytes).digest('hex')
  if (digest !== manifestEvidence.digest) return { failure: null, entries: [] }
  const manifest = parseOverlayManifest(bytes.toString('utf8'))
  if (!manifest) return { failure: null, entries: [] }
  const sources = [specrailsWorkspaceOf(worktree.worktree_path), input.repoDir].filter((value): value is string => !!value)
  const entries: RevokedOverlayPath[] = []
  for (const candidate of manifest.paths) {
    const rel = safeRelativeOverlayPath(candidate)
    if (!rel || rel === OVERLAY_MANIFEST || claimed.has(rel)) continue
    if (entries.some((entry) => entry.root.path === rel)) continue
    const target = path.join(worktree.worktree_path, ...rel.split('/'))
    if (!pathStillExists(target)) continue
    if (!reachedWithoutLinks(worktree.worktree_path, rel)) {
      return { failure: `overlay path ${rel} is reached through a link`, entries: [] }
    }
    // A tracked path is the checkout's, never overlay: leave it to Git's own
    // cleanliness check (it is not excluded from status below).
    const tracked = await input.git.run(['ls-files', '--error-unmatch', '--', rel], worktree.worktree_path)
    if (tracked.code === 0) continue
    if (tracked.code !== 1) return { failure: `Git could not verify ownership of overlay path ${rel}`, entries: [] }
    const fingerprint = fingerprintOverlayCleanupPath(target)
    if (!fingerprint) return { failure: `could not preserve overlay path ${rel}`, entries: [] }
    let proof: DiscardProof | null = null
    const record = manifest.records[rel]
    if (record && matchesOverlayManifestRecord(target, rel, record)) {
      proof = { via: 'record', record }
    } else if (!record) {
      // v1 manifest (no records). A link into a Specrails source holds no
      // data of its own; the managed settings are provable when only
      // Specrails-owned entries remain. Copied files stay unproven.
      try {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink()) {
          const linkTarget = path.resolve(path.dirname(target), fs.readlinkSync(target))
          if (insideOverlaySource(linkTarget, sources)) proof = { via: 'record', record: { kind: 'symlink', target: linkTarget } }
        } else if (rel === MANAGED_LOCAL_SETTINGS && isSpecrailsOnlyLocalSettings(target)) {
          proof = { via: 'settings' }
        }
      } catch { /* unreadable: unproven, archived */ }
    }
    entries.push({ root: { path: rel, ...fingerprint }, proof })
  }
  return { failure: null, entries }
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

interface ClearLeaf {
  rel: string
  /** Set when the path is provably Specrails's own unchanged kit. */
  proof: DiscardProof | null
  /** Fingerprint taken when planning; a kept path must not change while moving. */
  fingerprint: Omit<OverlayCleanupEvidence, 'path'> | null
}

/** Split one cleanup root into what can go (proven kit) and what is kept. A
 * real directory that contains proven kit is descended, so one edited file
 * never drags Specrails's unchanged links into the archive with it. Links are
 * never followed. Regenerable dependency installs are left for Git's removal. */
function planClearLeaves(
  worktreePath: string,
  rel: string,
  discardable: ReadonlyMap<string, DiscardProof>,
  out: ClearLeaf[],
): string | null {
  const target = path.join(worktreePath, ...rel.split('/'))
  let stat: fs.Stats
  try { stat = fs.lstatSync(target) } catch { return null }
  const proof = discardable.get(rel)
  if (proof) {
    out.push({ rel, proof, fingerprint: fingerprintOverlayCleanupPath(target) })
    return null
  }
  const prefix = `${rel}/`
  if (stat.isDirectory() && !stat.isSymbolicLink() && [...discardable.keys()].some((key) => key.startsWith(prefix))) {
    let names: string[]
    try { names = fs.readdirSync(target).sort() } catch (err) {
      return `could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`
    }
    for (const name of names) {
      const failure = planClearLeaves(worktreePath, `${rel}/${name}`, discardable, out)
      if (failure) return failure
    }
    return null
  }
  if (isRegenerableIgnoredPath(rel)) return null
  const fingerprint = fingerprintOverlayCleanupPath(target)
  if (!fingerprint) return `could not preserve ${rel}`
  out.push({ rel, proof: null, fingerprint })
  return null
}

/** Remove now-empty directories beneath `dir` (and `dir` itself when empty).
 * Only `rmdir`: anything still holding content stays. Links are not followed. */
function pruneEmptyDirectories(dir: string): void {
  let stat: fs.Stats
  try { stat = fs.lstatSync(dir) } catch { return }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) pruneEmptyDirectories(path.join(dir, name))
  try { fs.rmdirSync(dir) } catch { /* not empty: kept */ }
}

/**
 * Clear verified overlay roots and authorized ignored paths out of the
 * worktree before Git's non-force removal (which deletes ignored content).
 *
 * - Provably unchanged Specrails kit (see {@link DiscardProof}) is REMOVED:
 *   atomically renamed into a unique sibling, re-proven there, then deleted.
 *   A copy that changed in between is kept there instead and the release stops.
 * - Everything else is KEPT in that sibling, the safety archive
 *   `<worktree>.specrails-overlay-quarantine-XXXXXX`, recorded through
 *   `onSafetyArchive` before the first kept path is moved in. It is never
 *   deleted or restored automatically; a concurrently recreated source is
 *   never overwritten.
 * - When nothing had to be kept, the sibling is removed and nothing is recorded.
 */
async function clearVerifiedOverlayEntries(
  input: ReleaseRailWorktreesInput,
  worktree: NonNullable<ReturnType<typeof getRailWorktree>>,
  evidence: readonly OverlayCleanupEvidence[],
  discardable: ReadonlyMap<string, DiscardProof>,
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
    if (!reachedWithoutLinks(worktree.worktree_path, entry.path)) {
      return { failure: `overlay path ${entry.path} is reached through a link`, entries: [] }
    }
    removable.push(entry)
  }

  const cleanupRoots: OverlayCleanupEvidence[] = []
  for (const entry of [...removable].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (cleanupRoots.some((root) => root.kind === 'directory' && entry.path.startsWith(`${root.path}/`))) continue
    cleanupRoots.push(entry)
  }
  const leaves: ClearLeaf[] = []
  for (const root of cleanupRoots) {
    const failure = planClearLeaves(worktree.worktree_path, root.path, discardable, leaves)
    if (failure) return { failure, entries: [] }
  }
  if (leaves.length === 0) return { failure: null, entries: [] }

  let quarantineRoot: string | null = null
  let recorded = false
  const quarantined: QuarantinedOverlayEntry[] = []
  const ensureRoot = (): string => {
    // mkdtemp creates the batch directory atomically beside the worktree, so
    // every rename stays within one filesystem.
    quarantineRoot ??= fs.mkdtempSync(`${worktree.worktree_path}.specrails-overlay-quarantine-`)
    return quarantineRoot
  }
  const record = async (): Promise<string | null> => {
    if (recorded) return null
    const root = ensureRoot()
    try {
      await input.onSafetyArchive?.(root)
      recorded = true
      return null
    } catch (err) {
      return `could not record safety archive ${root}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const done = (failure: string | null): OverlayQuarantineResult => {
    if (quarantineRoot && !recorded) pruneEmptyDirectories(quarantineRoot)
    return { failure, entries: quarantined }
  }

  for (const leaf of leaves) {
    const sourcePath = path.join(worktree.worktree_path, ...leaf.rel.split('/'))
    if (!pathStillExists(sourcePath)) continue
    // A proof that no longer holds on the live path downgrades it to "keep".
    const proof = leaf.proof && proofHolds(sourcePath, leaf.rel, leaf.proof) ? leaf.proof : null
    const fingerprint = proof ? null : (leaf.proof ? fingerprintOverlayCleanupPath(sourcePath) : leaf.fingerprint)
    if (!proof) {
      if (!fingerprint || !matchesOverlayCleanupEvidenceAtPath(sourcePath, fingerprint)) {
        return done(`overlay path ${leaf.rel} changed before quarantine`)
      }
      const failure = await record()
      if (failure) return done(failure)
    }
    let quarantinePath: string
    try {
      quarantinePath = path.join(ensureRoot(), ...leaf.rel.split('/'))
      fs.mkdirSync(path.dirname(quarantinePath), { recursive: true })
      await input.beforeOverlayQuarantine?.(sourcePath)
      fs.renameSync(sourcePath, quarantinePath)
    } catch (err) {
      return done(`could not quarantine overlay path ${leaf.rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const moved = { sourcePath, quarantinePath, evidence: { path: leaf.rel, ...(fingerprint ?? { kind: 'file' as const, digest: '' }) } }
    try {
      await input.afterOverlayRename?.(sourcePath, quarantinePath)
    } catch (err) {
      quarantined.push(moved)
      const failure = await record()
      return done(failure ?? `overlay post-rename hook failed at ${quarantinePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (proof) {
      // Re-prove the exact moved bytes, then delete only those.
      if (proofHolds(quarantinePath, leaf.rel, proof)) {
        try {
          fs.rmSync(quarantinePath, { recursive: true })
          continue
        } catch (err) {
          quarantined.push(moved)
          const failure = await record()
          return done(failure ?? `could not remove overlay path ${leaf.rel}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      quarantined.push(moved)
      const failure = await record()
      return done(failure ?? `overlay path ${leaf.rel} changed during atomic quarantine at ${quarantinePath}`)
    }
    quarantined.push(moved)
    if (!matchesOverlayCleanupEvidenceAtPath(quarantinePath, fingerprint!)) {
      return done(`overlay path ${leaf.rel} changed during atomic quarantine at ${quarantinePath}`)
    }
    try {
      await input.afterOverlayQuarantine?.(quarantinePath)
    } catch (err) {
      return done(`overlay quarantine hook failed at ${quarantinePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (quarantineRoot) {
    // Parents created only for removed kit leave empty directories behind.
    pruneEmptyDirectories(quarantineRoot)
    if (!recorded && pathStillExists(quarantineRoot)) {
      // Defensive: something unexpected is in the sibling. Disclose it.
      const failure = await record()
      if (failure) return { failure, entries: quarantined }
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
    // A reclaimed terminal row keeps its recorded state whatever happens to the mount.
    const reclaimed = input.reclaimTerminalMounts === true && wt.merge_state !== 'needs-review' && isTerminalMergeState(wt.merge_state)
    const markNeedsReview = (): void => { if (!reclaimed) updateRailWorktreeState(input.db, wt.id, 'needs-review') }
    const recordRemoved = (): void => {
      input.db.transaction(() => {
        if (!reclaimed) updateRailWorktreeState(input.db, wt.id, state)
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
    if (wt.merge_state !== 'needs-review' && isTerminalMergeState(wt.merge_state) && !(reclaimed && pathStillExists(wt.worktree_path))) continue
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
      markNeedsReview()
      const warning = `worktree ${wt.worktree_path}: preserved because ${evidence.failure}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] ${warning}`)
      continue
    }
    // A dev/preview server left by the run would keep serving a deleted
    // checkout. Stop it BEFORE the kit is cleared: a process still holding a
    // kit file open could otherwise write into bytes that are about to be
    // deleted. Processes are not data; every file is still re-proven below.
    await reapWorktreeLeftovers({ worktreePaths: [wt.worktree_path], reason: 'worktree-removed', runId: wt.run_id ?? undefined })
    const quarantine = await clearVerifiedOverlayEntries(input, wt, evidence.overlayEntries, evidence.discardable ?? new Map())
    if (quarantine.failure) {
      markNeedsReview()
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
      markNeedsReview()
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
      if (!reclaimed && current && current.merge_state !== 'needs-review' && isTerminalMergeState(current.merge_state)) {
        continue
      }
      markNeedsReview()
      const warning = `worktree ${wt.worktree_path}: ${[
        err instanceof Error ? err.message : String(err),
        ...quarantineLocationNotes(quarantine.entries),
      ].join('; ')}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] failed to remove ${warning}`)
      continue
    }
    if (reclaimed || wt.merge_state === 'needs-review' || !isTerminalMergeState(wt.merge_state)) {
      recordRemoved()
    }
  }
  return warnings
}
