import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initDb, type DbInstance } from './db'
import { executePrDecision, isPrDecisionAction, type PrDecisionDeps } from './rail-pr-decision'
import {
  createPrDelivery, getPrDelivery, transitionDecision,
  type DeliverBranchRecord, type PrDecision, type PrDeliveryPatch,
} from './rail-pr-store'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import { insertLinkWithId } from './jira/jira-db'
import type { GitRunner } from './worktree-manager'
import type { Exec, ExecResult } from './pr-publisher'

// ─── Fakes (DI — no git/gh/net; commands recorded for assertions) ─────────────

const ok: ExecResult = { code: 0, stdout: '', stderr: '' }

function fakeGit(opts: { failOn?: (args: string[]) => boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const git: GitRunner = {
    async run(args, cwd) {
      calls.push({ args, cwd })
      if (opts.failOn?.(args)) return { code: 1, stdout: '', stderr: 'fatal: boom' }
      return ok
    },
  }
  return { git, calls }
}

type GhHandler = ExecResult | (() => ExecResult)

/** gh handlers keyed on the pr subcommand (create/ready/close/view) + git push. */
function fakeExec(handlers: Partial<Record<'create' | 'ready' | 'close' | 'view' | 'push', GhHandler>> = {}, opts: { throwOnGh?: boolean } = {}) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
  const resolve = (h: GhHandler | undefined): ExecResult => (typeof h === 'function' ? h() : h ?? ok)
  const exec: Exec = {
    async run(cmd, args, cwd) {
      calls.push({ cmd, args, cwd })
      if (cmd === 'git' && args[0] === 'push') return resolve(handlers.push)
      if (cmd === 'gh') {
        if (opts.throwOnGh) throw new Error('gh exploded')
        return resolve(handlers[args[1] as 'create' | 'ready' | 'close' | 'view'])
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
  ids.map((id) => ({ ticketId: id, branch: `feat/${id}-t${id}`, succeeded: true }))

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
}) {
  const ticketIds = input.ticketIds ?? [1, 2]
  const row = createPrDelivery(db, {
    railIndex: 0, loopId: 'factory:implement', railKey: RAIL_KEY,
    ticketIds, baseBranch: input.baseBranch ?? 'main', loopName: 'Implement',
    originSurface: input.originConversationId ? 'agent-chat' : 'dashboard',
    originConversationId: input.originConversationId ?? null,
  })
  if (input.decision === 'building') return getPrDelivery(db, row.id)!
  const settlePatch: PrDeliveryPatch = {
    branches: input.branches ?? branchRecords(ticketIds),
    worktreeIds: input.worktreeIds ?? [],
  }
  transitionDecision(db, row.id, 'building', 'on_review', settlePatch)
  if (input.decision === 'on_review') return getPrDelivery(db, row.id)!
  const draftPatch: PrDeliveryPatch = input.prUrl
    ? { branch: 'feat/1-t1', prUrl: input.prUrl, prNumber: 7, prState: input.prState ?? 'pr-created' }
    : { branch: 'feat/1-t1', prUrl: null, prNumber: null, prState: input.prState ?? 'pushed' }
  if (input.decision === 'pr_failed') {
    transitionDecision(db, row.id, 'on_review', 'pr_failed')
    return getPrDelivery(db, row.id)!
  }
  transitionDecision(db, row.id, 'on_review', 'pr_draft', draftPatch)
  if (input.decision === 'pr_draft') return getPrDelivery(db, row.id)!
  transitionDecision(db, row.id, 'pr_draft', input.decision)
  return getPrDelivery(db, row.id)!
}

function mkDeps(overrides: Partial<PrDecisionDeps> & { git?: GitRunner; exec?: Exec } = {}) {
  const broadcast = vi.fn()
  const jira = { onRailMerged: vi.fn(), onRailDiscard: vi.fn() }
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

// ─── Guards (404 / CAS / legality) ────────────────────────────────────────────

describe('executePrDecision guards', () => {
  it('isPrDecisionAction accepts the four actions and rejects everything else', () => {
    for (const a of ['create-pr', 'publish', 'discard', 'poll-merge']) expect(isPrDecisionAction(a)).toBe(true)
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
    ['discard', 'building'],
    ['poll-merge', 'on_review'],
    ['poll-merge', 'pr_failed'],
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

// ─── create-pr ────────────────────────────────────────────────────────────────

describe('create-pr', () => {
  it('delivered pr-created → pr_draft with branch/prUrl/prNumber/prState patched', async () => {
    const row = mkRow({ decision: 'on_review', branches: [{ ticketId: 1, branch: 'feat/1-t1', succeeded: true }] })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps, broadcast } = mkDeps({ exec })

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

  it('retry from pr_failed pre-deletes the stale batch branch, never the integration branch', async () => {
    const row = mkRow({ decision: 'pr_failed', branches: branchRecords([1, 2]) })
    const { git, calls } = fakeGit()
    const { exec } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_failed' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prUrl: PR_URL })
    // stale batch branch dropped BEFORE the batch worktree is re-created
    const delIdx = calls.findIndex((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === BATCH)
    const addIdx = calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add')
    expect(delIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeGreaterThan(delIdx)
    expect(calls[delIdx].cwd).toBe('/repo')
    // the integration branch is never deleted
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === 'main')).toBe(false)
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

// ─── create-pr — wedged-row recovery (the live #37 local-only failure) ─────────
//
// Reproduces the observed production wedge: a prior auto-discarded run left its
// worktree MOUNTED on the legacy `sr/<slug>/ticket-<id>` branch; the next run
// silently reused that checkout, so its commits landed on the sr/ branch while
// the delivery row recorded the conventional `feat/…` name that was NEVER
// created. create-pr pushed a non-existent ref → degraded to local-only, and
// every retry could only repeat it. The pre-flight must recover the REAL branch
// from the ticket's worktree ledger — or fail honestly.

describe('create-pr — wedged-row branch recovery', () => {
  const RECORDED = 'feat/1-add-guess-the-number-mini-game'
  const REAL = 'sr/s1/ticket-1'

  /** Git fake with per-ref existence + ahead-count control (everything else ok). */
  function recoveryGit(opts: { missing: string[]; ahead?: Record<string, string> }) {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        calls.push({ args, cwd })
        if (args[0] === 'rev-parse' && args.includes('--verify')) {
          const ref = args[args.length - 1].replace('refs/heads/', '')
          return opts.missing.includes(ref) ? { code: 1, stdout: '', stderr: '' } : ok
        }
        if (args[0] === 'rev-list' && args[1] === '--count') {
          return { code: 0, stdout: `${opts.ahead?.[args[2]] ?? '0'}\n`, stderr: '' }
        }
        return ok
      },
    }
    return { git, calls }
  }

  /** The user's exact wedged row: pr_draft, local-only, no PR, drifted branch record. */
  function wedgedRow() {
    return mkRow({
      decision: 'pr_draft', prUrl: null, prState: 'local-only', ticketIds: [1],
      branches: [{ ticketId: 1, branch: RECORDED, succeeded: true }],
    })
  }

  function mkLedgerRows() {
    // The drifted record's own ledger row (same missing branch — must be skipped)…
    createRailWorktree(db, {
      id: 'new-l', railIndex: 0, ticketId: 1, branch: RECORDED,
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    // …and the EARLIER auto-discarded run's row whose branch really carries the commits.
    createRailWorktree(db, {
      id: 'old-l', railIndex: 0, ticketId: 1, branch: REAL,
      worktreePath: '/wt/ticket-1', mergeState: 'failed',
    })
  }

  it('HEALING: retry recovers the REAL ledger branch, pushes IT, and persists the corrected record', async () => {
    mkLedgerRows()
    const row = wedgedRow()
    const { git } = recoveryGit({ missing: [RECORDED], ahead: { [`main..${REAL}`]: '3' } })
    const { exec, calls: execCalls } = fakeExec({ create: { code: 0, stdout: `${PR_URL}\n`, stderr: '' } })
    const { deps, broadcast } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, decision: 'pr_draft', prUrl: PR_URL, prState: 'pr-created' })
    // The push targeted the branch that actually holds the commits.
    expect(execCalls).toContainEqual({ cmd: 'git', args: ['push', '-u', 'origin', REAL], cwd: '/repo' })
    const create = execCalls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')!
    expect(create.args[create.args.indexOf('--head') + 1]).toBe(REAL)
    // Row heals: delivered head + corrected unit record persisted.
    const after = getPrDelivery(db, row.id)!
    expect(after).toMatchObject({ decision: 'pr_draft', branch: REAL, pr_url: PR_URL, pr_state: 'pr-created' })
    expect(JSON.parse(after.branches)).toEqual([{ ticketId: 1, branch: REAL, succeeded: true }])
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_draft', branch: REAL, prUrl: PR_URL })
  })

  it('HONEST FAILURE: recorded branch missing and no recoverable ledger branch → pr_failed with a truthful detail', async () => {
    // Only the drifted record's own ledger row exists — nothing to recover from.
    createRailWorktree(db, {
      id: 'new-l', railIndex: 0, ticketId: 1, branch: RECORDED,
      worktreePath: '/wt/ticket-1', mergeState: 'built',
    })
    const row = wedgedRow()
    const { git } = recoveryGit({ missing: [RECORDED] })
    const { exec, calls: execCalls } = fakeExec()
    const { deps, broadcast } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, decision: 'pr_failed' })
    expect((r.body.detail as string)).toContain(RECORDED)
    expect((r.body.detail as string)).toContain('no longer exists')
    // Never pushed a ref it knew to be missing.
    expect(execCalls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false)
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_failed')
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_failed' })
  })

  it('a ledger candidate with NO commits ahead of base is not a recovery target (empty PR would be dishonest)', async () => {
    mkLedgerRows()
    const row = wedgedRow()
    const { git } = recoveryGit({ missing: [RECORDED], ahead: { [`main..${REAL}`]: '0' } })
    const { deps } = mkDeps({ git })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_failed' })
  })

  it('recovery still persists the corrected record when the delivery then degrades (retry works from reality)', async () => {
    mkLedgerRows()
    const row = wedgedRow()
    const { git } = recoveryGit({ missing: [RECORDED], ahead: { [`main..${REAL}`]: '2' } })
    const { exec } = fakeExec({ push: { code: 1, stdout: '', stderr: 'network unreachable' } })
    const { deps } = mkDeps({ git, exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'create-pr', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ decision: 'pr_draft', prState: 'local-only', detail: 'network unreachable' })
    expect(JSON.parse(getPrDelivery(db, row.id)!.branches)).toEqual([{ ticketId: 1, branch: REAL, succeeded: true }])
  })
})

// ─── publish ──────────────────────────────────────────────────────────────────

describe('publish', () => {
  it('gh pr ready → pr_ready + broadcast', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    const { exec, calls } = fakeExec()
    const { deps, broadcast } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'pr_ready', prUrl: PR_URL })
    expect(calls).toContainEqual({ cmd: 'gh', args: ['pr', 'ready', PR_URL], cwd: '/repo' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'pr_ready' })
  })

  it('gh failure → 502 gh_failed with NO transition and NO broadcast', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    const { exec } = fakeExec({ ready: { code: 1, stdout: '', stderr: 'gh: not authenticated' } })
    const { deps, broadcast } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'gh_failed', detail: 'gh: not authenticated' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_draft')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('409 stale_decision when a concurrent mutation races the CAS transition', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    // The other surface discards the delivery WHILE our gh call is in flight:
    // the pre-check passed, but the CAS UPDATE must lose.
    const { exec } = fakeExec({
      ready: () => {
        transitionDecision(db, row.id, 'pr_draft', 'discarded')
        return ok
      },
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
  function mkLedger(id: string, ticketId: number, state: 'built' | 'failed' = 'built') {
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
    // gh pr close --delete-branch
    expect(execCalls).toContainEqual({ cmd: 'gh', args: ['pr', 'close', PR_URL, '--delete-branch'], cwd: '/repo' })
    // worktrees removed (reconcile-style) + ledger rows closed
    expect(calls).toContainEqual({ args: ['worktree', 'remove', '--force', '/wt/ticket-1'], cwd: '/repo' })
    expect(calls).toContainEqual({ args: ['worktree', 'remove', '--force', '/wt/ticket-2'], cwd: '/repo' })
    expect(getRailWorktree(db, 'w1')?.merge_state).toBe('failed')
    expect(getRailWorktree(db, 'w2')?.merge_state).toBe('failed')
    // per-unit branches + the batch branch -D'd; integration branch untouched
    const deleted = calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D').map((c) => c.args[2])
    expect(deleted).toContain('feat/1-t1')
    expect(deleted).toContain('feat/2-t2')
    expect(deleted).toContain(BATCH)
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
})

// ─── poll-merge ───────────────────────────────────────────────────────────────

describe('poll-merge', () => {
  it('MERGED → merged, tickets on_review→done, jira notified with the PR url', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL, ticketIds: [1, 2, 3] })
    const { exec, calls } = fakeExec({ view: { code: 0, stdout: '{"state":"MERGED","mergedAt":"2026-07-03T00:00:00Z"}', stderr: '' } })
    const { deps, broadcast, jira } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'merged', merged: true, prUrl: PR_URL })
    expect(calls).toContainEqual({ cmd: 'gh', args: ['pr', 'view', PR_URL, '--json', 'state,mergedAt'], cwd: '/repo' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('merged')
    const statuses = readTicketStatuses(ticketFile)
    expect(statuses['1']).toBe('done')
    expect(statuses['2']).toBe('done')
    expect(statuses['3']).toBe('done') // already done — untouched, not double-reported
    expect(ticketBroadcasts(broadcast).map((m) => m.ticket!.id).sort()).toEqual([1, 2])
    expect(jira.onRailMerged).toHaveBeenCalledWith([1, 2], row.id, PR_URL)
    expect(prStateBroadcasts(broadcast)[0]).toMatchObject({ decision: 'merged' })
  })

  it('not merged → 200 merged:false, decision unchanged, nothing broadcast', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    const { exec } = fakeExec({ view: { code: 0, stdout: '{"state":"OPEN","mergedAt":null}', stderr: '' } })
    const { deps, broadcast, jira } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_draft' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, decision: 'pr_draft', merged: false })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_draft')
    expect(broadcast).not.toHaveBeenCalled()
    expect(jira.onRailMerged).not.toHaveBeenCalled()
    expect(readTicketStatuses(ticketFile)['1']).toBe('on_review')
  })

  it('gh failure → 502 gh_failed, no transition', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL })
    const { exec } = fakeExec({ view: { code: 1, stdout: '', stderr: 'no such pr' } })
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'gh_failed', detail: 'no such pr' })
    expect(getPrDelivery(db, row.id)?.decision).toBe('pr_ready')
  })

  it('unparseable gh output → 502 gh_failed, no transition', async () => {
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL })
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
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, originConversationId: 'conv-42' })
    const { deps, card } = mkDeps()

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(card).toHaveBeenCalledTimes(1)
    expect(card).toHaveBeenCalledWith('conv-42', expect.objectContaining({
      kind: 'pr_decision', prDeliveryId: row.id, railIndex: 0, projectId: 'p1',
      baseBranch: 'main', ticketIds: [1, 2], decision: 'pr_ready', prUrl: PR_URL, prState: 'pr-created',
    }))
  })

  it('skips the card for dashboard-originated rows (origin null)', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL })
    const { deps, card } = mkDeps()

    await executePrDecision(deps, { prDeliveryId: row.id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(card).not.toHaveBeenCalled()
  })

  it('a null agent-chat registry (tests / disabled builds) is tolerated', async () => {
    const row = mkRow({ decision: 'pr_draft', prUrl: PR_URL, originConversationId: 'conv-42' })
    const { deps } = mkDeps({ agentChat: () => null })

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
    const row = mkRow({ decision: 'pr_ready', prUrl: PR_URL })
    const { exec } = fakeExec({ view: { code: 0, stdout: '{"state":"MERGED"}', stderr: '' } })
    fs.writeFileSync(ticketFile, 'not json at all')
    const { deps } = mkDeps({ exec })

    const r = await executePrDecision(deps, { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: 'pr_ready' })

    expect(r.status).toBe(200)
    expect(getPrDelivery(db, row.id)?.decision).toBe('merged')
  })
})
