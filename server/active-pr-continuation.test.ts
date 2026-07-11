import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  resolveActivePrContinuationTargets,
  type ResolveActivePrContinuationInput,
} from './active-pr-continuation'
import { createPrDelivery, transitionDecision, type PrDecision } from './rail-pr-store'
import { createRailWorktree } from './rail-worktrees-store'
import type { Exec } from './pr-publisher'
import type { GitRunner } from './worktree-manager'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const BRANCH = 'feat/PROJ-1-review-followup'
const PR_URL = 'https://github.com/example/repo/pull/17'

function lifecycle(overrides: {
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  branch?: string
  baseBranch?: string
  sha?: string
  isDraft?: boolean
} = {}): string {
  const sha = overrides.sha ?? SHA
  return JSON.stringify({
    state: overrides.state ?? 'OPEN',
    isDraft: overrides.isDraft ?? false,
    headRefName: overrides.branch ?? BRANCH,
    baseRefName: overrides.baseBranch ?? 'main',
    isCrossRepository: false,
    headRefOid: sha,
    mergeCommit: null,
    commits: [{ oid: sha }],
  })
}

function gitRefs(localSha: string | null = SHA, remoteSha: string | null = SHA): GitRunner {
  return {
    run: vi.fn(async (args: string[]) => {
      const ref = args.at(-1)
      if (ref === `refs/heads/${BRANCH}`) {
        return localSha
          ? { code: 0, stdout: `${localSha}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: '' }
      }
      if (ref === `refs/remotes/origin/${BRANCH}`) {
        return remoteSha
          ? { code: 0, stdout: `${remoteSha}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    }),
  }
}

describe('historical active-PR continuation recovery', () => {
  let db: DbInstance

  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => db.close())

  function seedTerminal(input: {
    id?: string
    ticketIds?: number[]
    isContinuation?: boolean
    decision?: Extract<PrDecision, 'discarded' | 'completed' | 'merged' | 'superseded'>
    branch?: string | null
    baseBranch?: string
    prUrl?: string | null
    prNumber?: number | null
    deliverySha?: string | null
    worktreeIds?: string[]
  } = {}) {
    const decision = input.decision ?? 'discarded'
    const row = createPrDelivery(db, {
      id: input.id,
      railIndex: 0,
      loopId: 'factory:implement',
      railKey: `0-${input.id ?? 'historical'}`,
      ticketIds: input.ticketIds ?? [1],
      baseBranch: input.baseBranch ?? 'main',
      loopName: 'Implement',
      originSurface: 'dashboard',
      isContinuation: input.isContinuation ?? true,
    })
    transitionDecision(db, row.id, 'building', decision, {
      branch: input.branch === undefined ? BRANCH : input.branch,
      prUrl: input.prUrl === undefined ? PR_URL : input.prUrl,
      prNumber: input.prNumber === undefined ? 17 : input.prNumber,
      prState: 'local-only',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'push_failed',
      deliverySha: input.deliverySha === undefined ? SHA : input.deliverySha,
      isContinuation: input.isContinuation ?? true,
      worktreeIds: input.worktreeIds ?? [],
    })
    return row
  }

  function resolveInput(overrides: Partial<ResolveActivePrContinuationInput> = {}): ResolveActivePrContinuationInput {
    const exec: Exec = {
      run: vi.fn(async () => ({ code: 0, stdout: lifecycle(), stderr: '' })),
    }
    return {
      db,
      git: gitRefs(),
      exec,
      repoDir: '/repo',
      ticketIds: [1],
      integrationBranch: 'main',
      fetchOk: true,
      getTicketSpec: () => ({ status: 'todo' }),
      ...overrides,
    }
  }

  it('recovers an exact discarded local-only continuation without fuzzy ticket metadata', async () => {
    seedTerminal()
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.get(1)).toEqual({
      ticketId: 1,
      deliveryId: expect.any(String),
      branch: BRANCH,
      baseBranch: 'main',
      baseRef: `origin/${BRANCH}`,
      prUrl: PR_URL,
      prNumber: 17,
      isDraft: false,
      deliverySha: SHA,
      source: 'rail-pr-delivery',
    })
    expect(input.exec.run).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', PR_URL, '--json', expect.any(String)],
      '/repo',
    )
  })

  it.each([
    { name: 'remote-only exact ref', local: null, remote: SHA, expectedBaseRef: `origin/${BRANCH}` },
    { name: 'local-only exact ref', local: SHA, remote: null, expectedBaseRef: undefined },
  ])('materializes a $name', async ({ local, remote, expectedBaseRef }) => {
    seedTerminal()

    const targets = await resolveActivePrContinuationTargets(resolveInput({
      git: gitRefs(local, remote),
    }))

    expect(targets.get(1)).toMatchObject({ branch: BRANCH, deliverySha: SHA })
    expect(targets.get(1)?.baseRef).toBe(expectedBaseRef)
  })

  it('does not resurrect an older continuation after a newer fresh generation for the exact target', async () => {
    seedTerminal({ id: 'older-continuation' })
    seedTerminal({ id: 'newer-fresh', isContinuation: false })
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it.each([
    { requested: [1], newer: [1, 2], label: 'newer superset' },
    { requested: [1, 2], newer: [1], label: 'newer subset' },
  ])('does not resurrect older exact history across a $label generation', async ({ requested, newer }) => {
    seedTerminal({ id: 'older-exact-continuation', ticketIds: requested })
    seedTerminal({ id: 'newer-overlapping-generation', ticketIds: newer, isContinuation: false })
    const input = resolveInput({
      ticketIds: requested,
      getTicketSpec: () => ({ status: 'on_review', jira_key: 'PROJ-1' }),
    })

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it('treats a newer fresh generation as authoritative negative evidence and blocks fuzzy fallback', async () => {
    seedTerminal({ id: 'older-continuation' })
    seedTerminal({ id: 'newer-fresh', isContinuation: false })
    const input = resolveInput({
      getTicketSpec: () => ({ status: 'on_review', jira_key: 'PROJ-1' }),
    })

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it('lets a newer malformed exact-target row shadow an older valid continuation', async () => {
    seedTerminal({ id: 'older-valid-continuation' })
    seedTerminal({ id: 'newer-malformed-continuation' })
    db.prepare(`UPDATE rail_pr_deliveries SET ticket_ids = '[1,1]' WHERE id = ?`)
      .run('newer-malformed-continuation')
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it('does not recover a terminal generation until its decision lease is released', async () => {
    const row = seedTerminal()
    db.prepare(`
      UPDATE rail_pr_deliveries
         SET operation = 'dismiss', operation_token = 'still-finalizing', operation_started_at_ms = 1
       WHERE id = ?
    `).run(row.id)
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it.each([
    { requested: [1], historical: [1, 2] },
    { requested: [1, 2], historical: [1] },
  ])('requires the historical ticket target to match exactly: $historical vs $requested', async ({ requested, historical }) => {
    seedTerminal({ ticketIds: historical })
    const input = resolveInput({ ticketIds: requested })

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'merged', decision: 'merged' as const },
    { name: 'completed', decision: 'completed' as const },
    { name: 'superseded', decision: 'superseded' as const },
  ])('never resumes a latest $name continuation generation', async ({ decision }) => {
    seedTerminal({ decision })
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it('does not absorb a retained needs-review worktree whose dirty state is outside the recorded SHA', async () => {
    createRailWorktree(db, {
      id: 'dirty-retained-worktree',
      railIndex: 0,
      ticketId: 1,
      branch: BRANCH,
      worktreePath: '/wt/dirty-retained',
      mergeState: 'needs-review',
    })
    seedTerminal({ worktreeIds: ['dirty-retained-worktree'] })
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
    expect(input.git.run).not.toHaveBeenCalled()
  })

  it('does not trust a terminal ledger state while its old worktree path still exists', async () => {
    const retainedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-historical-wt-'))
    try {
      createRailWorktree(db, {
        id: 'failed-but-mounted-worktree', railIndex: 0, ticketId: 1,
        branch: BRANCH, worktreePath: retainedPath, mergeState: 'failed',
      })
      seedTerminal({ worktreeIds: ['failed-but-mounted-worktree'] })
      const input = resolveInput()

      const targets = await resolveActivePrContinuationTargets(input)

      expect(targets.size).toBe(0)
      expect(input.exec.run).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(retainedPath, { recursive: true, force: true })
    }
  })

  it('blocks an active continuation whose retained worktree is still needs-review', async () => {
    createRailWorktree(db, {
      id: 'active-dirty-worktree', railIndex: 0, ticketId: 1,
      branch: BRANCH, worktreePath: '/wt/active-dirty', mergeState: 'needs-review',
    })
    const active = createPrDelivery(db, {
      id: 'active-dirty-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-active-dirty', ticketIds: [1], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', isContinuation: true,
    })
    transitionDecision(db, active.id, 'building', 'pr_ready', {
      branch: BRANCH, prUrl: PR_URL, prNumber: 17, prState: 'pr-created',
      deliverySha: SHA, worktreeIds: ['active-dirty-worktree'], isContinuation: true,
    })
    const input = resolveInput({ getTicketSpec: () => ({ status: 'on_review', jira_key: 'PROJ-1' }) })

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it('does not resume an active delivery when the PR advanced beyond its recorded SHA', async () => {
    const active = createPrDelivery(db, {
      id: 'active-advanced-pr', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-active-advanced', ticketIds: [1], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', isContinuation: true,
    })
    transitionDecision(db, active.id, 'building', 'pr_ready', {
      branch: BRANCH, prUrl: PR_URL, prNumber: 17, prState: 'pr-created',
      deliverySha: SHA, isContinuation: true,
    })
    const exec: Exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({
          state: 'OPEN', isDraft: false, headRefName: BRANCH, baseRefName: 'main',
          isCrossRepository: false,
          headRefOid: OTHER_SHA, mergeCommit: null, commits: [{ oid: SHA }, { oid: OTHER_SHA }],
        }),
        stderr: '',
      })),
    }

    const targets = await resolveActivePrContinuationTargets(resolveInput({ exec }))

    expect(targets.size).toBe(0)
    expect(exec.run).toHaveBeenCalledTimes(1)
  })

  it('blocks fuzzy fallback while an active generation owns any part of the requested target', async () => {
    const active = createPrDelivery(db, {
      id: 'active-without-pr-identity', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-active', ticketIds: [1], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', isContinuation: false,
    })
    transitionDecision(db, active.id, 'building', 'on_review')
    const input = resolveInput({
      ticketIds: [1, 2],
      getTicketSpec: () => ({ status: 'on_review', jira_key: 'PROJ-1' }),
    })

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it('recovers a historical batch only from one row with the same complete ticket set', async () => {
    seedTerminal({ ticketIds: [2, 1] })

    const targets = await resolveActivePrContinuationTargets(resolveInput({ ticketIds: [1, 2] }))

    expect([...targets.keys()]).toEqual([1, 2])
    expect(targets.get(1)).toMatchObject({ prUrl: PR_URL, branch: BRANCH, deliverySha: SHA })
    expect(targets.get(2)).toMatchObject({ prUrl: PR_URL, branch: BRANCH, deliverySha: SHA })
  })

  it.each([
    { name: 'missing PR URL', prUrl: null },
    { name: 'PR number inconsistent with URL', prNumber: 18 },
    { name: 'missing branch', branch: null },
    { name: 'head equal to base', branch: 'main' },
    { name: 'missing immutable SHA', deliverySha: null },
    { name: 'malformed immutable SHA', deliverySha: 'not-a-sha' },
  ])('fails closed for historical evidence with $name', async (override) => {
    seedTerminal(override)
    const input = resolveInput()

    const targets = await resolveActivePrContinuationTargets(input)

    expect(targets.size).toBe(0)
    expect(input.exec.run).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'closed PR', lifecycle: { state: 'CLOSED' as const } },
    { name: 'different head branch', lifecycle: { branch: 'feat/PROJ-999-unrelated' } },
    { name: 'different base branch', lifecycle: { baseBranch: 'release' } },
    { name: 'different head SHA', lifecycle: { sha: OTHER_SHA } },
  ])('rejects a $name even when the terminal row itself is well formed', async ({ lifecycle: observed }) => {
    seedTerminal()
    const exec: Exec = {
      run: vi.fn(async () => ({ code: 0, stdout: lifecycle(observed), stderr: '' })),
    }

    const targets = await resolveActivePrContinuationTargets(resolveInput({ exec }))

    expect(targets.size).toBe(0)
  })

  it.each([
    { name: 'GitHub unavailable', result: { code: 1, stdout: '', stderr: 'offline' } },
    { name: 'malformed lifecycle response', result: { code: 0, stdout: '{not-json', stderr: '' } },
  ])('fails closed when $name prevents exact reobservation', async ({ result }) => {
    seedTerminal()
    const exec: Exec = { run: vi.fn(async () => result) }

    const targets = await resolveActivePrContinuationTargets(resolveInput({ exec }))

    expect(targets.size).toBe(0)
  })

  it.each([
    { name: 'local branch advanced', local: OTHER_SHA, remote: SHA },
    { name: 'fetched remote ref moved', local: SHA, remote: OTHER_SHA },
    { name: 'no materializable ref', local: null, remote: null },
  ])('rejects $name after GitHub exactness succeeds', async ({ local, remote }) => {
    seedTerminal()

    const targets = await resolveActivePrContinuationTargets(resolveInput({
      git: gitRefs(local, remote),
    }))

    expect(targets.size).toBe(0)
  })

  it('does not downgrade invalid historical ownership into a same-Jira foreign PR match', async () => {
    seedTerminal()
    const exec: Exec = {
      run: vi.fn(async (_cmd, args) => {
        if (args[1] === 'view') {
          return { code: 0, stdout: lifecycle({ branch: 'feat/foreign-pr' }), stderr: '' }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 99,
            title: 'PROJ-1 unrelated work',
            body: 'PROJ-1',
            headRefName: 'feat/foreign-pr',
            baseRefName: 'main',
            url: 'https://github.com/example/repo/pull/99',
            isDraft: false,
            state: 'OPEN',
          }]),
          stderr: '',
        }
      }),
    }

    const targets = await resolveActivePrContinuationTargets(resolveInput({
      exec,
      getTicketSpec: () => ({ status: 'on_review', jira_key: 'PROJ-1' }),
    }))

    expect(targets.size).toBe(0)
    expect(exec.run).toHaveBeenCalledTimes(1)
    expect(exec.run).not.toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['list']),
      '/repo',
    )
  })
})
