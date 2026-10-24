import { beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../db'
import { claimDrainable, enqueueHeldUpdate, listOutbox } from './jira-db'

describe('enqueueHeldUpdate (undo window)', () => {
  let db: DbInstance
  const t0 = new Date('2026-03-01T10:00:00.000Z')
  const at = (ms: number) => new Date(t0.getTime() + ms)
  beforeEach(() => { db = initDb(':memory:') })

  it('does not release the write inside the hold window, then releases it', () => {
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k1', fields: { labels: ['b'] }, holdMs: 10_000, now: t0 })
    expect(claimDrainable(db, 5, at(5_000).toISOString())).toEqual([])
    const claimed = claimDrainable(db, 5, at(10_001).toISOString())
    expect(claimed).toHaveLength(1)
    expect(JSON.parse(claimed[0].payload as string)).toMatchObject({ fields: { labels: ['b'] } })
  })

  it('collapses an edit undone inside the window: Jira only ever receives the final value', () => {
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k1', fields: { labels: ['changed'] }, holdMs: 10_000, now: t0 })
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k2', fields: { labels: ['original'] }, holdMs: 10_000, now: at(3_000) })
    expect(listOutbox(db, { state: 'superseded' })).toHaveLength(1)
    const claimed = claimDrainable(db, 5, at(20_000).toISOString())
    expect(claimed).toHaveLength(1)
    expect(JSON.parse(claimed[0].payload as string).fields).toEqual({ labels: ['original'] })
  })

  it('keeps the other fields of a superseded held edit', () => {
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k1', fields: { summary: 'New', labels: ['x'] }, holdMs: 10_000, now: t0 })
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k2', fields: { labels: ['y'] }, holdMs: 10_000, now: at(1_000) })
    const [op] = claimDrainable(db, 5, at(20_000).toISOString())
    expect(JSON.parse(op.payload as string).fields).toEqual({ summary: 'New', labels: ['y'] })
  })

  it('never folds an update of another issue, nor one already past its hold', () => {
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k1', fields: { labels: ['a'] }, holdMs: 10_000, now: t0 })
    enqueueHeldUpdate(db, { jiraIssueId: 'J2', idempotencyKey: 'k2', fields: { labels: ['b'] }, holdMs: 10_000, now: at(1_000) })
    enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k3', fields: { labels: ['c'] }, holdMs: 10_000, now: at(30_000) })
    expect(listOutbox(db, { state: 'superseded' })).toHaveLength(0)
    expect(listOutbox(db, { state: 'pending' })).toHaveLength(3)
  })

  it('is idempotent on the idempotency key', () => {
    const a = enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k1', fields: { labels: ['a'] }, holdMs: 10_000, now: t0 })
    const b = enqueueHeldUpdate(db, { jiraIssueId: 'J1', idempotencyKey: 'k1', fields: { labels: ['z'] }, holdMs: 10_000, now: at(500) })
    expect(b).toBe(a)
    expect(listOutbox(db)).toHaveLength(1)
  })
})
