import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { initDb, type DbInstance } from './db'
import { executePrDecision, isPrDecisionAction, type PrDecisionDeps } from './rail-pr-decision'
import {
  claimPrDeliveryOperation, createPrDelivery, getPrDelivery, toPrDeliverySnapshot, transitionDecision,
  type DeliverBranchRecord, type PrDecision, type PrDeliveryPatch,
} from './rail-pr-store'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import { insertLinkWithId } from './jira/jira-db'
import type { GitRunner } from './worktree-manager'
import type { Exec, ExecResult } from './pr-publisher'
import { PR_LIFECYCLE_JSON_FIELDS } from './pr-lifecycle'
import { withRepoLock } from './repo-lock'
import { claimTicketOutcomeOwners } from './rails-store'
import { fingerprintOverlayCleanupPath } from './worktree-overlay'
import { recoveryRefForDelivery } from './rail-pr-recovery-git'

// ─── Fakes (DI — no git/gh/net; commands recorded for assertions) ─────────────

const ok: ExecResult = { code: 0, stdout: '', stderr: '' }

function fakeGit(opts: { failOn?: (args: string[]) => boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  let releaseHead: string | null = null
  const shaForBranch = (branch: string): string => {
    const ticket = /feat\/(\d+)-/.exec(branch)
    return ticket
      ? Math.max(1, Number(ticket[1]) % 16).toString(16).repeat(40)
      : '1'.repeat(40)
  }
  const git: GitRunner = {
    async run(args, cwd) {
      calls.push({ args, cwd })
      if (opts.failOn?.(args)) return { code: 1, stdout: '', stderr: 'fatal: boom' }
      if (args[0] === 'status' && cwd.startsWith('/wt/')) {
        const ticket = /ticket-(\d+)/.exec(cwd)
        releaseHead = ticket
          ? Math.max(1, Number(ticket[1]) % 16).toString(16).repeat(40)
          : '1'.repeat(40)
        return ok
      }
      if (args.join(' ') === 'rev-parse --verify HEAD' && cwd.startsWith('/wt/')) {
        return { code: 0, stdout: `${releaseHead ?? '1'.repeat(40)}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        const sha = releaseHead ?? shaForBranch(args[2].slice('refs/heads/'.length))
        releaseHead = null
        return { code: 0, stdout: `${sha}\n`, stderr: '' }
      }
      return ok
    },
  }
  return { git, calls }
}

type GhHandler = ExecResult | (() => ExecResult)

/** gh handlers keyed on the pr subcommand plus Git push/remote inspection. */
function fakeExec(handlers: Partial<Record<'create' | 'ready' | 'close' | 'view' | 'reopen' | 'push' | 'remote', GhHandler>> = {}, opts: { throwOnGh?: boolean } = {}) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
  const resolve = (h: GhHandler | undefined): ExecResult => (typeof h === 'function' ? h() : h ?? ok)
  const exec: Exec = {
    async run(cmd, args, cwd) {
      calls.push({ cmd, args, cwd })
      if (cmd === 'git' && args[0] === 'push') return resolve(handlers.push)
      if (cmd === 'git' && args.join(' ') === 'remote get-url --push --all origin') {
        return resolve(handlers.remote ?? { code: 0, stdout: 'https://github.com/o/r.git\n', stderr: '' })
      }
      if (cmd === 'gh') {
        if (opts.throwOnGh) throw new Error('gh exploded')
        return resolve(handlers[args[1] as 'create' | 'ready' | 'close' | 'view' | 'reopen'])
      }
      return ok
    },
  }
  return { exec, calls }
}

function writeTicketStore(dir: string, tickets: Array<{ id: number; status: string }>): string {
  const file = path.join(dir, 'local-tickets.json')
  const store = {
    schema_version: '1.3',
    revision: 1,
    last_updated: '2026-01-01T00:00:00Z',
    next_id: 100,
    tickets: Object.fromEntries(tickets.map((t) => [String(t.id), {
      id: t.id, title: `T${t.id}`, description: '', status: t.status, priority: 'medium',
      labels: [], assignee: null, prerequisites: [], metadata: {},
      origin_conversation_id: null, is_epic: false, parent_epic_id: null,
      execution_order: null, short_summary: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      created_by: 'test', source: 'manual',
    }])),
  }
  fs.writeFileSync(file, JSON.stringify(store))
  return file
}

function readTicketStatuses(file: string): Record<string, string> {
  const store = JSON.parse(fs.readFileSync(file, 'utf-8')) as { tickets: Record<string, { status: string }> }
  return Object.fromEntries(Object.entries(store.tickets).map(([id, t]) => [id, t.status]))
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

const PROJECT = { id: 'p1', slug: 's1', path: '/repo' }
const RAIL_KEY = '0-factory:implement'
// The conventional batch name create-pr computes from the store's ticket data
// (tickets 1+2 titled T1/T2, no jira link, both feat) — see pr-naming.
const BATCH = 'feat/1-batch-2-tickets'

let db: DbInstance
let tmpDir: string
let ticketFile: string

beforeEach(() => {
  db = initDb(':memory:')
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-pr-decision-'))
  ticketFile = writeTicketStore(tmpDir, [
    { id: 1, status: 'on_review' },
    { id: 2, status: 'on_review' },
    { id: 3, status: 'done' },
  ])
})
afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const branchRecords = (ids: number[]): DeliverBranchRecord[] =>
  ids.map((id) => ({
    ticketId: id,
    branch: `feat/${id}-t${id}`,
    succeeded: true,
    finalSha: Math.max(1, id % 16).toString(16).repeat(40),
    branchOwnership: 'created',
  }))

/** Insert a delivery row and walk it to the requested decision state. */
function mkRow(input: {
  decision: PrDecision
  ticketIds?: number[]
  branches?: DeliverBranchRecord[]
  worktreeIds?: string[]
  prUrl?: string | null
  prState?: 'none' | 'local-only' | 'pushed' | 'pr-created'
  originConversationId?: string | null
  baseBranch?: string
  branch?: string
  deliverySha?: string | null
  isContinuation?: boolean
  supersedesDeliveryId?: string | null
}) {
  const ticketIds = input.ticketIds ?? [1, 2]
  const row = createPrDelivery(db, {
    railIndex: 0, loopId: 'factory:implement', railKey: RAIL_KEY,
    ticketIds, baseBranch: input.baseBranch ?? 'main', loopName: 'Implement',
    originSurface: input.originConversationId ? 'agent-chat' : 'dashboard',
    originConversationId: input.originConversationId ?? null,
    isContinuation: input.isContinuation,
    supersedesDeliveryId: input.supersedesDeliveryId,
  })
  // Production loop admission claims these exact tickets before a delivery can
  // settle. Keep the fixture causally faithful so terminal outbox assertions do
  // not rely on the unsafe legacy "missing owner means current" behaviour.
  claimTicketOutcomeOwners(db, ticketIds, `run:${row.id}`)
  if (input.decision === 'building') return getPrDelivery(db, row.id)!
  const preparedBranches = (input.branches ?? branchRecords(ticketIds)).map((branch) => ({
    ...branch,
    ...(branch.succeeded && branch.finalSha === undefined
      ? { finalSha: Math.max(1, branch.ticketId % 16).toString(16).repeat(40) }
      : {}),
    ...(branch.branchOwnership === undefined ? { branchOwnership: 'created' as const } : {}),
  }))
  const settlePatch: PrDeliveryPatch = {
    branches: preparedBranches,
    worktreeIds: input.worktreeIds ?? [],
    implementationOutcome: 'succeeded',
    deliveryOutcome: 'ready',
    statusCode: 'ready_for_review',
    deliverySha: Object.prototype.hasOwnProperty.call(input, 'deliverySha')
      ? input.deliverySha ?? null
      : null,
  }
  if (input.decision === 'no_changes') {
    transitionDecision(db, row.id, 'building', 'no_changes', {
      ...settlePatch,
      branches: input.branches ?? [],
      deliveryOutcome: 'no_changes',
      statusCode: 'no_changes',
    })
    return getPrDelivery(db, row.id)!
  }
  transitionDecision(db, row.id, 'building', 'on_review', settlePatch)
  if (input.decision === 'on_review') return getPrDelivery(db, row.id)!
  const draftPatch: PrDeliveryPatch = input.prUrl
    ? {
        branch: input.branch ?? 'feat/1-t1', prUrl: input.prUrl, prNumber: 7, prState: input.prState ?? 'pr-created',
        deliveryOutcome: 'delivered', statusCode: 'pr_draft_ready',
      }
    : {
        branch: input.branch ?? 'feat/1-t1', prUrl: null, prNumber: null, prState: input.prState ?? 'pushed',
        deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
      }
  if (input.decision === 'pr_failed') {
    transitionDecision(db, row.id, 'on_review', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
    })
    return getPrDelivery(db, row.id)!
  }
  transitionDecision(db, row.id, 'on_review', 'pr_draft', draftPatch)
  if (input.decision === 'pr_draft') return getPrDelivery(db, row.id)!
  transitionDecision(db, row.id, 'pr_draft', input.decision)
  return getPrDelivery(db, row.id)!
}

function mkDeps(overrides: Partial<PrDecisionDeps> & { git?: GitRunner; exec?: Exec } = {}) {
  const broadcast = vi.fn()
  const jira = {
    onRailMerged: vi.fn(() => true),
    onRailDiscard: vi.fn(() => true),
    onRailCompleted: vi.fn(() => true),
    onRailRefined: vi.fn(() => true),
  }
  const card = vi.fn()
  const deps: PrDecisionDeps = {
    db,
    project: PROJECT,
    git: overrides.git ?? fakeGit().git,
    exec: overrides.exec ?? fakeExec().exec,
    broadcast,
    jiraSyncManager: jira,
    agentChat: () => ({ updatePrDecisionCard: card }),
    ticketFile,
    ...overrides,
  }
  return { deps, broadcast, jira, card }
}

const prStateBroadcasts = (broadcast: ReturnType<typeof vi.fn>) =>
  broadcast.mock.calls.map((c) => c[0] as { type: string; decision?: string }).filter((m) => m.type === 'rail.pr_state')
const ticketBroadcasts = (broadcast: ReturnType<typeof vi.fn>) =>
  broadcast.mock.calls.map((c) => c[0] as { type: string; ticket?: { id: number; status: string } }).filter((m) => m.type === 'ticket_updated')

const PR_URL = 'https://github.com/o/r/pull/7'

function lifecycleJson(input: {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  sha?: string | null
  headSha?: string | null
  branch?: string
  base?: string
  isDraft?: boolean
  includeSha?: boolean
}): string {
  const sha = input.sha ?? null
  const includeSha = input.includeSha ?? Boolean(sha)
  return JSON.stringify({
    state: input.state,
    isDraft: input.isDraft ?? false,
    headRefName: input.branch ?? 'feat/1-t1',
    baseRefName: input.base ?? 'main',
    isCrossRepository: false,
    headRefOid: input.headSha === undefined ? sha : input.headSha,
    mergeCommit: input.state === 'MERGED' ? { oid: 'f'.repeat(40) } : null,
    commits: includeSha && sha ? [{ oid: sha }] : [{ oid: 'e'.repeat(40) }],
  })
}

function lifecycleSequence(...snapshots: string[]): GhHandler {
  let index = 0
  return () => ({
    code: 0,
    stdout: snapshots[Math.min(index++, snapshots.length - 1)],
    stderr: '',
  })
}

function registeredWorktreeList(entries: Array<{ worktreePath: string; head: string; branch: string }>): string {
  return entries
    .map((entry) => `worktree ${entry.worktreePath}\0HEAD ${entry.head}\0branch refs/heads/${entry.branch}\0`)
    .join('\0')
}

function verifiedPublishExec(sha: string) {
  return fakeExec({
    view: lifecycleSequence(
      lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
      lifecycleJson({ state: 'OPEN', sha, isDraft: false }),
    ),
  })
}

// ─── Guards (404 / CAS / legality) ────────────────────────────────────────────

describe('executePrDecision guards', () => {
  it('isPrDecisionAction accepts the decision actions and rejects everything else', () => {
    for (const a of ['create-pr', 'publish', 'discard', 'dismiss', 'poll-merge', 'reopen', 'merge-local', 'acknowledge-no-changes', 'recover-and-retry']) {
      expect(isPrDecisionAction(a)).toBe(true)
    }
    for (const a of ['ready', 'merge', 'approve', '', 42, null, undefined]) expect(isPrDecisionAction(a)).toBe(false)
  })

  it('404 on an unknown prDeliveryId', async () => {
    const { deps } = mkDeps()
    const r = await executePrDecision(deps, { prDeliveryId: 'ghost', action: 'discard', expectedDecision: 'on_review' })
    expect(r.status).toBe(404)
  })

  it('409 stale_decision at the pre-check when expectedDecision does not match', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    const { deps, broadcast } = mkDeps()
    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'stale_decision', current: 'pr_draft' })
    expect(broadcast).not.toHaveBeenCalled()
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_draft')
  })

  it.each([
    ['create-pr', 'building'],
    ['create-pr', 'pr_ready'],
    ['publish', 'on_review'],
    ['publish', 'pr_failed'],
    ['publish', 'implementation_failed'],
    ['discard', 'building'],
    ['poll-merge', 'on_review'],
    ['poll-merge', 'pr_failed'],
    ['poll-merge', 'implementation_failed'],
    ['create-pr', 'implementation_failed'],
    ['merge-local', 'implementation_failed'],
    ['recover-and-retry', 'on_review'],
    ['recover-and-retry', 'pr_ready'],
    ['recover-and-retry', 'implementation_failed'],
    ['create-pr', 'merged'],
    ['discard', 'discarded'],
  ] as const)('409 illegal_action: %s from %s', async (action, decision) => {
    const row = mkRow({ decision, prUrl: decision === 'pr_ready' || decision === 'merged' ? PR_URL : null })
    const { deps, broadcast } = mkDeps()
    const r = await executePrDecision(deps, { prDeliveryId: row.id, action, expectedDecision: decision })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'stale_decision', current: decision, reason: 'illegal_action' })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('409 illegal_action: create-pr from a pr_draft that already has a PR URL', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    const { deps } = mkDeps()
    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ reason: 'illegal_action' })
  })

  it('409 illegal_action: publish on a degraded pr_draft (no PR URL)', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: null, prState: 'pushed' })
    const { deps } = mkDeps()
    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ reason: 'illegal_action' })
  })

  it('409 illegal_action: poll-merge on a degraded pr_draft (no PR URL)', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: null, prState: 'local-only' })
    const { deps } = mkDeps()
    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_draft' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ reason: 'illegal_action' })
  })
})

describe('no-change acknowledgement', () => {
  it('marks a fresh no-change result completed without claiming a merge or PR', async () => {
    const row = mkRow({ decision: 'no_changes', ticketIds: [1], branches: [] })
    const { deps, jira, broadcast } = mkDeps()

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id,
      action: 'acknowledge-no-changes',
      expectedDecision: 'no_changes',
    })

    expect(result).toMatchObject({ status: 200, body: { ok: true, decision: 'completed', noChanges: true } })
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'completed', delivery_outcome: 'no_changes', status_code: 'no_changes',
    })
    expect(readTicketStatuses(ticketFile)['1']).toBe('done')
    expect(jira.onRailCompleted).toHaveBeenCalledWith([1], row.id)
    expect(jira.onRailMerged).not.toHaveBeenCalled()
    expect(prStateBroadcasts(broadcast)).toEqual([expect.objectContaining({ decision: 'completed' })])
  })

  it('returns a fresh no-change result for refinement without using Jira discard semantics', async () => {
    const row = mkRow({ decision: 'no_changes', ticketIds: [1], branches: [] })
    const { deps, jira } = mkDeps()

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id,
      action: 'discard',
      expectedDecision: 'no_changes',
    })

    expect(result).toMatchObject({ status: 200, body: { ok: true, decision: 'discarded' } })
    expect(readTicketStatuses(ticketFile)['1']).toBe('todo')
    expect(jira.onRailRefined).toHaveBeenCalledWith([1], row.id)
    expect(jira.onRailDiscard).not.toHaveBeenCalled()
  })

  it('claims acknowledgement before cleanup so a racing refine performs no effect', async () => {
    createRailWorktree(db, {
      id: 'w-no-change', railIndex: 0, ticketId: 1, branch: 'feat/no-change',
      worktreePath: '/wt/no-change', mergeState: 'built',
    })
    const row = mkRow({
      decision: 'no_changes', ticketIds: [1], worktreeIds: ['w-no-change'],
      branches: [{
        ticketId: 1, branch: 'feat/no-change', succeeded: false,
        deliveryOutcome: 'no_changes', finalSha: '1'.repeat(40), branchOwnership: 'created',
      }],
    })
    let unblock!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const blocked = new Promise<void>((resolve) => { unblock = resolve })
    const calls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        calls.push(args)
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return { code: 0, stdout: `${'1'.repeat(40)}\n`, stderr: '' }
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          markStarted()
          await blocked
        }
        return ok
      },
    }
    const { deps } = mkDeps({ git })

    const acknowledgement = executePrDecision(deps, {
      prDeliveryId: row.id, action: 'acknowledge-no-changes', expectedDecision: 'no_changes',
    })
    await started
    const refine = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'no_changes',
    })
    expect(refine).toMatchObject({ status: 409, body: { error: 'operation_in_progress' } })
    expect(calls.filter((args) => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(1)
    unblock()
    await expect(acknowledgement).resolves.toMatchObject({ status: 200, body: { decision: 'completed' } })
  })

  it('rejects acknowledgement for an existing-PR no-change continuation', async () => {
    const row = mkRow({ decision: 'no_changes', ticketIds: [1], branches: [], isContinuation: true })
    const { deps } = mkDeps()
    await expect(executePrDecision(deps, {
      prDeliveryId: row.id,
      action: 'acknowledge-no-changes',
      expectedDecision: 'no_changes',
    })).resolves.toMatchObject({ status: 409, body: { reason: 'illegal_action' } })
  })
})

// ─── create-pr ────────────────────────────────────────────────────────────────

describe('create-pr', () => {
  it('delivered pr-created → pr_draft with branch/prUrl/prNumber/prState patched', async () => {
    createRailWorktree(db, {
      id: 'w1', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const row = mkRow({
      decision: 'on_review',
      branches: [{ ticketId: 1, branch: 'feat/1-t1', succeeded: true }],
      worktreeIds: ['w1'],
    })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { git, calls: gitCalls } = fakeGit()
    const { deps, broadcast } = mkDeps({ exec, git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'pr_draft', prUrl: PR_URL, prState: 'pr-created' })
    const after = getPrDelivery(db, row.id)!
    expect(after).toMatchObject({
      decision: 'pr_draft', branch: 'feat/1-t1', pr_url: PR_URL, pr_number: 7, pr_state: 'pr-created',
    })
    // one durable rail.pr_state broadcast carrying the post-mutation snapshot
    const msgs = prStateBroadcasts(broadcast)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ decision: 'pr_draft' })
    // PR opened as draft from the base repo against the stored base branch
    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    expect(create.args).toContain('--draft')
    expect(create.args).toContain('main')
    expect(create.cwd).toBe('/repo')
    expect(gitCalls).toContainEqual({ args: ['worktree', 'remove', '/wt/ticket-1'], cwd: '/repo' })
    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('released')
  })

  it('preserves a worktree changed after settlement while still creating the PR from frozen evidence', async () => {
    createRailWorktree(db, {
      id: 'dirty-after-settle', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const row = mkRow({
      decision: 'on_review', branches: branchRecords([1]), worktreeIds: ['dirty-after-settle'],
    })
    const base = fakeGit()
    const git: GitRunner = {
      async run(args, cwd) {
        if (args[0] === 'status' && cwd === '/wt/ticket-1') {
          return { code: 0, stdout: ' M manually-edited.ts\n', stderr: '' }
        }
        return base.git.run(args, cwd)
      },
    }
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })

    const result = await executePrDecision(mkDeps({ exec, git }).deps, {
      prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'pr_draft' } })
    expect(base.calls.some((call) => call.args[0] === 'worktree')).toBe(false)
    expect(getRailWorktree(db, 'dirty-after-settle')?.merge_state).toBe('needs-review')
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'pr_draft', status_code: 'cleanup_incomplete' })
    expect(JSON.parse(getPrDelivery(db, row.id)!.cleanup_warnings)).toEqual([
      expect.stringContaining('contains changes made after settlement'),
    ])
  })

  it('persists a successful safety archive without marking cleanup incomplete, including later fd writes', async () => {
    const worktree = path.join(tmpDir, 'archive-wt')
    const overlayDirectory = path.join(worktree, '.claude', 'rules')
    const overlayFile = path.join(overlayDirectory, 'owned.md')
    fs.mkdirSync(overlayDirectory, { recursive: true })
    fs.writeFileSync(overlayFile, 'allocator copy')
    const fingerprint = fingerprintOverlayCleanupPath(overlayDirectory)!
    const fd = fs.openSync(overlayFile, 'r+')
    createRailWorktree(db, {
      id: 'archive-wt', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: worktree, mergeState: 'built',
    })
    const row = mkRow({
      decision: 'on_review', worktreeIds: ['archive-wt'],
      branches: [{
        ...branchRecords([1])[0],
        overlayExcludes: ['.claude/rules'],
        overlayCleanupEvidence: [{ path: '.claude/rules', ...fingerprint }],
      }],
    })
    transitionDecision(db, row.id, 'on_review', 'on_review', { safetyArchives: ['/previous/archive'] })
    const base = fakeGit()
    const git: GitRunner = {
      async run(args, cwd) {
        if (cwd === worktree && args[0] === 'status') return ok
        if (cwd === worktree && args[0] === 'ls-files') return { code: 1, stdout: '', stderr: 'not tracked' }
        if (cwd === worktree && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${'1'.repeat(40)}\n`, stderr: '' }
        }
        if (cwd === '/repo' && args.join(' ') === 'rev-parse --verify refs/heads/feat/1-t1') {
          return { code: 0, stdout: `${'1'.repeat(40)}\n`, stderr: '' }
        }
        return base.git.run(args, cwd)
      },
    }
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })

    try {
      const result = await executePrDecision(mkDeps({ exec, git }).deps, {
        prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review',
      })
      expect(result).toMatchObject({ status: 200, body: { decision: 'pr_draft' } })

      const snapshot = toPrDeliverySnapshot(getPrDelivery(db, row.id)!)
      expect(snapshot.statusCode).toBe('pr_draft_ready')
      expect(snapshot.cleanupWarnings).toEqual([])
      expect(snapshot.safetyArchives).toHaveLength(2)
      expect(snapshot.safetyArchives[0]).toBe('/previous/archive')
      const archive = snapshot.safetyArchives[1]
      expect(archive).toContain('.specrails-overlay-quarantine-')

      fs.writeSync(fd, 'post-rename write', 0, 'utf8')
      expect(fs.readFileSync(path.join(archive, '.claude', 'rules', 'owned.md'), 'utf8')).toContain('post-rename write')
    } finally {
      fs.closeSync(fd)
    }
  })

  it('single-unit delivery uses the frozen top-level SHA instead of recapturing a moved branch', async () => {
    const frozen = 'a'.repeat(40)
    const moved = 'b'.repeat(40)
    const row = mkRow({
      decision: 'on_review', deliverySha: frozen,
      branches: [{
        ticketId: 1, branch: 'feat/1-t1', succeeded: true,
        finalSha: null, branchOwnership: 'borrowed-pr',
      }],
    })
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${moved}\n`, stderr: '' }
        return ok
      },
    }
    const { exec, calls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })

    await executePrDecision(mkDeps({ exec, git }).deps, {
      prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review',
    })

    expect(calls).toContainEqual({
      cmd: 'git', args: ['push', 'origin', `${frozen}:refs/heads/feat/1-t1`], cwd: '/repo',
    })
    expect(calls.some((call) => call.cmd === 'git' && call.args.includes(`${moved}:refs/heads/feat/1-t1`))).toBe(false)
    expect(gitCalls.some((args) => args.join(' ') === 'rev-parse --verify refs/heads/feat/1-t1')).toBe(false)
    expect(JSON.parse(getPrDelivery(db, row.id)!.branches)[0]).toMatchObject({ finalSha: frozen })
  })

  it('single unit covering N tickets: title counts and body lists ALL covered tickets', async () => {
    // scope='all' → ONE branch record whose unit covers tickets 1 AND 2.
    const row = mkRow({
      decision: 'on_review', ticketIds: [1, 2],
      branches: [{ ticketId: 1, branch: 'feat/1-t1', succeeded: true }],
    })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ exec })

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    const title = create.args[create.args.indexOf('--title') + 1]
    const body = create.args[create.args.indexOf('--body') + 1]
    expect(title).toBe('[1 +1]feat - implement batch of 2 tickets')
    expect(body).toContain('## #1 — T1')
    expect(body).toContain('## #2 — T2')
  })

  it('per-ticket units: only the succeeded tickets are listed', async () => {
    const row = mkRow({
      decision: 'on_review', ticketIds: [1, 2],
      branches: [
        { ticketId: 1, branch: 'feat/1-t1', succeeded: true },
        { ticketId: 2, branch: 'feat/2-t2', succeeded: false },
      ],
    })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    const title = create.args[create.args.indexOf('--title') + 1]
    const body = create.args[create.args.indexOf('--body') + 1]
    expect(title).toBe('[1]feat - t1')
    expect(body).toContain('## #1 — T1')
    expect(body).not.toContain('#2')
  })

  it('delivered pushed (gh create failed) → pr_draft with prUrl null, prState pushed and the gh detail relayed', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]) })
    const { exec } = fakeExec({ create: { code: 1, stdout: '', stderr: 'gh: no auth' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'pr_draft', prUrl: null, prState: 'pushed', detail: 'gh: no auth' })
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'pr_draft', pr_url: null, pr_number: null, pr_state: 'pushed' })
  })

  it('delivered local-only (push failed) → pr_draft with prState local-only and the git stderr as detail', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]) })
    const { exec } = fakeExec({ push: { code: 1, stdout: '', stderr: 'no remote' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prState: 'local-only', detail: 'no remote' })
    expect(getPrDelivery(db, row.id)?.pr_state).toBe('local-only')
  })

  it('assembly failure (batch merge conflict) → pr_failed, tickets untouched', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1, 2]) })
    const { git } = fakeGit({ failOn: (args) => args[0] === 'merge' && args[1] === '--no-ff' })
    const { deps, broadcast } = mkDeps({ git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, decision: 'pr_failed', detail: 'merge-conflict:feat/1-t1' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_failed')
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_failed' })
    // tickets stay parked at on_review (retry or discard decides their fate)
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
  })

  it('a thrown delivery error (e.g. GitGuardrailError) → pr_failed, never a crash', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]) })
    const { exec } = fakeExec({}, { throwOnGh: true })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_failed' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_failed')
  })

  it('retry from pr_failed never pre-deletes a merely name-matching batch branch', async () => {
    const row = mkRow({ decision: 'pr_failed', branches: branchRecords([1, 2]) })
    const { git, calls } = fakeGit()
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prUrl: PR_URL })
    const addIdx = calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add')
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === BATCH)).toBe(false)
    // the integration branch is never deleted
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === 'main')).toBe(false)
  })

  it('retry from pr_failed with an existing PR pushes follow-up commits to the same PR branch', async () => {
    createRailWorktree(db, {
      id: 'w1', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const draft = mkRow({ decision: 'pr_draft', prUrl: PR_URL, worktreeIds: ['w1'], deliverySha: 'a'.repeat(40) })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      prState: 'local-only', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    })
    const row = getPrDelivery(db, draft.id)!
    let views = 0
    const { exec, calls: execCalls } = fakeExec({
      view: () => ++views === 1
        ? {
            code: 0,
            stdout: lifecycleJson({
              state: 'OPEN', sha: 'a'.repeat(40), headSha: 'b'.repeat(40), includeSha: false,
            }),
            stderr: '',
          }
        : { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha: 'a'.repeat(40) }), stderr: '' },
    })
    const { git, calls: gitCalls } = fakeGit()
    const { deps, broadcast } = mkDeps({ exec, git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      ok: true, decision: 'pr_ready', prUrl: PR_URL, prState: 'pr-created',
      deliveryVerified: true, verifiedSha: 'a'.repeat(40),
      remoteHeadSha: 'a'.repeat(40), pushed: true,
    })
    expect(execCalls).toContainEqual({
      cmd: 'git', args: ['push', 'https://github.com/o/r.git', `${'a'.repeat(40)}:refs/heads/feat/1-t1`], cwd: '/repo',
    })
    expect(execCalls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false)
    expect(gitCalls).toContainEqual({ args: ['worktree', 'remove', '/wt/ticket-1'], cwd: '/repo' })
    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('released')
    expect(getPrDelivery(db, row.id)?.status_detail).toBeNull()
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_ready', prState: 'pr-created' })
  })

  it('retry from pr_failed with an existing PR stays retryable when the follow-up push fails', async () => {
    createRailWorktree(db, {
      id: 'w1', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const draft = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, worktreeIds: ['w1'], deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      prState: 'local-only', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    })
    const row = getPrDelivery(db, draft.id)!
    const { exec } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({
          state: 'OPEN', sha: 'a'.repeat(40), headSha: 'b'.repeat(40), includeSha: false,
        }),
        stderr: '',
      },
      push: { code: 1, stdout: '', stderr: 'no remote' },
    })
    const { git, calls: gitCalls } = fakeGit()
    const { deps, broadcast } = mkDeps({ exec, git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, decision: 'pr_failed', prUrl: PR_URL, detail: 'no remote' })
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'pr_failed', pr_state: 'local-only' })
    expect(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false)
    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('built')
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_failed', prState: 'local-only' })
  })

  it('Commit & retry push commits only the preserved worktree and delivers its exact SHA', async () => {
    const runId = 'legacy-recovery-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const recovered = 'b'.repeat(40)
    const projectPath = path.join(tmpDir, 'legacy-recovery-repo')
    const worktreePath = path.join(tmpDir, 'legacy-recovery-wt')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    const worktreeRealPath = fs.realpathSync(worktreePath)
    createRailWorktree(db, {
      id: 'legacy-recovery-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['legacy-recovery-wt'], isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    let head = baseline
    const recoveryRefs = new Map<string, string>()
    const gitCalls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        gitCalls.push({ args, cwd })
        if (args[0] === 'update-ref' && args[1] === '-d') {
          const [, , ref, expected] = args
          if (expected && recoveryRefs.get(ref) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
          recoveryRefs.delete(ref)
          return ok
        }
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          const [, ref, sha] = args
          recoveryRefs.set(ref, sha)
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = recoveryRefs.get(args[2])
          return value
            ? { code: 0, stdout: `${value}\n`, stderr: '' }
            : { code: 1, stdout: '', stderr: 'missing' }
        }
        if (args.join(' ') === 'worktree list --porcelain -z' && cwd === projectPath) {
          return {
            code: 0,
            stdout: registeredWorktreeList([
              { worktreePath: projectPath, head: baseline, branch: 'main' },
              { worktreePath, head, branch },
            ]),
            stderr: '',
          }
        }
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD' && (cwd === worktreeRealPath || cwd === worktreePath)) {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --verify HEAD' && (cwd === worktreeRealPath || cwd === worktreePath)) {
          return { code: 0, stdout: `${head}\n`, stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}` && cwd === projectPath) {
          return { code: 0, stdout: `${head}\n`, stderr: '' }
        }
        if (args[0] === 'cat-file') return ok
        if (args[0] === 'merge-base') return ok
        if (args[0] === 'add') return ok
        if (args[0] === 'commit') {
          head = recovered
          return ok
        }
        if (args[0] === 'status') return ok
        if (args[0] === 'ls-files') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'worktree' && args[1] === 'remove') return ok
        return ok
      },
    }
    let views = 0
    const { exec, calls: execCalls } = fakeExec({
      view: () => {
        views++
        if (views < 3) {
          return {
            code: 0,
            stdout: lifecycleJson({ state: 'OPEN', sha: recovered, headSha: baseline, includeSha: false, branch }),
            stderr: '',
          }
        }
        return { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha: recovered, branch }), stderr: '' }
      },
    })

    const result = await executePrDecision(mkDeps({
      git,
      exec,
      project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_ready', deliveryVerified: true, verifiedSha: recovered, pushed: true },
    })
    expect(gitCalls).toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['commit', '-m', `specrails: recovered follow-up (run ${runId})`]),
      cwd: worktreeRealPath,
    }))
    expect(execCalls).toContainEqual({
      cmd: 'git', args: ['push', 'https://github.com/o/r.git', `${recovered}:refs/heads/${branch}`], cwd: projectPath,
    })
    expect(gitCalls.filter(({ args }) => args.join(' ') === 'worktree list --porcelain -z')).toHaveLength(2)
    expect(gitCalls.some(({ args, cwd }) => cwd === projectPath && args[0] === 'checkout')).toBe(false)
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision: 'pr_ready', delivery_sha: recovered, delivery_outcome: 'delivered',
    })
    expect(getRailWorktree(db, 'legacy-recovery-wt')?.merge_state).toBe('released')
    expect(recoveryRefs.size).toBe(0)
  })

  it('Commit & retry push preserves an arbitrary later branch tip instead of adopting it', async () => {
    const runId = 'legacy-branch-only-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'update-ref' && args[1] === '-d') {
          refs.delete(args[2])
          return ok
        }
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${candidate}\n`, stderr: '' }
        }
        if (args[0] === 'cat-file' || args[0] === 'merge-base') return ok
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: 'pr_failed',
        recoveryUnavailable: true,
        detail: expect.stringContaining('branch advanced beyond the run-owned result'),
      },
    })
    expect(gitCalls.some((args) => args[0] === 'commit' || args[0] === 'checkout')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      status_code: 'recovery_unavailable', delivery_sha: null,
    })
  })

  it('recovers a removed-worktree orphan, pins it, updates every matching unit, and releases the ref after exact delivery', async () => {
    const runId = 'removed-worktree-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1, 2], prUrl: PR_URL, branch,
      isContinuation: true,
      branches: [1, 2].map((ticketId) => ({
        ticketId, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded' as const,
        deliveryOutcome: 'blocked' as const,
        failureCode: 'settlement_interrupted',
        branchOwnership: 'borrowed-pr' as const,
      })),
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'update-ref' && args[1] === '-d') {
          const [, , ref, expected] = args
          if (expected && refs.get(ref) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
          refs.delete(ref)
          return ok
        }
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value
            ? { code: 0, stdout: `${value}\n`, stderr: '' }
            : { code: 1, stdout: '', stderr: 'missing' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args[0] === 'fsck') {
          return { code: 0, stdout: `unreachable commit ${candidate}\n`, stderr: '' }
        }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') {
          return { code: 0, stdout: `specrails: recovered follow-up (run ${runId})\n`, stderr: '' }
        }
        if (args[0] === 'cat-file' || args[0] === 'merge-base') return ok
        return ok
      },
    }
    const { exec, calls: execCalls } = fakeExec({
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        lifecycleJson({ state: 'OPEN', sha: candidate, headSha: candidate, branch }),
      ),
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_ready', deliveryVerified: true, verifiedSha: candidate, pushed: true },
    })
    expect(execCalls).toContainEqual({
      cmd: 'git', args: ['push', 'https://github.com/o/r.git', `${candidate}:refs/heads/${branch}`], cwd: PROJECT.path,
    })
    expect(gitCalls).toContainEqual(['fsck', '--unreachable', '--no-reflogs', '--no-progress'])
    expect(gitCalls.some((args) => args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/'))).toBe(true)
    expect(gitCalls.some((args) => args[0] === 'update-ref' && args[1] === '-d')).toBe(true)
    expect(refs.size).toBe(0)
    const settled = toPrDeliverySnapshot(getPrDelivery(db, draft.id)!)
    expect(settled.branches).toHaveLength(2)
    expect(settled.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketId: 1, succeeded: true, finalSha: candidate, changed: true, failureCode: null }),
      expect.objectContaining({ ticketId: 2, succeeded: true, finalSha: candidate, changed: true, failureCode: null }),
    ]))
  })

  it('pins and freezes a removed-worktree orphan before a transient GitHub observation failure', async () => {
    const runId = 'offline-orphan-run'
    const branch = 'feat/1-t1'
    const candidate = 'b'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'fsck') return { code: 0, stdout: `unreachable commit ${candidate}\n`, stderr: '' }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') return { code: 0, stdout: `settle (run ${runId})\n`, stderr: '' }
        if (args[0] === 'cat-file') return ok
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: { code: 1, stdout: '', stderr: 'GitHub unavailable' },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', recovered: true, detail: expect.stringContaining('GitHub unavailable') },
    })
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure',
      status_code: 'settlement_interrupted', delivery_sha: candidate,
    })
    expect([...refs.values()]).toEqual([candidate])
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(toPrDeliverySnapshot(getPrDelivery(db, draft.id)!).branches[0]).toMatchObject({
      succeeded: true, finalSha: candidate, deliveryOutcome: 'ready', failureCode: null,
    })
  })

  it.each([
    { state: 'MERGED' as const, decision: 'merged' },
    { state: 'CLOSED' as const, decision: 'pr_closed' },
  ])('settles an exact orphan already present in a $state PR without pushing', async ({ state, decision }) => {
    const runId = `orphan-${state.toLowerCase()}-run`
    const branch = 'feat/1-t1'
    const candidate = 'b'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'update-ref' && args[1] === '-d') {
          refs.delete(args[2])
          return ok
        }
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'fsck') return { code: 0, stdout: `unreachable commit ${candidate}\n`, stderr: '' }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') return { code: 0, stdout: `settle (run ${runId})\n`, stderr: '' }
        if (args[0] === 'cat-file') return ok
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state, sha: candidate, headSha: candidate, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision, deliveryVerified: true, verifiedSha: candidate, pushed: false },
    })
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision, delivery_outcome: 'delivered', delivery_sha: candidate,
    })
    expect(refs.size).toBe(0)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it('pins a unique orphan while preserving a different dirty authenticated worktree without commit or push', async () => {
    const runId = 'orphan-plus-dirty-worktree-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const orphan = 'b'.repeat(40)
    const projectPath = path.join(tmpDir, 'orphan-dirty-repo')
    const worktreePath = path.join(tmpDir, 'orphan-dirty-worktree')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'valuable-local-change.txt'), 'preserve me')
    const worktreeRealPath = fs.realpathSync(worktreePath)
    createRailWorktree(db, {
      id: 'orphan-dirty-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['orphan-dirty-wt'], isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        gitCalls.push({ args, cwd })
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'fsck') return { code: 0, stdout: `unreachable commit ${orphan}\n`, stderr: '' }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') return { code: 0, stdout: `settle (run ${runId})\n`, stderr: '' }
        if (args[0] === 'cat-file') return ok
        if (args.join(' ') === 'worktree list --porcelain -z' && cwd === projectPath) {
          return {
            code: 0,
            stdout: registeredWorktreeList([
              { worktreePath: projectPath, head: baseline, branch: 'main' },
              { worktreePath, head: baseline, branch },
            ]),
            stderr: '',
          }
        }
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD' && cwd === worktreeRealPath) {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --verify HEAD' && cwd === worktreeRealPath) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}` && cwd === projectPath) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args[0] === 'status') return { code: 0, stdout: '?? valuable-local-change.txt\n', stderr: '' }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({
      git, exec, project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: 'pr_failed', recoveryUnavailable: true,
        detail: expect.stringContaining('different live worktree result'),
      },
    })
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      delivery_outcome: 'blocked', status_code: 'recovery_unavailable', delivery_sha: orphan,
    })
    expect([...refs.values()]).toEqual([orphan])
    expect(fs.readFileSync(path.join(worktreePath, 'valuable-local-change.txt'), 'utf8')).toBe('preserve me')
    expect(gitCalls.some(({ args }) => args[0] === 'add' || args[0] === 'commit')).toBe(false)
    // Worktree enumeration is read-only; no worktree remove/move may run.
    expect(gitCalls.some(({ args }) => args[0] === 'worktree' && args[1] !== 'list')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(getRailWorktree(db, 'orphan-dirty-wt')?.merge_state).toBe('needs-review')
  })

  it('pins a unique orphan while preserving a recreated unregistered ledger directory', async () => {
    const runId = 'orphan-plus-recreated-path-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const orphan = 'b'.repeat(40)
    const projectPath = path.join(tmpDir, 'orphan-recreated-repo')
    const worktreePath = path.join(tmpDir, 'orphan-recreated-directory')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'unrelated.txt'), 'unrelated directory')
    createRailWorktree(db, {
      id: 'orphan-recreated-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['orphan-recreated-wt'], isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args, cwd) {
        gitCalls.push(args)
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'fsck') return { code: 0, stdout: `unreachable commit ${orphan}\n`, stderr: '' }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') return { code: 0, stdout: `settle (run ${runId})\n`, stderr: '' }
        if (args[0] === 'cat-file') return ok
        if (args.join(' ') === 'worktree list --porcelain -z' && cwd === projectPath) {
          return {
            code: 0,
            stdout: registeredWorktreeList([{ worktreePath: projectPath, head: baseline, branch: 'main' }]),
            stderr: '',
          }
        }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({
      git, exec, project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', recoveryUnavailable: true, detail: expect.stringContaining('not uniquely registered') },
    })
    expect(getPrDelivery(db, draft.id)).toMatchObject({ delivery_sha: orphan, status_code: 'recovery_unavailable' })
    expect([...refs.values()]).toEqual([orphan])
    expect(fs.readFileSync(path.join(worktreePath, 'unrelated.txt'), 'utf8')).toBe('unrelated directory')
    expect(gitCalls.some((args) => args[0] === 'add' || args[0] === 'commit')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it.each([
    { name: 'ambiguous marked objects', scanCode: 0, ambiguous: true },
    { name: 'failed object enumeration', scanCode: 1, ambiguous: false },
  ])('fails closed with recovery_unavailable for $name', async ({ scanCode, ambiguous }) => {
    const runId = 'failed-discovery-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const first = 'b'.repeat(40)
    const second = 'c'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args[0] === 'cat-file') return ok
        if (args[0] === 'fsck') {
          return scanCode === 0
            ? { code: 0, stdout: `unreachable commit ${first}\nunreachable commit ${second}\n`, stderr: '' }
            : { code: 1, stdout: '', stderr: 'fsck failed' }
        }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') {
          return { code: 0, stdout: ambiguous ? `settle (run ${runId})\n` : 'unrelated\n', stderr: '' }
        }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', recoveryUnavailable: true },
    })
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      status_code: 'recovery_unavailable', delivery_sha: null,
    })
    expect(gitCalls.some((args) => args[0] === 'update-ref')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it('rejects a non-fast-forward run-marked orphan while keeping its exact ref discardable', async () => {
    const runId = 'non-fast-forward-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args[0] === 'cat-file') return ok
        if (args[0] === 'fsck') return { code: 0, stdout: `unreachable commit ${candidate}\n`, stderr: '' }
        if (args[0] === 'log') return ok
        if (args[0] === 'show') return { code: 0, stdout: `settle (run ${runId})\n`, stderr: '' }
        if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'not an ancestor' }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', recoveryUnavailable: true, detail: expect.stringContaining('not a fast-forward') },
    })
    expect([...refs.values()]).toEqual([candidate])
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(getPrDelivery(db, draft.id)).toMatchObject({ delivery_sha: candidate })
  })

  it('recovers a consistent durable final SHA after the visible branch was reset to the PR baseline', async () => {
    const runId = 'durable-final-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
        initialSha: baseline, finalSha: candidate, changed: true,
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'update-ref' && args[1] === '-d') {
          refs.delete(args[2])
          return ok
        }
        if (args[0] === 'update-ref') {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args[0] === 'cat-file' || args[0] === 'merge-base') return ok
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        lifecycleJson({ state: 'OPEN', sha: candidate, headSha: candidate, branch }),
      ),
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'pr_ready', verifiedSha: candidate } })
    expect(gitCalls.some((args) => args[0] === 'fsck' || args[0] === 'log')).toBe(false)
    expect(calls).toContainEqual({
      cmd: 'git', args: ['push', 'https://github.com/o/r.git', `${candidate}:refs/heads/${branch}`], cwd: PROJECT.path,
    })
  })

  it.each([
    { name: 'durably proven no changes', noChanges: true },
    { name: 'durable final already at the PR head', noChanges: false },
  ])('classifies $name without creating a commit or pushing', async ({ noChanges }) => {
    const runId = noChanges ? 'no-change-run' : 'already-delivered-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
        initialSha: baseline, finalSha: baseline, changed: noChanges ? false : true,
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted', deliverySha: null, isContinuation: true,
    })
    const refs = new Map<string, string>()
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'update-ref' && args[1] === '-d') {
          refs.delete(args[2])
          return ok
        }
        if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
          refs.set(args[1], args[2])
          return ok
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args[0] === 'cat-file') return ok
        if (args[0] === 'fsck' || args[0] === 'log') return ok
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: noChanges ? 'no_changes' : 'pr_ready',
        deliveryVerified: true,
        verifiedSha: baseline,
        pushed: false,
      },
    })
    expect(gitCalls.some((args) => args[0] === 'commit')).toBe(false)
    expect(refs.size).toBe(0)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it.each([
    { action: 'discard', retained: false },
    { action: 'dismiss', retained: true },
  ] as const)('$action applies the explicit recovery-ref ownership contract', async ({ action, retained }) => {
    const candidate = 'b'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch: 'feat/1-t1',
      isContinuation: true, deliverySha: candidate,
      branches: [{
        ticketId: 1, branch: 'feat/1-t1', succeeded: true, finalSha: candidate,
        branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
      deliverySha: candidate, isContinuation: true,
    })
    const ref = recoveryRefForDelivery(row.id)
    const refs = new Map([[ref, candidate]])
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'update-ref' && args[1] === '-d') {
          const [, , targetRef, expected] = args
          if (expected && refs.get(targetRef) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
          refs.delete(targetRef)
          return ok
        }
        if (args[0] === 'rev-parse' && args[2] === ref) {
          const value = refs.get(ref)
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        return ok
      },
    }

    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action, expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'discarded' } })
    expect(refs.has(ref)).toBe(retained)
  })

  it.each([
    { proof: 'exact run marker', durableFinal: false },
    { proof: 'consistent durable final', durableFinal: true },
  ])('Discard after a pre-persistence crash releases a ref proven by $proof', async ({ durableFinal }) => {
    const runId = durableFinal ? 'discard-durable-final-run' : 'discard-run-marker-run'
    const candidate = 'b'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch: 'feat/1-t1',
      isContinuation: true, deliverySha: null,
      branches: [{
        ticketId: 1, runId, branch: 'feat/1-t1', succeeded: false,
        finalSha: durableFinal ? candidate : undefined,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'recovery_unavailable', deliverySha: null, isContinuation: true,
    })
    const ref = recoveryRefForDelivery(row.id)
    const refs = new Map([[ref, candidate]])
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'rev-parse' && args[2] === ref) {
          const value = refs.get(ref)
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'show') {
          return {
            code: 0,
            stdout: durableFinal ? 'unmarked durable commit\n' : `settle (run ${runId})\n`,
            stderr: '',
          }
        }
        if (args[0] === 'update-ref' && args[1] === '-d') {
          const [, , targetRef, expected] = args
          if (refs.get(targetRef) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
          refs.delete(targetRef)
          return ok
        }
        return ok
      },
    }

    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'discarded' } })
    expect(result.body).not.toHaveProperty('cleanupWarnings')
    expect(refs.has(ref)).toBe(false)
    expect(gitCalls).toContainEqual(['update-ref', '-d', ref, candidate])
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'discarded', status_code: 'discarded', delivery_sha: null,
    })
  })

  it('Discard after a pre-persistence crash warns and preserves a substituted recovery ref', async () => {
    const runId = 'discard-substituted-run'
    const ownedFinal = 'b'.repeat(40)
    const substituted = 'c'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch: 'feat/1-t1',
      isContinuation: true, deliverySha: null,
      branches: [{
        ticketId: 1, runId, branch: 'feat/1-t1', succeeded: false, finalSha: ownedFinal,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'recovery_unavailable', deliverySha: null, isContinuation: true,
    })
    const ref = recoveryRefForDelivery(row.id)
    const refs = new Map([[ref, substituted]])
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'rev-parse' && args[2] === ref) {
          return { code: 0, stdout: `${refs.get(ref)}\n`, stderr: '' }
        }
        if (args[0] === 'show') return { code: 0, stdout: 'unrelated commit\n', stderr: '' }
        if (args[0] === 'update-ref' && args[1] === '-d') {
          refs.delete(args[2])
          return ok
        }
        return ok
      },
    }

    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: 'discarded',
        cleanupWarnings: [expect.stringContaining('could not be proven to belong to this delivery')],
      },
    })
    expect(refs.get(ref)).toBe(substituted)
    expect(gitCalls.some((args) => args[0] === 'update-ref' && args[1] === '-d')).toBe(false)
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'discarded', status_code: 'cleanup_incomplete' })
  })

  it('retains the exact recovery ref and frozen SHA when a retry push fails', async () => {
    const candidate = 'b'.repeat(40)
    const baseline = 'a'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch: 'feat/1-t1',
      isContinuation: true, deliverySha: candidate,
      branches: [{
        ticketId: 1, branch: 'feat/1-t1', succeeded: true, finalSha: candidate,
        branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'settlement_interrupted',
      deliverySha: candidate, isContinuation: true,
    })
    const ref = recoveryRefForDelivery(row.id)
    const refs = new Map([[ref, candidate]])
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'update-ref' && args[1] === '-d') {
          refs.delete(args[2])
          return ok
        }
        return ok
      },
    }
    const { exec } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch: 'feat/1-t1' }),
        stderr: '',
      },
      push: { code: 1, stdout: '', stderr: 'network unavailable' },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', detail: 'network unavailable' },
    })
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'pr_failed', delivery_sha: candidate, delivery_outcome: 'retryable_failure',
    })
    expect(refs.get(ref)).toBe(candidate)
  })

  it.each([
    { name: 'a proven fast-forward', divergent: false },
    { name: 'a divergent delivery', divergent: true },
  ])('Retry push fetches the live PR object and handles $name safely', async ({ divergent }) => {
    const baseline = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const branch = 'feat/1-t1'
    const row = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      isContinuation: true, deliverySha: candidate,
      branches: [{
        ticketId: 1, branch, succeeded: true, finalSha: candidate,
        branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
      deliverySha: candidate, isContinuation: true,
    })
    const ref = recoveryRefForDelivery(row.id)
    const refs = new Map([[ref, candidate]])
    let fetched = false
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'cat-file' && args[2] === `${baseline}^{commit}`) {
          return fetched ? ok : { code: 1, stdout: '', stderr: 'missing' }
        }
        if (args[0] === 'fetch') {
          fetched = true
          return ok
        }
        if (args[0] === 'merge-base') {
          return divergent ? { code: 1, stdout: '', stderr: 'not an ancestor' } : ok
        }
        if (args[0] === 'show-ref' && args[3]?.startsWith('refs/specrails/recovery/')) {
          return refs.has(args[3]) ? ok : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
          const value = refs.get(args[2])
          return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'update-ref' && args[1] === '-d') {
          const [, , targetRef, expected] = args
          if (refs.has(targetRef) && refs.get(targetRef) !== expected) {
            return { code: 1, stdout: '', stderr: 'mismatch' }
          }
          refs.delete(targetRef)
          return ok
        }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        lifecycleJson({ state: 'OPEN', sha: candidate, headSha: candidate, branch }),
      ),
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed',
    })

    expect(gitCalls).toContainEqual(['fetch', 'origin', `refs/heads/${branch}`])
    expect(gitCalls).toContainEqual(['merge-base', '--is-ancestor', baseline, candidate])
    const pushes = calls.filter((call) => call.cmd === 'git' && call.args[0] === 'push')
    if (divergent) {
      expect(result).toMatchObject({
        status: 200,
        body: { decision: 'pr_failed', recoveryUnavailable: true, detail: expect.stringContaining('not a fast-forward') },
      })
      expect(pushes).toEqual([])
      expect(refs.get(ref)).toBe(candidate)
      expect(getPrDelivery(db, row.id)).toMatchObject({
        decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'recovery_unavailable',
        delivery_sha: candidate,
      })
    } else {
      expect(result).toMatchObject({
        status: 200,
        body: { decision: 'pr_ready', deliveryVerified: true, verifiedSha: candidate, pushed: true },
      })
      expect(pushes).toHaveLength(1)
      expect(gitCalls).toContainEqual(['update-ref', '-d', ref, candidate])
      expect(refs.has(ref)).toBe(false)
    }
  })

  it.each(['discarded', 'superseded'] as const)(
    'exact successor delivery releases an ancestor ref retained by its %s predecessor',
    async (predecessorDecision) => {
      const ancestor = 'a'.repeat(40)
      const delivered = 'b'.repeat(40)
      const branch = 'feat/1-t1'
      const predecessor = mkRow({
        decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
        isContinuation: true, deliverySha: ancestor,
        branches: [{
          ticketId: 1, branch, succeeded: true, finalSha: ancestor,
          branchOwnership: 'borrowed-pr',
        }],
      })
      transitionDecision(db, predecessor.id, 'pr_draft', predecessorDecision, {
        deliverySha: ancestor, isContinuation: true,
      })
      const successor = mkRow({
        decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
        isContinuation: true, deliverySha: delivered,
        supersedesDeliveryId: predecessor.id,
        branches: [{
          ticketId: 1, branch, succeeded: true, finalSha: delivered,
          branchOwnership: 'borrowed-pr',
        }],
      })
      transitionDecision(db, successor.id, 'pr_draft', 'pr_failed', {
        deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
        deliverySha: delivered, isContinuation: true,
      })
      const predecessorRef = recoveryRefForDelivery(predecessor.id)
      const refs = new Map([[predecessorRef, ancestor]])
      const gitCalls: string[][] = []
      const git: GitRunner = {
        async run(args) {
          gitCalls.push(args)
          if (args[0] === 'rev-parse' && args[2]?.startsWith('refs/specrails/recovery/')) {
            const value = refs.get(args[2])
            return value ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
          }
          if (args[0] === 'merge-base') return ok
          if (args[0] === 'update-ref' && args[1] === '-d') {
            const [, , ref, expected] = args
            if (refs.has(ref) && refs.get(ref) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
            refs.delete(ref)
            return ok
          }
          return ok
        },
      }
      const { exec, calls } = fakeExec({
        view: {
          code: 0,
          stdout: lifecycleJson({ state: 'OPEN', sha: delivered, headSha: delivered, branch }),
          stderr: '',
        },
      })

      const result = await executePrDecision(mkDeps({ git, exec }).deps, {
        prDeliveryId: successor.id, action: 'create-pr', expectedDecision: 'pr_failed',
      })

      expect(result).toMatchObject({
        status: 200,
        body: { decision: 'pr_ready', deliveryVerified: true, verifiedSha: delivered, pushed: false },
      })
      expect(refs.has(predecessorRef)).toBe(false)
      expect(gitCalls).toContainEqual(['merge-base', '--is-ancestor', ancestor, delivered])
      expect(gitCalls).toContainEqual(['update-ref', '-d', predecessorRef, ancestor])
      expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    },
  )

  it('Commit & retry push stays blocked without local evidence on this computer and performs no mutation', async () => {
    const runId = 'legacy-other-computer-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'cat-file') return ok
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: 'unknown ref' }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: 'pr_failed',
        recoveryUnavailable: true,
        detail: expect.stringContaining('available in this clone'),
      },
    })
    expect(gitCalls.some((args) => ['add', 'commit', 'checkout', 'reset', 'stash'].includes(args[0]))).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'recovery_unavailable', delivery_sha: null,
    })
  })

  it('Commit & retry push refuses to fabricate ownership when no exact run-and-branch unit exists', async () => {
    const runId = 'legacy-owned-run'
    const branch = 'feat/1-t1'
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch, isContinuation: true,
      branches: [{
        ticketId: 1, runId: 'different-run', branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const { git, calls: gitCalls } = fakeGit()
    const { exec, calls } = fakeExec()

    const result = await executePrDecision(mkDeps({ git, exec }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', detail: expect.stringContaining('exact recorded unit') },
    })
    expect(gitCalls).toEqual([])
    expect(calls).toEqual([])
  })

  it('Commit & retry push refuses a divergent preserved branch before commit or push', async () => {
    const runId = 'legacy-diverged-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const divergent = 'c'.repeat(40)
    const projectPath = path.join(tmpDir, 'legacy-diverged-repo')
    const worktreePath = path.join(tmpDir, 'legacy-diverged-wt')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    createRailWorktree(db, {
      id: 'legacy-diverged-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['legacy-diverged-wt'], isContinuation: true,
      branches: [{ ticketId: 1, runId, branch, succeeded: false, branchOwnership: 'borrowed-pr' }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted', deliverySha: null, isContinuation: true,
    })
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args, cwd) {
        gitCalls.push(args)
        if (args.join(' ') === 'worktree list --porcelain -z' && cwd === projectPath) {
          return {
            code: 0,
            stdout: registeredWorktreeList([
              { worktreePath: projectPath, head: baseline, branch: 'main' },
              { worktreePath, head: divergent, branch },
            ]),
            stderr: '',
          }
        }
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args.join(' ') === 'rev-parse --verify HEAD') return { code: 0, stdout: `${divergent}\n`, stderr: '' }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}`) return { code: 0, stdout: `${divergent}\n`, stderr: '' }
        if (args[0] === 'cat-file') return ok
        if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'not an ancestor' }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: divergent, headSha: baseline, includeSha: false, branch }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({
      git,
      exec,
      project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'pr_failed', detail: expect.stringContaining('diverges') } })
    expect(gitCalls.some((args) => args[0] === 'add' || args[0] === 'commit')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(getRailWorktree(db, 'legacy-diverged-wt')?.merge_state).toBe('needs-review')
  })

  it('Commit & retry push rejects a ledger worktree symlinked to the main checkout before staging', async () => {
    const runId = 'legacy-symlink-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const projectPath = path.join(tmpDir, 'symlink-main-repo')
    const worktreePath = path.join(tmpDir, 'symlink-hijack-wt')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.symlinkSync(projectPath, worktreePath, process.platform === 'win32' ? 'junction' : 'dir')
    createRailWorktree(db, {
      id: 'symlink-hijack-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['symlink-hijack-wt'], isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'cat-file') return ok
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }), stderr: '' },
    })

    const result = await executePrDecision(mkDeps({
      git,
      exec,
      project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', detail: expect.stringContaining('symbolic link') },
    })
    expect(gitCalls.some((args) => args[0] === 'add' || args[0] === 'commit')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(fs.lstatSync(worktreePath).isSymbolicLink()).toBe(true)
  })

  it('Commit & retry push rejects a reused directory that is no longer a registered Git worktree', async () => {
    const runId = 'legacy-reused-path-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const projectPath = path.join(tmpDir, 'reused-path-repo')
    const worktreePath = path.join(tmpDir, 'reused-ordinary-directory')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    createRailWorktree(db, {
      id: 'reused-path-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['reused-path-wt'], isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        gitCalls.push(args)
        if (args[0] === 'cat-file') return ok
        if (args.join(' ') === 'worktree list --porcelain -z') {
          return {
            code: 0,
            stdout: registeredWorktreeList([{ worktreePath: projectPath, head: baseline, branch: 'main' }]),
            stderr: '',
          }
        }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }), stderr: '' },
    })

    const result = await executePrDecision(mkDeps({
      git,
      exec,
      project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', detail: expect.stringContaining('not uniquely registered') },
    })
    expect(gitCalls.some((args) => args[0] === 'add' || args[0] === 'commit')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(fs.readdirSync(worktreePath)).toEqual([])
  })

  it('Commit & retry push reauthenticates Git registration immediately before staging', async () => {
    const runId = 'legacy-registration-race-run'
    const branch = 'feat/1-t1'
    const baseline = 'a'.repeat(40)
    const projectPath = path.join(tmpDir, 'registration-race-repo')
    const worktreePath = path.join(tmpDir, 'registration-race-wt')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    const worktreeRealPath = fs.realpathSync(worktreePath)
    createRailWorktree(db, {
      id: 'registration-race-wt', railIndex: 0, ticketId: 1, runId, branch,
      worktreePath, mergeState: 'needs-review',
    })
    const draft = mkRow({
      decision: 'pr_draft', ticketIds: [1], prUrl: PR_URL, branch,
      worktreeIds: ['registration-race-wt'], isContinuation: true,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      runIds: [runId], deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      deliverySha: null, isContinuation: true,
    })
    let registrations = 0
    const gitCalls: string[][] = []
    const git: GitRunner = {
      async run(args, cwd) {
        gitCalls.push(args)
        if (args[0] === 'cat-file' || args[0] === 'merge-base') return ok
        if (args.join(' ') === 'worktree list --porcelain -z') {
          registrations++
          return {
            code: 0,
            stdout: registeredWorktreeList(registrations === 1
              ? [
                  { worktreePath: projectPath, head: baseline, branch: 'main' },
                  { worktreePath, head: baseline, branch },
                ]
              : [{ worktreePath: projectPath, head: baseline, branch: 'main' }]),
            stderr: '',
          }
        }
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD' && cwd === worktreeRealPath) {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --verify HEAD' && cwd === worktreeRealPath) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${branch}` && cwd === projectPath) {
          return { code: 0, stdout: `${baseline}\n`, stderr: '' }
        }
        return ok
      },
    }
    const { exec, calls } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha: baseline, headSha: baseline, branch }), stderr: '' },
    })

    const result = await executePrDecision(mkDeps({
      git,
      exec,
      project: { ...PROJECT, path: projectPath },
    }).deps, {
      prDeliveryId: draft.id, action: 'recover-and-retry', expectedDecision: 'pr_failed',
    })

    expect(registrations).toBe(2)
    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', detail: expect.stringContaining('failed final authentication') },
    })
    expect(gitCalls.some((args) => args[0] === 'add' || args[0] === 'commit')).toBe(false)
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it('keeps an existing PR retryable when lifecycle observation fails after an exact push', async () => {
    const draft = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, deliverySha: 'a'.repeat(40), isContinuation: true,
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    })
    let views = 0
    const { exec } = fakeExec({
      view: () => ++views === 1
        ? {
            code: 0,
            stdout: lifecycleJson({
              state: 'OPEN', sha: 'a'.repeat(40), headSha: 'b'.repeat(40), includeSha: false,
            }),
            stderr: '',
          }
        : { code: 1, stdout: '', stderr: 'network unavailable after push' },
    })

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: draft.id, action: 'create-pr', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'pr_failed', prUrl: PR_URL } })
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure', delivery_sha: 'a'.repeat(40),
    })
  })

  it('refuses an exact-SHA retry when origin points at a different repository', async () => {
    const sha = 'a'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha, isContinuation: true,
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    })
    const { exec, calls } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha, headSha: 'b'.repeat(40), includeSha: false }),
        stderr: '',
      },
      remote: { code: 0, stdout: 'git@github.com:someone-else/r.git\n', stderr: '' },
    })

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: draft.id, action: 'create-pr', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'pr_failed', detail: expect.stringContaining('does not own') },
    })
    expect(calls).toContainEqual({
      cmd: 'git', args: ['remote', 'get-url', '--push', '--all', 'origin'], cwd: PROJECT.path,
    })
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure', delivery_sha: sha,
    })
  })

  it('retry observes the exact commit already MERGED and terminalizes without pushing again', async () => {
    const sha = 'a'.repeat(40)
    const draft = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha, isContinuation: true,
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    })
    const { exec, calls } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha }), stderr: '' },
    })
    const { deps, jira } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: draft.id, action: 'create-pr', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 200, body: { ok: true, decision: 'merged', merged: true } })
    expect(getPrDelivery(db, draft.id)).toMatchObject({
      decision: 'merged', delivery_outcome: 'delivered', delivery_sha: sha,
    })
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false)
    expect(readTicketStatuses(ticketFile)).toMatchObject({ '1': 'done', '2': 'done' })
    expect(jira.onRailMerged).toHaveBeenCalledWith([1, 2], draft.id, PR_URL)
  })

  it('retry from a degraded pr_draft (prUrl null) is allowed and can succeed', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: null, prState: 'pushed', branches: branchRecords([1]) })
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'pr_draft', prUrl: PR_URL, prState: 'pr-created' })
    expect(getPrDelivery(db, row.id)).toMatchObject({ pr_url: PR_URL, pr_state: 'pr-created' })
  })

  it('JIRA ALWAYS PREVAILS: the jira_links row keys the title/body ref over the local id', async () => {
    // Authoritative link for ticket 1 (the ticket store row has no jira_key).
    insertLinkWithId(db, { localId: 1, jiraIssueId: 'jira-issue-9001', jiraKey: 'SKILLS-101', jiraProjectId: 'jp-1', deployment: 'cloud' })
    const row = mkRow({ decision: 'on_review', branches: [{ ticketId: 1, branch: 'feat/1-t1', succeeded: true }], ticketIds: [1] })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    const title = create.args[create.args.indexOf('--title') + 1]
    const body = create.args[create.args.indexOf('--body') + 1]
    expect(title).toBe('[SKILLS-101]feat - t1')
    expect(body).toContain('## SKILLS-101 — T1')
    expect(body).not.toContain('## #1')
  })

  it('composes the canonical OSS body: summary, Tests honesty, Changes, no v1 footer', async () => {
    const row = mkRow({ decision: 'on_review', branches: [{ ticketId: 1, branch: 'feat/1-t1', succeeded: true }], ticketIds: [1] })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ exec })

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    const body = create.args[create.args.indexOf('--body') + 1]
    expect(body).toContain('This pull request delivers 1 ticket (#1)')
    expect(body).toContain('`main`')
    expect(body).toContain('**Tests**')
    // the fake git reports an empty diff → the honest no-tests sentence
    expect(body).toContain('No test files changed in this diff.')
    expect(body).toContain('## Changes')
    // the retired v1 footer never reappears
    expect(body).not.toContain('Draft PR produced by specrails')
  })

  it('an unreadable ticket store still creates the PR with bare refs (never blocks)', async () => {
    fs.writeFileSync(ticketFile, 'not json at all')
    const row = mkRow({ decision: 'on_review', branches: [{ ticketId: 1, branch: 'feat/1-t1', succeeded: true }], ticketIds: [1] })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prUrl: PR_URL })
    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    expect(create.args[create.args.indexOf('--title') + 1]).toBe('[1]feat - implement 1')
  })

  it('skips the batch-branch pre-delete when it would name the integration branch', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1, 2]), baseBranch: BATCH })
    const { git, calls } = fakeGit()
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ git, exec })

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    // never deletes the integration branch, and the assembled batch head is
    // collision-suffixed AWAY from it.
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === BATCH)).toBe(false)
    expect(getPrDelivery(db, row.id)?.branch).toBe(`${BATCH}-2`)
  })

  it('HARD GUARD: the pre-delete NEVER deletes a branch present in row.branches, even when the batch name collides with a unit branch', async () => {
    // Pathological but real: a unit branch named exactly like the derived batch
    // name. The old pre-delete would `branch -D` the branch it was about to
    // merge — destroying the delivered commits.
    const row = mkRow({
      decision: 'on_review',
      branches: [
        { ticketId: 1, branch: BATCH, succeeded: true }, // == batchBranchNameFor([T1, T2])
        { ticketId: 2, branch: 'feat/2-t2', succeeded: true },
      ],
    })
    const { git, calls } = fakeGit()
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prUrl: PR_URL })
    // The unit branch survives: no -D at all on it, and the batch head is
    // suffixed away from the reserved unit names.
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === BATCH)).toBe(false)
    expect(getPrDelivery(db, row.id)?.branch).toBe(`${BATCH}-2`)
  })

  it('single-ticket create-pr derives NO batch name and performs NO branch -D at all', async () => {
    const row = mkRow({ decision: 'pr_failed', branches: branchRecords([1]) })
    const { git, calls } = fakeGit()
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prUrl: PR_URL })
    expect(calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toEqual([])
  })
})

