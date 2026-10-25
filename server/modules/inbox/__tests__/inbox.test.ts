import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { initDb, type DbInstance } from '../../../db'
import { createPrDelivery, transitionDecision } from '../../delivery/runtime/rail-pr-store'
import { createLoopRun, finishLoopRun, pauseLoopRun } from '../../loops/runtime/loop-runs-store'
import { enqueueOutbox, markOutboxDead } from '../../../jira/jira-db'
import { collectInbox } from '../application'
import { compareInboxItems, inboxItemId, oneLine, toIso, type InboxItem } from '../domain'
import { deriveFailureDiagnosis, serializeDiagnosis } from '../../recovery'
import { createProjectInboxSource } from '../adapters/project-source'
import { registerInboxRoutes } from '../adapters/http'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const source = (handle: { id: string; name: string; db: DbInstance }) =>
  createProjectInboxSource({ project: { id: handle.id, name: handle.name }, db: handle.db }, () => NOW)

function delivery(id: string, rail: number, decision: Parameters<typeof transitionDecision>[3], patch: Parameters<typeof transitionDecision>[4] = {}, conv: string | null = 'conv-1') {
  createPrDelivery(db, { id, railIndex: rail, loopId: 'loop-1', railKey: `${rail}-loop-1`, ticketIds: [rail + 1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent', originConversationId: conv })
  if (decision !== 'building') expect(transitionDecision(db, id, 'building', decision, patch)).toBe(true)
}

function run(id: string, rail: number, startedAt = iso(-3_600_000)) {
  createLoopRun(db, { id, projectId: 'p1', loopId: 'loop-a', loopName: 'Implement', railIndex: rail, ticketIds: [7], iterationLimit: 3, startedAt })
}

describe('inbox projection: deliveries', () => {
  it('lists review-ready deliveries with the origin mission and ignores building/closed ones', () => {
    delivery('d-review', 0, 'on_review')
    delivery('d-draft', 1, 'pr_draft')
    delivery('d-building', 2, 'building')
    delivery('d-nochanges', 3, 'no_changes')
    const items = source({ id: 'p1', name: 'Alpha', db }).collect()
    expect(items.map((i) => i.subjectId).sort()).toEqual(['d-draft', 'd-review'])
    const review = items.find((i) => i.subjectId === 'd-review')!
    expect(review).toMatchObject({ kind: 'review', action: 'open-review', projectId: 'p1', projectName: 'Alpha', conversationId: 'conv-1', id: 'p1:review:d-review' })
    expect(review.version).toMatch(/^on_review:.*:none$/)
  })

  it('treats a failed delivery as failed, but review_changes_requested as a decision', () => {
    delivery('d-fail', 0, 'implementation_failed', { statusCode: 'implementation_failed', statusDetail: 'Tests\nfailed   in Reviewer' })
    delivery('d-chg', 1, 'implementation_failed', { statusCode: 'review_changes_requested' })
    delivery('d-prfail', 2, 'pr_failed')
    const byId = Object.fromEntries(source({ id: 'p1', name: 'Alpha', db }).collect().map((i) => [i.subjectId, i]))
    expect(byId['d-fail']).toMatchObject({ kind: 'failed', detail: 'Tests failed in Reviewer' })
    expect(byId['d-chg'].kind).toBe('review')
    expect(byId['d-prfail'].kind).toBe('failed')
  })

  it('changes version when the delivery state changes (Done re-arms)', () => {
    delivery('d1', 0, 'on_review')
    const before = source({ id: 'p1', name: 'Alpha', db }).collect()[0].version
    transitionDecision(db, 'd1', 'on_review', 'pr_draft')
    expect(source({ id: 'p1', name: 'Alpha', db }).collect()[0].version).not.toBe(before)
  })
})

describe('inbox projection: runs', () => {
  it('maps paused runs by pause kind', () => {
    run('r-budget', 0); pauseLoopRun(db, 'r-budget', undefined, 'budget_paused')
    run('r-human', 1); pauseLoopRun(db, 'r-human')
    run('r-restart', 2); db.prepare("UPDATE loop_runs SET status='paused', restart_reason='restart' WHERE id='r-restart'").run()
    run('r-fork', 3); db.prepare("UPDATE loop_runs SET status='paused', restart_reason='fork' WHERE id='r-fork'").run()
    const byId = Object.fromEntries(source({ id: 'p1', name: 'Alpha', db }).collect().map((i) => [i.subjectId, i]))
    expect(byId['r-budget']).toMatchObject({ kind: 'budget', action: 'resume-run' })
    expect(byId['r-human']).toMatchObject({ kind: 'question', action: 'open-run' })
    expect(byId['r-restart']).toMatchObject({ kind: 'blocked', action: 'resume-run' })
    expect(byId['r-fork']).toBeUndefined()
  })

  it('lists recent failed/blocked runs, drops old ones, successes and superseded ones', () => {
    run('r-failed', 0); finishLoopRun(db, 'r-failed', { outcome: 'failed', finishedAt: iso(-60_000) })
    run('r-blocked', 1); finishLoopRun(db, 'r-blocked', { outcome: 'blocked', finishedAt: iso(-60_000) })
    run('r-old', 2, iso(-10 * 86_400_000)); finishLoopRun(db, 'r-old', { outcome: 'failed', finishedAt: iso(-9 * 86_400_000) })
    run('r-ok', 3); finishLoopRun(db, 'r-ok', { outcome: 'success', finishedAt: iso(-60_000) })
    run('r-superseded', 4, iso(-7_200_000)); finishLoopRun(db, 'r-superseded', { outcome: 'stalled', finishedAt: iso(-7_000_000) })
    run('r-retry', 4, iso(-3_600_000)); finishLoopRun(db, 'r-retry', { outcome: 'success', finishedAt: iso(-3_000_000) })
    const byId = Object.fromEntries(source({ id: 'p1', name: 'Alpha', db }).collect().map((i) => [i.subjectId, i]))
    expect(Object.keys(byId).sort()).toEqual(['r-blocked', 'r-failed'])
    expect(byId['r-failed']).toMatchObject({ kind: 'failed', title: 'Implement · #7', action: 'open-run' })
    expect(byId['r-blocked'].kind).toBe('blocked')
  })

  it('leaves runs a delivery already represents to the delivery', () => {
    run('r-del', 0); finishLoopRun(db, 'r-del', { outcome: 'failed', finishedAt: iso(-60_000) })
    delivery('d1', 0, 'implementation_failed', { runIds: ['r-del'], statusCode: 'implementation_failed' })
    const items = source({ id: 'p1', name: 'Alpha', db }).collect()
    expect(items.map((i) => i.subjectId)).toEqual(['d1'])
  })
})

describe('inbox projection: failure diagnosis', () => {
  const diagnose = (input: Parameters<typeof deriveFailureDiagnosis>[0]) => serializeDiagnosis(deriveFailureDiagnosis(input))

  it('labels a provider-limit run as blocked, with its reset hint and ranked remedies', () => {
    run('r-limit', 0)
    finishLoopRun(db, 'r-limit', { outcome: 'failed', finishedAt: iso(-60_000), failureDiagnosis: diagnose({ outcome: 'stalled', stallReason: 'provider_limit', providerLimit: { kind: 'session_limit', message: "You've hit your session limit", resetsAt: '3am (Europe/Madrid)' } }) })
    const [item] = source({ id: 'p1', name: 'Alpha', db }).collect()
    expect(item).toMatchObject({ kind: 'blocked', detail: "You've hit your session limit", diagnosis: { kind: 'provider_limit', confidence: 'high', resetAt: '3am (Europe/Madrid)', remedies: ['resume', 'retry', 'open-logs'] } })
    expect(item.version).toContain('provider_limit')
  })

  it('labels an environment blocker as blocked and keeps a plain failure as failed', () => {
    run('r-env', 0); finishLoopRun(db, 'r-env', { outcome: 'failed', finishedAt: iso(-60_000), failureDiagnosis: diagnose({ outcome: 'failed', errorText: 'Verification cannot run in this environment: the registry rejected the credentials' }) })
    run('r-tests', 1); finishLoopRun(db, 'r-tests', { outcome: 'failed', finishedAt: iso(-50_000), failureDiagnosis: diagnose({ outcome: 'failed', core: { kind: 'tests_failed', phase: 'fixer', rounds: 4, resumablePhase: 'fixer', confidence: 'high' } }) })
    const byId = Object.fromEntries(source({ id: 'p1', name: 'Alpha', db }).collect().map((i) => [i.subjectId, i]))
    expect(byId['r-env']).toMatchObject({ kind: 'blocked', diagnosis: { kind: 'environment', remedies: expect.arrayContaining(['fix-environment']) } })
    expect(byId['r-tests']).toMatchObject({ kind: 'failed', diagnosis: { kind: 'tests_failed', rounds: 4, remedies: ['resume', 'edit-spec', 'open-logs', 'retry'] } })
  })

  it('never claims a cause for a run finished before diagnosis existed', () => {
    run('r-old', 0); finishLoopRun(db, 'r-old', { outcome: 'failed', finishedAt: iso(-60_000) })
    const [item] = source({ id: 'p1', name: 'Alpha', db }).collect()
    expect(item).toMatchObject({ kind: 'failed', detail: 'failed', diagnosis: { kind: 'unknown', confidence: 'low', remedies: ['open-logs', 'retry'] } })
  })

  it('explains a failed delivery through its last run', () => {
    run('r-del', 0)
    finishLoopRun(db, 'r-del', { outcome: 'stalled', finishedAt: iso(-60_000), failureDiagnosis: diagnose({ outcome: 'stalled', stallReason: 'idle_timeout' }) })
    delivery('d1', 0, 'implementation_failed', { runIds: ['r-del'], statusCode: 'implementation_failed' })
    const [item] = source({ id: 'p1', name: 'Alpha', db }).collect()
    expect(item).toMatchObject({ subjectId: 'd1', kind: 'failed', diagnosis: { kind: 'tool_inactivity' } })
  })
})

describe('inbox projection: jira', () => {
  it('lists dead outbox ops and carries the retry subject', () => {
    const id = enqueueOutbox(db, { jiraIssueId: '10001', opType: 'transition', idempotencyKey: 'k1', payload: {} })
    enqueueOutbox(db, { jiraIssueId: '10002', opType: 'comment', idempotencyKey: 'k2', payload: {} })
    markOutboxDead(db, id, 'Transition not allowed')
    const items = source({ id: 'p1', name: 'Alpha', db }).collect()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'jira', action: 'retry-jira', subjectId: String(id), detail: 'Transition not allowed', title: '10001 · transition' })
  })
})

describe('collectInbox', () => {
  const item = (projectId: string, id: string, at: string): InboxItem => ({
    id: inboxItemId(projectId, 'review', id), projectId, projectName: projectId, kind: 'review', title: id, detail: null, at, version: 'v', action: 'open-review', subjectId: id, conversationId: null, diagnosis: null,
  })

  it('orders newest first across projects and counts per project', () => {
    const snap = collectInbox([
      { projectId: 'a', projectName: 'A', collect: () => [item('a', 'a1', iso(-1000)), item('a', 'a2', iso(-5000))] },
      { projectId: 'b', projectName: 'B', collect: () => [item('b', 'b1', iso(-3000))] },
    ], () => new Date(NOW))
    expect(snap.items.map((i) => i.subjectId)).toEqual(['a1', 'b1', 'a2'])
    expect(snap.projects).toEqual([{ projectId: 'a', projectName: 'A', count: 2 }, { projectId: 'b', projectName: 'B', count: 1 }])
    expect(snap.generatedAt).toBe(iso(0))
  })

  it('isolates a failing project and refuses items a source does not own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snap = collectInbox([
      { projectId: 'a', projectName: 'A', collect: () => { throw new Error('db locked') } },
      { projectId: 'b', projectName: 'B', collect: () => [item('b', 'b1', iso(0)), item('a', 'leak', iso(0))] },
    ])
    expect(snap.items.map((i) => i.subjectId)).toEqual(['b1'])
    expect(snap.projects.find((p) => p.projectId === 'a')?.count).toBe(0)
    warn.mockRestore()
  })

  it('keeps two projects separate: each source reads only its own database', () => {
    const dbB = initDb(':memory:')
    delivery('only-in-a', 0, 'on_review')
    createPrDelivery(dbB, { id: 'only-in-b', railIndex: 0, loopId: 'l', railKey: '0-l', ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent' })
    transitionDecision(dbB, 'only-in-b', 'building', 'on_review')
    const snap = collectInbox([source({ id: 'a', name: 'A', db }), source({ id: 'b', name: 'B', db: dbB })])
    expect(snap.items.map((i) => `${i.projectId}:${i.subjectId}`).sort()).toEqual(['a:only-in-a', 'b:only-in-b'])
  })
})

