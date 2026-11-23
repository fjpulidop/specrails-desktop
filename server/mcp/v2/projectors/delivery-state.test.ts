import { beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createPrDelivery, getPrDelivery, toPrDeliverySnapshot, transitionDecision, type PrDeliveryPatch } from '../../../modules/delivery/runtime/rail-pr-store'
import { actionAllowed, PR_DECISION_ACTIONS } from '../../../modules/delivery'
import type { PrDecision } from '../../../modules/delivery'
import { createCatalog } from '../core/registry'
import { buildDecisionState } from '../core/decision-state'
import { translator } from '../core/lang'
import { V2_TOOLS } from '../tools'
import { projectDeliveryState, type DeliveryStateFacts } from './delivery-state'

// The delivery projector against the real domain rules (decision-policy.ts,
// rail-delivery-revision.ts) and real rows from the delivery store.

const REF = 'delivery:shop-api/d1'
const SHA = 'a'.repeat(40)
const catalog = createCatalog(V2_TOOLS)
const env = { translate: translator('en'), policyFor: catalog.policyFor, confirmAboveUsd: 0.5 }

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

function row(decision: PrDecision, patch: PrDeliveryPatch = {}) {
  createPrDelivery(db, { id: 'd1', railIndex: 0, loopId: 'loop-1', railKey: '0-loop-1', ticketIds: [7], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard' })
  transitionDecision(db, 'd1', 'building', decision, {
    branch: 'feat/7', deliverySha: SHA, implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
    branches: [{ ticketId: 7, branch: 'feat/7', succeeded: true, finalSha: SHA, changed: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready' }],
    ...patch,
  })
  return toPrDeliverySnapshot(getPrDelivery(db, 'd1')!)
}

const facts = (snap: ReturnType<typeof row>, extra: Partial<DeliveryStateFacts> = {}): DeliveryStateFacts =>
  ({ snap, active: true, railTicketIds: [7], ci: null, mergePreview: null, accept: null, since: null, ...extra })

const ids = (input: ReturnType<typeof projectDeliveryState>) => input.offers.map((offer) => offer.id)

describe('projectDeliveryState', () => {
  it('offers exactly the PR decisions actionAllowed permits, plus review offers', () => {
    const snap = row('on_review')
    const input = projectDeliveryState(REF, facts(snap))
    const legal = PR_DECISION_ACTIONS.filter((action) => actionAllowed(action, {
      decision: snap.decision, delivery_outcome: snap.deliveryOutcome, implementation_outcome: snap.implementationOutcome,
      status_code: snap.statusCode, is_continuation: 0, pr_url: snap.prUrl, branch: snap.branch,
    })).map((action) => `decide.${action.replace(/-/g, '_')}`)
    expect(ids(input)).toEqual([...legal, 'decide.request_changes', 'decide.checkout'])
    expect(input.status).toBe('ready_for_review')
    expect(input.hold?.kind).toBe('pr_decision')
    // Every offer is a real v2 call (buildDecisionState throws otherwise).
    const state = buildDecisionState(input, env)
    expect(state.offers.find((offer) => offer.id === 'decide.merge_local')).toMatchObject({ irreversible: true, needsConfirm: true })
    expect(state.offers.find((offer) => offer.id === 'decide.request_changes')).toMatchObject({ needs: ['note'], tier: 'ai-spawn' })
  })

  it('recommends merge_local when the preview is clean and Accept integrates locally, create_pr when it opens a PR', () => {
    const snap = row('on_review')
    const clean = { status: 'clean' as const, conflictFileCount: 0, siblingConflictCount: 0, baseAdvancedBy: 0 }
    expect(projectDeliveryState(REF, facts(snap, { mergePreview: clean, accept: 'merge-local' })).recommended).toBe('decide.merge_local')
    expect(projectDeliveryState(REF, facts(snap, { mergePreview: clean, accept: 'create-pr' })).recommended).toBe('decide.create_pr')
    expect(projectDeliveryState(REF, facts(snap)).recommended).toBeNull()
  })

  it('offers and recommends refresh_on_base on a conflicting local review', () => {
    const snap = row('on_review')
    const input = projectDeliveryState(REF, facts(snap, { accept: 'merge-local', mergePreview: { status: 'conflicts', conflictFileCount: 2, siblingConflictCount: 0, baseAdvancedBy: 3 } }))
    expect(ids(input)).toContain('decide.refresh_on_base')
    expect(input.recommended).toBe('decide.refresh_on_base')
  })

  it('offers no revision or checkout for an older generation of the rail', () => {
    const input = projectDeliveryState(REF, facts(row('on_review'), { active: false }))
    expect(ids(input)).not.toContain('decide.request_changes')
    expect(ids(input)).not.toContain('decide.checkout')
  })

  it('offers no revision when the rail no longer carries the delivery tickets', () => {
    expect(ids(projectDeliveryState(REF, facts(row('on_review'), { railTicketIds: [7, 8] })))).not.toContain('decide.request_changes')
  })

  it('offers the CI fix only on an open PR with CI facts (ciFixAllowed)', () => {
    const snap = row('pr_draft', { prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created' })
    expect(ids(projectDeliveryState(REF, facts(snap)))).not.toContain('decide.ci_fix')
    const ci = { decision: 'pr_draft' as const, delivery_outcome: snap.deliveryOutcome, implementation_outcome: snap.implementationOutcome, status_code: null, is_continuation: 0, pr_url: snap.prUrl, branch: snap.branch, operation: null }
    const input = projectDeliveryState(REF, facts(snap, { ci }))
    expect(ids(input)).toEqual(expect.arrayContaining(['decide.publish', 'decide.poll_merge', 'decide.ci_fix']))
    expect(ids(input)).not.toContain('decide.merge_local')
  })

  it('offers nothing while a decision-side operation holds the row', () => {
    const input = projectDeliveryState(REF, facts(row('on_review', { operation: 'merge-local' })))
    expect(input.offers).toEqual([])
    expect(input.phase).toContain('merge-local')
  })

  it('maps terminal decisions and offers no decision', () => {
    const input = projectDeliveryState(REF, facts(row('merged')))
    expect(input.status).toBe('integrated')
    expect(input.offers).toEqual([])
    expect(input.hold).toBeNull()
  })

  it('projects the local-changes actions from the stash and restore states', () => {
    const snap = row('merged')
    const withStash = (state: string, restore?: Record<string, unknown>) => ({ ...snap, localStash: { sha: SHA, name: 's', branch: 'main', state, restoreBranch: null, conflictPaths: [], savedAt: '', updatedAt: '', ...(restore ? { restore } : {}) } }) as never
    expect(ids(projectDeliveryState(REF, facts(withStash('needs_attention'))))).toEqual(['decide.local_restore'])
    expect(ids(projectDeliveryState(REF, facts(withStash('needs_attention', { status: 'ready', branch: 'r', commitSha: SHA })))))
      .toEqual(['decide.local_restore', 'decide.local_bring_back', 'decide.local_discard_branch'])
    expect(ids(projectDeliveryState(REF, facts(withStash('restored'))))).toEqual([])
  })

  it('changes the version when the row changes (confirmations go stale)', () => {
    const before = buildDecisionState(projectDeliveryState(REF, facts(row('on_review'))), env).version
    transitionDecision(db, 'd1', 'on_review', 'on_review', { statusDetail: 'touched' })
    db.prepare("UPDATE rail_pr_deliveries SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 'd1'").run()
    const after = buildDecisionState(projectDeliveryState(REF, facts(toPrDeliverySnapshot(getPrDelivery(db, 'd1')!))), env).version
    expect(after).not.toBe(before)
    // Language never changes the version.
    const es = buildDecisionState(projectDeliveryState(REF, facts(toPrDeliverySnapshot(getPrDelivery(db, 'd1')!))), { ...env, translate: translator('es') }).version
    expect(es).toBe(after)
  })
})
