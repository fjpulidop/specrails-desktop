import { describe, it, expect } from 'vitest'
import { RUN_STATES } from '../../../../components/ui/run-state/run-state'
import { LOOP_CHIP_RUN_STATE, LOOP_STEP_RUN_STATE, loopChipRunState, loopStepRunState } from '../loop-run-state'

describe('loop steps → run state', () => {
  it('covers every step status and chip state with a vocabulary state', () => {
    expect(Object.keys(LOOP_STEP_RUN_STATE).sort()).toEqual(['failed', 'interrupted', 'ok', 'paused', 'pending', 'running', 'stalled', 'unknown'])
    expect(Object.keys(LOOP_CHIP_RUN_STATE).sort()).toEqual(['failed', 'interrupted', 'ok', 'paused', 'pending', 'running'])
    for (const state of [...Object.values(LOOP_STEP_RUN_STATE), ...Object.values(LOOP_CHIP_RUN_STATE)]) expect(RUN_STATES).toContain(state)
  })

  it('running is working, ok is done, a plain failure is failed', () => {
    expect(loopStepRunState('running')).toBe('working')
    expect(loopStepRunState('ok')).toBe('done')
    expect(loopStepRunState('failed')).toBe('failed')
    expect(loopStepRunState('failed', 'exit_code')).toBe('failed')
    expect(loopStepRunState('pending')).toBe('queued')
  })

  it('a provider-limit failure is blocked', () => {
    expect(loopStepRunState('failed', 'provider_limit')).toBe('blocked')
    expect(loopStepRunState('ok', 'provider_limit')).toBe('done')
  })

  it('stalled and interrupted steps are paused', () => {
    expect(loopStepRunState('stalled')).toBe('paused')
    expect(loopStepRunState('interrupted')).toBe('paused')
    expect(loopStepRunState('paused')).toBe('paused')
    expect(loopChipRunState('interrupted')).toBe('paused')
    expect(loopChipRunState('running')).toBe('working')
  })
})
