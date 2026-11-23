import { describe, expect, it } from 'vitest'
import {
  buildLanes, columnOf, countColumns, projectCards, settledInDay,
  type DayWindow, type LiveAttentionRef, type LiveCard, type LiveRunFacts,
} from '../domain'

const DAY: DayWindow = { from: '2026-11-18T00:00:00.000Z', to: '2026-11-19T00:00:00.000Z' }
const NOW = '2026-11-18T12:00:00.000Z'

function run(sourceId: string, patch: Partial<LiveRunFacts> = {}): LiveRunFacts {
  return {
    sourceId, kind: 'loop', status: { source: 'loop-run', status: 'running', outcome: null, restartReason: null },
    title: sourceId, phase: null, question: null, steps: null, provider: 'claude', model: null,
    startedAt: '2026-11-18T08:00:00.000Z', finishedAt: null, costUsd: null, costEstimated: false, costTodayUsd: null,
    railIndex: null, ticketIds: [], conversationId: null, jobId: sourceId, deliveryId: null, subjectIds: [sourceId],
    ...patch,
  }
}

function item(subjectId: string, kind: string, patch: Partial<LiveAttentionRef> = {}): LiveAttentionRef {
  return { id: `p1:${kind}:${subjectId}`, projectId: 'p1', kind, action: kind === 'review' ? 'open-review' : 'open-run', subjectId, conversationId: null, title: subjectId, at: '2026-11-18T09:00:00.000Z', ...patch }
}

const cards = (runs: LiveRunFacts[], attention: LiveAttentionRef[] = []) => projectCards({ projectId: 'p1', projectName: 'Alpha', runs, attention }, DAY, NOW)

describe('live board: done today is the local day', () => {
  it('includes the start of the day and excludes the next midnight', () => {
    expect(settledInDay('2026-11-18T00:00:00.000Z', DAY)).toBe(true)
    expect(settledInDay('2026-11-18T23:59:59.999Z', DAY)).toBe(true)
    expect(settledInDay('2026-11-19T00:00:00.000Z', DAY)).toBe(false)
    expect(settledInDay('2026-11-17T23:59:59.999Z', DAY)).toBe(false)
    expect(settledInDay(null, DAY)).toBe(false)
  })

  it('keeps a run settled yesterday off the board', () => {
    const yesterday = run('old', { status: { source: 'loop-run', status: 'completed', outcome: 'success', restartReason: null }, finishedAt: '2026-11-17T22:00:00.000Z' })
    expect(cards([yesterday])).toEqual([])
  })
})

