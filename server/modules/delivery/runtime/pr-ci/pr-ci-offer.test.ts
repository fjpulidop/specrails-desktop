import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../../db'
import { createPrDelivery } from '../rail-pr-store'
import { dismissPrCiOffer, prCiOfferEligible, prCiOfferKey, prCiTerminalState, projectPrCiOffer, type PrCiOfferHost } from './pr-ci-offer'
import { PR_CI_LOOP_ID } from './pr-ci-target'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

function host() {
  const rows = new Map<string, Record<string, unknown>>()
  const writes: Array<Record<string, unknown>> = []
  const value: PrCiOfferHost = {
    upsertSystemRow: (conversationId, row, key) => { const next = { ...row, dedupeKey: key }; rows.set(conversationId + '|' + key, next); writes.push(next); return 'm1' },
    getSystemRow: (conversationId, key) => rows.get(conversationId + '|' + key) ?? null,
  }
  return { value, rows, writes }
}
function delivery(over: Record<string, unknown> = {}, input: Partial<Parameters<typeof createPrDelivery>[1]> = {}) {
  const row = createPrDelivery(db, { railIndex: 0, railKey: 'r0', ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent-chat', originConversationId: 'conv-1', loopId: 'factory:implement', ...input })
  const set = { decision: 'pr_draft', pr_url: 'https://github.com/acme/app/pull/7', pr_number: 7, branch: 'feature', pr_state: 'pr-created', ...over }
  db.prepare(`UPDATE rail_pr_deliveries SET ${Object.keys(set).map(key => `${key} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), row.id)
  return row.id
}
const event = (runId: string, seq: number, task: string, outcome: string) => db.prepare("INSERT INTO events (job_id, seq, event_type, source, payload) VALUES (?, ?, 'host_task_finished', 'stdout', ?)").run(runId, seq, JSON.stringify({ task, outcome }))

describe('PR CI offer', () => {
  it('offers once per generation, only with the capability and only for an attached PR', () => {
    const h = host(), id = delivery()
    projectPrCiOffer(db, 'p1', h.value, id, { capable: false })
    expect(h.writes).toEqual([])
    projectPrCiOffer(db, 'p1', h.value, id, { capable: true, now: () => 0 })
    projectPrCiOffer(db, 'p1', h.value, id, { capable: true, now: () => 1 })
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]).toMatchObject({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: id, prNumber: 7, railIndex: 0, state: 'offered', dedupeKey: prCiOfferKey(id) })
    const building = delivery({ decision: 'building', pr_url: null }, { railIndex: 1, railKey: 'r1' })
    projectPrCiOffer(db, 'p1', h.value, building, { capable: true })
    expect(h.writes).toHaveLength(1)
  })

  it('never offers to a CI loop generation, a multi-repo delivery or a delivery without a mission', () => {
    expect(prCiOfferEligible({ decision: 'pr_draft', pr_url: 'u', branch: 'b', origin_conversation_id: 'c', loop_id: PR_CI_LOOP_ID, execution_manifest: null })).toBe(false)
    expect(prCiOfferEligible({ decision: 'pr_draft', pr_url: 'u', branch: 'b', origin_conversation_id: 'c', loop_id: 'factory:implement', execution_manifest: '{}' })).toBe(false)
    expect(prCiOfferEligible({ decision: 'pr_ready', pr_url: 'u', branch: 'b', origin_conversation_id: null, loop_id: 'factory:implement', execution_manifest: null })).toBe(false)
  })

  it('persists "Not now" for that generation only', () => {
    const h = host(), id = delivery()
    expect(dismissPrCiOffer(db, h.value, id)).toBe(false)
    projectPrCiOffer(db, 'p1', h.value, id, { capable: true })
    expect(dismissPrCiOffer(db, h.value, id)).toBe(true)
    expect(h.value.getSystemRow('conv-1', prCiOfferKey(id))).toMatchObject({ state: 'dismissed' })
    projectPrCiOffer(db, 'p1', h.value, id, { capable: true })
    expect(h.value.getSystemRow('conv-1', prCiOfferKey(id))).toMatchObject({ state: 'dismissed' })
    expect(dismissPrCiOffer(db, h.value, id)).toBe(false)
  })

  it('follows the CI loop generation: started, then its terminal state on the offered row', () => {
    const h = host(), offered = delivery()
    projectPrCiOffer(db, 'p1', h.value, offered, { capable: true })
    db.prepare("UPDATE rail_pr_deliveries SET decision = 'superseded' WHERE id = ?").run(offered)
    const loop = delivery({ decision: 'building', run_ids: JSON.stringify(['run-ci']) }, { loopId: PR_CI_LOOP_ID, supersedesDeliveryId: offered, isContinuation: true })
    projectPrCiOffer(db, 'p1', h.value, loop, { capable: true })
    expect(h.value.getSystemRow('conv-1', prCiOfferKey(offered))).toMatchObject({ state: 'started', runId: 'run-ci', runDeliveryId: loop })
    db.prepare("INSERT INTO jobs (id, command, started_at, status) VALUES ('run-ci', 'loop', '2026-11-10T00:00:00Z', 'running')").run()
    event('run-ci', 1, 'pr.checks', 'red'); event('run-ci', 2, 'pr.sync', 'pushed'); event('run-ci', 3, 'pr.checks', 'green')
    db.prepare("UPDATE rail_pr_deliveries SET decision = 'pr_draft', implementation_outcome = 'succeeded' WHERE id = ?").run(loop)
    projectPrCiOffer(db, 'p1', h.value, loop, { capable: true })
    expect(h.value.getSystemRow('conv-1', prCiOfferKey(offered))).toMatchObject({ state: 'green', pushes: 1, rounds: 1 })
    // The CI loop generation itself is never offered again.
    expect(h.value.getSystemRow('conv-1', prCiOfferKey(loop))).toBeNull()
  })

  it('maps no checks and failures to plain terminal states', () => {
    expect(prCiTerminalState({ decision: 'pr_draft', implementation_outcome: 'succeeded', status_detail: null }, [{ task: 'pr.checks', outcome: 'none' }])).toMatchObject({ state: 'no-ci' })
    expect(prCiTerminalState({ decision: 'pr_failed', implementation_outcome: 'failed', status_detail: 'The checks still fail after 5 fix round(s).' }, [{ task: 'pr.checks', outcome: 'red' }]))
      .toEqual({ state: 'needs-attention', reason: 'The checks still fail after 5 fix round(s).', pushes: 0, rounds: 1 })
    expect(prCiTerminalState({ decision: 'pr_failed', implementation_outcome: 'failed', status_detail: null }, [])).toMatchObject({ state: 'needs-attention', reason: expect.stringContaining('stopped') })
  })
})
