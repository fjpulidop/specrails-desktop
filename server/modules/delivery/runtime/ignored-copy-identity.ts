/**
 * "This ignored path loses nothing when its worktree goes away." Shared by the
 * retained-worktree evaluation (Settings ▸ Storage) and the release path's
 * opt-in (`acceptIgnoredBaseCopies`), so what the list promises is exactly
 * what removal re-proves live.
 *
 * Safe means one of:
 * - a symbolic link (removal deletes the link, never its target);
 * - a regular file, or a directory of them, byte-identical to the same path
 *   in the main checkout (a copied `.env`, a generated config).
 *
 * Bounded: a tree beyond {@link MAX_ENTRIES} entries or {@link MAX_BYTES}
 * bytes is not proven identical (so it stays "at risk"). All reads are async.
 */
import { promises as fsp, type Stats } from 'fs'
import * as path from 'path'

const MAX_ENTRIES = 2000
const MAX_BYTES = 64 * 1024 * 1024

interface Budget { entries: number; bytes: number }

async function lstatOrNull(target: string): Promise<Stats | null> {
  try { return await fsp.lstat(target) } catch { return null }
}

async function sameFile(a: string, b: string, size: number, budget: Budget): Promise<boolean> {
  budget.bytes += size
  if (budget.bytes > MAX_BYTES) return false
  const [left, right] = await Promise.all([fsp.readFile(a), fsp.readFile(b)])
  return left.equals(right)
}

async function sameTree(worktreeEntry: string, baseEntry: string, budget: Budget): Promise<boolean> {
  budget.entries += 1
  if (budget.entries > MAX_ENTRIES) return false
  const [here, there] = await Promise.all([lstatOrNull(worktreeEntry), lstatOrNull(baseEntry)])
  if (!here || !there) return false
  if (here.isSymbolicLink()) {
    if (!there.isSymbolicLink()) return false
    const [l, r] = await Promise.all([fsp.readlink(worktreeEntry), fsp.readlink(baseEntry)])
    return l === r
  }
  if (here.isFile()) return there.isFile() && here.size === there.size && sameFile(worktreeEntry, baseEntry, here.size, budget)
  if (!here.isDirectory() || !there.isDirectory()) return false
  const [mine, theirs] = await Promise.all([fsp.readdir(worktreeEntry), fsp.readdir(baseEntry)])
  // Extra entries in the base checkout lose nothing; a name only here would.
  const available = new Set(theirs)
  for (const name of mine) {
    if (!available.has(name)) return false
    if (!(await sameTree(path.join(worktreeEntry, name), path.join(baseEntry, name), budget))) return false
  }
  return true
}

/** Resolve a Git-reported relative path under `root`, refusing anything that escapes it. */
function under(root: string, relative: string): string | null {
  const clean = relative.replace(/\/$/, '')
  if (!clean || clean.includes('\0') || path.isAbsolute(clean) || clean.split('/').includes('..')) return null
  return path.join(root, ...clean.split('/'))
}

/**
 * True when removing `<worktreePath>/<relative>` loses no bytes: it is a link,
 * or the main checkout holds an identical copy. Any read error answers false.
 */
export async function ignoredPathIsSafeCopy(worktreePath: string, baseRepoDir: string, relative: string): Promise<boolean> {
  const here = under(worktreePath, relative)
  const there = under(baseRepoDir, relative)
  if (!here || !there) return false
  try {
    const stat = await lstatOrNull(here)
    if (!stat) return true // already gone: nothing left to lose
    if (stat.isSymbolicLink()) return true
    return await sameTree(here, there, { entries: 0, bytes: 0 })
  } catch {
    return false
  }
}
