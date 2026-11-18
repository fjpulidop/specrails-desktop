import { describe, it, expect } from 'vitest'
import { JUMP_BACK_IN_MAX, buildJumpBackIn, jobLabel, refreshJumpEntries, type JumpJob, type JumpMission, type JumpSources } from '../jump-back-in'

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 18, 12, 0) - minutesAgo * 60_000).toISOString()

const mission = (id: string, minutesAgo: number, over: Partial<JumpMission> = {}): JumpMission => ({
  id, title: `Mission ${id}`, pinned_project_id: 'p1', updated_at: at(minutesAgo), archivedAt: null, ...over,
})
const job = (id: string, minutesAgo: number, over: Partial<JumpJob> = {}): JumpJob => ({
  id, command: `/specrails:implement ${id}`, status: 'completed', started_at: at(minutesAgo + 1), finished_at: at(minutesAgo), ...over,
})

function sources(over: Partial<JumpSources> = {}): JumpSources {
  return {
    missions: [], attention: new Set(), attentionKinds: new Map(), streaming: new Set(), unread: new Set(),
    jobs: [], jobsProjectId: 'p1', ...over,
  }
}

const keys = (src: JumpSources, max?: number) => buildJumpBackIn(src, max).map((e) => e.key)

describe('buildJumpBackIn', () => {
  it('is empty without data', () => {
    expect(buildJumpBackIn(sources())).toEqual([])
  })

  it('lists the most recent missions and jobs newest first; a mission waiting on the person is not moved ahead', () => {
    const src = sources({
      missions: [mission('m-recent', 1), mission('m-decision', 30), mission('m-unread', 10), mission('m-idle', 200)],
      attention: new Set(['m-decision']),
      unread: new Set(['m-unread']),
      jobs: [job('j-1', 2), job('j-2', 100)],
    })
    expect(keys(src)).toEqual(['mission:m-recent', 'job:j-1', 'mission:m-unread', 'mission:m-decision', 'job:j-2', 'mission:m-idle'])
  })

  it('carries no inbox item (the palette has one row that opens the inbox instead)', () => {
    const src = { ...sources({ missions: [mission('m', 1)] }), inbox: [{ id: 'i1' }] } as unknown as JumpSources
    expect(keys(src)).toEqual(['mission:m'])
  })

  it('leads with the open project\'s newest row; the rest stays newest first', () => {
    const src = sources({
      activeProjectId: 'p1',
      missions: [mission('m-elsewhere', 2, { pinned_project_id: 'p2' }), mission('m-elsewhere-2', 5, { pinned_project_id: 'p2' }), mission('m-here', 40)],
      jobs: [job('j-here', 60)],
    })
    expect(keys(src)).toEqual(['mission:m-here', 'mission:m-elsewhere', 'mission:m-elsewhere-2', 'job:j-here'])
    // A mission pinned to no project counts as here.
    expect(keys(sources({ activeProjectId: 'p1', missions: [mission('m-elsewhere', 2, { pinned_project_id: 'p2' }), mission('m-unpinned', 30, { pinned_project_id: null })] })))
      .toEqual(['mission:m-unpinned', 'mission:m-elsewhere'])
  })

  it('maps each kind to its run state with the domain mappers', () => {
    const src = sources({
      missions: [mission('fail', 3), mission('dec', 4), mission('live', 5), mission('unread', 6), mission('idle', 7)],
      attention: new Set(['fail', 'dec']),
      attentionKinds: new Map([['fail', 'failed']]),
      streaming: new Set(['live']),
      unread: new Set(['unread']),
      jobs: [job('run', 8, { status: 'running', finished_at: null })],
    })
    const states = Object.fromEntries(buildJumpBackIn(src, 20).map((e) => [e.key, e.state]))
    expect(states).toEqual({
      'mission:fail': 'failed', 'mission:dec': 'review', 'mission:unread': 'needs-input',
      'mission:live': 'working', 'mission:idle': null, 'job:run': 'working',
    })
  })

  it('caps the group at six rows and skips archived missions', () => {
    const src = sources({
      missions: [mission('archived', 0, { archivedAt: at(0) }), ...Array.from({ length: 7 }, (_, i) => mission(`m${i}`, i + 1))],
    })
    expect(JUMP_BACK_IN_MAX).toBe(6)
    expect(keys(src)).toEqual(['mission:m0', 'mission:m1', 'mission:m2', 'mission:m3', 'mission:m4', 'mission:m5'])
    expect(keys(src, 2)).toEqual(['mission:m0', 'mission:m1'])
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
      missions: [mission('new', 1), mission('a', 1, { title: 'Renamed' }), mission('b', 0)],
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
    const frozen = buildJumpBackIn(sources({ jobs: [job('gone', 1, { status: 'failed' })] }))
    const rows = refreshJumpEntries(frozen, sources())
    expect(rows).toEqual(frozen)
    expect(rows[0].state).toBe('failed')
  })
})
