import { describe, it, expect } from 'vitest'
import { buildFailureBriefing, describeFailureCode, failureBriefingRef, railLabel, FAILURE_BRIEFING_MAX_TAIL, FAILURE_BRIEFING_REF_KIND } from './agent-failure-briefing'

describe('buildFailureBriefing', () => {
  it('is deterministic and names rail, run, specs, step, detail, options and conduct', () => {
    const text = buildFailureBriefing({
      runId: 'run-1', railIndex: 1, railName: 'Auth', ticketIds: [12, 14], tickets: [{ id: 12, title: 'Login' }],
      failure: { code: 'implementation_failed', detail: 'verify: 3 failed', stepId: 'verify' },
      recovery: { canResume: true, recoverableSteps: ['developer'], pendingApproval: true, pendingQuestion: 'Which DB?' },
      hasDelivery: true, prDeliveryId: 'd1',
    })
    expect(text).toContain('[Specrails run-failure briefing')
    expect(text).toContain('Rail 2 (Auth) · run run-1 stopped: the verify step failed.')
    expect(text).toContain('Specs: #12 — Login, #14.')
    expect(text).toContain('Failed step: verify.')
    expect(text).toContain('Detail: verify: 3 failed')
    expect(text).toContain('waiting for an answer: "Which DB?"')
    expect(text).toContain('waiting for approval')
    expect(text).toContain('Resume (continue')
    expect(text).toContain('Recover & retry the interrupted step(s): developer')
    expect(text).toContain('Relaunch')
    expect(text).toContain('Delivery id: d1.')
    expect(text).toContain('Do NOT relaunch')
    expect(text).toContain('runtime_diagnose')
    expect(text).toContain('not a card button')
    expect(text).toContain('do not default to Relaunch')
    expect(text).not.toContain('Last output')
    expect(buildFailureBriefing({ runId: 'r', railIndex: 0, ticketIds: [], failure: { code: 'x', detail: null, stepId: null } })).toBe(
      buildFailureBriefing({ runId: 'r', railIndex: 0, ticketIds: [], failure: { code: 'x', detail: null, stepId: null } }),
    )
  })

  it('caps the output tail, notes the no-git case and unknown codes', () => {
    const tail = 'x'.repeat(FAILURE_BRIEFING_MAX_TAIL + 50)
    const text = buildFailureBriefing({ runId: 'r', railIndex: 0, ticketIds: [1], failure: { code: 'weird', detail: null, stepId: null }, outputTail: tail, hasDelivery: false })
    expect(text).toContain('Last output:')
    expect(text).toContain('…' + 'x'.repeat(FAILURE_BRIEFING_MAX_TAIL))
    expect(text).not.toContain('x'.repeat(FAILURE_BRIEFING_MAX_TAIL + 1))
    expect(text).toContain('no git isolation')
    expect(text).toContain('stopped with status "weird"')
    expect(describeFailureCode('stalled')).toContain('stalled')
    expect(railLabel(0)).toBe('Rail 1')
    expect(railLabel(2, '  ')).toBe('Rail 3')
  })

  it('emits the compact-render context ref', () => {
    expect(failureBriefingRef('run-1', 3, 'stalled')).toEqual({ kind: FAILURE_BRIEFING_REF_KIND, id: 'run-1', label: 'Run failure briefing', token: '', metadata: { railIndex: 3, code: 'stalled' } })
  })
})