// ─── create-pr — immutable settled-object recovery ────────────────────────────

describe('create-pr — immutable settled-object recovery', () => {
  const RECORDED = 'feat/1-add-guess-the-number-mini-game'
  const REAL = 'sr/s1/ticket-1'
  const FINAL_SHA = '1'.repeat(40)

  function recoveryGit(opts: { objectExists: boolean; legacyRefSha?: string | null }) {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        calls.push({ args, cwd })
        if (args[0] === 'cat-file') {
          return opts.objectExists ? ok : { code: 1, stdout: '', stderr: 'missing object' }
        }
        if (args[0] === 'rev-parse' && args.includes('--verify')) {
          return opts.legacyRefSha
            ? { code: 0, stdout: `${opts.legacyRefSha}\n`, stderr: '' }
            : { code: 1, stdout: '', stderr: 'missing ref' }
        }
        return ok
      },
    }
    return { git, calls }
  }

  function settledRow() {
    return mkRow({
      decision: 'pr_draft', prUrl: null, prState: 'local-only', ticketIds: [1],
      branches: [{ ticketId: 1, branch: RECORDED, succeeded: true, finalSha: FINAL_SHA }],
    })
  }

  it('delivers the persisted final SHA even when the recorded branch is missing', async () => {
    createRailWorktree(db, {
      id: 'old-l', railIndex: 0, ticketId: 1, branch: REAL,
      worktreePath: '/wt/ticket-1', mergeState: 'failed',
    })
    const row = settledRow()
    const { git } = recoveryGit({ objectExists: true })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.body).toMatchObject({ ok: true, decision: 'pr_draft', prUrl: PR_URL, prState: 'pr-created' })
    expect(execCalls).toContainEqual({
      cmd: 'git', args: ['push', 'origin', `${FINAL_SHA}:refs/heads/${RECORDED}`], cwd: '/repo',
    })
    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    expect(create.args[create.args.indexOf('--head') + 1]).toBe(RECORDED)
    expect(execCalls.some((call) => call.args.includes(REAL))).toBe(false)
  })

  it('fails closed when the persisted final object is unavailable, ignoring historical ticket branches', async () => {
    createRailWorktree(db, {
      id: 'old-l', railIndex: 0, ticketId: 1, branch: REAL,
      worktreePath: '/wt/old', mergeState: 'failed',
    })
    const row = settledRow()
    const { git } = recoveryGit({ objectExists: false, legacyRefSha: '2'.repeat(40) })
    const { exec, calls: execCalls } = fakeExec()
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.body).toMatchObject({ ok: true, decision: 'pr_failed' })
    expect((r.body.detail as string)).toContain(RECORDED)
    expect(execCalls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false)
  })

  it('captures a legacy recorded ref once and persists its exact SHA for retry', async () => {
    const row = settledRow()
    transitionDecision(db, row.id, 'pr_draft', 'pr_draft', {
      branches: [{ ticketId: 1, branch: RECORDED, succeeded: true }],
      deliverySha: null,
    })
    const legacySha = '3'.repeat(40)
    const { git } = recoveryGit({ objectExists: true, legacyRefSha: legacySha })
    const { exec, calls: execCalls } = fakeExec({ push: { code: 1, stdout: '', stderr: 'network unreachable' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.body).toMatchObject({ decision: 'pr_draft', prState: 'local-only', detail: 'network unreachable' })
    expect(execCalls).toContainEqual({
      cmd: 'git', args: ['push', 'origin', `${legacySha}:refs/heads/${RECORDED}`], cwd: '/repo',
    })
    expect(JSON.parse(getPrDelivery(db, row.id)!.branches)).toEqual([
      { ticketId: 1, branch: RECORDED, succeeded: true, finalSha: legacySha },
    ])
  })
})

