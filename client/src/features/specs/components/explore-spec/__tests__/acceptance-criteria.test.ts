import { describe, it, expect } from 'vitest'
import { parseAcceptanceCriteria, formatWithCriteria } from '../acceptance-criteria'

describe('parseAcceptanceCriteria', () => {
  it('returns empty criteria when no section is present', () => {
    const r = parseAcceptanceCriteria('## Problem Statement\n\nFoo.')
    expect(r.criteria).toEqual([])
    expect(r.body).toBe('## Problem Statement\n\nFoo.')
  })

  it('returns empty result for empty description', () => {
    expect(parseAcceptanceCriteria('')).toEqual({ body: '', criteria: [] })
  })

  it('extracts a standard section with - bullets', () => {
    const input = '## Problem\n\nIssue.\n\n## Acceptance Criteria\n\n- one\n- two\n- three'
    const r = parseAcceptanceCriteria(input)
    expect(r.body).toBe('## Problem\n\nIssue.')
    expect(r.criteria).toEqual(['one', 'two', 'three'])
  })

  it('handles mixed bullet styles (- and *)', () => {
    const input = '## Acceptance Criteria\n\n- one\n* two\n+ three'
    const r = parseAcceptanceCriteria(input)
    expect(r.criteria).toEqual(['one', 'two', 'three'])
  })

  it('parses an empty body + criteria-only document', () => {
    const r = parseAcceptanceCriteria('## Acceptance Criteria\n\n- solo')
    expect(r.body).toBe('')
    expect(r.criteria).toEqual(['solo'])
  })

  it('preserves trailing sections after the criteria', () => {
    const input = '## A\n\nfoo\n\n## Acceptance Criteria\n\n- crit\n\n## Z\n\ntrailing'
    const r = parseAcceptanceCriteria(input)
    expect(r.criteria).toEqual(['crit'])
    expect(r.body).toContain('## A\n\nfoo')
    expect(r.body).toContain('## Z\n\ntrailing')
  })

  it('is case-insensitive on the heading', () => {
    const r = parseAcceptanceCriteria('## acceptance criteria\n\n- x')
    expect(r.criteria).toEqual(['x'])
  })

  it('trims bullet whitespace', () => {
    const r = parseAcceptanceCriteria('## Acceptance Criteria\n\n-   spaced   ')
    expect(r.criteria).toEqual(['spaced'])
  })
})

describe('formatWithCriteria', () => {
  it('appends a section to a body when criteria non-empty', () => {
    expect(formatWithCriteria('Body.', ['A'])).toBe('Body.\n\n## Acceptance Criteria\n\n- A')
  })

  it('returns body unchanged when criteria empty', () => {
    expect(formatWithCriteria('Body.', [])).toBe('Body.')
  })

  it('returns just the section when body is empty', () => {
    expect(formatWithCriteria('', ['solo'])).toBe('## Acceptance Criteria\n\n- solo')
  })
})

describe('parse → format round-trip', () => {
  it('is stable for a typical input', () => {
    const input = '## Problem\n\nIssue.\n\n## Acceptance Criteria\n\n- one\n- two'
    const parsed = parseAcceptanceCriteria(input)
    const out = formatWithCriteria(parsed.body, parsed.criteria)
    expect(out).toBe(input)
  })

  it('normalises whitespace on round-trip when input has trailing newlines', () => {
    const input = '## Problem\n\nIssue.\n\n## Acceptance Criteria\n\n- one\n\n'
    const parsed = parseAcceptanceCriteria(input)
    const out = formatWithCriteria(parsed.body, parsed.criteria)
    expect(out).toBe('## Problem\n\nIssue.\n\n## Acceptance Criteria\n\n- one')
  })
})
