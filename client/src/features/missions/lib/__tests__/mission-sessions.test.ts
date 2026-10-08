import { describe, it, expect } from 'vitest'

import type { AgentSubagent } from '../agent-api'
import {
  MAX_LIVE_EVENTS_PER_SUBAGENT,
  applySessionMessage,
  applySessionSnapshot,
  dismissSessionNotice,
  isInterruptedSubagent,
  isLiveSubagent,
  placeUnanchoredSubagents,
  settleMissingSessions,
  subagentsForTurn,
  unanchoredSubagents,
  type MissionSessionsState,
} from '../mission-sessions'

const node = (over: Partial<AgentSubagent> = {}): AgentSubagent => ({
  subagentId: 'sa-1', parentId: null, kind: 'background', agentType: 'Explore', description: 'Scan the repo',
  phase: 'running', reason: null, restarts: 0, startedAt: '2026-10-07T10:00:00.000Z', endedAt: null,
  usage: null, toolUses: null, durationMs: null, resultSummary: null, launchedInTurnId: 't1', ...over,
})

const empty: MissionSessionsState = new Map()

describe('applySessionMessage', () => {
  it('ignores messages without a conversation or of unrelated types', () => {
    expect(applySessionMessage(empty, { type: 'agent_resident_state' })).toBe(empty)
    expect(applySessionMessage(empty, { type: 'agent_done', conversationId: 'c1' })).toBe(empty)
  })

  it('tracks resident state and keeps unspecified fields', () => {
    let state = applySessionMessage(empty, { type: 'agent_resident_state', conversationId: 'c1', phase: 'background', processAlive: true, liveSubagents: 2 })
    expect(state.get('c1')).toMatchObject({ residentPhase: 'background', processAlive: true, liveSubagents: 2 })
    state = applySessionMessage(state, { type: 'agent_resident_state', conversationId: 'c1', phase: 'idle' })
    expect(state.get('c1')).toMatchObject({ residentPhase: 'idle', processAlive: true, liveSubagents: 2 })
  })

  it('upserts sub-agents by id', () => {
    let state = applySessionMessage(empty, { type: 'agent_subagent', conversationId: 'c1', subagent: node() })
    state = applySessionMessage(state, { type: 'agent_subagent', conversationId: 'c1', subagent: node({ phase: 'idle', resultSummary: 'done' }) })
    expect(Object.values(state.get('c1')!.subagents)).toEqual([node({ phase: 'idle', resultSummary: 'done' })])
    expect(applySessionMessage(state, { type: 'agent_subagent', conversationId: 'c1' })).toBe(state)
  })

  it('appends live events, dedupes by seq and keeps the tail bounded', () => {
    let state = empty
    for (let seq = 1; seq <= MAX_LIVE_EVENTS_PER_SUBAGENT + 5; seq++) {
      state = applySessionMessage(state, { type: 'agent_subagent_event', conversationId: 'c1', subagentId: 'sa-1', seq, channel: 'text', delta: `d${seq}` })
    }
    const duplicate = applySessionMessage(state, { type: 'agent_subagent_event', conversationId: 'c1', subagentId: 'sa-1', seq: MAX_LIVE_EVENTS_PER_SUBAGENT + 5, channel: 'text', delta: 'again' })
    const events = duplicate.get('c1')!.liveEvents['sa-1']
    expect(events).toHaveLength(MAX_LIVE_EVENTS_PER_SUBAGENT)
    expect(events[0].seq).toBe(6)
    expect(events.at(-1)).toMatchObject({ seq: MAX_LIVE_EVENTS_PER_SUBAGENT + 5, delta: `d${MAX_LIVE_EVENTS_PER_SUBAGENT + 5}` })
    expect(applySessionMessage(state, { type: 'agent_subagent_event', conversationId: 'c1', subagentId: 'sa-1', channel: 'text' })).toBe(state)
  })

  it('streams a background turn and clears it when done; user turns are not tracked', () => {
    expect(applySessionMessage(empty, { type: 'agent_turn_started', conversationId: 'c1', turnId: 'u1', origin: 'user' })).toBe(empty)
    let state = applySessionMessage(empty, { type: 'agent_turn_started', conversationId: 'c1', turnId: 'bg', origin: 'subagent', triggeredBy: ['sa-1'] })
    state = applySessionMessage(state, { type: 'agent_stream', conversationId: 'c1', turnId: 'bg', delta: 'Hel' })
    state = applySessionMessage(state, { type: 'agent_stream', conversationId: 'c1', turnId: 'other', delta: 'x' })
    state = applySessionMessage(state, { type: 'agent_stream', conversationId: 'c1', delta: 'user turn' })
    state = applySessionMessage(state, { type: 'agent_stream', conversationId: 'c1', turnId: 'bg', delta: 'lo' })
    expect(state.get('c1')!.backgroundTurn).toEqual({ turnId: 'bg', origin: 'subagent', triggeredBy: ['sa-1'], text: 'Hello' })
    state = applySessionMessage(state, { type: 'agent_turn_done', conversationId: 'c1', turnId: 'other' })
    expect(state.get('c1')!.backgroundTurn).not.toBeNull()
    state = applySessionMessage(state, { type: 'agent_turn_done', conversationId: 'c1', turnId: 'bg' })
    expect(state.get('c1')!.backgroundTurn).toBeNull()
  })

  it('accumulates deferred settings and clears them once applied', () => {
    let state = applySessionMessage(empty, { type: 'agent_session_updated', conversationId: 'c1', outcome: 'deferred', changes: { model: 'opus' } })
    state = applySessionMessage(state, { type: 'agent_session_updated', conversationId: 'c1', outcome: 'deferred', changes: { effort: 'high' } })
    expect(state.get('c1')!.deferredChanges).toEqual({ model: 'opus', effort: 'high' })
    state = applySessionMessage(state, { type: 'agent_session_updated', conversationId: 'c1', outcome: 'applied' })
    expect(state.get('c1')!.deferredChanges).toBeNull()
  })
})