// ─── publish ──────────────────────────────────────────────────────────────────

describe('publish', () => {
  it('gh pr ready → pr_ready + broadcast', async () => {
    const sha = '1'.repeat(40)
    createRailWorktree(db, {
      id: 'w1', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, worktreeIds: ['w1'], deliverySha: sha,
    })
    const { exec, calls } = fakeExec({
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
        lifecycleJson({ state: 'OPEN', sha, isDraft: false }),
      ),
    })
    const { git, calls: gitCalls } = fakeGit()
    const { deps, broadcast } = mkDeps({ exec, git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      ok: true, decision: 'pr_ready', prUrl: PR_URL,
      deliveryVerified: true, verifiedSha: sha, remoteHeadSha: sha,
    })
    expect(calls).toContainEqual({ cmd: 'gh', args: ['pr', 'ready', PR_URL], cwd: '/repo' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_ready' })
    expect(gitCalls).toContainEqual({ args: ['worktree', 'remove', '/wt/ticket-1'], cwd: '/repo' })
    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('released')
  })

  it('gh failure → 502 gh_failed with NO transition and NO broadcast', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha })
    const { exec } = fakeExec({
      ready: { code: 1, stdout: '', stderr: 'gh: not authenticated' },
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
        lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
      ),
    })
    const { deps, broadcast } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'gh_failed', detail: 'gh: not authenticated' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_draft')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('409 stale_decision when a concurrent mutation races the CAS transition', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha })
    // The other surface discards the delivery WHILE our gh call is in flight:
    // the pre-check passed, but the CAS UPDATE must lose.
    const { exec } = fakeExec({
      ready: () => {
        transitionDecision(db, row.id, 'pr_draft', 'discarded')
        return ok
      },
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
        lifecycleJson({ state: 'OPEN', sha, isDraft: false }),
      ),
    })
    const { deps, broadcast } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'stale_decision', current: 'discarded' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded') // the racer's win stands
    expect(prStateBroadcasts(broadcast)).toHaveLength(0)
  })
})

