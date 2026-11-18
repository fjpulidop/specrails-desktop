import { describe, it, expect } from 'vitest'
import { INTENT_RUN_STATE, intentRunState } from '../lib/intent-run-tone'
import type { IntentState } from '../lib/intent-api'

describe('Intent state → run state', () => {
  it('maps every Intent state', () => {
    const expected: Record<IntentState, string> = {
      active: 'working', paused: 'paused', 'needs-review': 'blocked', handed_off: 'done', delivered: 'done', discarded: 'stopped', closed: 'stopped',
    }
    expect(INTENT_RUN_STATE).toEqual(expected)
    expect(intentRunState('active')).toBe('working')
  })
})
