import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  resolveLoopStepIdleTimeoutMs,
  LOOP_STEP_IDLE_DEFAULT_MS,
  _resetLoopStepIdleWarningForTests,
} from './loop-step-idle'
import { STUCK_FLOOR_MS } from './stuck-run-detector'

describe('resolveLoopStepIdleTimeoutMs', () => {
  beforeEach(() => _resetLoopStepIdleWarningForTests())

  it('defaults to 30 minutes when the env var is unset', () => {
    expect(resolveLoopStepIdleTimeoutMs({})).toBe(LOOP_STEP_IDLE_DEFAULT_MS)
    expect(LOOP_STEP_IDLE_DEFAULT_MS).toBe(30 * 60 * 1000)
  })

  it('treats an empty value as unset', () => {
    expect(resolveLoopStepIdleTimeoutMs({ SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: '' })).toBe(LOOP_STEP_IDLE_DEFAULT_MS)
  })

  it.each(['0', 'false', 'off', ' OFF ', 'False'])('%s disables the watchdog (0)', (raw) => {
    expect(resolveLoopStepIdleTimeoutMs({ SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: raw })).toBe(0)
  })

  it('honours an explicit value above the stuck floor', () => {
    const v = 45 * 60 * 1000
    expect(resolveLoopStepIdleTimeoutMs({ SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: String(v) })).toBe(v)
  })

  it('falls back to the default on garbage / negative values', () => {
    expect(resolveLoopStepIdleTimeoutMs({ SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: 'soon' })).toBe(LOOP_STEP_IDLE_DEFAULT_MS)
    expect(resolveLoopStepIdleTimeoutMs({ SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: '-5' })).toBe(LOOP_STEP_IDLE_DEFAULT_MS)
  })

  it('clamps a value below the stuck threshold up to it and warns ONCE', () => {
    const warn = vi.fn()
    const env = { SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: '60000' }
    expect(resolveLoopStepIdleTimeoutMs(env, warn)).toBe(STUCK_FLOOR_MS)
    expect(resolveLoopStepIdleTimeoutMs(env, warn)).toBe(STUCK_FLOOR_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('clamping')
  })

  it('clamps against a RAISED stuck threshold', () => {
    const warn = vi.fn()
    const raised = 20 * 60 * 1000
    const env = { SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: '900000', SPECRAILS_STUCK_THRESHOLD_MS: String(raised) }
    expect(resolveLoopStepIdleTimeoutMs(env, warn)).toBe(raised)
  })

  it('does not clamp when stuck detection is disabled', () => {
    const warn = vi.fn()
    const env = { SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: '60000', SPECRAILS_STUCK_THRESHOLD_MS: 'off' }
    expect(resolveLoopStepIdleTimeoutMs(env, warn)).toBe(60000)
    expect(warn).not.toHaveBeenCalled()
  })
})
