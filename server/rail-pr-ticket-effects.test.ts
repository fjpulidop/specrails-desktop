import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { enqueueOutbox } from './jira/jira-db'
import { claimPrDeliveryOperation, createPrDelivery, getPrDelivery } from './rail-pr-store'
import { claimTicketOutcomeOwners } from './rails-store'
import {
  applyRailPrTicketEffect,
  replayPendingRailPrTicketEffects,
  replayRailPrTicketEffectsUntilSettled,
  transitionClaimedDecisionWithTicketEffect,
} from './rail-pr-ticket-effects'

let db: DbInstance
let dir: string
let ticketFile: string

function writeTickets(status = 'on_review'): void {
  writeTicketStatuses({ 1: status })
}

function writeTicketStatuses(statuses: Record<number, string>): void {
  const tickets = Object.fromEntries(Object.entries(statuses).map(([rawId, status]) => {
    const id = Number(rawId)
    return [rawId, {
      id, title: `T${id}`, description: '', status, priority: 'medium', labels: [],
      assignee: null, prerequisites: [], metadata: {}, origin_conversation_id: null,
      is_epic: false, parent_epic_id: null, execution_order: null, short_summary: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      created_by: 'test', source: 'manual',
    }]
  }))
  fs.writeFileSync(ticketFile, JSON.stringify({
    schema_version: '1.3', revision: 1, last_updated: '2026-01-01T00:00:00Z',
    next_id: Math.max(0, ...Object.keys(statuses).map(Number)) + 1,
    tickets,
  }))
}

