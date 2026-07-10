import { describe, it, expect } from 'vitest'
import { deliverRailAsPr, type DeliverBranch } from './rail-pr-delivery'
import type { GitRunner, GitResult } from './worktree-manager'
import type { Exec, ExecResult } from './pr-publisher'

function fakeGit(opts: { addFails?: boolean; conflictOn?: string; existingBranches?: string[] } = {}): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args)
      if (args[0] === 'for-each-ref') {
        return { code: 0, stdout: (opts.existingBranches ?? []).join('\n'), stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return opts.addFails ? { code: 1, stdout: '', stderr: 'fatal: add boom' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        return opts.conflictOn && args.includes(opts.conflictOn) ? { code: 1, stdout: '', stderr: 'CONFLICT' } : { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { git, calls }
}

function fakeExec(pr: ExecResult = { code: 0, stdout: 'https://github.com/o/r/pull/5\n', stderr: '' }): { exec: Exec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const exec: Exec = {
    async run(cmd, args) {
      calls.push({ cmd, args })
      if (cmd === 'gh') return pr
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { exec, calls }
}

const base = {
  baseRepo: '/repo',
  integrationBranch: 'main',
  railKey: '0-impl',
  batchBranch: 'feat/1-batch-2-tickets',
  batchWorktreeRoot: '/wt',
  title: 'Batch',
  body: 'B',
}
const br = (ticketId: number, succeeded: boolean): DeliverBranch => ({ ticketId, branch: `feat/${ticketId}-t${ticketId}`, succeeded })

describe('deliverRailAsPr', () => {
  it('no-op when nothing succeeded', async () => {
    const { git } = fakeGit()
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, false), br(2, false)] })
    expect(r).toEqual({ state: 'no-op', reason: 'no-succeeded-branches' })
  })

  it('single ticket → PR straight from its branch (no batch worktree)', async () => {
    const { git, calls } = fakeGit()
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, false)] })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') {
      expect(r.branch).toBe('feat/1-t1')
      expect(r.pr.state).toBe('pr-created')
      expect(r.ticketIds).toEqual([1])
    }
    // no batch worktree was created
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false)
  })

  it('single ticket pushes the immutable settled object, not the mutable branch ref', async () => {
    const sha = 'a'.repeat(40)
    const { git } = fakeGit()
    const { exec, calls } = fakeExec()
    const r = await deliverRailAsPr(git, exec, {
      ...base,
      branches: [{ ...br(1, true), sourceSha: sha }],
    })
    expect(r.state).toBe('delivered')
    expect(calls).toContainEqual({
      cmd: 'git', args: ['push', 'origin', `${sha}:refs/heads/feat/1-t1`],
    })
  })

  it('multiple tickets clean → batch branch off integration, merges, one PR, worktree removed', async () => {
    const { git, calls } = fakeGit()
    const { exec, calls: execCalls } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') {
      expect(r.branch).toBe('feat/1-batch-2-tickets')
      expect(r.ticketIds).toEqual([1, 2])
    }
    // batch branch created off the integration branch
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'feat/1-batch-2-tickets', '/wt/batch-0-impl', 'main'])
    // both ticket branches merged
    expect(calls.filter((c) => c[0] === 'merge' && c[1] === '--no-ff')).toHaveLength(2)
    // PR opened against integration base from the batch branch
    expect(execCalls.find((c) => c.cmd === 'gh')?.args).toContain('main')
    // transient worktree cleaned up
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/batch-0-impl'])
  })

  it('batch assembly merges immutable settled objects', async () => {
    const first = 'a'.repeat(40)
    const second = 'b'.repeat(40)
    const { git, calls } = fakeGit()
    const { exec } = fakeExec()
    await deliverRailAsPr(git, exec, {
      ...base,
      branches: [
        { ...br(1, true), sourceSha: first },
        { ...br(2, true), sourceSha: second },
      ],
    })
    expect(calls.filter((call) => call[0] === 'merge')).toEqual([
      ['merge', '--no-ff', '--no-edit', first],
      ['merge', '--no-ff', '--no-edit', second],
    ])
  })

  it('an existing branch of the preferred batch name → bounded -2 suffix', async () => {
    const { git, calls } = fakeGit({ existingBranches: ['feat/1-batch-2-tickets'] })
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') expect(r.branch).toBe('feat/1-batch-2-tickets-2')
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'feat/1-batch-2-tickets-2', '/wt/batch-0-impl', 'main'])
  })

  it('the batch branch never lands on the integration branch even when preferred', async () => {
    const { git, calls } = fakeGit()
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, {
      ...base,
      batchBranch: 'main', // pathological: preferred name == integration branch
      branches: [br(1, true), br(2, true)],
    })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') expect(r.branch).toBe('main-2')
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add' && c[3] === 'main')).toBe(false)
  })

  it('multiple tickets conflict → abort + teardown + assembly-failed (base untouched)', async () => {
    const { git, calls } = fakeGit({ conflictOn: 'feat/2-t2' })
    const { exec, calls: execCalls } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r).toEqual({ state: 'assembly-failed', reason: 'merge-conflict:feat/2-t2', ticketIds: [1, 2] })
    expect(calls).toContainEqual(['merge', '--abort'])
    expect(calls).toContainEqual(['branch', '-D', 'feat/1-batch-2-tickets'])
    // never pushed / opened a PR
    expect(execCalls.some((c) => c.cmd === 'gh')).toBe(false)
  })

  it('assembly-failed when the batch worktree cannot be created', async () => {
    const { git } = fakeGit({ addFails: true })
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r.state).toBe('assembly-failed')
    if (r.state === 'assembly-failed') expect(r.reason).toContain('add boom')
  })

  it('assembly-failed batch-branch-collision when every suffix is taken (bounded)', async () => {
    const taken = ['feat/1-batch-2-tickets', ...Array.from({ length: 25 }, (_, i) => `feat/1-batch-2-tickets-${i + 2}`)]
    const { git } = fakeGit({ existingBranches: taken })
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r.state).toBe('assembly-failed')
    if (r.state === 'assembly-failed') expect(r.reason).toContain('batch-branch-collision')
  })

  it('HARD GUARD: the batch head is never assembled ON a unit branch name — suffixed away', async () => {
    // Pathological ticket title ("Batch 2 tickets") makes the preferred batch
    // name equal unit 1's branch. Assembling (and later tearing down) on it
    // would `branch -D` the commits being delivered.
    const { git, calls } = fakeGit()
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, {
      ...base,
      batchBranch: 'feat/1-t1', // == unit 1's branch
      branches: [br(1, true), br(2, true)],
    })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') expect(r.branch).toBe('feat/1-t1-2')
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'feat/1-t1-2', '/wt/batch-0-impl', 'main'])
    expect(calls.some((c) => c[0] === 'branch' && c[1] === '-D' && c[2] === 'feat/1-t1')).toBe(false)
  })

  it('HARD GUARD under conflict teardown: only the suffixed batch head is -D-ed, never a unit branch', async () => {
    const { git, calls } = fakeGit({ conflictOn: 'feat/2-t2' })
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, {
      ...base,
      batchBranch: 'feat/1-t1',
      branches: [br(1, true), br(2, true)],
    })
    expect(r.state).toBe('assembly-failed')
    const deleted = calls.filter((c) => c[0] === 'branch' && c[1] === '-D').map((c) => c[2])
    expect(deleted).toEqual(['feat/1-t1-2'])
  })

  it('defensive: a multi-unit delivery without a batchBranch fails safely (never assembles an empty ref)', async () => {
    const { git, calls } = fakeGit()
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, batchBranch: undefined, branches: [br(1, true), br(2, true)] })
    expect(r).toEqual({ state: 'assembly-failed', reason: 'missing-batch-branch', ticketIds: [1, 2] })
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false)
  })

  it('a single-unit delivery needs no batchBranch at all', async () => {
    const { git } = fakeGit()
    const { exec } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, batchBranch: undefined, branches: [br(1, true)] })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') expect(r.branch).toBe('feat/1-t1')
  })
})
