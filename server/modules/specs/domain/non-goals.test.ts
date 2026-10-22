import { describe, expect, it } from 'vitest'
import {
  NON_GOALS_MAX_ITEMS, NON_GOAL_MAX_CHARS, descriptionWithNonGoals, extractOutOfScopeSection,
  normalizeNonGoals, parseNonGoalsText, renderNonGoalsSection, validateNonGoals,
} from './non-goals'

describe('ticket non-goals', () => {
  it('validates caller input: arrays of strings, null clears, anything else is rejected', () => {
    expect(validateNonGoals(['- one', ' two ', '', 'one'])).toEqual({ ok: true, nonGoals: ['one', 'two'] })
    expect(validateNonGoals(null)).toEqual({ ok: true, nonGoals: [] })
    expect(validateNonGoals('one')).toEqual({ ok: false, error: 'nonGoals must be an array of strings' })
    expect(validateNonGoals([1])).toMatchObject({ ok: false })
  })

  it('bounds the list and each item, and tolerates junk on read', () => {
    const many = Array.from({ length: 40 }, (_, i) => `item ${i}`)
    expect(normalizeNonGoals(many)).toHaveLength(NON_GOALS_MAX_ITEMS)
    expect(normalizeNonGoals(['x'.repeat(NON_GOAL_MAX_CHARS + 50)])[0]).toHaveLength(NON_GOAL_MAX_CHARS)
    expect(normalizeNonGoals('nope')).toEqual([])
    expect(normalizeNonGoals([null, 3, '  ', '1. numbered', '* starred'])).toEqual(['numbered', 'starred'])
  })

  it('splits the modal text one item per line', () => {
    expect(parseNonGoalsText('- a\r\n\n  b  \n- a')).toEqual(['a', 'b'])
  })

  it('moves the Out of Scope section out of a generated description', () => {
    const body = '## Problem Statement\nP\n\n## Out of Scope\n- Mobile\n- Exports\n\n## Acceptance Criteria\n1. Works'
    expect(extractOutOfScopeSection(body)).toEqual({
      description: '## Problem Statement\nP\n\n## Acceptance Criteria\n1. Works',
      nonGoals: ['Mobile', 'Exports'],
    })
    expect(extractOutOfScopeSection('## Non-Goals\n- Later').nonGoals).toEqual(['Later'])
    expect(extractOutOfScopeSection('## Problem\nnothing')).toEqual({ description: '## Problem\nnothing', nonGoals: [] })
  })

  it('renders the section agents receive and never duplicates an existing one', () => {
    expect(renderNonGoalsSection(['a', 'b'])).toBe('## Out of Scope\n- a\n- b')
    expect(renderNonGoalsSection([])).toBe('')
    expect(descriptionWithNonGoals('Body', ['a'])).toBe('Body\n\n## Out of Scope\n- a')
    expect(descriptionWithNonGoals('', ['a'])).toBe('## Out of Scope\n- a')
    expect(descriptionWithNonGoals(null, undefined)).toBe('')
    expect(descriptionWithNonGoals('Body\n## Out of Scope\n- old', ['a'])).toBe('Body\n## Out of Scope\n- old')
  })
})
