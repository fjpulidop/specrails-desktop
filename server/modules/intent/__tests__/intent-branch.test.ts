import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultGitRunner } from '../../../worktree-manager'
import { ensureIntentBranch } from '../adapters/bindings'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const BRANCH = 'fix/3-intent'
/** A repository with the Intent branch at the base commit, checked out in its own worktree. */
function intent(): { repo: string; worktree: string; base: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'intent-branch-'))); roots.push(root)
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@e.st'); git(repo, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
  const worktree = path.join(root, 'ticket-3')
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, worktree)
  git(worktree, 'config', 'user.email', 't@e.st'); git(worktree, 'config', 'user.name', 'T')
  return { repo, worktree, base: git(repo, 'rev-parse', 'HEAD') }
}

describe('ensureIntentBranch (hand-off commits on the Intent branch)', () => {
  it('leaves a worktree already on its branch alone', async () => {
    const { worktree } = intent()
    await ensureIntentBranch(defaultGitRunner, worktree, BRANCH, 'flow')
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
  })

  // deckdex-mtg: the agent ran `git checkout -q HEAD~0`, then work was committed on the detached HEAD.
  it('reattaches a detached HEAD at or ahead of the branch, without touching files', async () => {
    const { worktree, base } = intent()
    git(worktree, 'checkout', '-q', 'HEAD~0')
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'intent\n'); git(worktree, 'commit', '-q', '-am', 'Intent #3')
    fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'uncommitted\n')
    const head = git(worktree, 'rev-parse', 'HEAD')
    expect(git(worktree, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(base)
    await ensureIntentBranch(defaultGitRunner, worktree, BRANCH, 'flow')
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
    expect(git(worktree, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(head)
    expect(fs.readFileSync(path.join(worktree, 'dirty.txt'), 'utf8')).toBe('uncommitted\n')
    // Detached exactly at the tip (nothing committed yet) reattaches too.
    git(worktree, 'checkout', '-q', '--detach')
    await ensureIntentBranch(defaultGitRunner, worktree, BRANCH, 'flow')
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
  })

  it('refuses a detached HEAD that does not contain the branch, another branch, or a branch held elsewhere', async () => {
    const { repo, worktree } = intent()
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'ahead\n'); git(worktree, 'commit', '-q', '-am', 'branch work')
    git(worktree, 'checkout', '-q', 'HEAD~1')
    await expect(ensureIntentBranch(defaultGitRunner, worktree, BRANCH, 'flow')).rejects.toThrow('does not contain its branch')
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    git(worktree, 'switch', '-q', '-c', 'other')
    await expect(ensureIntentBranch(defaultGitRunner, worktree, BRANCH, 'flow')).rejects.toThrow(`is on other, not its branch ${BRANCH}`)
    git(worktree, 'checkout', '-q', '--detach', BRANCH)
    git(repo, 'worktree', 'add', '-q', path.join(path.dirname(worktree), 'elsewhere'), BRANCH)
    await expect(ensureIntentBranch(defaultGitRunner, worktree, BRANCH, 'flow')).rejects.toThrow('Another worktree holds')
  })
})
