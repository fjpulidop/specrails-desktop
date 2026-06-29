import { describe, it, expect, vi } from 'vitest'
import { runMergeBack, type MergeExecutor } from './rail-merge-orchestrator'
import type { GitRunner, GitResult } from './worktree-manager'
import type { BranchToMerge } from './merge-manager'

function fakeGit(opts?: { conflict?: Set<string>; unmergedAfterResolve?: boolean }) {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args)
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'SHA\n', stderr: '' }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        const branch = args[args.length - 1]
        if (opts?.conflict?.has(branch)) return { code: 1, stdout: '', stderr: 'CONFLICT' }
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { code: 0, stdout: opts?.unmergedAfterResolve ? 'registry.ts\n' : '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { git, calls }
}

/** Executor that returns programmed AI-step texts IN ORDER (the orchestrator calls
 *  verify/resolve/fix deterministically), so the test is decoupled from prompt text. */
function queueExecutor(texts: string[]) {
  let i = 0
  const prompts: string[] = []
  const executor: MergeExecutor = {
    runAiStep: vi.fn(async ({ prompt }) => {
      prompts.push(prompt)
      return { text: i < texts.length ? texts[i++] : '', failed: false }
    }),
  }
  return { executor, prompts }
}

const B = (id: number): BranchToMerge => ({ ticketId: id, branch: `sr/p/ticket-${id}`, succeeded: true })
const ctxBase = { baseDir: '/repo', provider: 'claude', model: 'sonnet', constants: {} as Record<string, string> }

describe('runMergeBack orchestrator', () => {
  it('clean merges → all merged when verify passes', async () => {
    const { git } = fakeGit()
    const { executor } = queueExecutor(['VERIFICATION: PASS', 'VERIFICATION: PASS'])
    const out = await runMergeBack({ ...ctxBase, git, executor, branches: [B(1), B(2)] })
    expect(out.map((o) => o.state)).toEqual(['merged', 'merged'])
  })

  it('conflict → resolver clears unmerged paths → merged', async () => {
    const { git } = fakeGit({ conflict: new Set(['sr/p/ticket-1']), unmergedAfterResolve: false })
    const { executor } = queueExecutor(['(resolved)', 'VERIFICATION: PASS'])
    const out = await runMergeBack({ ...ctxBase, git, executor, branches: [B(1)] })
    expect(out[0].state).toBe('merged')
  })

  it('conflict → resolver leaves unmerged paths → needs-review', async () => {
    const { git, calls } = fakeGit({ conflict: new Set(['sr/p/ticket-1']), unmergedAfterResolve: true })
    const { executor } = queueExecutor(['RESOLVE: needs-review'])
    const out = await runMergeBack({ ...ctxBase, git, executor, branches: [B(1)] })
    expect(out[0].state).toBe('needs-review')
    expect(calls).toContainEqual(['merge', '--abort'])
  })

  it('integrated red then fix makes verify pass → merged', async () => {
    const { git } = fakeGit()
    const { executor } = queueExecutor(['VERIFICATION: FAIL — boom', '(fixed)', 'VERIFICATION: PASS'])
    const out = await runMergeBack({ ...ctxBase, git, executor, branches: [B(1)] })
    expect(out[0].state).toBe('merged')
  })

  it('integrated red and fix cannot fix → needs-review', async () => {
    const { git, calls } = fakeGit()
    const { executor } = queueExecutor(['VERIFICATION: FAIL', '(tried)', 'VERIFICATION: FAIL'])
    const out = await runMergeBack({ ...ctxBase, git, executor, branches: [B(1)] })
    expect(out[0].state).toBe('needs-review')
    expect(calls.some((c) => c[0] === 'reset' && c[1] === '--hard')).toBe(true)
  })
})
