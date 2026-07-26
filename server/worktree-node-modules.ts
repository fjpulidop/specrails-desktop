/**
 * Warm-dependency reuse for isolated rail worktrees.
 *
 * `git worktree add` materializes only TRACKED files, so a fresh worktree has
 * no `node_modules` — every isolated run used to pay a cold `npm install`
 * (root + nested packages) plus cold build caches before doing any real work.
 * This module links the base checkout's existing install into the worktree so
 * the run starts warm.
 *
 * Mechanics:
 *  - DISCOVER: every directory that holds a `package.json` in the base repo at
 *    depth ≤ `MAX_DEPTH` (root plus shallow sub-packages like `client/`),
 *    skipping dot-dirs and anything inside a `node_modules` tree.
 *  - LINK: for each discovered package dir whose base checkout actually has a
 *    `node_modules`, create the same relative path in the worktree as a
 *    SYMLINK (junction on Windows). No copy fallback on purpose — copying a
 *    multi-GB dependency tree would be slower than the `npm install` it
 *    replaces; a failed link simply degrades to the legacy cold start.
 *  - NEVER overwrite: an existing entry at the destination (a real dir, a
 *    prior link, anything) is left untouched, so resume passes are idempotent
 *    and an agent-made install is never clobbered.
 *
 * The returned `authenticated` paths are appended to the launch's overlay-
 * exclusion list, so a linked `node_modules` inherits the same commit-time
 * guarantees as overlay scaffolding (excluded pathspecs + index audit) even if
 * the repo's `.gitignore` were ever missing the entry.
 *
 * Release safety (why `authenticated` exists next to `linked`): a repo whose
 * `.gitignore` carries the ordinary `node_modules/` DIRECTORY pattern does not
 * ignore a SYMLINK named `node_modules`, so the link surfaces as an untracked
 * entry in `git status`. Without evidence authorizing it, worktree release read
 * that as "the worktree contains changes made after settlement", parked the row
 * at `needs-review` forever and permanently blocked checkout of the branch. The
 * links therefore also carry `OverlayCleanupEvidence`, and a link created by an
 * EARLIER pass (resume) is re-authenticated instead of being ignored — the old
 * `linked`-only contract silently dropped both guarantees on resume.
 *
 * Authentication is deliberately narrow and source-anchored, never name-based:
 * the worktree entry must be a symlink whose resolved target is exactly the base
 * checkout's identically-named dependency directory. A real directory, a copy,
 * or a link pointing anywhere else stays unauthorized and preserves the
 * worktree, as `Recoverable work is never removed automatically` requires.
 *
 * Honest caveat (documented, accepted): the link SHARES the dependency tree
 * with the base checkout. Reads (tests, builds) are safe under concurrency; an
 * in-worktree `npm install` would write through to the shared tree — the same
 * mutation it would make in the user's checkout after merge.
 *
 * Kill switch: `SPECRAILS_WORKTREE_NODE_MODULES=false` restores the byte-
 * identical cold-worktree behaviour.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fingerprintOverlayCleanupPath, type OverlayCleanupEvidence } from './worktree-overlay'

export interface NodeModulesLinkResult {
  /** Worktree-relative POSIX paths of the links created by THIS call. */
  linked: string[]
  /** Worktree-relative POSIX paths of every warm link PROVEN to point at the
   *  base checkout's identically-named dependency dir — created by this call OR
   *  by an earlier pass. This is the set callers must exclude and authorize. */
  authenticated: string[]
  /** Cleanup fingerprints for `authenticated`, in overlay-evidence shape so the
   *  existing exclusion + atomic-quarantine machinery handles them unchanged. */
  evidence: OverlayCleanupEvidence[]
  /** Non-fatal degradation notes (link failures, unreadable dirs). */
  warnings: string[]
}

/** Package-dir discovery depth: 0 = repo root, 1 = `client/`-style children. */
const MAX_DEPTH = 2

/** Name of the dependency directory this module links. */
const DEPS_DIR = 'node_modules'

