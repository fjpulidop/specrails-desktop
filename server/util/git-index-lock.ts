/**
 * `index.lock` awareness for Specrails' git reads and writes.
 *
 * Git writes the index through `<gitdir>/index.lock` and renames it into place.
 * Two situations matter to Specrails:
 *
 *  - A LIVE lock: an agent (or the person) is mid `git add`/`commit` in the
 *    checkout. A `git status` taken at that instant sees a half-staged index
 *    and Specrails would report changes that are about to be committed (for
 *    example "the worktree contains changes made after settlement"). Waiting a
 *    short moment for the lock to go away reads the settled result.
 *  - A STALE lock: a Git process crashed and left the file behind. Waiting
 *    every time would add a second to each read forever, and every write fails
 *    with Git's terse "File exists". The same lock (same inode + mtime) that
 *    survives a full wait is remembered as stale so later reads skip the wait,
 *    and write failures get a message that says what happened.
 *
 * Specrails never deletes a lock: only the person can know no Git process is
 * still running there.
 */
import { promises as fsp } from 'fs'
import * as path from 'path'

const POLL_MS = 50
/** Commits and staging release the lock well within this. */
export const INDEX_LOCK_MAX_WAIT_MS = 1_000
const MAX_REMEMBERED = 64

/** lockPath → identity of the lock that outlived a full wait. */
const staleLocks = new Map<string, string>()

export interface IndexLockObservation {
  path: string
  /** The same lock survived a full wait (now or earlier). */
  stale: boolean
  /** Age from the lock's mtime when observed, in ms (null when unreadable). */
  ageMs: number | null
}

/** Test-only: forget remembered stale locks. */
export function __resetIndexLockMemory(): void {
  staleLocks.clear()
}

function remember(lockPath: string, identity: string): void {
  staleLocks.delete(lockPath)
  staleLocks.set(lockPath, identity)
  while (staleLocks.size > MAX_REMEMBERED) staleLocks.delete(staleLocks.keys().next().value as string)
}

/**
 * The index.lock path for the checkout containing `cwd`, resolved from the
 * filesystem only (no git spawn): `<top>/.git/index.lock` for a main checkout,
 * `<gitdir>/index.lock` for a linked worktree whose `.git` file names it.
 */
export async function resolveIndexLockPath(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = path.join(dir, '.git')
    try {
      const stat = await fsp.stat(dotGit)
      if (stat.isDirectory()) return path.join(dotGit, 'index.lock')
      if (stat.isFile()) {
        const content = await fsp.readFile(dotGit, 'utf8')
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
        if (!match) return null
        return path.join(path.resolve(dir, match[1]), 'index.lock')
      }
    } catch { /* not here — keep walking up */ }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

async function lockIdentity(lockPath: string): Promise<{ identity: string; mtimeMs: number } | null> {
  try {
    const stat = await fsp.stat(lockPath)
    return { identity: `${stat.ino}:${stat.mtimeMs}`, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function observation(lockPath: string, stale: boolean, mtimeMs: number | null): IndexLockObservation {
  return { path: lockPath, stale, ageMs: mtimeMs === null ? null : Math.max(0, Date.now() - mtimeMs) }
}

/**
 * Wait (bounded) for a live index.lock in the checkout at `cwd` to go away.
 * Resolves null when there is no lock (or it was released while waiting), or
 * the observed lock otherwise. A remembered stale lock returns immediately.
 * Never throws: probing is an optimization, a failure reads immediately.
 */
export async function waitForIndexLockRelease(
  cwd: string,
  opts: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<IndexLockObservation | null> {
  try {
    const lockPath = await resolveIndexLockPath(cwd)
    if (!lockPath) return null
    const first = await lockIdentity(lockPath)
    if (!first) {
      staleLocks.delete(lockPath)
      return null
    }
    if (staleLocks.get(lockPath) === first.identity) return observation(lockPath, true, first.mtimeMs)
    const deadline = Date.now() + (opts.maxWaitMs ?? INDEX_LOCK_MAX_WAIT_MS)
    const poll = opts.pollMs ?? POLL_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, poll))
      const current = await lockIdentity(lockPath)
      if (!current) return null
      // A different lock is a new writer: it deserves its own wait.
      if (current.identity !== first.identity) return observation(lockPath, false, current.mtimeMs)
    }
    remember(lockPath, first.identity)
    return observation(lockPath, true, first.mtimeMs)
  } catch {
    return null
  }
}

/** Current lock state without waiting (remembered staleness only). */
export async function inspectIndexLock(cwd: string): Promise<IndexLockObservation | null> {
  try {
    const lockPath = await resolveIndexLockPath(cwd)
    if (!lockPath) return null
    const current = await lockIdentity(lockPath)
    if (!current) {
      staleLocks.delete(lockPath)
      return null
    }
    return observation(lockPath, staleLocks.get(lockPath) === current.identity, current.mtimeMs)
  } catch {
    return null
  }
}

const LOCK_FAILURE_RE = /Unable to create '([^']*index\.lock)': File exists/

/** True when Git's stderr reports it could not take the index lock. */
export function isIndexLockFailure(stderr: string): boolean {
  return LOCK_FAILURE_RE.test(stderr)
}

/** One actionable sentence for an index-lock failure, or null. */
export function describeIndexLockFailure(stderr: string, observed?: IndexLockObservation | null): string | null {
  const match = LOCK_FAILURE_RE.exec(stderr)
  if (!match) return null
  const age = observed?.ageMs != null ? ` (unchanged for ${Math.round(observed.ageMs / 1000)} s)` : ''
  return `Git's index is locked: ${match[1]} exists${age}. Another Git process is working in this checkout, or one crashed and left the lock behind. ` +
    'Specrails never deletes it; remove that file once no Git command is running there, then retry.'
}

/**
 * Append the explanation to a failed git result's stderr when the failure is
 * an index lock (inspects the lock to report its age). Other results unchanged.
 */
export async function annotateIndexLockFailure<T extends { code: number; stderr: string }>(result: T, cwd: string): Promise<T> {
  if (result.code === 0 || !isIndexLockFailure(result.stderr)) return result
  const note = describeIndexLockFailure(result.stderr, await inspectIndexLock(cwd))
  return note ? { ...result, stderr: `${result.stderr.trimEnd()}\n${note}` } : result
}
