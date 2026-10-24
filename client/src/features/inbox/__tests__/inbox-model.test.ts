import { beforeEach, describe, expect, it } from 'vitest'
import {
  DISMISSALS_KEY, doneDismissal, groupByProject, inboxTarget, isDismissed, nextSnoozeExpiry, readDismissals, readInboxSnapshot,
  snoozeDismissal, tomorrowMorning, writeDismissals, type InboxItem,
} from '../lib/inbox-model'

const NOW = new Date(2026, 9, 24, 15, 30, 0).getTime()
const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'p1:review:d1', projectId: 'p1', projectName: 'Alpha', kind: 'review', title: 'Add login', detail: null, at: '2026-10-24T10:00:00.000Z',
  version: 'on_review', action: 'open-review', subjectId: 'd1', conversationId: 'c1', diagnosis: null, ...over,
})

beforeEach(() => { localStorage.clear() })

describe('readInboxSnapshot', () => {
  it('keeps valid items and drops malformed ones without throwing', () => {
    const snap = readInboxSnapshot({ items: [item(), { id: 'x' }, null, item({ id: 'p1:bad', kind: 'nope' as never })], projects: [{ projectId: 'p1', projectName: 'Alpha', count: 1 }, 7], generatedAt: 'now' })
    expect(snap.items.map((i) => i.id)).toEqual(['p1:review:d1'])
    expect(snap.projects).toEqual([{ projectId: 'p1', projectName: 'Alpha', count: 1 }])
    expect(readInboxSnapshot(undefined).items).toEqual([])
  })
})

describe('readInboxSnapshot: failure diagnosis', () => {
  it('reads the diagnosis of a failed run and never trusts an uncertain one as a cause', () => {
    const wire = { ...item({ id: 'p1:blocked:r1', kind: 'blocked', action: 'open-run', subjectId: 'r1' }), diagnosis: { kind: 'provider_limit', confidence: 'high', phase: null, rounds: null, resetAt: '3am', detail: null, resumablePhase: null, blocker: null, source: 'desktop', remedies: ['resume', 'retry', 'open-logs'] } }
    const [read] = readInboxSnapshot({ items: [wire] }).items
    expect(read.diagnosis).toMatchObject({ kind: 'provider_limit', resetAt: '3am', remedies: ['resume', 'retry', 'open-logs'] })
    const [uncertain] = readInboxSnapshot({ items: [{ ...wire, diagnosis: { ...wire.diagnosis, confidence: 'low' } }] }).items
    expect(uncertain.diagnosis).toMatchObject({ kind: 'unknown', confidence: 'low' })
    expect(readInboxSnapshot({ items: [{ ...wire, diagnosis: 'nope' }] }).items[0].diagnosis).toBeNull()
  })
})

describe('Snooze / Done', () => {
  it('a snooze hides until it lapses; Done hides while the state is unchanged', () => {
    const it1 = item()
    const snoozed = { [it1.id]: snoozeDismissal(it1, 'hour', NOW) }
    expect(isDismissed(it1, snoozed, NOW + 59 * 60_000)).toBe(true)
    expect(isDismissed(it1, snoozed, NOW + 61 * 60_000)).toBe(false)
    const done = { [it1.id]: doneDismissal(it1, NOW) }
    expect(isDismissed(it1, done, NOW + 40 * 86_400_000)).toBe(true)
  })

  it('reappears when the item state changes (new version), even if snoozed or done', () => {
    const it1 = item()
    const done = { [it1.id]: doneDismissal(it1, NOW) }
    const snoozed = { [it1.id]: snoozeDismissal(it1, 'tomorrow', NOW) }
    const changed = item({ version: 'pr_draft' })
    expect(isDismissed(changed, done, NOW)).toBe(false)
    expect(isDismissed(changed, snoozed, NOW)).toBe(false)
  })

  it('is keyed per item id, so the same source id in two projects stays independent', () => {
    const a = item(), b = item({ id: 'p2:review:d1', projectId: 'p2', projectName: 'Beta' })
    const done = { [a.id]: doneDismissal(a, NOW) }
    expect(isDismissed(a, done, NOW)).toBe(true)
    expect(isDismissed(b, done, NOW)).toBe(false)
  })

  it('"until tomorrow" is 08:00 the next local day', () => {
    const t = new Date(tomorrowMorning(NOW))
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([25, 8, 0])
  })

  it('persists across reads, prunes old entries and survives corrupt storage', () => {
    const it1 = item()
    writeDismissals({ [it1.id]: doneDismissal(it1, NOW), old: { version: 'v', until: null, at: NOW - 40 * 86_400_000 } })
    const read = readDismissals(NOW)
    expect(Object.keys(read)).toEqual([it1.id])
    localStorage.setItem(DISMISSALS_KEY, '{not json')
    expect(readDismissals(NOW)).toEqual({})
  })

  it('knows when the next snooze lapses', () => {
    const it1 = item()
    expect(nextSnoozeExpiry({ [it1.id]: snoozeDismissal(it1, 'hour', NOW) }, NOW)).toBe(NOW + 3_600_000)
    expect(nextSnoozeExpiry({ [it1.id]: doneDismissal(it1, NOW) }, NOW)).toBeNull()
  })
})

describe('groupByProject / inboxTarget', () => {
  it('groups by project in first-seen (newest first) order', () => {
    const groups = groupByProject([item({ id: 'a1' }), item({ id: 'b1', projectId: 'p2', projectName: 'Beta' }), item({ id: 'a2' })])
    expect(groups.map((g) => [g.projectId, g.items.map((i) => i.id)])).toEqual([['p1', ['a1', 'a2']], ['p2', ['b1']]])
  })

  it('Mission mode layers the place over the mission; Board mode uses the route', () => {
    expect(inboxTarget(item(), 'agent')).toEqual({ pathname: '/', search: '?mission=c1&review=d1', place: 'review' })
    expect(inboxTarget(item({ action: 'open-run', subjectId: 'r1', conversationId: null }), 'agent')).toEqual({ pathname: '/', search: '?job=r1', place: 'job' })
    expect(inboxTarget(item(), 'kanban')).toEqual({ pathname: '/review/d1', search: '', place: 'review' })
    expect(inboxTarget(item({ action: 'open-run', subjectId: 'r1' }), 'kanban')).toEqual({ pathname: '/jobs/r1', search: '', place: 'job' })
  })
})
