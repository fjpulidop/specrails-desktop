import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { initDb, type DbInstance } from '../../../db'
import { defaultGitRunner, type GitRunner } from '../../../worktree-manager'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import {
  createRetainedSizeScanner, listRetainedWorktrees, removeRetainedWorktree, type RetainedWorktreeProject,
} from './retained-worktrees'

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

let root: string
let repo: string
let db: DbInstance
let project: RetainedWorktreeProject
let counter = 0

const OLD = '2026-01-01 00:00:00'

/** Make a worktree look idle: its ledger row and its Git metadata are days old. */
function age(id: string, worktreePath: string): void {
  db.prepare('UPDATE rail_worktrees SET updated_at = ? WHERE id = ?').run(OLD, id)
  const gitDir = path.resolve(worktreePath, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(worktreePath, '.git'), 'utf8'))![1].trim())
  const then = new Date('2026-01-01T00:00:00Z')
  for (const file of ['index', 'HEAD', path.join('logs', 'HEAD')]) {
    const target = path.join(gitDir, file)
    if (fs.existsSync(target)) fs.utimesSync(target, then, then)
  }
}

function retain(branch: string, state: 'needs-review' | 'failed' = 'needs-review'): { id: string; wt: string } {
  counter += 1
  const id = `wt-${counter}`
  const wt = path.join(root, 'worktrees', id)
  git(repo, 'worktree', 'add', '-b', branch, wt, 'HEAD')
  createRailWorktree(db, { id, railIndex: 0, ticketId: counter, branch, worktreePath: wt, mergeState: state })
  return { id, wt }
}

