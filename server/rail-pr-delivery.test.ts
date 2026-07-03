import { describe, it, expect } from 'vitest'
import { deliverRailAsPr, batchBranchName, buildBatchPrBody, type DeliverBranch } from './rail-pr-delivery'
import type { GitRunner, GitResult } from './worktree-manager'
import type { Exec, ExecResult } from './pr-publisher'

function fakeGit(opts: { addFails?: boolean; conflictOn?: string } = {}): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args)
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
  slug: 'p',
  railKey: '0-impl',
  batchWorktreeRoot: '/wt',
  title: 'Batch',
  body: 'B',
}
const br = (ticketId: number, succeeded: boolean): DeliverBranch => ({ ticketId, branch: `sr/p/ticket-${ticketId}`, succeeded })

describe('helpers', () => {
  it('batchBranchName', () => {
    expect(batchBranchName('p', '0-impl')).toBe('sr/p/batch-0-impl')
  })
  it('buildBatchPrBody lists every ticket', () => {
    const body = buildBatchPrBody('Implement', [{ ticketId: 1, title: 'A' }, { ticketId: 2 }])
    expect(body).toContain('- [x] #1 — A')
    expect(body).toContain('- [x] #2')
    expect(body).toContain('Implement')
  })
})

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
      expect(r.branch).toBe('sr/p/ticket-1')
      expect(r.pr.state).toBe('pr-created')
      expect(r.ticketIds).toEqual([1])
    }
    // no batch worktree was created
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false)
  })

  it('multiple tickets clean → batch branch off integration, merges, one PR, worktree removed', async () => {
    const { git, calls } = fakeGit()
    const { exec, calls: execCalls } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r.state).toBe('delivered')
    if (r.state === 'delivered') {
      expect(r.branch).toBe('sr/p/batch-0-impl')
      expect(r.ticketIds).toEqual([1, 2])
    }
    // batch branch created off the integration branch
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'sr/p/batch-0-impl', '/wt/batch-0-impl', 'main'])
    // both ticket branches merged
    expect(calls.filter((c) => c[0] === 'merge' && c[1] === '--no-ff')).toHaveLength(2)
    // PR opened against integration base from the batch branch
    expect(execCalls.find((c) => c.cmd === 'gh')?.args).toContain('main')
    // transient worktree cleaned up
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/batch-0-impl'])
  })

  it('multiple tickets conflict → abort + teardown + assembly-failed (base untouched)', async () => {
    const { git, calls } = fakeGit({ conflictOn: 'sr/p/ticket-2' })
    const { exec, calls: execCalls } = fakeExec()
    const r = await deliverRailAsPr(git, exec, { ...base, branches: [br(1, true), br(2, true)] })
    expect(r).toEqual({ state: 'assembly-failed', reason: 'merge-conflict:sr/p/ticket-2', ticketIds: [1, 2] })
    expect(calls).toContainEqual(['merge', '--abort'])
    expect(calls).toContainEqual(['branch', '-D', 'sr/p/batch-0-impl'])
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
})