export function isWorktreeNodeModulesEnabled(): boolean {
  return (process.env.SPECRAILS_WORKTREE_NODE_MODULES ?? '').toLowerCase() !== 'false'
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Relative POSIX paths of package dirs (containing package.json) at depth ≤ MAX_DEPTH. */
function discoverPackageDirs(baseRepo: string): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    const abs = rel === '' ? baseRepo : path.join(baseRepo, rel)
    if (exists(path.join(abs, 'package.json'))) found.push(rel)
    if (depth >= MAX_DEPTH) return
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      return
    }
    for (const name of names) {
      // Dot-dirs (.git, .specrails, provider dirs) and dependency trees never
      // hold linkable first-party packages.
      if (name.startsWith('.') || name === 'node_modules') continue
      const childAbs = path.join(abs, name)
      if (!isDir(childAbs)) continue
      walk(rel === '' ? name : `${rel}/${name}`, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** Resolve a path through symlinks when possible; the literal path otherwise
 *  (a nonexistent target must still compare, and must still compare EQUAL to an
 *  equally-nonexistent expectation rather than silently authorizing). */
function resolveRealPath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Prove one worktree-relative path is an app-created warm-dependency link and
 * fingerprint it. Returns null for anything that is not EXACTLY a symlink whose
 * target resolves to the base checkout's identically-named directory — a real
 * directory, a dereferencing copy, a dangling link, or a link into some other
 * tree are all unauthorized and must keep preserving the worktree.
 */
function authenticateWarmLink(
  baseRepo: string,
  worktreePath: string,
  rel: string,
): OverlayCleanupEvidence | null {
  const dest = path.join(worktreePath, ...rel.split('/'))
  try {
    if (!fs.lstatSync(dest).isSymbolicLink()) return null
    const target = path.resolve(path.dirname(dest), fs.readlinkSync(dest))
    const expected = path.join(baseRepo, ...rel.split('/'))
    if (resolveRealPath(target) !== resolveRealPath(expected)) return null
    // A link to something that is not a live directory proves nothing about the
    // base checkout's dependency tree.
    if (!isDir(target)) return null
  } catch {
    return null
  }
  const fingerprint = fingerprintOverlayCleanupPath(dest)
  return fingerprint ? { path: rel, ...fingerprint } : null
}

/** Worktree-relative POSIX paths of every `node_modules` entry the worktree
 *  holds at depth ≤ MAX_DEPTH. Mirrors the linker's own discovery depth, so it
 *  can only ever see paths this module could have created. Recursion uses lstat
 *  so a symlinked directory is never walked into. */
function discoverWorktreeDependencyPaths(worktreePath: string): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    const abs = rel === '' ? worktreePath : path.join(worktreePath, rel)
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      return
    }
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (name === DEPS_DIR) {
        found.push(childRel)
        continue
      }
      if (depth >= MAX_DEPTH || name.startsWith('.')) continue
      try {
        if (!fs.lstatSync(path.join(abs, name)).isDirectory()) continue
      } catch {
        continue
      }
      walk(childRel, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/**
 * Live authentication of the warm-dependency links a worktree currently holds.
 *
 * Deriving this from the filesystem (instead of only from persisted evidence)
 * is what heals worktrees that settled BEFORE the links carried evidence: they
 * are stuck at `needs-review` with the link as their only "dirt", and a
 * persisted-only fix would never reach them. The proof is identical either way
 * — the link target anchored to a directory the app controls.
 */
export function authenticateWarmNodeModulesLinks(
  baseRepo: string,
  worktreePath: string,
): OverlayCleanupEvidence[] {
  const evidence: OverlayCleanupEvidence[] = []
  for (const rel of discoverWorktreeDependencyPaths(worktreePath)) {
    const entry = authenticateWarmLink(baseRepo, worktreePath, rel)
    if (entry) evidence.push(entry)
  }
  return evidence
}

/**
 * Link the base checkout's installed `node_modules` trees into a fresh
 * worktree. Best-effort and side-effect-transparent: never throws, never
 * overwrites, and returns both what it created and what it can PROVE is a warm
 * link (including links a previous pass created), so the caller can exclude
 * those paths from commits and authorize them for release.
 */
export function linkNodeModulesIntoWorktree(baseRepo: string, worktreePath: string): NodeModulesLinkResult {
  const result: NodeModulesLinkResult = { linked: [], authenticated: [], evidence: [], warnings: [] }
  if (!isWorktreeNodeModulesEnabled()) return result
  for (const pkgRel of discoverPackageDirs(baseRepo)) {
    const rel = pkgRel === '' ? DEPS_DIR : `${pkgRel}/${DEPS_DIR}`
    const src = path.join(baseRepo, ...rel.split('/'))
    if (!isDir(src)) continue
    const dest = path.join(worktreePath, ...rel.split('/'))
    if (!exists(dest)) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : undefined)
        result.linked.push(rel)
      } catch (err) {
        result.warnings.push(`failed to link ${rel}: ${errMsg(err)}`)
        continue
      }
    }
    // Authenticate what is actually on disk NOW — a link we just made, or one a
    // previous pass made. An entry that cannot prove itself (a real dir, an
    // agent-made install) is deliberately left unauthorized.
    const entry = authenticateWarmLink(baseRepo, worktreePath, rel)
    if (entry) {
      result.authenticated.push(rel)
      result.evidence.push(entry)
    }
  }
  return result
}
