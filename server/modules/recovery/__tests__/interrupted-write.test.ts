import { describe, expect, it } from 'vitest'
import { deriveFailureDiagnosis } from '../domain'

describe('interrupted write refused on resume', () => {
  it('is a known, continuable cause instead of an unknown one', () => {
    const d = deriveFailureDiagnosis({ outcome: 'failed', errorText: 'An interrupted write requires explicit recovery' })
    expect(d).toMatchObject({ kind: 'crash', confidence: 'high' })
    expect(d.detail).toMatch(/Continue re-runs that step/)
  })
})
