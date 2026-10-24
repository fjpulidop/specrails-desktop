import { describe, it, expect } from 'vitest'
import { normalizeSpecQuery, specMatchesQuery } from '../spec-search'
import type { LocalTicket } from '../../../../types'

function ticket(over: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 13,
    title: 'Paddle physics',
    description: '',
    status: 'todo',
    priority: 'medium',
    labels: ['gameplay'],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester',
    source: 'manual',
    ...over,
  }
}

describe('spec search', () => {
  it('normalizes by trimming and lower-casing', () => {
    expect(normalizeSpecQuery('  PaDDle ')).toBe('paddle')
  })

  it('an empty query matches everything', () => {
    expect(specMatchesQuery(ticket(), '')).toBe(true)
  })

  it('matches a title substring, case-insensitively', () => {
    expect(specMatchesQuery(ticket(), normalizeSpecQuery('PHYS'))).toBe(true)
    expect(specMatchesQuery(ticket(), 'brick')).toBe(false)
  })

  it('matches the id with or without a leading #', () => {
    expect(specMatchesQuery(ticket(), '#13')).toBe(true)
    expect(specMatchesQuery(ticket(), '13')).toBe(true)
    expect(specMatchesQuery(ticket(), '#1')).toBe(false)
    // A numeric query still matches a title that contains it.
    expect(specMatchesQuery(ticket({ title: 'Level 42 boss' }), '42')).toBe(true)
  })

  it('matches the Jira key and labels', () => {
    expect(specMatchesQuery(ticket({ jira_key: 'PROJ-7' }), normalizeSpecQuery('proj-7'))).toBe(true)
    expect(specMatchesQuery(ticket(), 'gameplay')).toBe(true)
  })

  it('never throws on null labels or Jira key', () => {
    const t = ticket({ labels: null as unknown as string[], jira_key: null as unknown as string })
    expect(specMatchesQuery(t, 'anything')).toBe(false)
  })
})