async function itemOf(id: string) {
  const items = await listRetainedWorktrees(project, defaultGitRunner)
  const item = items.find((entry) => entry.id === id)
  if (!item) throw new Error(`no item ${id}`)
  return item
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-retained-')))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\ndist/\n')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=same\n')
  db = initDb(':memory:')
  project = { id: 'p1', name: 'Project', path: repo, db }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('retained worktrees (real Git)', () => {
  it('lists a clean idle worktree as nothing to lose and removes it with its branch', async () => {
    const { id, wt } = retain('feat/clean')
    age(id, wt)
    const item = await itemOf(id)
    expect(item.evaluation).toMatchObject({ label: 'nothing-to-lose', removable: true, branchDeletable: true })
    expect(item).toMatchObject({ trackedChanges: 0, untrackedFiles: 0, unpushedCommits: 0, ignoredAtRiskCount: 0 })

    const result = await removeRetainedWorktree(project, defaultGitRunner, { id, head: item.head!, deleteBranch: true })
    expect(result).toMatchObject({ status: 'removed', branchDeleted: true })
    expect(fs.existsSync(wt)).toBe(false)
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/clean'], { cwd: repo }).status).not.toBe(0)
    expect(getRailWorktree(db, id)?.merge_state).toBe('released')
    expect((await listRetainedWorktrees(project, defaultGitRunner)).map((entry) => entry.id)).not.toContain(id)
  })

  it('keeps a worktree with uncommitted changes', async () => {
    const { id, wt } = retain('feat/dirty')
    fs.appendFileSync(path.join(wt, 'app.ts'), 'export const b = 2\n')
    age(id, wt)
    const item = await itemOf(id)
    expect(item.evaluation).toMatchObject({ removable: false, removeBlocker: 'uncommitted-changes' })
    expect(item.trackedChanges).toBe(1)
    const result = await removeRetainedWorktree(project, defaultGitRunner, { id, head: item.head!, deleteBranch: true })
    expect(result).toMatchObject({ status: 'kept', reason: 'uncommitted-changes' })
    expect(fs.existsSync(path.join(wt, 'app.ts'))).toBe(true)
  })

  it('removes the worktree of a branch with unique commits but keeps the branch', async () => {
    const { id, wt } = retain('feat/ahead')
    fs.writeFileSync(path.join(wt, 'new.ts'), 'export {}\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'work')
    age(id, wt)
    const item = await itemOf(id)
    expect(item.unpushedCommits).toBe(1)
    expect(item.evaluation).toMatchObject({ label: 'waiting-for-you', reasons: ['unpushed-commits'], removable: true, branchDeletable: false })

    const result = await removeRetainedWorktree(project, defaultGitRunner, { id, head: item.head!, deleteBranch: true })
    expect(result).toMatchObject({ status: 'removed', branchDeleted: false })
    expect(git(repo, 'rev-parse', 'refs/heads/feat/ahead')).toBe(item.head)
  })

  it('counts commits on a remote as safe', async () => {
    const remote = path.join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    const { id, wt } = retain('feat/pushed')
    fs.writeFileSync(path.join(wt, 'pushed.ts'), 'export {}\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'pushed work')
    git(wt, 'push', '-q', 'origin', 'feat/pushed')
    age(id, wt)
    const item = await itemOf(id)
    expect(item.unpushedCommits).toBe(0)
    expect(item.evaluation.label).toBe('nothing-to-lose')
  })

  it('treats an ignored file identical to the main checkout as safe and a different one as at risk', async () => {
    const same = retain('feat/env-same')
    fs.writeFileSync(path.join(same.wt, '.env'), 'TOKEN=same\n')
    age(same.id, same.wt)
    const different = retain('feat/env-different')
    fs.writeFileSync(path.join(different.wt, '.env'), 'TOKEN=only-here\n')
    fs.mkdirSync(path.join(different.wt, 'dist'))
    fs.writeFileSync(path.join(different.wt, 'dist', 'out.js'), 'built\n')
    age(different.id, different.wt)

    const safe = await itemOf(same.id)
    expect(safe.evaluation.label).toBe('nothing-to-lose')
    const risky = await itemOf(different.id)
    expect(risky.evaluation).toMatchObject({ removable: false, removeBlocker: 'ignored-files' })
    expect(risky.ignoredAtRisk.sort()).toEqual(['.env', 'dist'])

    // The release path re-proves the identical copy live and removes the worktree.
    const removed = await removeRetainedWorktree(project, defaultGitRunner, { id: same.id, head: safe.head!, deleteBranch: false })
    expect(removed.status).toBe('removed')
    expect(fs.readFileSync(path.join(repo, '.env'), 'utf8')).toBe('TOKEN=same\n')
    const kept = await removeRetainedWorktree(project, defaultGitRunner, { id: different.id, head: risky.head!, deleteBranch: false })
    expect(kept).toMatchObject({ status: 'kept', reason: 'ignored-files' })
    expect(fs.readFileSync(path.join(different.wt, '.env'), 'utf8')).toBe('TOKEN=only-here\n')
  })

  it('refuses when HEAD moved after the person confirmed', async () => {
    const { id, wt } = retain('feat/moved')
    age(id, wt)
    const item = await itemOf(id)
    fs.writeFileSync(path.join(wt, 'late.ts'), 'export {}\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'late')
    age(id, wt)
    const result = await removeRetainedWorktree(project, defaultGitRunner, { id, head: item.head!, deleteBranch: true })
    expect(result).toMatchObject({ status: 'kept', reason: 'changed' })
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('deletes a branch only while it still points at the recorded commit', async () => {
    const base = git(repo, 'rev-parse', 'HEAD')
    const { id, wt } = retain('feat/race')
    age(id, wt)
    const item = await itemOf(id)
    // Someone moves the branch between the check and the deletion.
    const racing: GitRunner = {
      async run(args, cwd) {
        if (args[0] === 'update-ref' && args[1] === '-d') {
          fs.writeFileSync(path.join(repo, 'other.ts'), 'export {}\n')
          git(repo, 'add', 'other.ts')
          git(repo, 'commit', '-qm', 'other')
          git(repo, 'update-ref', 'refs/heads/feat/race', git(repo, 'rev-parse', 'HEAD'))
        }
        return defaultGitRunner.run(args, cwd)
      },
    }
    const result = await removeRetainedWorktree(project, racing, { id, head: item.head!, deleteBranch: true })
    expect(result).toMatchObject({ status: 'removed', branchDeleted: false })
    expect(git(repo, 'rev-parse', 'refs/heads/feat/race')).not.toBe(base)
  })

  it('reclaims a terminal row whose mount is still on disk and keeps its recorded state', async () => {
    const { id, wt } = retain('feat/leftover', 'failed')
    age(id, wt)
    const item = await itemOf(id)
    expect(item.state).toBe('failed')
    const result = await removeRetainedWorktree(project, defaultGitRunner, { id, head: item.head!, deleteBranch: false })
    expect(result.status).toBe('removed')
    expect(fs.existsSync(wt)).toBe(false)
    expect(getRailWorktree(db, id)?.merge_state).toBe('failed')
  })

  it('waits for a recently touched worktree and leaves a live allocation out', async () => {
    const recent = retain('feat/recent')
    expect((await itemOf(recent.id)).evaluation.removeBlocker).toBe('recently-active')
    const live = retain('feat/live')
    db.prepare("UPDATE rail_worktrees SET merge_state = 'building' WHERE id = ?").run(live.id)
    expect((await listRetainedWorktrees(project, defaultGitRunner)).map((entry) => entry.id)).not.toContain(live.id)
  })
})

describe('createRetainedSizeScanner', () => {
  it('bounds scans in flight, reuses fresh results and keys by project', async () => {
    let inFlight = 0
    let peak = 0
    const resolvers: Array<() => void> = []
    const scanner = createRetainedSizeScanner({
      concurrency: 2,
      read: () => new Promise<number>((resolve) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        resolvers.push(() => { inFlight--; resolve(1024) })
      }),
    })
    for (const id of ['a', 'b', 'c']) expect(scanner.request('p1', id, `/tmp/${id}`).status).toBe('scanning')
    expect(peak).toBe(2)
    while (resolvers.length) { resolvers.shift()!(); await new Promise((r) => setTimeout(r, 0)) }
    expect(scanner.request('p1', 'a', '/tmp/a')).toMatchObject({ status: 'done', bytes: 1024 })
    expect(scanner.request('p2', 'a', '/tmp/a').status).toBe('scanning')
    expect(peak).toBe(2)
  })
})
