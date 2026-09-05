import { describe, expect, it } from 'vitest'
import { terminalResultError } from './terminal-result'

describe('terminalResultError', () => {
  it.each([null, 'bad JSON', {}, { type: 'result', subtype: 'success', is_error: false }])('accepts absent or successful error signals: %j', (payload) => {
    expect(terminalResultError(payload)).toBeNull()
  })

  it('ignores recoverable tool failures, including nested errors on a successful result', () => {
    expect(terminalResultError({ type: 'tool_result', is_error: true, content: 'test failed' })).toBeNull()
    expect(terminalResultError({ type: 'result', subtype: 'success', tool_results: [{ is_error: true }] })).toBeNull()
  })

  it('preserves a useful bounded error reason', () => {
    expect(terminalResultError({ type: 'result', subtype: 'error_max_turns', errors: ['turn limit', 'work incomplete'] })).toBe('error_max_turns: turn limit; work incomplete')
    expect(terminalResultError({ type: 'result', is_error: true, result: 'x'.repeat(5000) })?.length).toBe(2000)
  })
})