// ─── discard ──────────────────────────────────────────────────────────────────

describe('discard', () => {
  function mkLedger(id: string, ticketId: number, state: 'built' | 'failed' | 'needs-review' = 'built') {
    const row = createRailWorktree(db, {
      id, railIndex: 0, ticketId, branch: `feat/${ticketId}-t${ticketId}`,
      worktreePath: `/wt/ticket-${ticketId}`, mergeState: state,
    })
    return row
  }

  it('full cleanup: closes the PR, removes worktrees, deletes branches, reverts tickets, notifies jira', async () => {
    mkLedger('w1', 1)
    mkLedger('w2', 2)
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, ticketIds: [1, 2, 3],
      branches: branchRecords([1, 2]), worktreeIds: ['w1', 'w2'],
    })
    const { git, calls } = fakeGit()
    const { exec, calls: execCalls } = fakeExec()
    const { deps, broadcast, jira } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'discarded' })
    // Closing and remote-head deletion are deliberately separate: gh's
    // --delete-branch has no immutable-tip lease.
    expect(execCalls).toContainEqual({ cmd: 'gh', args: ['pr', 'close', PR_URL], cwd: '/repo' })
    expect(execCalls.some((call) => call.args.includes('--delete-branch'))).toBe(false)
    // worktrees removed (reconcile-style) + ledger rows closed
    expect(calls).toContainEqual({ args: ['worktree', 'remove', '/wt/ticket-1'], cwd: '/repo' })
    expect(calls).toContainEqual({ args: ['worktree', 'remove', '/wt/ticket-2'], cwd: '/repo' })
    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('failed')
    expect(getRailWorktree(db, 'w2')?.merge_state).toBe('failed')
    // Only durably owned unit branches are deleted. A preferred batch name is
    // never inferred during cleanup; it may belong to the user.
    const deleted = calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D').map((c) => c.args[2])
    expect(deleted).toContain('feat/1-t1')
    expect(deleted).toContain('feat/2-t2')
    expect(deleted).not.toContain(BATCH)
    expect(deleted).not.toContain('main')
    // ONLY the on_review tickets revert to todo; the done one is respected
    const statuses = readTicketStatuses(ticketFile)
    expect(statuses['1']).toBe('todo')
    expect(statuses['2']).toBe('todo')
    expect(statuses['3']).toBe('done')
    const tickets = ticketBroadcasts(broadcast)
    expect(tickets.map((m) => m.ticket!.id).sort()).toEqual([1, 2])
    expect(tickets.every((m) => m.ticket!.status === 'todo')).toBe(true)
    // jira gets the CHANGED ids + the delivery id
    expect(jira.onRailDiscard).toHaveBeenCalledWith([1, 2], row.id)
    // row terminal + durable broadcast
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded')
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'discarded' })
  })

  it.each([
    { name: 'fresh blocked delivery', decision: 'pr_failed' as const, implementationOutcome: 'succeeded' as const, continuation: false },
    { name: 'blocked continuation', decision: 'pr_failed' as const, implementationOutcome: 'succeeded' as const, continuation: true },
    { name: 'failed implementation', decision: 'implementation_failed' as const, implementationOutcome: 'failed' as const, continuation: false },
  ])('preserves ignored local progress during $name discard', async ({ decision, implementationOutcome, continuation }) => {
    mkLedger('dirty-wt', 1, 'needs-review')
    const row = mkRow({
      decision,
      ticketIds: [1],
      branches: branchRecords([1]),
      worktreeIds: ['dirty-wt'],
      isContinuation: continuation,
    })
    transitionDecision(db, row.id, decision, decision, {
      implementationOutcome,
      deliveryOutcome: 'blocked',
      statusCode: 'commit_failed',
    })
    const gitCalls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        gitCalls.push({ args, cwd })
        if (args[0] === 'status') {
          expect(args).toContain('--ignored=matching')
          return { code: 0, stdout: '!! ignored-user/progress.bin\n', stderr: '' }
        }
        return ok
      },
    }
    const { deps } = mkDeps({ git })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id,
      action: 'discard',
      expectedDecision: decision,
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ decision: 'discarded' })
    expect(result.body.cleanupWarnings).toEqual(expect.arrayContaining([
      // Ignored path with NO settlement snapshot → preserved with the
      // snapshot-specific reason (cleanup-and-checkout-tolerate-run-artifacts).
      expect.stringContaining('no settlement snapshot'),
    ]))
    expect(gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove')).toBe(false)
    expect(gitCalls.some((call) => call.args.includes('--force'))).toBe(false)
    expect(gitCalls.some((call) => call.args[0] === 'branch' && call.args[1] === '-D')).toBe(false)
    expect(getRailWorktree(db, 'dirty-wt')?.merge_state).toBe('needs-review')
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'discarded', status_code: 'cleanup_incomplete' })
  })

  it.each(['borrowed-pr', 'preexisting'] as const)(
    'closes a fresh replacement PR without deleting its %s remote head branch',
    async (branchOwnership) => {
      const row = mkRow({
        decision: 'pr_draft', prUrl: PR_URL, ticketIds: [1], isContinuation: false,
        branches: [{
          ticketId: 1, branch: 'feat/1-t1', succeeded: true,
          finalSha: '1'.repeat(40), branchOwnership,
        }],
      })
      const { exec, calls: execCalls } = fakeExec()
      const { git, calls: gitCalls } = fakeGit()

      const result = await executePrDecision(mkDeps({ exec, git }).deps, {
        prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft',
      })

      expect(result).toMatchObject({ status: 200, body: { decision: 'discarded' } })
      expect(execCalls).toContainEqual({ cmd: 'gh', args: ['pr', 'close', PR_URL], cwd: '/repo' })
      expect(execCalls.some((call) => call.args.includes('--delete-branch'))).toBe(false)
      expect(gitCalls.some((call) => call.args[0] === 'branch' && call.args[1] === '-D')).toBe(false)
      expect(readTicketStatuses(ticketFile)['1']).toBe('todo')
    },
  )

  it('deletes the exact owned suffixed batch head without touching the colliding preferred name', async () => {
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, branch: `${BATCH}-2`,
      ticketIds: [1, 2], branches: branchRecords([1, 2]), deliverySha: '1'.repeat(40),
    })
    const { git, calls } = fakeGit()
    const { deps } = mkDeps({ git })

    const r = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft',
    })

    expect(r.status).toBe(200)
    const deleted = calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D').map((c) => c.args[2])
    expect(deleted).toContain(`${BATCH}-2`)
    expect(deleted).not.toContain(BATCH)
  })

  it('preserves an owned local branch that advanced after the discard card was rendered', async () => {
    const expected = '1'.repeat(40)
    const advanced = 'b'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, ticketIds: [1],
      branches: [{
        ticketId: 1, branch: 'feat/1-t1', succeeded: true,
        finalSha: expected, branchOwnership: 'created',
      }],
    })
    const calls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        calls.push(args)
        if (args.join(' ') === 'rev-parse --verify refs/heads/feat/1-t1') {
          return { code: 0, stdout: `${advanced}\n`, stderr: '' }
        }
        return ok
      },
    }

    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'discarded' } })
    expect(calls.some((args) => args[0] === 'branch' && args[1] === '-D')).toBe(false)
    expect(result.body.cleanupWarnings).toEqual([expect.stringContaining('current tip no longer matches delivered HEAD')])
    expect(getPrDelivery(db, row.id)?.status_code).toBe('cleanup_incomplete')
  })

  it('discard from on_review (no PR yet) skips gh and still cleans up', async () => {
    mkLedger('w1', 1)
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]), worktreeIds: ['w1'] })
    const { exec, calls: execCalls } = fakeExec()
    const { deps, jira } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(execCalls.filter((c) => c.cmd === 'gh')).toHaveLength(0)
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded')
    expect(jira.onRailDiscard).toHaveBeenCalledWith([1, 2], row.id)
  })

  it('tolerates a gh close failure, a missing ledger row and failing git deletes', async () => {
    mkLedger('w1', 1)
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL,
      branches: branchRecords([1]), worktreeIds: ['w1', 'ghost'],
    })
    const { git } = fakeGit({ failOn: (args) => args[0] === 'branch' || args[0] === 'worktree' })
    const { exec } = fakeExec({ close: { code: 1, stdout: '', stderr: 'already closed' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded')
    expect(readTicketStatuses(ticketFile)['1']).toBe('todo')
  })

  it('does not reopen a ledger row already terminal (post-restart reconcile sweep)', async () => {
    mkLedger('w1', 1, 'failed')
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]), worktreeIds: ['w1'] })
    const { deps } = mkDeps()

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'on_review' })

    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('failed')
  })

  it('discard from pr_failed reverts the parked tickets', async () => {
    const row = mkRow({ decision: 'pr_failed', branches: branchRecords([1]) })
    const { deps, jira } = mkDeps()

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_failed' })

    expect(r.status).toBe(200)
    expect(readTicketStatuses(ticketFile)['1']).toBe('todo')
    expect(jira.onRailDiscard).toHaveBeenCalledWith([1, 2], row.id)
  })

  it('discard from implementation_failed clears the failed implementation card', async () => {
    const row = mkRow({ decision: 'implementation_failed', branches: branchRecords([1]) })
    const { deps, jira } = mkDeps()

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'implementation_failed' })

    expect(r.status).toBe(200)
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded')
    expect(readTicketStatuses(ticketFile)['1']).toBe('todo')
    expect(jira.onRailDiscard).toHaveBeenCalledWith([1, 2], row.id)
  })

  it('discard from implementation_failed does not close an existing PR or delete its branch', async () => {
    const { git, calls: gitCalls } = fakeGit()
    const { exec, calls: execCalls } = fakeExec()
    const row = mkRow({
      decision: 'implementation_failed',
      prUrl: PR_URL,
      prState: 'pr-created',
      branches: [{ ticketId: 1, branch: 'feat/existing-pr', succeeded: false }],
    })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'implementation_failed' })

    expect(r.status).toBe(200)
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded')
    expect(execCalls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close')).toBe(false)
    expect(gitCalls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false)
  })
})