describe('live board: columns', () => {
  it('puts live work in progress and settled-today work in done', () => {
    expect(columnOf({ source: 'job', status: 'queued' }, null, null, DAY)).toBe('working')
    expect(columnOf({ source: 'job', status: 'running' }, null, null, DAY)).toBe('working')
    expect(columnOf({ source: 'job', status: 'completed' }, null, '2026-11-18T10:00:00.000Z', DAY)).toBe('done')
    expect(columnOf({ source: 'job', status: 'canceled' }, null, '2026-11-18T10:00:00.000Z', DAY)).toBe('done')
    expect(columnOf({ source: 'delivery', decision: 'building', statusCode: null }, null, null, DAY)).toBe('working')
    expect(columnOf({ source: 'delivery', decision: 'merged', statusCode: null }, null, '2026-11-18T10:00:00.000Z', DAY)).toBe('done')
    expect(columnOf({ source: 'delivery', decision: 'pr_ready', statusCode: null }, null, null, DAY)).toBe('needs')
    expect(columnOf({ source: 'intent', state: 'active' }, null, null, DAY)).toBe('working')
    expect(columnOf({ source: 'intent', state: 'discarded' }, null, '2026-11-18T10:00:00.000Z', DAY)).toBe('done')
    expect(columnOf({ source: 'attention' }, null, null, DAY)).toBeNull()
  })

  it('lets the inbox decide: every inbox item needs you, a review included', () => {
    expect(columnOf({ source: 'delivery', decision: 'on_review', statusCode: null }, { kind: 'review' }, null, DAY)).toBe('needs')
    expect(columnOf({ source: 'loop-run', status: 'paused', outcome: null, restartReason: null }, { kind: 'question' }, null, DAY)).toBe('needs')
    expect(columnOf({ source: 'delivery', decision: 'implementation_failed', statusCode: null }, { kind: 'failed' }, '2026-11-18T10:00:00.000Z', DAY)).toBe('needs')
  })

  it('never shows a run in two columns and keeps every inbox item exactly once', () => {
    const runs = [
      run('r-question', { status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: null } }),
      run('d-review', { kind: 'rail', status: { source: 'delivery', decision: 'on_review', statusCode: null }, subjectIds: ['d-review'] }),
      run('r-live'),
      run('r-done', { status: { source: 'loop-run', status: 'completed', outcome: 'success', restartReason: null }, finishedAt: '2026-11-18T11:00:00.000Z' }),
      run('r-live'), // a duplicate row from another read is listed once
    ]
    const attention = [item('r-question', 'question'), item('d-review', 'review'), item('jira-1', 'jira', { action: 'retry-jira' })]
    const result = cards(runs, attention)
    expect(new Set(result.map((c) => c.id)).size).toBe(result.length)
    const columns = Object.fromEntries(result.map((c) => [c.id, c.column]))
    expect(columns).toEqual({
      'p1:loop-run:r-question': 'needs',
      'p1:delivery:d-review': 'needs',
      'p1:loop-run:r-live': 'working',
      'p1:loop-run:r-done': 'done',
      'p1:jira:jira-1': 'needs',
    })
    const attentionIds = result.flatMap((c) => (c.attention ? [c.attention.id] : []))
    expect(attentionIds.sort()).toEqual(attention.map((a) => a.id).sort())
    expect(result.find((c) => c.id === 'p1:jira:jira-1')).toMatchObject({ kind: null, status: { source: 'attention' } })
  })

  it('drops another project\'s inbox item (a source speaks only for its own project)', () => {
    expect(cards([], [item('x', 'failed', { projectId: 'p2', id: 'p2:failed:x' })])).toEqual([])
  })

  it('puts a paused run after running and queued ones, and counts it in its column', () => {
    const result = cards([
      run('p', { status: { source: 'intent', state: 'paused' }, kind: 'intent', startedAt: '2026-10-20T08:00:00.000Z' }),
      run('q', { kind: 'job', status: { source: 'job', status: 'queued' }, startedAt: '2026-11-18T07:00:00.000Z' }),
      run('w', { startedAt: '2026-11-18T09:00:00.000Z' }),
    ], [])
    expect(result.filter((c) => c.column === 'working').map((c) => c.id.split(':')[2])).toEqual(['w', 'q', 'p'])
    expect(countColumns(result).inProgress).toBe(3)
  })

  it('orders needs you oldest first, running before queued, done most recent first', () => {
    const result = cards([
      run('a', { status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: null } }),
      run('b', { status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: null } }),
      run('q', { kind: 'job', status: { source: 'job', status: 'queued' }, startedAt: '2026-11-18T07:00:00.000Z' }),
      run('w2', { startedAt: '2026-11-18T09:00:00.000Z' }),
      run('w1', { startedAt: '2026-11-18T08:30:00.000Z' }),
      run('d1', { status: { source: 'loop-run', status: 'completed', outcome: 'success', restartReason: null }, finishedAt: '2026-11-18T09:00:00.000Z' }),
      run('d2', { status: { source: 'loop-run', status: 'completed', outcome: 'stopped', restartReason: null }, finishedAt: '2026-11-18T10:00:00.000Z' }),
    ], [item('a', 'failed', { at: '2026-11-18T10:00:00.000Z' }), item('b', 'question', { at: '2026-11-18T09:00:00.000Z' })])
    const ids = (column: string) => result.filter((c) => c.column === column).map((c) => c.id.split(':')[2])
    expect(ids('needs')).toEqual(['b', 'a'])
    expect(ids('working')).toEqual(['w1', 'w2', 'q'])
    expect(ids('done')).toEqual(['d2', 'd1'])
    expect(countColumns(result)).toEqual({ needsYou: 2, inProgress: 3, doneToday: 2 })
  })
})

describe('live board: lanes by mission', () => {
  const card = (id: string, column: LiveCard['column'], conversationId: string | null, at: string, costTodayUsd: number | null = null): LiveCard => ({
    ...run(id, { conversationId, costTodayUsd }), id, projectId: 'p1', projectName: 'Alpha', kind: 'loop', column,
    urgency: { needs: 0, working: 1, done: 2 }[column], at, attention: null,
  })

  it('orders lanes by urgency then recency, and puts runs without a mission last', () => {
    const lanes = buildLanes([
      card('free', 'needs', null, '2026-11-18T11:00:00.000Z'),
      card('m1-run', 'working', 'm1', '2026-11-18T11:30:00.000Z'),
      card('m2-run', 'needs', 'm2', '2026-11-18T08:00:00.000Z'),
      card('m3-fail', 'needs', 'm3', '2026-11-18T07:00:00.000Z'),
      card('m3-live', 'working', 'm3', '2026-11-18T07:30:00.000Z'),
      card('m4-done', 'done', 'm4', '2026-11-18T06:00:00.000Z'),
      card('m5-live', 'working', 'm5', '2026-11-18T10:00:00.000Z'),
    ], new Map([['m3', { title: 'Seasons', provider: 'codex', todayCostUsd: 1.5 }]]))
    // m2 waits for a review and m3 has a failure: both need you, the most recent first.
    expect(lanes.map((lane) => lane.conversationId)).toEqual(['m2', 'm3', 'm1', 'm5', 'm4', null])
    expect(lanes[1]).toMatchObject({ title: 'Seasons', provider: 'codex', cardIds: ['m3-fail', 'm3-live'], urgency: 0, projectIds: ['p1'] })
  })

  it('adds the mission\'s own turns today to what its runs recorded today', () => {
    const lanes = buildLanes([card('r1', 'working', 'm1', NOW, 0.25), card('r2', 'done', 'm1', NOW, 0.5), card('r3', 'working', 'm2', NOW)],
      new Map([['m1', { title: 'One', provider: 'claude', todayCostUsd: 1 }]]))
    expect(lanes.find((l) => l.conversationId === 'm1')?.todayCostUsd).toBeCloseTo(1.75)
    expect(lanes.find((l) => l.conversationId === 'm2')?.todayCostUsd).toBeNull()
  })
})