describe('domain helpers', () => {
  it('compares newest first with a stable tie-break', () => {
    const a = { id: 'a', at: iso(0) } as InboxItem, b = { id: 'b', at: iso(0) } as InboxItem
    expect([b, a].sort(compareInboxItems).map((i) => i.id)).toEqual(['a', 'b'])
  })
  it('normalises sqlite timestamps and bounds text', () => {
    expect(toIso('2026-10-24 12:00:00', 'x')).toBe('2026-10-24T12:00:00.000Z')
    expect(toIso('garbage', 'fallback')).toBe('fallback')
    expect(oneLine('  a\n b ')).toBe('a b')
    expect(oneLine('x'.repeat(300))!.length).toBe(140)
    expect(oneLine('   ')).toBeNull()
  })
})

describe('GET /inbox', () => {
  it('projects every registered project context', async () => {
    delivery('d1', 0, 'on_review')
    const router = express.Router()
    registerInboxRoutes(router, { listContexts: () => [{ project: { id: 'p1', name: 'Alpha' }, db }] } as never)
    const app = express(); app.use('/api', router)
    const server = app.listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const body = await (await fetch(`http://127.0.0.1:${port}/api/inbox`)).json() as { items: InboxItem[]; projects: unknown[] }
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({ projectId: 'p1', kind: 'review', subjectId: 'd1' })
      expect(body.projects).toEqual([{ projectId: 'p1', projectName: 'Alpha', count: 1 }])
    } finally { server.close() }
  })
})