describe('snapshots and reconnect', () => {
  it('marks a mission loaded without a session', () => {
    expect(applySessionSnapshot(empty, 'c1', null).get('c1')).toMatchObject({ loaded: true, subagents: {} })
  })

  it('merges snapshot rows over existing ones', () => {
    let state = applySessionMessage(empty, { type: 'agent_subagent', conversationId: 'c1', subagent: node({ subagentId: 'old', phase: 'idle' }) })
    state = applySessionSnapshot(state, 'c1', { residentPhase: 'background', processAlive: true, liveSubagents: 1, subagents: [node()] })
    const view = state.get('c1')!
    expect(view).toMatchObject({ residentPhase: 'background', liveSubagents: 1, loaded: true })
    expect(Object.keys(view.subagents).sort()).toEqual(['old', 'sa-1'])
  })

  it('settles missions the server no longer reports as live', () => {
    let state = applySessionMessage(empty, { type: 'agent_resident_state', conversationId: 'c1', phase: 'background', liveSubagents: 1 })
    state = applySessionMessage(state, { type: 'agent_resident_state', conversationId: 'c2', phase: 'background', liveSubagents: 1 })
    state = applySessionMessage(state, { type: 'agent_resident_state', conversationId: 'c3', phase: 'idle', liveSubagents: 0 })
    const settled = settleMissingSessions(state, new Set(['c2']))
    expect(settled.get('c1')).toMatchObject({ residentPhase: 'idle', liveSubagents: 0 })
    expect(settled.get('c2')).toBe(state.get('c2'))
    expect(settled.get('c3')).toBe(state.get('c3'))
    const idle = applySessionMessage(empty, { type: 'agent_resident_state', conversationId: 'c3', phase: 'idle' })
    expect(settleMissingSessions(idle, new Set())).toBe(idle)
  })
})

describe('selectors', () => {
  const state = [node({ subagentId: 'b', startedAt: '2026-10-07T10:00:02.000Z' }), node({ subagentId: 'a' }), node({ subagentId: 'c', launchedInTurnId: 't2' }), node({ subagentId: 'd', launchedInTurnId: null })]
    .reduce((acc, item) => applySessionMessage(acc, { type: 'agent_subagent', conversationId: 'c1', subagent: item }), empty)
  const view = state.get('c1')

  it('groups sub-agents by launching turn, oldest first', () => {
    expect(subagentsForTurn(view, 't1').map((item) => item.subagentId)).toEqual(['a', 'b'])
    expect(subagentsForTurn(view, null)).toEqual([])
    expect(subagentsForTurn(undefined, 't1')).toEqual([])
  })

  it('lists sub-agents with no settled message', () => {
    expect(unanchoredSubagents(view, new Set(['t1'])).map((item) => item.subagentId)).toEqual(['c', 'd'])
    expect(unanchoredSubagents(undefined, new Set())).toEqual([])
  })

  it('classifies phases', () => {
    expect(isLiveSubagent(node())).toBe(true)
    expect(isLiveSubagent(node({ phase: 'idle' }))).toBe(false)
    expect(['interrupted', 'stopped', 'killed'].every((phase) => isInterruptedSubagent(node({ phase: phase as AgentSubagent['phase'] })))).toBe(true)
    expect(isInterruptedSubagent(node({ phase: 'failed' }))).toBe(false)
  })
})