// ─── poll-merge ───────────────────────────────────────────────────────────────

describe('poll-merge', () => {
  it('MERGED → merged, tickets on_review→done, jira notified with the PR url', async () => {
    createRailWorktree(db, {
      id: 'w1', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, ticketIds: [1, 2, 3], worktreeIds: ['w1'],
      deliverySha: '1'.repeat(40),
    })
    const { exec, calls } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha: row.delivery_sha }), stderr: '' },
    })
    const { git, calls: gitCalls } = fakeGit()
    const { deps, broadcast, jira } = mkDeps({ exec, git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true, decision: 'merged', merged: true, prUrl: PR_URL,
      deliveryVerified: true, verifiedSha: row.delivery_sha, pushed: false,
    })
    expect(calls).toContainEqual({ cmd: 'gh', args: ['pr', 'view', PR_URL, '--json', PR_LIFECYCLE_JSON_FIELDS], cwd: '/repo' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('merged')
    const statuses = readTicketStatuses(ticketFile)
    expect(statuses['1']).toBe('done')
    expect(statuses['2']).toBe('done')
    expect(statuses['3']).toBe('done') // already done — untouched, not double-reported
    expect(ticketBroadcasts(broadcast).map((m) => m.ticket!.id).sort()).toEqual([1, 2])
    expect(jira.onRailMerged).toHaveBeenCalledWith([1, 2], row.id, PR_URL)
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'merged' })
    expect(gitCalls).toContainEqual({ args: ['worktree', 'remove', '/wt/ticket-1'], cwd: '/repo' })
    expect(gitCalls).toContainEqual({ args: ['branch', '-D', 'feat/1-t1'], cwd: '/repo' })
  })

  it('MERGED deletes its exact owned suffixed batch head, never the colliding preferred name', async () => {
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, branch: `${BATCH}-2`,
      ticketIds: [1, 2], branches: branchRecords([1, 2]), deliverySha: '1'.repeat(40),
    })
    const { exec } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha: row.delivery_sha, branch: `${BATCH}-2` }), stderr: '' },
    })
    const { git, calls } = fakeGit()
    const { deps } = mkDeps({ exec, git })

    const r = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(r.status).toBe(200)
    const deleted = calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D').map((c) => c.args[2])
    expect(deleted).toContain(`${BATCH}-2`)
    expect(deleted).not.toContain(BATCH)
  })

  it('MERGED preserves an owned branch whose local tip advanced after delivery', async () => {
    const delivered = '1'.repeat(40)
    const advanced = '2'.repeat(40)
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, ticketIds: [1],
      branches: branchRecords([1]), deliverySha: delivered,
    })
    const { exec } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha: delivered }), stderr: '' },
    })
    const calls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        calls.push(args)
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${advanced}\n`, stderr: '' }
        return ok
      },
    }

    const result = await executePrDecision(mkDeps({ exec, git }).deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'merged' } })
    expect(calls.some((args) => args[0] === 'branch' && args[1] === '-D')).toBe(false)
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'merged', status_code: 'cleanup_incomplete' })
    expect(JSON.parse(getPrDelivery(db, row.id)!.cleanup_warnings)).toEqual([
      expect.stringContaining('current tip no longer matches delivered HEAD'),
    ])
  })

  it('MERGED on a retargeted base never terminalizes and returns the preserved SHA for a new PR', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: sha, isContinuation: true })
    const { exec } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'MERGED', sha, base: 'release' }),
        stderr: '',
      },
    })
    const { deps, jira } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, decision: 'on_review', prUrl: null, rerouted: true },
    })
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'on_review', pr_url: null, pr_number: null,
      pr_state: 'pushed', delivery_outcome: 'ready', delivery_sha: sha,
      is_continuation: 0,
    })
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
    expect(jira.onRailMerged).not.toHaveBeenCalled()
  })

  it('does not infer a legacy merge and detaches the stale PR for one-time SHA recovery', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: null })
    const { exec } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha: 'f'.repeat(40) }), stderr: '' },
    })
    const { deps, jira } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, decision: 'on_review', prUrl: null, prState: 'local-only', rerouted: true },
    })
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'on_review', pr_url: null, pr_state: 'local-only',
      delivery_outcome: 'ready', status_code: 'ready_for_review', delivery_sha: null,
    })
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
    expect(jira.onRailMerged).not.toHaveBeenCalled()
  })

  it('not merged → 200 merged:false, decision unchanged, nothing broadcast', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: '1'.repeat(40) })
    const { exec } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha: row.delivery_sha }), stderr: '' },
    })
    const { deps, broadcast, jira } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true, decision: 'pr_draft', merged: false,
      deliveryVerified: true, verifiedSha: row.delivery_sha,
      remoteHeadSha: row.delivery_sha, pushed: false,
    })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_draft')
    expect(broadcast).not.toHaveBeenCalled()
    expect(jira.onRailMerged).not.toHaveBeenCalled()
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
  })

  it('open PR missing the verified SHA restores Retry push instead of saying only not merged', async () => {
    const expectedSha = '1'.repeat(40)
    const remoteSha = '2'.repeat(40)
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: expectedSha })
    const { exec } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({ state: 'OPEN', sha: expectedSha, headSha: remoteSha, includeSha: false }),
        stderr: '',
      },
    })
    const { deps, broadcast } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true, decision: 'pr_failed', deliveryVerified: false,
        verifiedSha: expectedSha, remoteHeadSha: remoteSha,
      },
    })
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure',
      status_code: 'push_failed', delivery_sha: expectedSha,
    })
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({
      decision: 'pr_failed', deliveryOutcome: 'retryable_failure', deliverySha: expectedSha,
    })
  })

  it.each([
    { name: 'has no persisted SHA', deliverySha: null, remoteSha: null },
    { name: 'does not contain the persisted SHA', deliverySha: '1'.repeat(40), remoteSha: '2'.repeat(40) },
  ])('CLOSED $name detaches from the stale PR and remains actionable', async ({ deliverySha, remoteSha }) => {
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, deliverySha, isContinuation: true,
    })
    const { exec } = fakeExec({
      view: {
        code: 0,
        stdout: lifecycleJson({
          state: 'CLOSED', sha: deliverySha, headSha: remoteSha, includeSha: false,
        }),
        stderr: '',
      },
    })

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, decision: 'on_review', prUrl: null, rerouted: true },
    })
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'on_review', pr_url: null,
      pr_state: 'local-only',
      delivery_outcome: 'ready', delivery_sha: deliverySha, is_continuation: 0,
    })
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
  })

  it('gh failure → 502 gh_failed, no transition', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: '1'.repeat(40) })
    const { exec } = fakeExec({ view: { code: 1, stdout: '', stderr: 'no such pr' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'gh_failed', detail: 'no such pr' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
  })

  it('unparseable gh output → 502 gh_failed, no transition', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: '1'.repeat(40) })
    const { exec } = fakeExec({ view: { code: 0, stdout: 'not json', stderr: '' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(502)
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
  })
})

// ─── Agent-chat card fan-out ──────────────────────────────────────────────────

describe('agent-chat decision card', () => {
  it('updates the card with the full envelope on every mutation of an agent-chat row', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, originConversationId: 'conv-42', deliverySha: sha,
    })
    const { deps, card } = mkDeps({ exec: verifiedPublishExec(sha).exec })

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(card).toHaveBeenCalledTimes(1)
    expect(card).toHaveBeenCalledWith('conv-42', expect.objectContaining({
      kind: 'pr_decision', prDeliveryId: row.id, railIndex: 0, projectId: 'p1',
      baseBranch: 'main', ticketIds: [1, 2], decision: 'pr_ready', prUrl: PR_URL, prState: 'pr-created',
    }))
  })

  it('skips the card for dashboard-originated rows (origin null)', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha })
    const { deps, card } = mkDeps({ exec: verifiedPublishExec(sha).exec })

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(card).not.toHaveBeenCalled()
  })

  it('a null agent-chat registry (tests / disabled builds) is tolerated', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, originConversationId: 'conv-42', deliverySha: sha,
    })
    const { deps } = mkDeps({ exec: verifiedPublishExec(sha).exec, agentChat: () => null })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
  })
})

// ─── Resilience ───────────────────────────────────────────────────────────────

describe('resilience', () => {
  it('a throwing jira hook never breaks the discard', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]) })
    const { deps } = mkDeps({
      jiraSyncManager: {
        onRailMerged: vi.fn(),
        onRailDiscard: vi.fn(() => { throw new Error('jira down') }),
      },
    })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
    expect(getPrDelivery(db, row.id)?.decision).toBe('discarded')
  })

  it('a missing jiraSyncManager (partial context) is tolerated', async () => {
    const row = mkRow({ decision: 'on_review', branches: branchRecords([1]) })
    const { deps } = mkDeps({ jiraSyncManager: undefined })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'discard', expectedDecision: 'on_review' })

    expect(r.status).toBe(200)
  })

  it('an unreadable ticket store is logged, not fatal (the transition stands)', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: '1'.repeat(40) })
    const { exec } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha: row.delivery_sha }), stderr: '' },
    })
    fs.writeFileSync(ticketFile, 'not json at all')
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(200)
    expect(getPrDelivery(db, row.id)?.decision).toBe('merged')
  })
})

// ─── merge-local (remote-less acceptance) ─────────────────────────────────────

function gitScript(responses: { head?: string; dirty?: boolean; failMergeOf?: string } = {}) {
  const calls: string[][] = []
  const baseSha = '1'.repeat(40)
  const assembledSha = '2'.repeat(40)
  let baseAdvanced = false
  const branchSha = (branch: string): string => {
    if (branch === BATCH) return 'a'.repeat(40)
    const ticket = /^feat\/(\d+)-/.exec(branch)
    if (ticket) return Math.max(1, Number(ticket[1]) % 16).toString(16).repeat(40)
    return baseSha
  }
  const git: GitRunner = {
    async run(args, cwd) {
      calls.push(args)
      if (args[0] === 'symbolic-ref') {
        return { code: 0, stdout: `refs/heads/${cwd.includes('local-base-') ? 'main' : responses.head ?? 'main'}\n`, stderr: '' }
      }
      if (args[0] === 'status') return { code: 0, stdout: responses.dirty ? ' M x.ts\n' : '', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        const ticket = /ticket-(\d+)/.exec(cwd)
        const sha = cwd === '/repo'
          ? baseAdvanced ? assembledSha : baseSha
          : ticket
            ? Math.max(1, Number(ticket[1]) % 16).toString(16).repeat(40)
            : assembledSha
        return { code: 0, stdout: `${sha}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        return { code: 0, stdout: `${args[2] === 'refs/heads/main' && baseAdvanced ? assembledSha : branchSha(args[2].slice('refs/heads/'.length))}\n`, stderr: '' }
      }
      if (args[0] === 'merge' && responses.failMergeOf && args.includes(responses.failMergeOf)) {
        return { code: 1, stdout: '', stderr: 'CONFLICT (content): merge conflict in x.ts' }
      }
      if (args[0] === 'merge' && args[1] === '--ff-only') baseAdvanced = true
      return ok
    },
  }
  return { git, calls }
}

