import { describe, it, expect, vi } from 'vitest'
import { runMergeBack, type MergeExecutor } from './rail-merge-orchestrator'
import { initDb, type DbInstance } from './db'
import type { InvocationRow } from './ai-invocations'
import type { AiStepResult } from './loop-run-manager'
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

/** Executor that returns fully-priced AiStepResults in order (verify/resolve/fix),
 *  so we can assert the cost-accounting rows the orchestrator writes (CRIT-2). */
function pricedExecutor(results: Array<Partial<AiStepResult> & { text: string }>) {
  let i = 0
  const executor: MergeExecutor = {
    runAiStep: vi.fn(async () => {
      const r = results[Math.min(i, results.length - 1)]
      i++
      return { text: '', ...r } as AiStepResult
    }),
  }
  return { executor }
}

function listInvocations(db: DbInstance): InvocationRow[] {
  return db.prepare('SELECT * FROM ai_invocations ORDER BY started_at ASC, id ASC').all() as InvocationRow[]
}

describe('runMergeBack cost accounting (CRIT-2)', () => {
  const PROJECT = 'proj-1'
  const recBase = (db: DbInstance, broadcast?: (m: unknown) => void) => ({
    db,
    projectId: PROJECT,
    jobId: 'rail-0-loopX',
    ticketId: 7,
    broadcast: broadcast as never,
  })

  it('records one surface=job row per merge-back AI step with cost + ref + ticket', async () => {
    const db = initDb(':memory:')
    const { git } = fakeGit()
    const broadcast = vi.fn()
    // Two clean branches → 2 verify steps.
    const { executor } = pricedExecutor([
      { text: 'VERIFICATION: PASS', cost: 0.5, tokensIn: 100, tokensOut: 50, provider: 'claude', model: 'sonnet' },
      { text: 'VERIFICATION: PASS', cost: 0.7, tokensIn: 120, tokensOut: 60, provider: 'claude', model: 'sonnet' },
    ])
    await runMergeBack({
      ...ctxBase, git, executor, branches: [B(1), B(2)],
      recording: recBase(db, broadcast),
    })
    const rows = listInvocations(db)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.surface).toBe('job')
      expect(r.project_id).toBe(PROJECT)
      expect(r.ticket_id).toBe(7)
      expect(r.provider).toBe('claude')
      expect(r.surface_ref_id).toBe('rail-0-loopX:merge:verify')
      expect(r.status).toBe('success')
    }
    expect(rows.map((r) => r.total_cost_usd).sort()).toEqual([0.5, 0.7])
    // One spending.invalidated broadcast per recorded row.
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledWith({ type: 'spending.invalidated', projectId: PROJECT })
  })

  it('records resolve-merge + fix steps and flags estimated / failed correctly', async () => {
    const db = initDb(':memory:')
    // Conflict on ticket-1 → resolve-merge; unmerged cleared → verify red → fix → verify pass.
    const { git } = fakeGit({ conflict: new Set(['sr/p/ticket-1']), unmergedAfterResolve: false })
    const { executor } = pricedExecutor([
      { text: '(resolved)', cost: 0.2, estimated: true, provider: 'claude', model: 'sonnet' }, // resolve-merge
      { text: 'VERIFICATION: FAIL', failed: true, provider: 'claude', model: 'sonnet' },        // verify (red)
      { text: '(fixed)', cost: 0.3, provider: 'claude', model: 'sonnet' },                      // fix
      { text: 'VERIFICATION: PASS', cost: 0.1, provider: 'claude', model: 'sonnet' },           // re-verify
    ])
    const out = await runMergeBack({
      ...ctxBase, git, executor, branches: [B(1)],
      recording: recBase(db),
    })
    expect(out[0].state).toBe('merged')
    const rows = listInvocations(db)
    expect(rows).toHaveLength(4)
    const bySuffix = new Map(rows.map((r) => [r.surface_ref_id, r]))
    expect(bySuffix.get('rail-0-loopX:merge:resolve-merge')!.total_cost_usd_estimated).toBe(1)
    // The red verify hard-failed → recorded status=failed (NOT success).
    const failedRow = rows.find((r) => r.status === 'failed')!
    expect(failedRow.surface_ref_id).toBe('rail-0-loopX:merge:verify')
    expect(rows.some((r) => r.surface_ref_id === 'rail-0-loopX:merge:fix')).toBe(true)
  })

  it('no recording deps → writes zero rows (byte-identical legacy behaviour)', async () => {
    const db = initDb(':memory:')
    const { git } = fakeGit()
    const { executor } = pricedExecutor([{ text: 'VERIFICATION: PASS', cost: 0.5 }])
    await runMergeBack({ ...ctxBase, git, executor, branches: [B(1)] })
    expect(listInvocations(db)).toHaveLength(0)
  })

  it('a broadcast failure never breaks the merge-back traversal', async () => {
    const db = initDb(':memory:')
    const { git } = fakeGit()
    const broadcast = vi.fn(() => { throw new Error('ws down') })
    const { executor } = pricedExecutor([{ text: 'VERIFICATION: PASS', cost: 0.5, provider: 'claude' }])
    const out = await runMergeBack({
      ...ctxBase, git, executor, branches: [B(1)],
      recording: recBase(db, broadcast),
    })
    expect(out[0].state).toBe('merged')
    expect(listInvocations(db)).toHaveLength(1)
  })
})