beforeEach(() => {
  db = initDb(':memory:')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-pr-ticket-effects-'))
  ticketFile = path.join(dir, 'local-tickets.json')
  writeTickets()
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function delivery(owner = 'loop-1') {
  const row = createPrDelivery(db, {
    id: 'delivery-1', railIndex: 0, loopId: 'loop-1', railKey: '0-loop-1',
    ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
  })
  claimTicketOutcomeOwners(db, [1], owner)
  return row
}

describe('rail PR ticket-effect outbox', () => {
  it('commits intent atomically with the terminal decision and replays it after a simulated crash', () => {
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'acknowledge-no-changes', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'completed', 'owner',
      {
        implementationOutcome: 'succeeded',
        deliveryOutcome: 'no_changes',
        statusCode: 'cleanup_incomplete',
        cleanupWarnings: ['ticket status update pending: simulated crash window'],
      },
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'done', jiraAction: 'completed', prUrl: null },
    )).toBe(true)

    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('on_review')
    expect(getPrDelivery(db, row.id)?.decision).toBe('completed')

    const broadcast = vi.fn()
    const onRailMerged = vi.fn(() => true)
    const onRailCompleted = vi.fn(() => true)
    const deps = {
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast,
      jiraSyncManager: { onRailMerged, onRailDiscard: vi.fn(() => true), onRailCompleted },
      ticketFile,
    }
    expect(replayPendingRailPrTicketEffects(deps)).toEqual({
      attempted: 1, completed: 1, pending: 0, attemptedDeliveryIds: [row.id],
    })
    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('done')
    expect(getPrDelivery(db, row.id)).toMatchObject({ status_code: 'no_changes', cleanup_warnings: '[]' })
    expect(onRailCompleted).toHaveBeenCalledWith([1], row.id)
    expect(onRailMerged).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_updated' }))
    expect(db.prepare(`
      SELECT applied_ticket_ids, tickets_applied_at IS NOT NULL AS tickets_applied,
             jira_enqueued_at IS NOT NULL AS jira_enqueued,
             completed_at IS NOT NULL AS completed
        FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({
      applied_ticket_ids: '[1]', tickets_applied: 1, jira_enqueued: 1, completed: 1,
    })
    expect(replayPendingRailPrTicketEffects(deps)).toEqual({
      attempted: 0, completed: 0, pending: 0, attemptedDeliveryIds: [],
    })
  })

  it('retains the selected IDs when the process stops after JSON but before Jira enqueue', () => {
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'acknowledge-no-changes', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'completed', 'owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'done', jiraAction: 'completed', prUrl: null },
    )).toBe(true)

    let crash = true
    const onRailCompleted = vi.fn(() => {
      if (crash) {
        crash = false
        throw new Error('simulated crash before Jira enqueue')
      }
      return true
    })
    const deps = {
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      jiraSyncManager: {
        onRailMerged: vi.fn(() => true),
        onRailDiscard: vi.fn(() => true),
        onRailCompleted,
      },
      ticketFile,
    }

    expect(applyRailPrTicketEffect(deps, row.id)).toMatchObject({ ok: false, changedTicketIds: [1] })
    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('done')
    expect(db.prepare(`
      SELECT applied_ticket_ids, tickets_applied_at IS NOT NULL AS tickets_applied,
             jira_enqueued_at, completed_at
        FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({
      applied_ticket_ids: '[1]', tickets_applied: 1, jira_enqueued_at: null, completed_at: null,
    })

    // JSON is already converged, so replay changes no file row; nevertheless it
    // must hand Jira the immutable IDs selected before the first write.
    expect(applyRailPrTicketEffect(deps, row.id)).toEqual({ ok: true, changedTicketIds: [] })
    expect(onRailCompleted).toHaveBeenNthCalledWith(2, [1], row.id)
    expect(db.prepare(`
      SELECT jira_enqueued_at IS NOT NULL AS jira_enqueued,
             completed_at IS NOT NULL AS completed
        FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({ jira_enqueued: 1, completed: 1 })
  })

  it('replays idempotently when Jira enqueues durably before the outer checkpoint', () => {
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'acknowledge-no-changes', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'completed', 'owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'done', jiraAction: 'completed', prUrl: null },
    )).toBe(true)

    let crash = true
    const onRailCompleted = vi.fn((ticketIds: number[], refId: string) => {
      for (const ticketId of ticketIds) {
        enqueueOutbox(db, {
          jiraIssueId: `J-${ticketId}`,
          opType: 'transition',
          idempotencyKey: `${refId}:${ticketId}:transition:completed`,
          payload: { localId: ticketId, logicalState: 'done' },
        })
      }
      if (crash) {
        crash = false
        throw new Error('simulated crash after durable Jira enqueue')
      }
      return true
    })
    const deps = {
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      jiraSyncManager: {
        onRailMerged: vi.fn(() => true),
        onRailDiscard: vi.fn(() => true),
        onRailCompleted,
      },
      ticketFile,
    }

    expect(applyRailPrTicketEffect(deps, row.id)).toMatchObject({ ok: false })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM jira_outbox`).get()).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT jira_enqueued_at, completed_at FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({ jira_enqueued_at: null, completed_at: null })

    expect(applyRailPrTicketEffect(deps, row.id)).toEqual({ ok: true, changedTicketIds: [] })
    expect(onRailCompleted).toHaveBeenCalledTimes(2)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM jira_outbox`).get()).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT jira_enqueued_at IS NOT NULL AS jira_enqueued,
             completed_at IS NOT NULL AS completed
        FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({ jira_enqueued: 1, completed: 1 })
  })

  it('rolls back the outbox insert when the caller no longer owns the lease', () => {
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'discard', 'new-owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'discarded', 'old-owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'todo', jiraAction: 'discard', prUrl: null },
    )).toBe(false)
    expect(getPrDelivery(db, row.id)?.decision).toBe('building')
    expect(db.prepare('SELECT COUNT(*) AS count FROM rail_pr_ticket_effects').get()).toEqual({ count: 0 })
  })

  it('keeps a failed JSON mutation pending and succeeds idempotently on a later replay', () => {
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'discard', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'discarded', 'owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'todo', jiraAction: 'discard', prUrl: null },
    )).toBe(true)
    fs.writeFileSync(ticketFile, 'not valid ticket json')
    const deps = {
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      jiraSyncManager: { onRailMerged: vi.fn(), onRailDiscard: vi.fn() },
      ticketFile,
    }
    expect(applyRailPrTicketEffect(deps, row.id)).toMatchObject({ ok: false })
    expect(db.prepare('SELECT completed_at, attempts FROM rail_pr_ticket_effects WHERE delivery_id = ?').get(row.id))
      .toEqual({ completed_at: null, attempts: 1 })

    writeTickets()
    expect(applyRailPrTicketEffect(deps, row.id)).toMatchObject({ ok: true, changedTicketIds: [1] })
    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('todo')
  })

  it('freezes and applies only candidate tickets still parked at on_review', () => {
    writeTicketStatuses({ 1: 'on_review', 2: 'done', 3: 'todo' })
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'discard', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'discarded', 'owner', {},
      { deliveryId: row.id, ticketIds: [1, 2, 3], targetStatus: 'todo', jiraAction: 'discard', prUrl: null },
    )).toBe(true)

    expect(applyRailPrTicketEffect({
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      ticketFile,
    }, row.id)).toEqual({ ok: true, changedTicketIds: [1] })
    const tickets = JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets
    expect([tickets['1'].status, tickets['2'].status, tickets['3'].status]).toEqual(['todo', 'done', 'todo'])
    expect(db.prepare(`
      SELECT applied_ticket_ids FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({ applied_ticket_ids: '[1]' })
  })

  it('never applies an old terminal effect to a newer ticket owner', () => {
    const row = delivery('run-old')
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'discard', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'discarded', 'owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'todo', jiraAction: 'discard', prUrl: null },
    )).toBe(true)
    claimTicketOutcomeOwners(db, [1], 'run-new')
    const onRailDiscard = vi.fn(() => true)

    expect(applyRailPrTicketEffect({
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      jiraSyncManager: { onRailMerged: vi.fn(() => true), onRailDiscard },
      ticketFile,
    }, row.id)).toEqual({ ok: true, changedTicketIds: [] })

    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('on_review')
    expect(onRailDiscard).not.toHaveBeenCalled()
    expect(db.prepare(`
      SELECT applied_ticket_ids, completed_at IS NOT NULL AS completed
        FROM rail_pr_ticket_effects WHERE delivery_id = ?
    `).get(row.id)).toEqual({ applied_ticket_ids: '[]', completed: 1 })
  })

  it('treats missing causal ownership as a no-op instead of mutating an unowned review ticket', () => {
    const row = delivery()
    db.prepare(`DELETE FROM ticket_outcome_ownership WHERE ticket_id = 1`).run()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'discard', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'discarded', 'owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'todo', jiraAction: 'discard', prUrl: null },
    )).toBe(true)
    const onRailDiscard = vi.fn(() => true)

    expect(applyRailPrTicketEffect({
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      jiraSyncManager: { onRailMerged: vi.fn(() => true), onRailDiscard },
      ticketFile,
    }, row.id)).toEqual({ ok: true, changedTicketIds: [] })

    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('on_review')
    expect(onRailDiscard).not.toHaveBeenCalled()
  })

  it('retries a failed startup effect in-process and settles after the ticket store recovers', async () => {
    const row = delivery()
    expect(claimPrDeliveryOperation(db, row.id, 'building', 'discard', 'owner')).toBe(true)
    expect(transitionClaimedDecisionWithTicketEffect(
      db, row.id, 'building', 'discarded', 'owner', {},
      { deliveryId: row.id, ticketIds: [1], targetStatus: 'todo', jiraAction: 'discard', prUrl: null },
    )).toBe(true)
    fs.writeFileSync(ticketFile, 'temporarily corrupt')
    const observations: Array<{ pending: number; warning: string }> = []

    const result = await replayRailPrTicketEffectsUntilSettled({
      db,
      project: { id: 'p1', slug: 'p1', path: dir },
      broadcast: vi.fn(),
      jiraSyncManager: { onRailMerged: vi.fn(() => true), onRailDiscard: vi.fn(() => true) },
      ticketFile,
    }, {
      isCurrent: () => true,
      wait: async () => { writeTickets() },
      onAttempt: (attempt) => observations.push({
        pending: attempt.pending,
        warning: getPrDelivery(db, row.id)?.cleanup_warnings ?? '[]',
      }),
    })

    expect(result).toEqual({ settled: true, attempts: 2 })
    expect(observations[0].pending).toBe(1)
    expect(observations[0].warning).toContain('ticket status update pending:')
    expect(observations[1].pending).toBe(0)
    expect(getPrDelivery(db, row.id)).toMatchObject({ cleanup_warnings: '[]', status_code: 'discarded' })
    expect(JSON.parse(fs.readFileSync(ticketFile, 'utf8')).tickets['1'].status).toBe('todo')
  })
})
