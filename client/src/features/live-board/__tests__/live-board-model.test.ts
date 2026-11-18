import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitPullRequest } from 'lucide-react'
import {
  LAYOUT_KEY, NO_FILTERS, columnsOf, countVisible, lanesOf, primaryOf, providersOf, readLayout, readLiveBoardSnapshot, readLiveBoardWindowResult, writeLayout,
  type LiveCard,
} from '../lib/live-board-model'
import { liveCardLook } from '../lib/live-board-run-state'
// The test stands in for the app's composition, which plugs Intent in through the missions seam.
import { intentRunStateOf } from '../../intent/lib/intent-run-tone'

const item = (over: Record<string, unknown> = {}) => ({
  id: 'p1:question:r1', projectId: 'p1', projectName: 'Alpha', kind: 'question', title: 'Implement · #7', detail: null,
  at: '2026-11-18T09:00:00.000Z', version: 'paused::', action: 'open-run', subjectId: 'r1', conversationId: null, diagnosis: null, ...over,
})

const wire = (over: Record<string, unknown> = {}) => ({
  id: 'p1:loop-run:r1', projectId: 'p1', projectName: 'Alpha', kind: 'loop',
  status: { source: 'loop-run', status: 'running', outcome: null, restartReason: null },
  column: 'working', urgency: 2, at: '2026-11-18T08:00:00.000Z', title: 'Implement · #7', phase: 'implement-fix', question: null, steps: null,
  provider: 'claude', model: null, startedAt: '2026-11-18T08:00:00.000Z', finishedAt: null, costUsd: 0.4, costEstimated: false, costTodayUsd: 0.4,
  railIndex: null, ticketIds: [7], conversationId: 'm1', jobId: 'r1', deliveryId: null, attention: null, ...over,
})

const snapshot = (cards: Record<string, unknown>[], lanes: Record<string, unknown>[] = []) => readLiveBoardSnapshot({
  generatedAt: '2026-11-18T12:00:00.000Z',
  projects: [{ projectId: 'p1', projectName: 'Alpha', count: cards.length }],
  cards, lanes,
  totals: { needsYou: 1, inProgress: 1, toDecide: 0, doneToday: 0, costTodayUsd: 4.82, costTodayEstimated: false },
})

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('live board wire', () => {
  it('reads cards defensively, keeping the inbox item through the inbox reader', () => {
    const s = snapshot([
      wire(),
      wire({ id: 'p1:loop-run:r2', column: 'needs', status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: null }, attention: item() }),
      { id: 'broken' },
      wire({ id: 'p1:x:y', column: 'sideways' }),
    ])
    expect(s.cards.map((c) => c.id)).toEqual(['p1:loop-run:r1', 'p1:loop-run:r2'])
    expect(s.cards[1].attention).toMatchObject({ id: 'p1:question:r1', kind: 'question', cap: null })
    expect(s.totals.costTodayUsd).toBe(4.82)
    expect(readLiveBoardSnapshot(null)).toMatchObject({ cards: [], lanes: [], totals: { needsYou: 0, costTodayUsd: null } })
  })

  it('reads a delivery card merge preview and drops a malformed one', () => {
    const s = snapshot([
      wire({ id: 'p1:delivery:d1', deliveryId: 'd1', mergePreview: { status: 'conflicts', conflictFileCount: 2, siblingConflictCount: 1, baseAdvancedBy: 4 } }),
      wire({ id: 'p1:delivery:d2', deliveryId: 'd2', mergePreview: { status: 'sideways' } }),
    ])
    expect(s.cards[0].mergePreview).toEqual({ status: 'conflicts', conflictFileCount: 2, siblingConflictCount: 1, baseAdvancedBy: 4 })
    expect(s.cards[1].mergePreview).toBeNull()
  })

  it('drops lane card ids that are not on the board', () => {
    const s = snapshot([wire()], [{ conversationId: 'm1', title: 'One', provider: 'claude', projectIds: ['p1'], cardIds: ['p1:loop-run:r1', 'ghost'], todayCostUsd: 1, urgency: 2 }])
    expect(s.lanes[0].cardIds).toEqual(['p1:loop-run:r1'])
  })
})

