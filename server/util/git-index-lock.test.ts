import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  __resetIndexLockMemory, describeIndexLockFailure, inspectIndexLock, resolveIndexLockPath, waitForIndexLockRelease,
} from './git-index-lock'
import { runBounded } from './bounded-exec'
import { defaultGitRunner } from '../worktree-manager'

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

let root: string
let repo: string

beforeEach(() => {
  __resetIndexLockMemory()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-index-lock-')))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveIndexLockPath', () => {
  it('finds the lock of a main checkout from a subdirectory', async () => {
    fs.mkdirSync(path.join(repo, 'sub'))
    expect(await resolveIndexLockPath(path.join(repo, 'sub'))).toBe(path.join(repo, '.git', 'index.lock'))
  })

  it('follows a linked worktree .git file to its private gitdir', async () => {
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
    expect(await resolveIndexLockPath(wt)).toBe(path.join(repo, '.git', 'worktrees', 'wt', 'index.lock'))
  })
})

describe('waitForIndexLockRelease', () => {
  it('returns null without a lock', async () => {
    expect(await waitForIndexLockRelease(repo)).toBeNull()
  })

  it('waits for a live lock that is released', async () => {
    const lock = path.join(repo, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    setTimeout(() => fs.rmSync(lock, { force: true }), 120)
    expect(await waitForIndexLockRelease(repo, { maxWaitMs: 2_000 })).toBeNull()
  })

  it('remembers a lock that outlives the wait and skips waiting next time', async () => {
    const lock = path.join(repo, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const first = await waitForIndexLockRelease(repo, { maxWaitMs: 200 })
    expect(first).toMatchObject({ path: lock, stale: true })
    const started = Date.now()
    const second = await waitForIndexLockRelease(repo, { maxWaitMs: 5_000 })
    expect(second).toMatchObject({ stale: true })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await inspectIndexLock(repo)).toMatchObject({ stale: true })
    // A NEW lock (different identity) gets its own wait, not the stale verdict.
    fs.rmSync(lock)
    expect(await inspectIndexLock(repo)).toBeNull()
  })
})

describe('describeIndexLockFailure', () => {
  it('explains Git lock failures and ignores others', () => {
    const stderr = "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"
    expect(describeIndexLockFailure(stderr, { path: '/r/.git/index.lock', stale: true, ageMs: 5_000 })).toMatch(/index is locked: \/r\/\.git\/index\.lock exists \(unchanged for 5 s\).*never deletes it/)
    expect(describeIndexLockFailure('fatal: not a git repository')).toBeNull()
  })
})

describe('real git', () => {
  it('read-only status through the bounded exec never rewrites the index (no optional lock)', async () => {
    const index = path.join(repo, '.git', 'index')
    // Same bytes, new mtime: a plain status refreshes the stat data and writes
    // the index back under index.lock as a side effect.
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(path.join(repo, 'a.txt'), later, later)
    const before = fs.statSync(index).mtimeMs
    const res = await runBounded('git', ['status', '--porcelain'], { cwd: repo, env: GIT_ENV, timeoutMs: 10_000 })
    expect(res.code).toBe(0)
    expect(fs.statSync(index).mtimeMs).toBe(before)
    // Control: the same read without the read-only env does take the lock.
    git(repo, 'status', '--porcelain')
    expect(fs.statSync(index).mtimeMs).not.toBe(before)
  })

  it('a write blocked by a lock gets an actionable explanation from the GitRunner', async () => {
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n')
    const res = await defaultGitRunner.run(['add', 'b.txt'], repo)
    expect(res.code).not.toBe(0)
    expect(res.stderr).toMatch(/Specrails never deletes it/)
  })

  it('status through the GitRunner succeeds while a stale lock exists', async () => {
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n')
    const res = await defaultGitRunner.run(['status', '--porcelain'], repo)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('?? b.txt')
  })
})
