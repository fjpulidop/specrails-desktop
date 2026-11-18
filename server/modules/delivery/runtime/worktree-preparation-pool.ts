/**
 * Prepared run checkouts — the expensive half of `git worktree add` (writing
 * every tracked file) done before a launch needs it.
 *
 * A prepared checkout is a DETACHED linked worktree under
 * `<worktreesRoot>/.prepared/<id>`, created with `worktree add --no-checkout`
 * and populated with `reset --hard` (parallel checkout workers). Neither runs
 * the person's `post-checkout` hook; the hook runs once, at adoption, when
 * `createWorktree` creates the run's branch in the moved checkout. Adoption
 * resets to the launch's exact base first, so a preparation cut from a stale
 * guess only costs the delta.
 *
 * Two producers:
 *  - `prewarmPreparedCheckouts` — the Launch all dialog opened: up to
 *    {@link MAX_PREPARED} checkouts per repository, refreshed with the fetch.
 *  - `ensurePreparedCheckout` — a launch with nothing prepared starts one
 *    preparation alongside its `git fetch`, so the file writes overlap the
 *    network round trip instead of following it.
 *
 * Unclaimed checkouts are discarded after {@link PREPARED_TTL_MS}, when the
 * dialog is dismissed, and at shutdown; leftovers of a previous process are
 * swept the first time a repository is touched. They never hold anyone's work
 * (detached, never handed to a run), so discarding them is a forced removal.
 *
 * State is keyed by the canonical repository path (as `repo-lock` and the
 * fetch de-duplication are) and only ever hands a checkout back to a launch on
 * the same repository and mount root.
 */
import * as fs from 'fs'
import * as path from 'path'
import { newId } from '../../../ids'
import { repositoryLockKey } from '../../../repo-lock'
import { checkoutWorkersArgs, type GitRunner, type PreparedCheckout } from '../../../worktree-manager'

export const MAX_PREPARED = 3
export const PREPARED_TTL_MS = 5 * 60_000
export const PREPARED_DIR = '.prepared'

/** `SPECRAILS_WORKTREE_PREPARATION=false` turns preparation off (plain
 *  `worktree add`, still with parallel checkout workers). */
export function isWorktreePreparationEnabled(): boolean {
  return (process.env.SPECRAILS_WORKTREE_PREPARATION ?? '').toLowerCase() !== 'false'
}

interface Entry {
  id: string
  path: string
  /** Mount root the checkout lives under; adoption only within it (same filesystem). */
  root: string
  /** Resolves true once populated; false when preparation failed (already cleaned). */
  ready: Promise<boolean>
  claimed: boolean
  discarded: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface RepoPool {
  repoDir: string
  git: GitRunner
  entries: Entry[]
  swept: Promise<void> | null
}

const pools = new Map<string, RepoPool>()

function poolFor(git: GitRunner, repoDir: string): RepoPool {
  const key = repositoryLockKey(repoDir)
  let pool = pools.get(key)
  if (!pool) {
    pool = { repoDir, git, entries: [], swept: null }
    pools.set(key, pool)
  }
  return pool
}

function preparedRoot(worktreesRoot: string): string {
  return path.join(worktreesRoot, PREPARED_DIR)
}

function samePath(a: string, b: string): boolean {
  const canon = (value: string): string => {
    try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
  }
  return canon(a) === canon(b)
}

/** Remove `.prepared/*` checkouts this process does not own (a previous
 *  process died or quit with them prepared). Once per repository. */
function sweepLeftovers(pool: RepoPool, worktreesRoot: string): Promise<void> {
  if (pool.swept) return pool.swept
  pool.swept = (async () => {
    const root = preparedRoot(worktreesRoot)
    const owned = new Set(pool.entries.map((entry) => path.basename(entry.path)))
    const list = await pool.git.run(['worktree', 'list', '--porcelain'], pool.repoDir).catch(() => null)
    const registered = (list?.code === 0 ? list.stdout : '').split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
    for (const mount of registered) {
      if (!samePath(path.dirname(mount), root) || owned.has(path.basename(mount))) continue
      await pool.git.run(['worktree', 'remove', '--force', mount], pool.repoDir).catch(() => {})
    }
    let names: string[] = []
    try { names = await fs.promises.readdir(root) } catch { /* no root yet */ }
    for (const name of names) {
      if (owned.has(name)) continue
      await fs.promises.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})
    }
    await pool.git.run(['worktree', 'prune'], pool.repoDir).catch(() => {})
  })()
  return pool.swept
}

async function removeEntry(pool: RepoPool, entry: Entry): Promise<void> {
  if (entry.discarded) return
  entry.discarded = true
  if (entry.timer) clearTimeout(entry.timer)
  pool.entries = pool.entries.filter((candidate) => candidate !== entry)
  const removed = await pool.git.run(['worktree', 'remove', '--force', entry.path], pool.repoDir).catch(() => null)
  if (!removed || removed.code !== 0) {
    await fs.promises.rm(entry.path, { recursive: true, force: true }).catch(() => {})
    await pool.git.run(['worktree', 'prune'], pool.repoDir).catch(() => {})
  }
}