describe('live board filters and layouts', () => {
  const cards = snapshot([
    wire({ id: 'a', column: 'needs', attention: item({ id: 'p1:question:a', subjectId: 'a' }) }),
    wire({ id: 'b', kind: 'job', provider: 'codex', status: { source: 'job', status: 'running' } }),
    wire({ id: 'c', projectId: 'p2', projectName: 'Beta', conversationId: 'm2', column: 'done', status: { source: 'loop-run', status: 'completed', outcome: 'success', restartReason: null } }),
  ], [
    { conversationId: 'm1', title: 'One', provider: 'claude', projectIds: ['p1'], cardIds: ['a', 'b'], todayCostUsd: null, urgency: 0 },
    { conversationId: 'm2', title: 'Two', provider: 'claude', projectIds: ['p2'], cardIds: ['c'], todayCostUsd: null, urgency: 3 },
    { conversationId: null, title: null, provider: null, projectIds: [], cardIds: [], todayCostUsd: null, urgency: 3 },
  ])

  it('counts a paused run apart from what is in progress', () => {
    const paused = snapshot([
      wire({ id: 'w', status: { source: 'job', status: 'running' } }),
      wire({ id: 'p', kind: 'intent', status: { source: 'intent', state: 'paused' } }),
    ], [])
    expect(countVisible(columnsOf(paused.cards, NO_FILTERS))).toEqual({ needsYou: 0, inProgress: 1, paused: 1 })
  })

  it('narrows columns by project, kind and engine, and hides inbox items the person dismissed', () => {
    expect(columnsOf(cards.cards, NO_FILTERS).needs.map((c) => c.id)).toEqual(['a'])
    expect(columnsOf(cards.cards, { ...NO_FILTERS, projectId: 'p2' }).done.map((c) => c.id)).toEqual(['c'])
    expect(columnsOf(cards.cards, { ...NO_FILTERS, kind: 'job' }).working.map((c) => c.id)).toEqual(['b'])
    expect(columnsOf(cards.cards, { ...NO_FILTERS, provider: 'codex' }).working.map((c) => c.id)).toEqual(['b'])
    expect(columnsOf(cards.cards, NO_FILTERS, (i) => i.id === 'p1:question:a').needs).toEqual([])
    expect(providersOf(cards.cards)).toEqual(['claude', 'codex'])
  })

  it('keeps the server lane order while filtering, and drops lanes left empty', () => {
    expect(lanesOf(cards, NO_FILTERS).map((l) => l.lane.conversationId)).toEqual(['m1', 'm2'])
    expect(lanesOf(cards, { ...NO_FILTERS, kind: 'job' }).map((l) => [l.lane.conversationId, l.cards.map((c) => c.id)])).toEqual([['m1', ['b']]])
    expect(lanesOf(cards, { ...NO_FILTERS, projectId: 'p2' }).map((l) => l.lane.conversationId)).toEqual(['m2'])
  })

  it('remembers the layout per viewer and survives a storage that throws', () => {
    expect(readLayout()).toBe('status')
    writeLayout('mission')
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('mission')
    expect(readLayout()).toBe('mission')
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readLayout()).toBe('status')
    expect(() => writeLayout('mission')).not.toThrow()
  })
})

describe('what a card does and how it looks', () => {
  const card = (over: Record<string, unknown>): LiveCard => snapshot([wire(over)]).cards[0]

  it('runs the inbox primary for an inbox item, opens a review, else opens the mission or run', () => {
    expect(primaryOf(card({ column: 'needs', attention: item() }))).toMatchObject({ kind: 'inbox', item: { id: 'p1:question:r1' } })
    expect(primaryOf(card({ column: 'decide', deliveryId: 'd1', status: { source: 'delivery', decision: 'on_review', statusCode: null } }))).toEqual({ kind: 'review', deliveryId: 'd1' })
    expect(primaryOf(card({}))).toEqual({ kind: 'open' })
    expect(primaryOf(card({ conversationId: null, jobId: null }))).toEqual({ kind: 'none' })
  })

  it('maps each domain status through its own vocabulary mapper', () => {
    expect(liveCardLook(card({})).state).toBe('working')
    expect(liveCardLook(card({ status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: null } })).state).toBe('needs-input')
    expect(liveCardLook(card({ status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: 'budget_paused' } })).state).toBe('paused')
    expect(liveCardLook(card({ status: { source: 'loop-run', status: 'completed', outcome: 'stopped', restartReason: null } })).state).toBe('stopped')
    expect(liveCardLook(card({ status: { source: 'job', status: 'queued' } })).state).toBe('queued')
    // Intent reaches the board through the missions extension seam; without it a state is never invented.
    expect(liveCardLook(card({ status: { source: 'intent', state: 'active' } }), intentRunStateOf).state).toBe('working')
    expect(liveCardLook(card({ status: { source: 'intent', state: 'active' } })).state).toBe('queued')
    expect(liveCardLook(card({ status: { source: 'delivery', decision: 'merged', statusCode: null } })).state).toBe('done')
    const pr = liveCardLook(card({ status: { source: 'delivery', decision: 'pr_ready', statusCode: null }, attention: item({ kind: 'review', action: 'open-review' }) }))
    expect(pr).toEqual({ state: 'review', objectIcon: GitPullRequest })
    // The inbox item decides: a failed delivery is failed, not its building glyph.
    expect(liveCardLook(card({ status: { source: 'delivery', decision: 'implementation_failed', statusCode: null }, attention: item({ kind: 'failed' }) })).state).toBe('failed')
    expect(liveCardLook(card({ status: { source: 'attention' }, attention: item({ kind: 'jira', action: 'retry-jira' }) })).state).toBe('blocked')
  })

  it('reads a board window result and rejects anything else', () => {
    const c = card({ attention: item() })
    expect(readLiveBoardWindowResult(JSON.parse(JSON.stringify({ action: 'primary', card: c })))).toMatchObject({ action: 'primary', card: { id: c.id, attention: { id: 'p1:question:r1' } } })
    expect(readLiveBoardWindowResult({ action: 'delete', card: c })).toBeNull()
    expect(readLiveBoardWindowResult({ action: 'open', card: { id: 'x' } })).toBeNull()
  })
})
