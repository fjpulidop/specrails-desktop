import { describe, it, expect, vi } from 'vitest'
import { orderBranches, mergeBack, type BranchToMerge, type MergeDeps } from './merge-manager'
import type { GitRunner, GitResult } from './worktree-manager'

function fakeGit(opts?: { conflict?: Set<string>; head?: string }) {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args)
      if (args[0] === 'rev-parse') return { code: 0, stdout: (opts?.head ?? 'BASE') + '\n', stderr: '' }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        const branch = args[args.length - 1]
        if (opts?.conflict?.has(branch)) return { code: 1, stdout: '', stderr: 'CONFLICT (content)' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { git, calls }
}

function deps(over: Partial<MergeDeps>, git: GitRunner): MergeDeps {
  return {
    git,
    baseDir: '/repo',
    resolveConflict: vi.fn(async () => true),
    verifyIntegrated: vi.fn(async () => true),
    rebaseAndFix: vi.fn(async () => true),
    ...over,
  }
}

const B = (ticketId: number, extra: Partial<BranchToMerge> = {}): BranchToMerge => ({
  ticketId, branch: `sr/p/ticket-${ticketId}`, succeeded: true, ...extra,
})

describe('orderBranches', () => {
  it('orders by ticket id when no touch-lists', () => {
    expect(orderBranches([B(3), B(1), B(2)]).map((b) => b.ticketId)).toEqual([1, 2, 3])
  })
  it('excludes failed runs', () => {
    expect(orderBranches([B(1), B(2, { succeeded: false })]).map((b) => b.ticketId)).toEqual([1])
  })
  it('orders least-overlapping first (then ticket id)', () => {
    // #1 touches only its own dir; #2 and #3 both touch the shared registry.
    const branches = [
      B(2, { touchList: ['registry.ts', 'b.ts'] }),
      B(3, { touchList: ['registry.ts', 'c.ts'] }),
      B(1, { touchList: ['a.ts'] }),
    ]
    expect(orderBranches(branches).map((b) => b.ticketId)).toEqual([1, 2, 3])
  })
})

describe('mergeBack', () => {
  it('merges all clean branches and reports merged', async () => {
    const { git, calls } = fakeGit()
    const d = deps({}, git)
    const out = await mergeBack(d, [B(1), B(2)])
    expect(out).toEqual([
      { ticketId: 1, branch: 'sr/p/ticket-1', state: 'merged' },
      { ticketId: 2, branch: 'sr/p/ticket-2', state: 'merged' },
    ])
    expect(d.resolveConflict).not.toHaveBeenCalled()
    expect(calls.filter((c) => c[0] === 'merge' && c[1] === '--no-ff')).toHaveLength(2)
  })

  it('resolves a conflict, commits the resolution, and merges', async () => {
    const { git, calls } = fakeGit({ conflict: new Set(['sr/p/ticket-1']) })
    const d = deps({ resolveConflict: vi.fn(async () => true) }, git)
    const out = await mergeBack(d, [B(1)])
    expect(out[0].state).toBe('merged')
    expect(d.resolveConflict).toHaveBeenCalledOnce()
    expect(calls).toContainEqual(['add', '-A'])
    expect(calls).toContainEqual(['commit', '--no-edit'])
    expect(calls.some((c) => c[0] === 'merge' && c[1] === '--abort')).toBe(false)
  })

  it('aborts and flags needs-review when the conflict is unresolvable', async () => {
    const { git, calls } = fakeGit({ conflict: new Set(['sr/p/ticket-1']) })
    const d = deps({ resolveConflict: vi.fn(async () => false) }, git)
    const out = await mergeBack(d, [B(1)])
    expect(out[0].state).toBe('needs-review')
    expect(calls).toContainEqual(['merge', '--abort'])
  })

  it('recovers a red integration via rebase+fix → merged', async () => {
    const { git } = fakeGit()
    const d = deps({ verifyIntegrated: vi.fn(async () => false), rebaseAndFix: vi.fn(async () => true) }, git)
    const out = await mergeBack(d, [B(1)])
    expect(out[0].state).toBe('merged')
    expect(d.rebaseAndFix).toHaveBeenCalledOnce()
  })

  it('rolls back to the pre-merge SHA and flags needs-review when fix fails', async () => {
    const { git, calls } = fakeGit({ head: 'PRESHA' })
    const d = deps({ verifyIntegrated: vi.fn(async () => false), rebaseAndFix: vi.fn(async () => false) }, git)
    const out = await mergeBack(d, [B(1)])
    expect(out[0].state).toBe('needs-review')
    expect(calls).toContainEqual(['reset', '--hard', 'PRESHA'])
  })

  it('never merges a failed run (skipped)', async () => {
    const { git, calls } = fakeGit()
    const d = deps({}, git)
    const out = await mergeBack(d, [B(1, { succeeded: false }), B(2)])
    expect(out.find((o) => o.ticketId === 1)?.state).toBe('skipped')
    expect(out.find((o) => o.ticketId === 2)?.state).toBe('merged')
    // only ticket-2 was actually merged
    expect(calls.filter((c) => c[0] === 'merge' && c[1] === '--no-ff')).toEqual([['merge', '--no-ff', '--no-edit', 'sr/p/ticket-2']])
  })

  it('emits state transitions', async () => {
    const { git } = fakeGit()
    const onState = vi.fn()
    await mergeBack(deps({ onState }, git), [B(1)])
    expect(onState).toHaveBeenCalledWith(1, 'merging')
    expect(onState).toHaveBeenCalledWith(1, 'merged')
  })
})
