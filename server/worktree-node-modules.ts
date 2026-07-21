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
 * The returned `linked` paths are appended to the launch's overlay-exclusion
 * list, so a linked `node_modules` inherits the same commit-time guarantees as
 * overlay scaffolding (excluded pathspecs + index audit) even if the repo's
 * `.gitignore` were ever missing the entry.
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

export interface NodeModulesLinkResult {
  /** Worktree-relative POSIX paths of the links created by THIS call. */
  linked: string[]
  /** Non-fatal degradation notes (link failures, unreadable dirs). */
  warnings: string[]
}

/** Package-dir discovery depth: 0 = repo root, 1 = `client/`-style children. */
const MAX_DEPTH = 2

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

/**
 * Link the base checkout's installed `node_modules` trees into a fresh
 * worktree. Best-effort and side-effect-transparent: never throws, never
 * overwrites, returns what it created so the caller can exclude those paths
 * from commits.
 */
export function linkNodeModulesIntoWorktree(baseRepo: string, worktreePath: string): NodeModulesLinkResult {
  const result: NodeModulesLinkResult = { linked: [], warnings: [] }
  if (!isWorktreeNodeModulesEnabled()) return result
  for (const pkgRel of discoverPackageDirs(baseRepo)) {
    const rel = pkgRel === '' ? 'node_modules' : `${pkgRel}/node_modules`
    const src = path.join(baseRepo, ...rel.split('/'))
    if (!isDir(src)) continue
    const dest = path.join(worktreePath, ...rel.split('/'))
    if (exists(dest)) continue
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : undefined)
      result.linked.push(rel)
    } catch (err) {
      result.warnings.push(`failed to link ${rel}: ${errMsg(err)}`)
    }
  }
  return result
}