describe('merge-local', () => {
  it('is ILLEGAL once a real PR exists (GitHub is the merge authority) and on terminal states', async () => {
    const { deps } = mkDeps({ git: gitScript().git })
    const withPr = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    let res = await executePrDecision(deps, { prDeliveryId: withPr.id, action: 'merge-local', expectedDecision: 'pr_draft' })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('illegal_action')

    transitionDecision(db, withPr.id, 'pr_draft', 'discarded')

    const building = mkRow({ decision: 'building' })
    res = await executePrDecision(deps, { prDeliveryId: building.id, action: 'merge-local', expectedDecision: 'building' })
    expect(res.status).toBe(409)
  })

  it('claims a separate base worktree when the user is on another branch', async () => {
    const script = gitScript({ head: 'develop' })
    const { deps } = mkDeps({ git: script.git })
    const row = mkRow({ decision: 'on_review' })
    const res = await executePrDecision(deps, { prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review' })
    expect(res.status).toBe(200)
    expect(script.calls.some((args) => args[0] === 'worktree' && args[1] === 'add' && args[3] === 'main')).toBe(true)
    expect(script.calls.some((args) => ['checkout', 'reset', 'stash'].includes(args[0]))).toBe(false)
    expect(getPrDelivery(db, row.id)!.decision).toBe('merged')
  })

  it('allows unrelated working tree changes through Git’s non-forced fast-forward', async () => {
    const { deps } = mkDeps({ git: gitScript({ dirty: true }).git })
    const row = mkRow({ decision: 'on_review' })
    const res = await executePrDecision(deps, { prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review' })
    expect(res.status).toBe(200)
    expect(getPrDelivery(db, row.id)!.decision).toBe('merged')
  })

  it('happy path from a degraded local-only draft: merges the assembled head, sweeps, tickets → done, jira gets NULL url', async () => {
    const script = gitScript()
    const { deps, broadcast, jira } = mkDeps({ git: script.git })
    const row = mkRow({
      decision: 'pr_draft', prUrl: null, prState: 'local-only', branch: BATCH, deliverySha: 'a'.repeat(40),
    })
    const res = await executePrDecision(deps, { prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'pr_draft' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, decision: 'merged', merged: true, local: true })

    // ONE merge of the assembled head, --no-ff --no-edit.
    const merges = script.calls.filter((a) => a[0] === 'merge' && a[1] === '--no-ff')
    expect(merges).toEqual([['merge', '--no-ff', '--no-edit', 'a'.repeat(40)]])
    // Spent branches swept; the integration branch never deleted.
    const deleted = script.calls.filter((a) => a[0] === 'branch' && a[1] === '-D').map((a) => a[2])
    expect(deleted).toContain('feat/1-t1')
    expect(deleted).not.toContain('main')
    expect(deleted).not.toContain('a'.repeat(40))

    expect(getPrDelivery(db, row.id)!.decision).toBe('merged')
    expect(JSON.parse(getPrDelivery(db, row.id)!.cleanup_warnings)).toEqual([])
    expect(prStateBroadcasts(broadcast).at(-1)?.decision).toBe('merged')
    expect(readTicketStatuses(ticketFile)).toMatchObject({ '1': 'done', '2': 'done' })
    expect(jira.onRailMerged).toHaveBeenCalledWith([1, 2], row.id, null)
  })

  it('straight from on_review (no assembled head): merges every succeeded unit branch sequentially', async () => {
    const script = gitScript()
    const { deps } = mkDeps({ git: script.git })
    const row = mkRow({ decision: 'on_review' }) // units feat/1-t1 + feat/2-t2
    const res = await executePrDecision(deps, { prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review' })
    expect(res.status).toBe(200)
    const merges = script.calls.filter((a) => a[0] === 'merge' && a[1] === '--no-ff').map((a) => a[3])
    expect(merges).toEqual(['1'.repeat(40), '2'.repeat(40)])
    expect(getPrDelivery(db, row.id)!.decision).toBe('merged')
  })

  it('a merge conflict ABORTS and returns 502 merge_failed — no transition, tickets untouched', async () => {
    const script = gitScript({ failMergeOf: '2'.repeat(40) })
    const { deps, jira } = mkDeps({ git: script.git })
    const row = mkRow({ decision: 'on_review' })
    const res = await executePrDecision(deps, { prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review' })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('merge_failed')
    expect(String(res.body.detail)).toContain('CONFLICT')
    expect(script.calls.some((a) => a[0] === 'merge' && a[1] === '--abort')).toBe(true)
    expect(getPrDelivery(db, row.id)!.decision).toBe('on_review')
    expect(readTicketStatuses(ticketFile)).toMatchObject({ '1': 'on_review', '2': 'on_review' })
    expect(jira.onRailMerged).not.toHaveBeenCalled()
  })

  it('sweeps the launch worktrees and marks their ledger rows merged', async () => {
    const script = gitScript()
    const { deps } = mkDeps({ git: script.git })
    createRailWorktree(db, {
      id: 'wt-1', railIndex: 0, ticketId: 1, runId: 'run-1',
      branch: 'feat/1-t1', worktreePath: '/wts/ticket-1', baseSha: 'abc',
    })
    const row = mkRow({ decision: 'on_review', worktreeIds: ['wt-1'] })
    const res = await executePrDecision(deps, { prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review' })
    expect(res.status).toBe(200)
    expect(script.calls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(true)
    expect(getRailWorktree(db, 'wt-1')!.merge_state).toBe('merged')
  })
})

describe('race-safe and recoverable PR decisions', () => {
  it('claims before effects: publish wins and concurrent discard performs zero external work', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha })
    const calls: string[][] = []
    let viewCount = 0
    let enterReady!: () => void
    let releaseReady!: () => void
    const readyEntered = new Promise<void>((resolve) => { enterReady = resolve })
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve })
    const exec: Exec = {
      async run(_cmd, args) {
        calls.push(args)
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            code: 0,
            stdout: lifecycleJson({ state: 'OPEN', sha, isDraft: viewCount++ === 0 }),
            stderr: '',
          }
        }
        if (args[0] === 'pr' && args[1] === 'ready') {
          enterReady()
          await readyGate
        }
        return ok
      },
    }
    const { deps } = mkDeps({ exec })

    const publish = executePrDecision(deps, {
      prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft',
    })
    await readyEntered
    const discard = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft',
    })

    expect(discard).toMatchObject({
      status: 409, body: { error: 'operation_in_progress', current: 'pr_draft', operation: 'publish' },
    })
    expect(calls.map((args) => args.slice(0, 2))).toEqual([['pr', 'view'], ['pr', 'ready']])
    releaseReady()
    await expect(publish).resolves.toMatchObject({ status: 200, body: { decision: 'pr_ready' } })
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'pr_ready', operation_token: null })
  })

  it('reclaims a stale operation lease and clears the replacement token after success', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha })
    expect(claimPrDeliveryOperation(
      db, row.id, 'pr_draft', 'discard', 'dead-process', Date.now() - 31 * 60 * 1000,
    )).toBe(true)
    const { exec, calls } = verifiedPublishExec(sha)
    const { deps } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft',
    })

    expect(result.status).toBe(200)
    expect(calls).toContainEqual({ cmd: 'gh', args: ['pr', 'ready', PR_URL], cwd: '/repo' })
    expect(getPrDelivery(db, row.id)?.operation_token).toBeNull()
  })

  it('refuses an existing-PR retry without a persisted verified SHA and invokes no git/gh effect', async () => {
    const draft = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, deliverySha: null, isContinuation: true,
    })
    transitionDecision(db, draft.id, 'pr_draft', 'pr_failed', {
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed', deliverySha: null,
    })
    const row = getPrDelivery(db, draft.id)!
    const { exec, calls } = fakeExec()
    const { deps } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({ status: 409, body: { error: 'missing_verified_sha' } })
    expect(calls).toEqual([])
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'branch_verification_failed',
    })
  })

  it('represents CLOSED explicitly and reopen restores the observed draft lifecycle', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, deliverySha: sha })
    const closedExec = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'CLOSED', sha }), stderr: '' },
    }).exec
    const closed = await executePrDecision(mkDeps({ exec: closedExec }).deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })
    expect(closed).toMatchObject({ status: 200, body: { decision: 'pr_closed', closed: true } })
    expect(getPrDelivery(db, row.id)).toMatchObject({ decision: 'pr_closed', status_code: 'pr_closed' })

    const { exec, calls } = fakeExec({
      reopen: ok,
      view: lifecycleSequence(
        lifecycleJson({ state: 'CLOSED', sha }),
        lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
      ),
    })
    const reopened = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: row.id, action: 'reopen', expectedDecision: 'pr_closed',
    })
    expect(reopened).toMatchObject({ status: 200, body: { decision: 'pr_draft', reopened: true } })
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'view'], ['pr', 'reopen'], ['pr', 'view'],
    ])
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_draft')
  })

  it('terminalizes when the exact delivery merges while reopen is in flight', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_closed', prUrl: PR_URL, deliverySha: sha })
    const { exec, calls } = fakeExec({
      reopen: ok,
      view: lifecycleSequence(
        lifecycleJson({ state: 'CLOSED', sha }),
        lifecycleJson({ state: 'MERGED', sha }),
      ),
    })
    const { deps, jira } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'reopen', expectedDecision: 'pr_closed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'merged', merged: true } })
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'view'], ['pr', 'reopen'], ['pr', 'view'],
    ])
    expect(getPrDelivery(db, row.id)?.decision).toBe('merged')
    expect(readTicketStatuses(ticketFile)['1']).toBe('done')
    expect(jira.onRailMerged).toHaveBeenCalledTimes(1)
  })

  it('detaches when a different delivery merges while reopen is in flight', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({
      decision: 'pr_closed', prUrl: PR_URL, deliverySha: sha, isContinuation: true,
    })
    const { exec, calls } = fakeExec({
      reopen: ok,
      view: lifecycleSequence(
        lifecycleJson({ state: 'CLOSED', sha }),
        lifecycleJson({
          state: 'MERGED', sha, headSha: '2'.repeat(40), includeSha: false,
        }),
      ),
    })
    const { deps, jira } = mkDeps({ exec })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'reopen', expectedDecision: 'pr_closed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, decision: 'on_review', prUrl: null, rerouted: true },
    })
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'view'], ['pr', 'reopen'], ['pr', 'view'],
    ])
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'on_review', pr_url: null, pr_state: 'local-only',
      delivery_outcome: 'ready', delivery_sha: sha, is_continuation: 0,
    })
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
    expect(jira.onRailMerged).not.toHaveBeenCalled()
  })

  it('adopts an already-ready PR after an ambiguous publish failure', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, deliverySha: sha })
    const { exec, calls } = fakeExec({
      ready: { code: 1, stdout: '', stderr: 'pull request is already ready for review' },
      view: lifecycleSequence(
        lifecycleJson({ state: 'OPEN', sha, isDraft: true }),
        lifecycleJson({ state: 'OPEN', sha, isDraft: false }),
      ),
    })

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'pr_ready' } })
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'view'], ['pr', 'ready'], ['pr', 'view'],
    ])
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
  })

  it('adopts an already-open exact PR without issuing a redundant reopen mutation', async () => {
    const sha = '1'.repeat(40)
    const row = mkRow({ decision: 'pr_closed', prUrl: PR_URL, deliverySha: sha })
    const { exec, calls } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'OPEN', sha, isDraft: false }), stderr: '' },
    })

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: row.id, action: 'reopen', expectedDecision: 'pr_closed',
    })

    expect(result).toMatchObject({ status: 200, body: { decision: 'pr_ready', reopened: true } })
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([['pr', 'view']])
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
  })

  it.each([
    {
      name: 'head/base identity changed',
      lifecycle: lifecycleJson({ state: 'OPEN', sha: '1'.repeat(40), base: 'release' }),
    },
    {
      name: 'verified SHA is absent',
      lifecycle: lifecycleJson({
        state: 'OPEN', sha: '1'.repeat(40), headSha: '2'.repeat(40), includeSha: false,
      }),
    },
  ])('reopen detaches when the $name', async ({ lifecycle }) => {
    const sha = '1'.repeat(40)
    const row = mkRow({
      decision: 'pr_closed', prUrl: PR_URL, deliverySha: sha, isContinuation: true,
    })
    const { exec, calls } = fakeExec({
      reopen: ok,
      view: { code: 0, stdout: lifecycle, stderr: '' },
    })

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: row.id, action: 'reopen', expectedDecision: 'pr_closed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, decision: 'on_review', prUrl: null, rerouted: true },
    })
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([['pr', 'view']])
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'on_review', pr_url: null, pr_state: 'local-only',
      delivery_outcome: 'ready', delivery_sha: sha, is_continuation: 0,
    })
  })

  it.each(['dismiss', 'discard'] as const)(
    '%s on a continuation preserves its borrowed PR, head branch, and review tickets',
    async (action) => {
      createRailWorktree(db, {
        id: 'continuation-wt', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
        worktreePath: '/wt/continuation', mergeState: 'built',
      })
      const row = mkRow({
        decision: 'pr_ready', prUrl: PR_URL, worktreeIds: ['continuation-wt'], isContinuation: true,
      })
      const { exec, calls: execCalls } = fakeExec()
      const { git, calls: gitCalls } = fakeGit()
      const { deps, jira } = mkDeps({ exec, git })

      const result = await executePrDecision(deps, {
        prDeliveryId: row.id, action, expectedDecision: 'pr_ready',
      })

      expect(result).toMatchObject({
        status: 200, body: { decision: 'discarded', preservedBorrowedReview: true },
      })
      expect(execCalls.some((call) => call.cmd === 'gh' && call.args[1] === 'close')).toBe(false)
      expect(gitCalls.some((call) => call.args[0] === 'branch' && call.args[1] === '-D')).toBe(false)
      expect(gitCalls).toContainEqual({ args: ['worktree', 'remove', '/wt/continuation'], cwd: '/repo' })
      expect(readTicketStatuses(ticketFile)).toMatchObject({ '1': 'on_review', '2': 'on_review' })
      expect(jira.onRailDiscard).not.toHaveBeenCalled()
      expect(getPrDelivery(db, row.id)).toMatchObject({
        decision: 'discarded', pr_url: PR_URL, branch: 'feat/1-t1',
      })
    },
  )

  it('startup-repaired legacy continuation ownership preserves an existing PR', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, ticketIds: [1], isContinuation: true })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
      statusDetail: 'Recovered successful implementation from durable run logs.',
    })
    const { exec, calls: execCalls } = fakeExec()
    const { git, calls: gitCalls } = fakeGit()
    const { deps, jira } = mkDeps({ exec, git })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: 'discarded',
        preservedExternalReview: true,
      },
    })
    expect(execCalls.some((call) => call.cmd === 'gh' && call.args[1] === 'close')).toBe(false)
    expect(gitCalls.some((call) => call.args[0] === 'branch' && call.args[1] === '-D')).toBe(false)
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
    expect(jira.onRailDiscard).not.toHaveBeenCalled()
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'discarded', pr_url: PR_URL, is_continuation: 1,
    })
  })

  it('stale Discard on a PR-ready repaired legacy continuation cannot close its borrowed PR', async () => {
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, ticketIds: [1], isContinuation: true,
      branches: [{
        ticketId: 1, runId: 'legacy-run', branch: 'feat/1-t1', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
        finalSha: '1'.repeat(40), branchOwnership: 'borrowed-pr',
      }],
      deliverySha: '1'.repeat(40),
    })
    const { exec, calls: execCalls } = fakeExec()
    const { git, calls: gitCalls } = fakeGit()
    const { deps, jira } = mkDeps({ exec, git })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({
      status: 200, body: { decision: 'discarded', preservedExternalReview: true },
    })
    expect(execCalls.some((call) => call.cmd === 'gh' && call.args[1] === 'close')).toBe(false)
    expect(gitCalls.some((call) => call.args[0] === 'branch' && call.args[1] === '-D')).toBe(false)
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
    expect(jira.onRailDiscard).not.toHaveBeenCalled()
  })

  it('dismiss treats an already-released continuation worktree as idempotently clean', async () => {
    createRailWorktree(db, {
      id: 'released-continuation', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/already-gone', mergeState: 'released',
    })
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, worktreeIds: ['released-continuation'], isContinuation: true,
    })
    const { git, calls } = fakeGit({ failOn: () => true })
    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action: 'dismiss', expectedDecision: 'pr_ready',
    })
    expect(result).toMatchObject({ status: 200, body: { decision: 'discarded' } })
    expect(calls).toEqual([])
    expect(getPrDelivery(db, row.id)?.cleanup_warnings).toBe('[]')
  })

  it('allows a blocked continuation with no live worktree to be dismissed without touching its PR', async () => {
    const row = mkRow({
      decision: 'pr_draft', prUrl: PR_URL, ticketIds: [1], isContinuation: true,
      branches: [{
        ticketId: 1, runId: 'legacy-run', branch: 'feat/1-t1', succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_failed', {
      runIds: ['legacy-run'], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted', deliverySha: null, isContinuation: true,
    })
    const { exec, calls } = fakeExec()

    const result = await executePrDecision(mkDeps({ exec }).deps, {
      prDeliveryId: row.id, action: 'dismiss', expectedDecision: 'pr_failed',
    })

    expect(result).toMatchObject({
      status: 200,
      body: { decision: 'discarded', preservedExternalReview: true },
    })
    expect(calls.some((call) => call.cmd === 'gh' && call.args[1] === 'close')).toBe(false)
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'discarded', pr_url: PR_URL, is_continuation: 1,
    })
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
  })

  it('dismiss discloses every needs-review worktree it intentionally leaves mounted', async () => {
    createRailWorktree(db, {
      id: 'dismiss-needs-review', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/recoverable-follow-up', mergeState: 'needs-review',
    })
    const row = mkRow({
      decision: 'pr_failed', prUrl: PR_URL, worktreeIds: ['dismiss-needs-review'], isContinuation: true,
    })
    transitionDecision(db, row.id, 'pr_failed', 'pr_failed', {
      implementationOutcome: 'partially_succeeded', deliveryOutcome: 'partial',
      statusCode: 'branch_verification_failed',
    })
    const { git, calls } = fakeGit()

    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action: 'dismiss', expectedDecision: 'pr_failed',
    })

    expect(result.status).toBe(200)
    expect(result.body.cleanupWarnings).toEqual([
      expect.stringContaining('/wt/recoverable-follow-up'),
    ])
    expect(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove')).toBe(false)
    expect(getRailWorktree(db, 'dismiss-needs-review')?.merge_state).toBe('needs-review')
    expect(getPrDelivery(db, row.id)).toMatchObject({
      decision: 'discarded', status_code: 'cleanup_incomplete',
    })
  })

  it('persists bounded cleanup warnings when PR, worktree, and branch cleanup are incomplete', async () => {
    createRailWorktree(db, {
      id: 'warning-wt', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/warning', mergeState: 'built',
    })
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, worktreeIds: ['warning-wt'] })
    const { exec } = fakeExec({ close: { code: 1, stdout: '', stderr: 'permission denied' } })
    const { git } = fakeGit({
      failOn: (args) => (args[0] === 'worktree' && args[1] === 'remove') || (args[0] === 'branch' && args[1] === '-D'),
    })

    const result = await executePrDecision(mkDeps({ exec, git }).deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_draft',
    })

    expect(result.status).toBe(200)
    const warnings = JSON.parse(getPrDelivery(db, row.id)!.cleanup_warnings) as string[]
    expect(warnings.some((warning) => warning.includes('PR close'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('worktree /wt/warning'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('branch feat/1-t1'))).toBe(true)
    expect(warnings.length).toBeLessThanOrEqual(8)
    expect(getPrDelivery(db, row.id)?.status_code).toBe('cleanup_incomplete')
  })

  it('preserves legacy branches with unknown ownership and reports cleanup as incomplete', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, ticketIds: [1] })
    const legacyBranches = branchRecords([1]).map(({ branchOwnership: _ownership, ...branch }) => branch)
    db.prepare(`UPDATE rail_pr_deliveries SET branches = ? WHERE id = ?`)
      .run(JSON.stringify(legacyBranches), row.id)
    const { git, calls } = fakeGit()

    const result = await executePrDecision(mkDeps({ git }).deps, {
      prDeliveryId: row.id, action: 'discard', expectedDecision: 'pr_ready',
    })

    expect(result).toMatchObject({
      status: 200,
      body: {
        decision: 'discarded',
        cleanupWarnings: [expect.stringContaining('ownership was not recorded')],
      },
    })
    expect(calls.some((call) => call.args[0] === 'branch' && call.args[1] === '-D')).toBe(false)
    expect(getPrDelivery(db, row.id)).toMatchObject({
      status_code: 'cleanup_incomplete',
    })
  })

  it('revalidates process admission after a queued local merge acquires the repository lock', async () => {
    const row = mkRow({ decision: 'on_review', ticketIds: [1] })
    let releaseHolder!: () => void
    let holderEntered!: () => void
    const entered = new Promise<void>((resolve) => { holderEntered = resolve })
    const blocked = new Promise<void>((resolve) => { releaseHolder = resolve })
    const holder = withRepoLock(PROJECT.path, async () => {
      holderEntered()
      await blocked
    })
    await entered
    const admissionClosed = new Error('project recovery started while merge was queued')
    const { git, calls } = fakeGit()

    const guarded = executePrDecision({
      ...mkDeps({ git }).deps,
      assertAdmission: () => { throw admissionClosed },
    }, {
      prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review',
    })
    // executePrDecision has synchronously claimed its operation and queued
    // behind the holder. Closing admission now must win before any Git read.
    const current = getPrDelivery(db, row.id)
    expect(current?.operation).toBe('merge-local')
    releaseHolder()
    await holder

    await expect(guarded).rejects.toBe(admissionClosed)
    expect(calls).toEqual([])
    expect(getPrDelivery(db, row.id)?.operation_token).toBeNull()
  })

  it('merged partial delivery cleans only included units and preserves blocked recovery evidence', async () => {
    createRailWorktree(db, {
      id: 'ready-wt', railIndex: 0, ticketId: 1, branch: 'feat/1-t1',
      worktreePath: '/wt/ready', mergeState: 'built',
    })
    createRailWorktree(db, {
      id: 'blocked-wt', railIndex: 0, ticketId: 2, branch: 'feat/2-t2',
      worktreePath: '/wt/blocked', mergeState: 'needs-review',
    })
    const row = mkRow({
      decision: 'pr_ready', prUrl: PR_URL, worktreeIds: ['ready-wt', 'blocked-wt'],
      deliverySha: '1'.repeat(40),
      branches: [
        { ticketId: 1, branch: 'feat/1-t1', succeeded: true, deliveryOutcome: 'ready' },
        { ticketId: 2, branch: 'feat/2-t2', succeeded: false, deliveryOutcome: 'blocked' },
      ],
    })
    const { exec } = fakeExec({
      view: { code: 0, stdout: lifecycleJson({ state: 'MERGED', sha: row.delivery_sha }), stderr: '' },
    })
    const { git, calls } = fakeGit()

    const result = await executePrDecision(mkDeps({ exec, git }).deps, {
      prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready',
    })

    expect(result.status).toBe(200)
    expect(calls).toContainEqual({ args: ['worktree', 'remove', '/wt/ready'], cwd: '/repo' })
    expect(calls.some((call) => call.args.includes('/wt/blocked'))).toBe(false)
    expect(calls.some((call) => call.args[0] === 'branch' && call.args[2] === 'feat/2-t2')).toBe(false)
    expect(getRailWorktree(db, 'ready-wt')?.merge_state).toBe('merged')
    expect(getRailWorktree(db, 'blocked-wt')?.merge_state).toBe('needs-review')
  })

  it('assembles in a detached worktree so a second-branch conflict leaves the user checkout byte-identical', async () => {
    const repo = path.join(tmpDir, 'atomic-repo')
    const assemblyRoot = path.join(tmpDir, 'assembly')
    fs.mkdirSync(repo)
    fs.mkdirSync(assemblyRoot)
    const git = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git(['init', '-b', 'main'])
    git(['config', 'user.name', 'Specrails Test'])
    git(['config', 'user.email', 'specrails@example.test'])
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n')
    git(['add', 'shared.txt'])
    git(['commit', '-m', 'base'])
    git(['checkout', '-b', 'feat/1-t1'])
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'first\n')
    git(['commit', '-am', 'first'])
    const firstSha = git(['rev-parse', 'HEAD'])
    git(['checkout', 'main'])
    git(['checkout', '-b', 'feat/2-t2'])
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'second\n')
    git(['commit', '-am', 'second'])
    const secondSha = git(['rev-parse', 'HEAD'])
    git(['checkout', 'main'])
    const beforeSha = git(['rev-parse', 'HEAD'])
    const beforeStatus = git(['status', '--porcelain'])

    const realGit: GitRunner = {
      async run(args, cwd) {
        try {
          return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8' }), stderr: '' }
        } catch (err) {
          const failure = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
          return {
            code: failure.status ?? 1,
            stdout: failure.stdout?.toString() ?? '',
            stderr: failure.stderr?.toString() ?? '',
          }
        }
      },
    }
    const row = mkRow({
      decision: 'on_review',
      branches: [
        { ticketId: 1, branch: 'feat/1-t1', succeeded: true, finalSha: firstSha },
        { ticketId: 2, branch: 'feat/2-t2', succeeded: true, finalSha: secondSha },
      ],
    })
    const { deps } = mkDeps({
      git: realGit,
      project: { id: PROJECT.id, slug: 'atomic-local-integration', path: repo },
      assemblyRoot,
    })

    const result = await executePrDecision(deps, {
      prDeliveryId: row.id, action: 'merge-local', expectedDecision: 'on_review',
    })

    expect(result).toMatchObject({ status: 502, body: { error: 'merge_failed' } })
    expect(git(['rev-parse', 'HEAD'])).toBe(beforeSha)
    expect(git(['status', '--porcelain'])).toBe(beforeStatus)
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(getPrDelivery(db, row.id)?.decision).toBe('on_review')
  })
})
