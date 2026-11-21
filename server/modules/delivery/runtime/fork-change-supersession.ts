import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import type { DbInstance } from '../../../db'
import { activeOpenSpecChangesAt, type GitRunner } from '../../../worktree-manager'

/**
 * A Core fork runs in its source run's worktree. Core copies the source's
 * active OpenSpec change to `<source>-fork-<digest>` and never touches the
 * source's own artifacts, so after the fork archives its copy the source change
 * is still active and the delivery hygiene gate rejects the commit
 * ("new active changes"). The host owns the worktree and delivery, so it retires
 * the superseded source change before committing.
 *
 * Mirrors specrails-core `src/agent-runtime/engine/fork.ts`:
 *   change.slice(0, 42).replace(/-+$/, '') + '-fork-' + contentDigest(runId).slice(0, 12)
 * where contentDigest(runId) is sha256 of the canonical JSON string.
 */
export function forkSuccessorChangeName(change: string, forkRunId: string): string {
  const digest = createHash('sha256').update(JSON.stringify(forkRunId), 'utf8').digest('hex').slice(0, 12)
  return change.slice(0, 42).replace(/-+$/, '') + '-fork-' + digest
}

/** The run and each fork ancestor that is itself a fork (nearest first). Empty for a non-fork run. */
export function definitionForkChain(db: DbInstance, runId: string): string[] {
  const parentOf = db.prepare('SELECT fork_of FROM loop_runs WHERE id = ?')
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | null = runId
  while (current && !seen.has(current)) {
    seen.add(current)
    const parent: string | null = (parentOf.get(current) as { fork_of: string | null } | undefined)?.fork_of ?? null
    if (parent) chain.push(current)
    current = parent
  }
  return chain
}

const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/

function directoryNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Retire active OpenSpec changes this checkout introduced that a fork in
 * `forkRunIds` (nearest first: `forkRunIds[0]` is the run being settled)
 * replaced with its own (active or archived) successor change.
 * Baseline changes, symlinks and changes without a successor are never touched.
 *
 * Core truncates a change name to 42 characters before appending
 * `-fork-<digest>`, so after two forks every change in the chain shares one
 * prefix and each looks like the "successor" of the other under some run of
 * the chain. The settled run's OWN change (its successor of an active change)
 * is therefore never retired — run fork-dddf836f lost its in-progress change
 * that way. A retired change is moved, never deleted, into the repository's
 * git directory (`specrails/retired-openspec-changes/`), outside the working
 * tree and every delivery. Returns the retired change names.
 */
export async function retireSupersededForkChanges(input: { git: GitRunner; worktreePath: string; baseRef: string; forkRunIds: readonly string[] }): Promise<string[]> {
  if (!input.forkRunIds.length) return []
  const changes = path.join(input.worktreePath, 'openspec', 'changes')
  const active = directoryNames(changes).filter(name => name !== 'archive')
  if (!active.length) return []
  const baseline = new Set(await activeOpenSpecChangesAt(input.git, input.worktreePath, input.baseRef))
  const successors = new Set([...active, ...directoryNames(path.join(changes, 'archive')).map(name => name.replace(ARCHIVE_DATE_PREFIX, ''))])
  // Decide every supersession before removing anything: in a fork-of-a-fork
  // chain an intermediate change is both a successor and superseded.
  const settled = input.forkRunIds[0]
  const own = new Set(active.map(name => forkSuccessorChangeName(name, settled)).filter(name => active.includes(name)))
  const superseded = active.filter(name => !baseline.has(name) && !own.has(name)
    && !fs.lstatSync(path.join(changes, name)).isSymbolicLink()
    && input.forkRunIds.some(runId => {
      const successor = forkSuccessorChangeName(name, runId)
      return successor !== name && successors.has(successor)
    }))
  if (!superseded.length) return []
  const backup = await retiredChangesDirectory(input.git, input.worktreePath)
  for (const name of superseded) {
    const target = path.join(backup, name)
    fs.mkdirSync(backup, { recursive: true })
    fs.rmSync(target, { recursive: true, force: true })
    moveDirectory(path.join(changes, name), target)
  }
  return superseded
}

/** `<git common dir>/specrails/retired-openspec-changes/<timestamp>`: outside the
 *  working tree (never staged or delivered) and kept with the repository. */
async function retiredChangesDirectory(git: GitRunner, worktreePath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const common = await git.run(['rev-parse', '--git-common-dir'], worktreePath).catch(() => null)
  const dir = common && common.code === 0 && common.stdout.trim() ? path.resolve(worktreePath, common.stdout.trim()) : null
  if (!dir) throw new Error('Could not locate the git directory to keep retired OpenSpec changes; nothing was removed')
  return path.join(dir, 'specrails', 'retired-openspec-changes', stamp)
}

function moveDirectory(from: string, to: string): void {
  try { fs.renameSync(from, to) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}
