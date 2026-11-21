import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildBaseRefreshResolverPrompt, mergeBaseIntoDelivery, rollbackBaseRefresh, type BaseRefreshInput, type ResolverInput } from './delivery-base-refresh'
import { defaultGitRunner } from '../../../worktree-manager'

let root: string, repo: string, worktree: string
const git = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const commit = (cwd: string, file: string, content: string, message: string): string => {
  writeFileSync(path.join(cwd, file), content); git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', message]); return git(cwd, ['rev-parse', 'HEAD'])
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'base-refresh ')))
  repo = path.join(root, 'repo'); worktree = path.join(root, 'wt')
  git(root, ['init', '-q', '-b', 'main', repo])
  commit(repo, 'cart.js', 'line1\nline2\nline3\n', 'baseline')
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/1-totals', worktree])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function input(deliverySha: string, overrides: Partial<BaseRefreshInput> = {}): BaseRefreshInput {
  return { worktreePath: worktree, branch: 'feat/1-totals', deliverySha, baseBranch: 'main', baseSha: git(repo, ['rev-parse', 'main']),
    protectedBranches: ['main'], specs: [{ ticketId: 1, title: 'Show totals', description: 'Cart shows totals' }], ticketRef: '1', ...overrides }
}
const noResolver = async (): Promise<void> => { throw new Error('the resolver must not run') }