describe('session notices', () => {
  const notice = (code: string, scope?: string, timestamp = 't1') => ({ type: 'agent_session_notice', conversationId: 'c1', level: 'warning' as const, code, message: `raw ${code}`, ...(scope ? { scope } : {}), timestamp })

  it('keeps one notice per code, bounded, and lets the user dismiss them', () => {
    let state = applySessionMessage(empty, notice('host_degraded', 'acme'))
    state = applySessionMessage(state, notice('host_degraded', 'acme', 't2'))
    expect(state.get('c1')!.notices).toEqual([{ id: 'host_degraded:t2', code: 'host_degraded', level: 'warning', message: 'raw host_degraded', scope: 'acme' }])
    for (let index = 0; index < 8; index++) state = applySessionMessage(state, notice(`code-${index}`))
    expect(state.get('c1')!.notices).toHaveLength(5)
    const [first] = state.get('c1')!.notices
    state = dismissSessionNotice(state, 'c1', first!.id)
    expect(state.get('c1')!.notices).toHaveLength(4)
    expect(dismissSessionNotice(state, 'c1', 'missing')).toBe(state)
    expect(applySessionMessage(state, { type: 'agent_session_notice', conversationId: 'c1' })).toBe(state)
  })

  it('clears host notices of a scope when its host is ready again', () => {
    let state = applySessionMessage(empty, notice('host_degraded', 'acme'))
    state = applySessionMessage(state, { ...notice('journal_locked', 'other'), conversationId: 'c2' })
    state = applySessionMessage(state, notice('policy.subagent_blocked'))
    expect(applySessionMessage(state, { type: 'agent_sessions_host', scope: 'acme', status: 'degraded' })).toBe(state)
    const ready = applySessionMessage(state, { type: 'agent_sessions_host', scope: 'acme', status: 'ready' })
    expect(ready.get('c1')!.notices.map((item) => item.code)).toEqual(['policy.subagent_blocked'])
    expect(ready.get('c2')).toBe(state.get('c2'))
    expect(applySessionMessage(ready, { type: 'agent_sessions_host', scope: 'nobody', status: 'ready' })).toBe(ready)
  })
})

describe('placeUnanchoredSubagents', () => {
  const messages = [
    { id: 'u1', created_at: '2026-10-07 10:00:00' },
    { id: 'a1', created_at: '2026-10-07T10:00:20.000Z' },
    { id: 'u2', created_at: '2026-10-07 10:01:00' },
  ]
  const at = (second: number, turn: string, id: string) => node({ subagentId: id, launchedInTurnId: turn, startedAt: new Date(Date.UTC(2026, 9, 7, 10, 0, second)).toISOString() })

  it('keeps past launches after the message that preceded them and the in-flight one live', () => {
    const placement = placeUnanchoredSubagents([at(10, 't1', 'x'), at(12, 't1', 'y'), at(75, 't2', 'z')], messages, true)
    expect([...placement.afterMessage.entries()].map(([id, groups]) => [id, groups.map((group) => group.map((item) => item.subagentId))])).toEqual([['u1', [['x', 'y']]]])
    expect(placement.live.map((item) => item.subagentId)).toEqual(['z'])
  })

  it('places every launch in the timeline when nothing is streaming', () => {
    const placement = placeUnanchoredSubagents([at(10, 't1', 'x'), at(75, 't2', 'z')], messages, false)
    expect(placement.live).toEqual([])
    expect([...placement.afterMessage.keys()]).toEqual(['u1', 'u2'])
  })

  it('keeps launches older than every message live rather than losing them', () => {
    const placement = placeUnanchoredSubagents([node({ startedAt: '2026-10-07T09:00:00.000Z' })], messages, false)
    expect(placement.live).toHaveLength(1)
  })
})

