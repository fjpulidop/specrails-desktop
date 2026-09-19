import { describe, it, expect, vi } from 'vitest'
import {
  parseRunFailureRow, systemBriefingRunId, focusPrCard, focusMatchesCard, FOCUS_PR_CARD_EVENT,
  requestMissionOpenRun, MISSION_OPEN_RUN_EVENT,
} from '../agent-run-failure'

const row = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'run-failure', runId: 'r1', railIndex: 1, projectId: 'p1', code: 'stalled', detail: 'idle 30m', stepId: 'verify', at: '2026-09-18T00:00:00Z', ...over,
})

describe('parseRunFailureRow', () => {
  it('parses a valid row and normalizes optional fields', () => {
    expect(parseRunFailureRow(row())).toEqual({
      kind: 'run-failure', runId: 'r1', railIndex: 1, projectId: 'p1', code: 'stalled', detail: 'idle 30m', stepId: 'verify', at: '2026-09-18T00:00:00Z',
    })
    expect(parseRunFailureRow(row({ detail: '  ', stepId: '', at: 5, prDeliveryId: null }))).toMatchObject({ detail: null, stepId: null, at: null, prDeliveryId: null })
    expect(parseRunFailureRow(row({ prDeliveryId: 'd1' }))?.prDeliveryId).toBe('d1')
  })
  it('rejects foreign / malformed rows', () => {
    expect(parseRunFailureRow('nope')).toBeNull()
    expect(parseRunFailureRow(JSON.stringify({ kind: 'pr_decision' }))).toBeNull()
    expect(parseRunFailureRow(row({ runId: '' }))).toBeNull()
    expect(parseRunFailureRow(row({ railIndex: -1 }))).toBeNull()
    expect(parseRunFailureRow(row({ code: 7 }))).toBeNull()
    expect(parseRunFailureRow('[1]')).toBeNull()
  })
})

describe('systemBriefingRunId', () => {
  it('detects the server-authored briefing user row only', () => {
    expect(systemBriefingRunId({ role: 'user', context_refs: [{ kind: 'system-briefing', id: 'r9', label: 'run failure', token: '' }] })).toBe('r9')
    expect(systemBriefingRunId({ role: 'assistant', context_refs: [{ kind: 'system-briefing', id: 'r9', label: '', token: '' }] })).toBeNull()
    expect(systemBriefingRunId({ role: 'user', context_refs: [{ kind: 'spec', id: '1', label: '', token: '#1' }] })).toBeNull()
    expect(systemBriefingRunId({ role: 'user' })).toBeNull()
  })
})

describe('focus bus', () => {
  it('dispatches and matches by delivery id or run id (incl. synthetic run: ids)', () => {
    const seen: unknown[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(FOCUS_PR_CARD_EVENT, on)
    focusPrCard({ runIds: ['r1'] })
    window.removeEventListener(FOCUS_PR_CARD_EVENT, on)
    expect(seen).toEqual([{ runIds: ['r1'] }])
    expect(focusMatchesCard({ prDeliveryId: 'd1' }, { prDeliveryId: 'd1' })).toBe(true)
    expect(focusMatchesCard({ runIds: ['r1'] }, { prDeliveryId: 'd1', runIds: ['r0', 'r1'] })).toBe(true)
    expect(focusMatchesCard({ runIds: ['r1'] }, { prDeliveryId: 'run:r1' })).toBe(true)
    expect(focusMatchesCard({ runIds: ['r2'] }, { prDeliveryId: 'd1', runIds: ['r1'] })).toBe(false)
    expect(focusMatchesCard(null, { prDeliveryId: 'd1' })).toBe(false)
  })
  it('requestMissionOpenRun dispatches the mission open-run event', () => {
    const spy = vi.fn()
    window.addEventListener(MISSION_OPEN_RUN_EVENT, spy)
    requestMissionOpenRun({ projectId: 'p1', jobId: 'j1' })
    window.removeEventListener(MISSION_OPEN_RUN_EVENT, spy)
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectId: 'p1', jobId: 'j1' })
  })
})
