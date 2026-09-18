/**
 * Reuse installed packages without sharing tool caches with the base checkout.
 * Each worktree owns its node_modules directory; package entries remain links,
 * while .vite, .vite-temp and .cache are local writable directories. No install,
 * dependency copy or permission broadening is performed. Legacy whole-directory
 * links are migrated only after their exact source has been authenticated.
 *
 * Cleanup authority covers individual source-anchored links, never the entire
 * writable directory. Replaced packages and newly created files therefore keep
 * the existing ignored-artifact / recoverable-work settlement guarantees.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fingerprintOverlayCleanupPath, type OverlayCleanupEvidence } from './worktree-overlay'

export interface NodeModulesLinkResult {
  /** Worktree-relative dependency directories prepared by THIS call. */
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
export const WORKTREE_DEPENDENCY_CACHES = ['.vite', '.vite-temp', '.cache'] as const

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
export function discoverPackageDirs(baseRepo: string): string[] {
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
      // A first-party symlink can escape the checkout or form a discovery cycle.
      if (!fs.lstatSync(childAbs).isDirectory()) continue
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
    if (!exists(target)) return null
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
    const legacy = authenticateWarmLink(baseRepo, worktreePath, rel)
    if (legacy) { evidence.push(legacy); continue }
    const dest = path.join(worktreePath, rel)
    try {
      if (!fs.lstatSync(dest).isDirectory()) continue
      for (const name of fs.readdirSync(dest)) {
        if ((WORKTREE_DEPENDENCY_CACHES as readonly string[]).includes(name)) continue
        const entryRel = `${rel}/${name}`
        const entry = authenticateWarmLink(baseRepo, worktreePath, entryRel)
        if (entry) { evidence.push(entry); continue }
        // Scoped package parents are local too; never follow foreign symlinks.
        if (name.startsWith('@') && fs.lstatSync(path.join(dest, name)).isDirectory()) {
          for (const scoped of fs.readdirSync(path.join(dest, name))) {
            const child = authenticateWarmLink(baseRepo, worktreePath, `${entryRel}/${scoped}`)
            if (child) evidence.push(child)
          }
        }
      }
    } catch { /* Unreadable or concurrently removed entries confer no authority. */ }
  }
  return evidence
}

function linkDependencyEntry(source: string, destination: string): void {
  fs.symlinkSync(source, destination, process.platform === 'win32'
    ? (isDir(source) ? 'junction' : 'file') : undefined)
}

function createLocalDependencyTree(source: string, destination: string): void {
  fs.mkdirSync(destination)
  for (const name of fs.readdirSync(source)) {
    if ((WORKTREE_DEPENDENCY_CACHES as readonly string[]).includes(name)) continue
    const src = path.join(source, name)
    const dest = path.join(destination, name)
    if (name.startsWith('@') && isDir(src)) {
      fs.mkdirSync(dest)
      for (const scoped of fs.readdirSync(src)) linkDependencyEntry(path.join(src, scoped), path.join(dest, scoped))
    } else linkDependencyEntry(src, dest)
  }
  for (const cache of WORKTREE_DEPENDENCY_CACHES) fs.mkdirSync(path.join(destination, cache))
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
    const legacy = authenticateWarmLink(baseRepo, worktreePath, rel)
    if (!exists(dest) || legacy) {
      let staging: string | undefined
      let removedLegacy = false
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        staging = fs.mkdtempSync(path.join(path.dirname(dest), '.specrails-dependencies-'))
        const prepared = path.join(staging, DEPS_DIR)
        createLocalDependencyTree(src, prepared)
        if (legacy) {
          // Recheck immediately before removing the old link. Never unlink a
          // directory or a replacement another actor installed in the meantime.
          const current = authenticateWarmLink(baseRepo, worktreePath, rel)
          if (!current || current.digest !== legacy.digest) throw new Error('dependency link changed during preparation')
          fs.unlinkSync(dest)
          removedLegacy = true
        }
        fs.renameSync(prepared, dest)
        result.linked.push(rel)
      } catch (err) {
        if (removedLegacy && !exists(dest)) {
          try { linkDependencyEntry(src, dest) }
          catch (restoreError) { result.warnings.push(`failed to restore ${rel}: ${errMsg(restoreError)}`) }
        }
        result.warnings.push(`failed to prepare ${rel}: ${errMsg(err)}`)
      } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true })
      }
    }
  }
  result.evidence = authenticateWarmNodeModulesLinks(baseRepo, worktreePath)
  result.authenticated = result.evidence.map(entry => entry.path)
  return result
}
