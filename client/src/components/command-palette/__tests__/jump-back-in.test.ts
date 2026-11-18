import { describe, it, expect } from 'vitest'
import { JUMP_BACK_IN_MAX, buildJumpBackIn, jobLabel, refreshJumpEntries, type JumpJob, type JumpMission, type JumpSources } from '../jump-back-in'
import type { InboxItem } from '../../../features/inbox/lib/inbox-model'

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 18, 12, 0) - minutesAgo * 60_000).toISOString()

const inbox = (id: string, minutesAgo: number, over: Partial<InboxItem> = {}): InboxItem => ({
  id, projectId: 'p1', projectName: 'One', kind: 'review', title: `Item ${id}`, detail: null, at: at(minutesAgo),
  version: 'v1', action: 'open-review', subjectId: `s-${id}`, conversationId: null, diagnosis: null, cap: null, ...over,
})
const mission = (id: string, minutesAgo: number, over: Partial<JumpMission> = {}): JumpMission => ({
  id, title: `Mission ${id}`, pinned_project_id: 'p1', updated_at: at(minutesAgo), archivedAt: null, ...over,
})
const job = (id: string, minutesAgo: number, over: Partial<JumpJob> = {}): JumpJob => ({
  id, command: `/specrails:implement ${id}`, status: 'completed', started_at: at(minutesAgo + 1), finished_at: at(minutesAgo), ...over,
})

function sources(over: Partial<JumpSources> = {}): JumpSources {
  return {
    inbox: [], missions: [], attention: new Set(), attentionKinds: new Map(), streaming: new Set(), unread: new Set(),
    jobs: [], jobsProjectId: 'p1', ...over,
  }
}

const keys = (src: JumpSources, max?: number) => buildJumpBackIn(src, max).map((e) => e.key)

describe('buildJumpBackIn', () => {
  it('is empty without data', () => {
    expect(buildJumpBackIn(sources())).toEqual([])
  })

  it('puts what needs the person first, newest first, then recent missions and jobs newest first', () => {
    const src = sources({
      inbox: [inbox('i-old', 90), inbox('i-new', 5)],
      missions: [mission('m-recent', 1), mission('m-decision', 30), mission('m-unread', 10), mission('m-idle', 200)],
      attention: new Set(['m-decision']),
      unread: new Set(['m-unread']),
      jobs: [job('j-1', 2), job('j-2', 100)],
    })
    expect(keys(src)).toEqual([
      'inbox:i-new', 'mission:m-unread', 'mission:m-decision', 'inbox:i-old',
      'mission:m-recent', 'job:j-1',
    ])
  })

  it('leads each tier with the open project\'s newest row; the rest stays newest first', () => {
    const src = sources({
      activeProjectId: 'p1',
      inbox: [inbox('i-elsewhere', 1, { projectId: 'p2' }), inbox('i-elsewhere-2', 5, { projectId: 'p2' }), inbox('i-here', 60)],
      missions: [mission('m-elsewhere', 2, { pinned_project_id: 'p2' }), mission('m-unpinned', 30, { pinned_project_id: null }), mission('m-here', 40)],
    })
    expect(keys(src)).toEqual(['inbox:i-here', 'inbox:i-elsewhere', 'inbox:i-elsewhere-2', 'mission:m-unpinned', 'mission:m-elsewhere', 'mission:m-here'])
  })

  it('maps each kind to its run state with the domain mappers', () => {
    const src = sources({
      inbox: [inbox('q', 1, { kind: 'question' }), inbox('b', 2, { kind: 'budget' })],
      missions: [mission('fail', 3), mission('dec', 4), mission('live', 5), mission('unread', 6), mission('idle', 7)],
      attention: new Set(['fail', 'dec']),
      attentionKinds: new Map([['fail', 'failed']]),
      streaming: new Set(['live']),
      unread: new Set(['unread']),
      jobs: [job('run', 8, { status: 'running', finished_at: null })],
    })
    const states = Object.fromEntries(buildJumpBackIn(src, 20).map((e) => [e.key, e.state]))
    expect(states).toEqual({
      'inbox:q': 'needs-input', 'inbox:b': 'paused',
      'mission:fail': 'failed', 'mission:dec': 'review', 'mission:unread': 'needs-input',
      'mission:live': 'working', 'mission:idle': null, 'job:run': 'working',
    })
  })

  it('does not repeat a mission or job that an inbox item already leads to', () => {
    const src = sources({
      inbox: [
        inbox('review', 50, { conversationId: 'm-1' }),
        inbox('run', 60, { action: 'open-run', kind: 'failed', subjectId: 'j-1' }),
      ],
      missions: [mission('m-1', 1), mission('m-2', 2)],
      attention: new Set(['m-1']),
      jobs: [job('j-1', 3), job('j-2', 4)],
    })
    expect(keys(src)).toEqual(['inbox:review', 'inbox:run', 'mission:m-2', 'job:j-2'])
  })

  it('caps the group at six rows and skips archived missions', () => {
    const src = sources({
      inbox: Array.from({ length: 4 }, (_, i) => inbox(`i${i}`, i)),
      missions: [mission('archived', 0, { archivedAt: at(0) }), mission('m', 10), mission('n', 11), mission('o', 12)],
    })
    expect(JUMP_BACK_IN_MAX).toBe(6)
    expect(keys(src)).toEqual(['inbox:i0', 'inbox:i1', 'inbox:i2', 'inbox:i3', 'mission:m', 'mission:n'])
    expect(keys(src, 2)).toEqual(['inbox:i0', 'inbox:i1'])
  })

  it('sorts an unparseable time last', () => {
    const src = sources({ missions: [mission('bad', 0, { updated_at: 'nope' }), mission('ok', 500)] })
    expect(keys(src)).toEqual(['mission:ok', 'mission:bad'])
  })

  it('names a job by its spec when it has one', () => {
    expect(jobLabel({ command: '/x', ticketId: 14, ticketTitle: 'Add login' })).toBe('#14 Add login')
    expect(jobLabel({ command: '/x' })).toBe('/x')
  })
})

describe('refreshJumpEntries (frozen order)', () => {
  it('keeps the order chosen at open while states and titles update in place', () => {
    const first = sources({ missions: [mission('a', 1), mission('b', 2)], jobs: [job('j', 3, { status: 'running', finished_at: null })] })
    const frozen = buildJumpBackIn(first)
    expect(frozen.map((e) => e.key)).toEqual(['mission:a', 'mission:b', 'job:j'])

    // b now needs the person and is the newest; the job finished; a new mission appeared.
    const later = sources({
      missions: [mission('new', 0), mission('a', 1, { title: 'Renamed' }), mission('b', 0)],
      attention: new Set(['b']),
      jobs: [job('j', 0, { status: 'failed' })],
    })
    const rows = refreshJumpEntries(frozen, later)
    expect(rows.map((e) => e.key)).toEqual(['mission:a', 'mission:b', 'job:j'])
    expect(rows.map((e) => e.state)).toEqual([null, 'review', 'failed'])
    expect(rows[0].title).toBe('Renamed')
    // Recomputed (next opening) the order follows the new data.
    expect(keys(later)[0]).toBe('mission:b')
  })

  it('keeps a row whose subject disappeared with its last known look', () => {
    const frozen = buildJumpBackIn(sources({ inbox: [inbox('gone', 1, { kind: 'failed' })] }))
    const rows = refreshJumpEntries(frozen, sources())
    expect(rows).toEqual(frozen)
    expect(rows[0].state).toBe('failed')
  })
})