describe('inbox projection: spend caps (CD5)', () => {
  const cap = (over: Partial<import('../../execution').CapStatus> = {}): import('../../execution').CapStatus =>
    ({ scope: 'project', period: 'week', budgetUsd: 20, spentUsd: 21, exhausted: true, resetsAt: '2026-10-26T00:00:00.000Z', ...over })
  const withCaps = (caps: import('../../execution').CapStatus[]) =>
    createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db, caps: () => caps }, () => NOW).collect()

  it('lists a reached cap with a Raise-cap action and leaves the unreached ones out', () => {
    const items = withCaps([cap(), cap({ period: 'month', spentUsd: 3, exhausted: false }), cap({ scope: 'desktop', period: 'day' })])
    expect(items.map((i) => i.id).sort()).toEqual(['p1:budget:cap-desktop-day', 'p1:budget:cap-project-week'])
    expect(items.find((i) => i.subjectId === 'project:week')).toMatchObject({
      kind: 'budget', action: 'raise-cap', projectId: 'p1', at: new Date(NOW).toISOString(),
      cap: { scope: 'project', period: 'week', budgetUsd: 20, spentUsd: 21, resetsAt: '2026-10-26T00:00:00.000Z' },
    })
  })

  it('re-arms a dismissal when the cap is raised or the period rolls over (version moves)', () => {
    const v = (c: import('../../execution').CapStatus) => withCaps([c])[0].version
    expect(v(cap({ budgetUsd: 25 }))).not.toBe(v(cap()))
    expect(v(cap({ resetsAt: '2026-11-02T00:00:00.000Z' }))).not.toBe(v(cap()))
  })

  it('shows nothing without caps and survives a failing cap reader', () => {
    expect(withCaps([])).toEqual([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db, caps: () => { throw new Error('boom') } }, () => NOW).collect()).toEqual([])
    warn.mockRestore()
  })
})