describe('mergeBaseIntoDelivery', () => {
  it('merges a moved base without conflicts by a merge commit, moving only the feature branch', async () => {
    const delivery = commit(worktree, 'cart.js', 'line1\nline2 totals\nline3\n', 'feat: totals')
    commit(repo, 'other.js', 'x\n', 'feat: other spec')
    const base = git(repo, ['rev-parse', 'main'])
    const result = await mergeBaseIntoDelivery({ git: defaultGitRunner, resolve: noResolver }, input(delivery))
    expect(result).toMatchObject({ ok: true, conflicts: [] })
    const merge = git(worktree, ['rev-parse', 'HEAD'])
    expect(git(worktree, ['rev-parse', 'feat/1-totals'])).toBe(merge)
    expect(git(worktree, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feat/1-totals')
    expect(git(worktree, ['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1)).toEqual([delivery, base])
    expect(git(repo, ['rev-parse', 'main'])).toBe(base)
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('hands real conflicts to the resolver with the spec, then commits the resolved merge', async () => {
    const delivery = commit(worktree, 'cart.js', 'line1\nline2 totals\nline3\n', 'feat: totals')
    commit(repo, 'cart.js', 'line1\nline2 discounts\nline3\n', 'feat: discounts')
    const seen: ResolverInput[] = []
    const result = await mergeBaseIntoDelivery({ git: defaultGitRunner, resolve: async (request) => {
      seen.push(request)
      writeFileSync(path.join(worktree, 'cart.js'), 'line1\nline2 discounts totals\nline3\n')
    } }, input(delivery))
    expect(result).toMatchObject({ ok: true, conflicts: ['cart.js'] })
    expect(seen).toEqual([expect.objectContaining({ conflictPaths: ['cart.js'], baseBranch: 'main', specs: [expect.objectContaining({ title: 'Show totals' })] })])
    expect(readFileSync(path.join(worktree, 'cart.js'), 'utf8')).toBe('line1\nline2 discounts totals\nline3\n')
    expect(git(worktree, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3)
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
    const prompt = buildBaseRefreshResolverPrompt(seen[0], 'MERGE SAFE')
    expect(prompt).toContain('- cart.js')
    expect(prompt).toContain('#1 Show totals: Cart shows totals')
    expect(prompt).toContain('Do not run git merge, git commit')
  })

  it('gives the resolver a second round on the files its first round left conflicted', async () => {
    const delivery = commit(worktree, 'cart.js', 'line1\nline2 totals\nline3\n', 'feat: totals')
    commit(repo, 'cart.js', 'line1\nline2 discounts\nline3\n', 'feat: discounts')
    const rounds: string[][] = []
    const result = await mergeBaseIntoDelivery({ git: defaultGitRunner, resolve: async (request) => {
      rounds.push([...request.conflictPaths])
      if (rounds.length === 2) writeFileSync(path.join(worktree, 'cart.js'), 'line1\nline2 discounts totals\nline3\n')
    } }, input(delivery))
    expect(rounds).toEqual([['cart.js'], ['cart.js']])
    expect(result).toMatchObject({ ok: true, conflicts: ['cart.js'] })
  })

  it('restores the delivery exactly when the resolver leaves markers, edits other files or fails', async () => {
    const delivery = commit(worktree, 'cart.js', 'line1\nline2 totals\nline3\n', 'feat: totals')
    commit(repo, 'cart.js', 'line1\nline2 discounts\nline3\n', 'feat: discounts')
    // Two resolver rounds, the second on the files the first left: both doing nothing still restores.
    const attempts: Array<[(r: ResolverInput) => Promise<void>, string]> = [
      [async () => {}, 'conflict_unresolved'],
      [async () => { writeFileSync(path.join(worktree, 'cart.js'), 'ok\n'); writeFileSync(path.join(worktree, 'stray.js'), 'x\n') }, 'conflict_unresolved'],
      [async () => { throw new Error('provider unavailable') }, 'resolver_failed'],
    ]
    for (const [resolve, reason] of attempts) {
      expect(await mergeBaseIntoDelivery({ git: defaultGitRunner, resolve }, input(delivery))).toMatchObject({ ok: false, reason, conflicts: ['cart.js'] })
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(delivery)
      expect(git(worktree, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feat/1-totals')
      expect(git(worktree, ['status', '--porcelain'])).toBe('')
    }
  })

  it('refuses protected branches, moved or dirty worktrees, and a delivery that already contains the base', async () => {
    const delivery = commit(worktree, 'cart.js', 'line1\nline2 totals\nline3\n', 'feat: totals')
    const deps = { git: defaultGitRunner, resolve: noResolver }
    expect(await mergeBaseIntoDelivery(deps, input(delivery))).toMatchObject({ ok: false, reason: 'up_to_date' })
    commit(repo, 'other.js', 'x\n', 'other')
    expect(await mergeBaseIntoDelivery(deps, input(delivery, { branch: 'main' }))).toMatchObject({ ok: false, reason: 'protected_branch' })
    expect(await mergeBaseIntoDelivery(deps, input(git(repo, ['rev-parse', 'main'])))).toMatchObject({ ok: false, reason: 'worktree_changed' })
    writeFileSync(path.join(worktree, 'cart.js'), 'dirty\n')
    expect(await mergeBaseIntoDelivery(deps, input(delivery))).toMatchObject({ ok: false, reason: 'worktree_changed' })
    expect(await mergeBaseIntoDelivery(deps, input(delivery, { worktreePath: path.join(root, 'gone') }))).toMatchObject({ ok: false, reason: 'worktree_unavailable' })
  })

  it('rolls a refresh back to the delivery commit when its re-verification cannot start', async () => {
    const delivery = commit(worktree, 'cart.js', 'line1\nline2 totals\nline3\n', 'feat: totals')
    commit(repo, 'other.js', 'x\n', 'other')
    const result = await mergeBaseIntoDelivery({ git: defaultGitRunner, resolve: noResolver }, input(delivery))
    if (!result.ok) throw new Error(result.detail)
    expect(await rollbackBaseRefresh(defaultGitRunner, { worktreePath: worktree, branch: 'feat/1-totals', deliverySha: delivery, mergeSha: result.mergeSha })).toBe(true)
    expect(git(worktree, ['rev-parse', 'feat/1-totals'])).toBe(delivery)
    expect(git(worktree, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feat/1-totals')
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
  })
})
