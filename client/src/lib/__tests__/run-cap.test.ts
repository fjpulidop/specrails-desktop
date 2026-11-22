import { describe, it, expect } from 'vitest'
import { isValidRaise, suggestedRaise } from '../run-cap'

describe('suggestedRaise', () => {
  it('suggests one more limit above what the run spent', () => {
    expect(suggestedRaise({ budgetUsd: 0.25, spentUsd: 0.42 })).toBe(0.67)
  })

  it('never suggests an amount the dialog would refuse (a sub-cent limit, nothing spent)', () => {
    const info = { budgetUsd: 0.0001, spentUsd: 0 }
    expect(suggestedRaise(info)).toBe(0.01)
    expect(isValidRaise(suggestedRaise(info), info)).toBe(true)
  })
})
