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

  it('covers the next step when the run stopped before one that costs more than one limit', () => {
    expect(suggestedRaise({ budgetUsd: 0.05, spentUsd: 0, nextStep: { label: 'Architect', usd: 0.13 } })).toBe(0.13)
    expect(suggestedRaise({ budgetUsd: 0.05, spentUsd: 0.02, nextStep: { label: 'Developer', usd: 0.121 } })).toBe(0.15)
    // A cheap next step keeps the "one more limit" suggestion.
    expect(suggestedRaise({ budgetUsd: 0.25, spentUsd: 0.42, nextStep: { label: 'Reviewer', usd: 0.03 } })).toBe(0.67)
  })
})