function startPreparation(pool: RepoPool, worktreesRoot: string, baseRef: string): Entry {
  const id = newId()
  const entry: Entry = {
    id,
    path: path.join(preparedRoot(worktreesRoot), id),
    root: worktreesRoot,
    ready: Promise.resolve(false),
    claimed: false,
    discarded: false,
    timer: null,
  }
  pool.entries.push(entry)
  entry.ready = (async () => {
    await sweepLeftovers(pool, worktreesRoot)
    const sha = await pool.git.run(['rev-parse', '--verify', `${baseRef}^{commit}`], pool.repoDir)
    if (sha.code !== 0 || entry.discarded) {
      await removeEntry(pool, entry)
      return false
    }
    await fs.promises.mkdir(path.dirname(entry.path), { recursive: true })
    const added = await pool.git.run(['worktree', 'add', '--detach', '--no-checkout', entry.path, sha.stdout.trim()], pool.repoDir)
    if (added.code !== 0) {
      entry.discarded = true
      pool.entries = pool.entries.filter((candidate) => candidate !== entry)
      await fs.promises.rm(entry.path, { recursive: true, force: true }).catch(() => {})
      return false
    }
    const workers = await checkoutWorkersArgs(pool.git, pool.repoDir)
    const populated = await pool.git.run([...workers, 'reset', '--hard', '--quiet', sha.stdout.trim()], entry.path)
    if (populated.code !== 0) {
      await removeEntry(pool, entry)
      return false
    }
    return true
  })().catch(async () => {
    await removeEntry(pool, entry).catch(() => {})
    return false
  })
  entry.timer = setTimeout(() => {
    if (entry.claimed) return
    void entry.ready.then(() => { if (!entry.claimed) return removeEntry(pool, entry) }).catch(() => {})
  }, PREPARED_TTL_MS)
  entry.timer.unref?.()
  return entry
}

function unclaimed(pool: RepoPool, worktreesRoot: string): Entry[] {
  return pool.entries.filter((entry) => !entry.claimed && !entry.discarded && samePath(entry.root, worktreesRoot))
}

export interface PreparationTarget {
  git: GitRunner
  repoDir: string
  /** The run mount root (`isolatedWorktreesRoot(slug[, repositoryId])`). */
  worktreesRoot: string
  /** Best current guess of the launch base (adoption resets to the exact one). */
  baseRef: string
}

/** The Launch all dialog opened: keep up to `count` (≤ MAX_PREPARED)
 *  unclaimed checkouts ready for this repository. Returns how many exist. */
export function prewarmPreparedCheckouts(target: PreparationTarget, count: number): number {
  if (!isWorktreePreparationEnabled()) return 0
  const pool = poolFor(target.git, target.repoDir)
  const want = Math.max(0, Math.min(MAX_PREPARED, Math.floor(count)))
  const have = unclaimed(pool, target.worktreesRoot)
  for (let i = have.length; i < want; i++) startPreparation(pool, target.worktreesRoot, target.baseRef)
  return Math.max(have.length, want)
}

/** A launch found nothing prepared: start one preparation now so it runs in
 *  parallel with the launch's fetch. No-op when one is already unclaimed. */
export function ensurePreparedCheckout(target: PreparationTarget): void {
  if (!isWorktreePreparationEnabled()) return
  const pool = poolFor(target.git, target.repoDir)
  if (unclaimed(pool, target.worktreesRoot).length > 0) return
  startPreparation(pool, target.worktreesRoot, target.baseRef)
}

/** Claim one prepared checkout for `worktreesRoot`'s repository (waits for an
 *  in-flight preparation). Null when none is available. */
export function preparedCheckoutClaimer(git: GitRunner, repoDir: string, worktreesRoot: string): () => Promise<PreparedCheckout | null> {
  return async () => {
    if (!isWorktreePreparationEnabled()) return null
    const pool = poolFor(git, repoDir)
    for (const entry of unclaimed(pool, worktreesRoot)) {
      entry.claimed = true
      if (entry.timer) clearTimeout(entry.timer)
      if (!(await entry.ready) || entry.discarded) continue
      pool.entries = pool.entries.filter((candidate) => candidate !== entry)
      return {
        path: entry.path,
        discard: async () => {
          entry.discarded = true
          const removed = await git.run(['worktree', 'remove', '--force', entry.path], repoDir).catch(() => null)
          if (!removed || removed.code !== 0) await fs.promises.rm(entry.path, { recursive: true, force: true }).catch(() => {})
        },
      }
    }
    return null
  }
}

/** The dialog was dismissed without launching: drop this repository's
 *  unclaimed checkouts. */
export async function releasePreparedCheckouts(git: GitRunner, repoDir: string, worktreesRoot?: string): Promise<number> {
  const pool = pools.get(repositoryLockKey(repoDir))
  if (!pool) return 0
  const victims = pool.entries.filter((entry) => !entry.claimed && !entry.discarded && (!worktreesRoot || samePath(entry.root, worktreesRoot)))
  for (const entry of victims) {
    await entry.ready.catch(() => false)
    await removeEntry(pool, entry)
  }
  return victims.length
}

/** Shutdown: discard every unclaimed checkout of every repository. */
export async function discardAllPreparedCheckouts(): Promise<void> {
  await Promise.all([...pools.values()].map(async (pool) => {
    for (const entry of pool.entries.filter((candidate) => !candidate.claimed)) {
      await entry.ready.catch(() => false)
      await removeEntry(pool, entry).catch(() => {})
    }
  }))
}

/** Test-only introspection and reset. */
export function __preparedCheckoutCount(repoDir: string): number {
  return pools.get(repositoryLockKey(repoDir))?.entries.filter((entry) => !entry.claimed && !entry.discarded).length ?? 0
}

export async function __resetPreparedCheckouts(): Promise<void> {
  await discardAllPreparedCheckouts()
  pools.clear()
}
