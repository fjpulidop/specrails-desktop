import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  __preparedCheckoutCount, __resetPreparedCheckouts, ensurePreparedCheckout, preparedCheckoutClaimer,
  prewarmPreparedCheckouts, releasePreparedCheckouts, PREPARED_DIR,
} from './worktree-preparation-pool'
import { __resetCheckoutWorkersCache, checkoutWorkersArgs, createWorktree, defaultGitRunner, listWorktrees } from '../../../worktree-manager'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim()

let tmp: string
let repo: string
let root: string
let hookLog: string

function commitFile(name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repo, name), content)
  git(repo, 'add', name)
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message)
  return git(repo, 'rev-parse', 'HEAD')
}

beforeEach(async () => {
  await __resetPreparedCheckouts()
  __resetCheckoutWorkersCache()
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-prep-')))
  repo = path.join(tmp, 'repo')
  root = path.join(tmp, 'worktrees')
  hookLog = path.join(tmp, 'hook.log')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), `file ${i}\n`)
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base')
  // A person's post-checkout hook: must run exactly once per run worktree,
  // after its files exist, with the branch-checkout flag.
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
  fs.writeFileSync(hook, `#!/bin/sh\necho "$3 $(test -f f0.txt && echo files) $(git rev-parse --abbrev-ref HEAD)" >> "${hookLog}"\n`, { mode: 0o755 })
})

afterEach(async () => {
  await __resetPreparedCheckouts()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function settle(): Promise<void> {
  // Wait until every in-flight preparation has populated its checkout.
  const claim = preparedCheckoutClaimer(defaultGitRunner, repo, root)
  void claim
  for (let i = 0; i < 200; i++) {
    const prepared = path.join(root, PREPARED_DIR)
    const dirs = fs.existsSync(prepared) ? fs.readdirSync(prepared) : []
    if (dirs.length > 0 && dirs.every((d) => fs.existsSync(path.join(prepared, d, 'f149.txt')))) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('prepared run checkouts', () => {
  it('prepares detached populated checkouts without running hooks, and a fresh worktree adopts one', async () => {
    expect(prewarmPreparedCheckouts({ git: defaultGitRunner, repoDir: repo, worktreesRoot: root, baseRef: 'main' }, 2)).toBe(2)
    expect(__preparedCheckoutCount(repo)).toBe(2)
    await settle()
    expect(fs.existsSync(hookLog)).toBe(false)

    const handle = await createWorktree(defaultGitRunner, {
      repoDir: repo, worktreesRoot: path.join(root, 'run-1'), slug: 's', ticketId: 7,
      baseRef: 'main', branch: 'feat/7-thing', fresh: true,
      claimPrepared: preparedCheckoutClaimer(defaultGitRunner, repo, root),
    })
    expect(handle).toMatchObject({ branch: 'feat/7-thing', worktreeCreated: true, branchCreated: true })
    expect(handle.worktreePath).toBe(path.join(root, 'run-1', 'ticket-7'))
    expect(git(handle.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/7-thing')
    expect(git(handle.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'))
    expect(git(handle.worktreePath, 'status', '--porcelain')).toBe('')
    expect(fs.readFileSync(hookLog, 'utf8').trim().split('\n')).toEqual(['1 files feat/7-thing'])
    expect(__preparedCheckoutCount(repo)).toBe(1)
  })

  it('adoption resets a checkout prepared from an older base to the exact launch base', async () => {
    ensurePreparedCheckout({ git: defaultGitRunner, repoDir: repo, worktreesRoot: root, baseRef: 'main' })
    await settle()
    const newer = commitFile('f0.txt', 'changed after preparation\n', 'move base')
    const handle = await createWorktree(defaultGitRunner, {
      repoDir: repo, worktreesRoot: path.join(root, 'run-2'), slug: 's', ticketId: 8,
      baseRef: newer, branch: 'feat/8', fresh: true,
      claimPrepared: preparedCheckoutClaimer(defaultGitRunner, repo, root),
    })
    expect(git(handle.worktreePath, 'rev-parse', 'HEAD')).toBe(newer)
    expect(fs.readFileSync(path.join(handle.worktreePath, 'f0.txt'), 'utf8')).toBe('changed after preparation\n')
    expect(git(handle.worktreePath, 'status', '--porcelain')).toBe('')
  })

  it('falls back to a plain worktree add when the claimed checkout is unusable', async () => {
    const handle = await createWorktree(defaultGitRunner, {
      repoDir: repo, worktreesRoot: path.join(root, 'run-3'), slug: 's', ticketId: 9,
      baseRef: 'main', branch: 'feat/9', fresh: true,
      claimPrepared: async () => ({ path: path.join(tmp, 'not-a-worktree'), discard: async () => {} }),
    })
    expect(git(handle.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/9')
    expect(fs.readFileSync(hookLog, 'utf8').trim().split('\n')).toEqual(['1 files feat/9'])
  })

  it('release drops unclaimed checkouts, and leftovers of a previous process are swept', async () => {
    prewarmPreparedCheckouts({ git: defaultGitRunner, repoDir: repo, worktreesRoot: root, baseRef: 'main' }, 1)
    await settle()
    expect(await releasePreparedCheckouts(defaultGitRunner, repo, root)).toBe(1)
    expect(__preparedCheckoutCount(repo)).toBe(0)
    expect((await listWorktrees(defaultGitRunner, repo)).length).toBe(0)

    // A previous process left a registered checkout and a stray directory.
    const stale = path.join(root, PREPARED_DIR, 'stale')
    fs.mkdirSync(path.dirname(stale), { recursive: true })
    git(repo, 'worktree', 'add', '--detach', '--no-checkout', stale, 'main')
    fs.mkdirSync(path.join(root, PREPARED_DIR, 'stray'))
    await __resetPreparedCheckouts() // a fresh process: nothing owned, nothing swept yet
    prewarmPreparedCheckouts({ git: defaultGitRunner, repoDir: repo, worktreesRoot: root, baseRef: 'main' }, 1)
    await settle()
    const left = fs.readdirSync(path.join(root, PREPARED_DIR))
    expect(left).toHaveLength(1)
    expect(left).not.toContain('stale')
    expect(left).not.toContain('stray')
    expect((await listWorktrees(defaultGitRunner, repo)).length).toBe(1)
  })

  it('never hands a checkout to a launch under another mount root', async () => {
    ensurePreparedCheckout({ git: defaultGitRunner, repoDir: repo, worktreesRoot: root, baseRef: 'main' })
    await settle()
    expect(await preparedCheckoutClaimer(defaultGitRunner, repo, path.join(tmp, 'elsewhere'))()).toBeNull()
    expect(__preparedCheckoutCount(repo)).toBe(1)
  })

  it('keeps a checkout.workers value the person configured', async () => {
    expect(await checkoutWorkersArgs(defaultGitRunner, repo)).toEqual(['-c', 'checkout.workers=4'])
    __resetCheckoutWorkersCache()
    git(repo, 'config', 'checkout.workers', '2')
    expect(await checkoutWorkersArgs(defaultGitRunner, repo)).toEqual([])
  })
})
