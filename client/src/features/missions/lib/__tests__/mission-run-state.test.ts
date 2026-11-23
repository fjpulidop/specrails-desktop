import { describe, it, expect } from 'vitest'
import { RUN_STATES } from '../../../../components/ui/run-state/run-state'
import {
  MISSION_RUN_STATUS_STATE, MISSION_TONE_RUN_STATE, SPEC_ACTIVITY_RUN_STATE, SUBAGENT_PHASE_RUN_STATE,
  deliveryStripRunState, missionRowRunState, missionRunStatusState, missionToneRunState, specActivityRunState, subagentRunState,
} from '../mission-run-state'
import type { AgentPrDecisionEnvelope } from '../agent-api'

type Env = Pick<AgentPrDecisionEnvelope, 'decision' | 'runtime' | 'statusCode'>
const env = (over: Partial<Env>): Env => ({ decision: 'on_review', runtime: null, statusCode: null, ...over } as Env)

describe('mission run states', () => {
  it('maps every value to a known RunState', () => {
    for (const table of [MISSION_TONE_RUN_STATE, MISSION_RUN_STATUS_STATE, SPEC_ACTIVITY_RUN_STATE, SUBAGENT_PHASE_RUN_STATE]) {
      for (const state of Object.values(table)) expect(RUN_STATES).toContain(state)
    }
  })

  it('maps strip tones', () => {
    expect(missionToneRunState('running')).toBe('working')
    expect(missionToneRunState('launching')).toBe('queued')
    expect(missionToneRunState('decision')).toBe('review')
    expect(missionToneRunState('failed')).toBe('failed')
    expect(missionToneRunState('paused')).toBe('paused')
    expect(missionToneRunState('info')).toBe('stopped')
  })

  it('maps the card run-phase status', () => {
    expect(missionRunStatusState('running')).toBe('working')
    expect(missionRunStatusState('stalled')).toBe('paused')
    expect(missionRunStatusState('cancelled')).toBe('stopped')
    expect(missionRunStatusState('succeeded')).toBe('done')
    expect(missionRunStatusState('changes_requested')).toBe('blocked')
    expect(missionRunStatusState('returned')).toBe('stopped')
  })

  it('maps spec activity and subagent phases', () => {
    expect(specActivityRunState('running')).toBe('working')
    expect(specActivityRunState('waiting')).toBe('review')
    expect(subagentRunState('running')).toBe('working')
    expect(subagentRunState('idle')).toBe('done')
    expect(subagentRunState('failed')).toBe('failed')
    expect(subagentRunState('killed')).toBe('stopped')
  })

  it('refines a delivery in the strip', () => {
    expect(deliveryStripRunState(env({}), 'decision', null)).toBe('review')
    expect(deliveryStripRunState(env({ decision: 'building' }), 'decision', { pendingApproval: true, stalled: false })).toBe('needs-input')
    expect(deliveryStripRunState(env({ decision: 'implementation_failed', statusCode: 'review_changes_requested' }), 'decision', null)).toBe('blocked')
    expect(deliveryStripRunState(env({ decision: 'building' }), 'failed', { pendingApproval: false, stalled: true })).toBe('paused')
    expect(deliveryStripRunState(env({ decision: 'pr_failed' }), 'failed', null)).toBe('failed')
    expect(deliveryStripRunState(env({ decision: 'no_changes' }), 'info', null)).toBe('done')
    expect(deliveryStripRunState(env({ decision: 'pr_closed' }), 'info', null)).toBe('stopped')
    expect(deliveryStripRunState(env({ decision: 'implementation_failed', statusCode: 'run_stopped' }), 'info', null)).toBe('stopped')
    expect(deliveryStripRunState(env({ decision: 'building' }), 'running', null)).toBe('working')
  })

  it('maps a mission row: what waits for the person first, then live work, then an unread reply', () => {
    const quiet = { attention: null, streaming: false, unread: false }
    expect(missionRowRunState(quiet)).toBeNull()
    expect(missionRowRunState({ ...quiet, unread: true })).toBe('needs-input')
    expect(missionRowRunState({ ...quiet, streaming: true, unread: true })).toBe('working')
    expect(missionRowRunState({ attention: 'decision', streaming: true, unread: true })).toBe('review')
    expect(missionRowRunState({ attention: 'failed', streaming: true, unread: false })).toBe('failed')
  })
})
