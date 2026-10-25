import { describe, expect, it } from 'vitest'
import { entryCost, eventCount, eventKey, groupByDay, localDayKey, timelineTarget, type TimelineEntry } from '../spec-timeline'
import { planProviderIds } from '../../../../lib/launch-forecast'

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: 'e', at: '2026-10-20T10:00:00.000Z', kind: 'job', event: 'job.run', params: {}, title: 'Implement', summary: null,
    actor: null, tone: 'neutral', provider: 'claude', link: null, ...over,
  }
}

describe('groupByDay', () => {
  it('keeps newest-first order and starts a group when the local day changes', () => {
    const noon = (d: number) => new Date(2026, 9, d, 12, 0, 0).toISOString()
    const groups = groupByDay([entry({ id: 'a', at: noon(22) }), entry({ id: 'b', at: noon(22) }), entry({ id: 'c', at: noon(20) })])
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([['a', 'b'], ['c']])
    expect(groups[0]!.key).toBe(localDayKey(noon(22)))
    expect(localDayKey('not a date')).toBe('unknown')
  })
})

describe('event phrases', () => {
  it('maps events to locale keys, with the verdict variant of a review', () => {
    expect(eventKey({ event: 'spec.ai.ai-edit', params: {} })).toBe('timeline.events.spec_ai_ai-edit')
    expect(eventKey({ event: 'review.verdict', params: { verdict: 'changes_requested' } })).toBe('timeline.events.review_changes_requested')
    expect(eventCount({ event: 'mission.turns', params: { turns: 4 }, count: 4 })).toBe(4)
    expect(eventCount({ event: 'job.run', params: {}, count: undefined })).toBeUndefined()
  })
})

describe('entryCost', () => {
  const plan = new Set(['codex'])
  it('shows billed and estimated apart, and nothing when no cost was reported', () => {
    expect(entryCost(entry({ costUsd: 1.5, costKind: 'billed' }), plan)).toEqual({ kind: 'billed', usd: 1.5 })
    expect(entryCost(entry({ costUsd: 0.2, costKind: 'estimated' }), plan)).toEqual({ kind: 'estimated', usd: 0.2 })
    expect(entryCost(entry({}), plan)).toBeNull()
  })
  it('shows turns, never dollars, for a provider billed through a plan', () => {
    expect(entryCost(entry({ provider: 'codex', costUsd: 9, costKind: 'billed', turns: 6 }), plan)).toEqual({ kind: 'turns', turns: 6 })
    expect(entryCost(entry({ provider: 'codex', costUsd: 9, costKind: 'billed' }), plan)).toBeNull()
  })
  it('derives plan providers from the usage snapshot', () => {
    const snapshot = { providers: [
      { providerId: 'claude', availability: 'available', plan: 'max', windows: [] },
      { providerId: 'codex', availability: 'available', windows: [{ usedPercent: 12 }] },
      { providerId: 'gemini', availability: 'unavailable' },
    ] }
    expect(planProviderIds(snapshot)).toEqual(['claude', 'codex'])
    expect(planProviderIds(null)).toEqual([])
  })
})

describe('timelineTarget: links resolve to places', () => {
  it('writes routed places in Board mode', () => {
    expect(timelineTarget({ place: 'job', id: 'run 1' }, 'kanban', '?spec=7')).toMatchObject({ pathname: '/jobs/run%201', search: '', place: 'job', needsAgentMode: false })
    expect(timelineTarget({ place: 'review', id: 'd1' }, 'kanban', '?spec=7')).toMatchObject({ pathname: '/review/d1', place: 'review' })
  })
  it('layers job and review over the current mission in Mission mode and drops ?spec', () => {
    const job = timelineTarget({ place: 'job', id: 'r1' }, 'agent', '?mission=c1&spec=7&review=old')!
    expect(job.pathname).toBe('/')
    expect(new URLSearchParams(job.search).get('job')).toBe('r1')
    expect(new URLSearchParams(job.search).get('mission')).toBe('c1')
    expect(new URLSearchParams(job.search).has('spec')).toBe(false)
    const review = timelineTarget({ place: 'review', id: 'd1' }, 'agent', '?mission=c1&spec=7&job=old')!
    expect(new URLSearchParams(review.search).get('review')).toBe('d1')
    expect(new URLSearchParams(review.search).has('job')).toBe(false)
  })
  it('needs Mission mode for a mission and has no target for the spec itself', () => {
    expect(timelineTarget({ place: 'mission', id: 'c9' }, 'kanban', '')).toEqual({ pathname: '/', search: '?mission=c9', needsAgentMode: true, place: 'mission' })
    expect(timelineTarget({ place: 'mission', id: 'c9' }, 'agent', '')!.needsAgentMode).toBe(false)
    expect(timelineTarget({ place: 'spec', id: '7' }, 'agent', '')).toBeNull()
    expect(timelineTarget(null, 'agent', '')).toBeNull()
  })
})
