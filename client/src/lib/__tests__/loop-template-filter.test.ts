import { describe, it, expect } from 'vitest'
import { filterTemplates, categoryCounts, LOOP_CATEGORY_ORDER } from '../loop-template-filter'

const T = (over: Partial<{ id: string; name: string; description: string; tags: string[]; category: string }>) => ({
  id: over.id ?? 'x',
  name: over.name ?? 'Name',
  description: over.description ?? 'Desc',
  tags: over.tags ?? [],
  category: over.category,
})

const SAMPLE = [
  T({ id: 'a', name: 'Flaky Test Triage', description: 'classify failures', category: 'Testing', tags: ['testing', 'flaky'] }),
  T({ id: 'b', name: 'Merge Conflict Resolver', description: 'resolve conflicts', category: 'Git', tags: ['git'] }),
  T({ id: 'c', name: 'A11y Audit', description: 'accessibility checks', category: 'Quality', tags: ['a11y', 'frontend'] }),
  T({ id: 'd', name: 'Coverage Climb', description: 'add tests for coverage', category: 'Testing', tags: ['coverage'] }),
]

describe('filterTemplates', () => {
  it('returns everything for an empty filter', () => {
    expect(filterTemplates(SAMPLE, { query: '', categories: [] })).toHaveLength(4)
  })

  it('matches the query against name, description, tags and category (case-insensitive)', () => {
    expect(filterTemplates(SAMPLE, { query: 'flaky', categories: [] }).map((t) => t.id)).toEqual(['a'])
    expect(filterTemplates(SAMPLE, { query: 'CONFLICT', categories: [] }).map((t) => t.id)).toEqual(['b'])
    expect(filterTemplates(SAMPLE, { query: 'frontend', categories: [] }).map((t) => t.id)).toEqual(['c'])
    // category text is searchable too
    expect(filterTemplates(SAMPLE, { query: 'git', categories: [] }).map((t) => t.id)).toEqual(['b'])
  })

  it('filters by a single category', () => {
    expect(filterTemplates(SAMPLE, { query: '', categories: ['Testing'] }).map((t) => t.id)).toEqual(['a', 'd'])
  })

  it('unions multiple selected categories', () => {
    expect(filterTemplates(SAMPLE, { query: '', categories: ['Git', 'Quality'] }).map((t) => t.id)).toEqual(['b', 'c'])
  })

  it('combines query AND category (intersection)', () => {
    expect(filterTemplates(SAMPLE, { query: 'coverage', categories: ['Testing'] }).map((t) => t.id)).toEqual(['d'])
    expect(filterTemplates(SAMPLE, { query: 'coverage', categories: ['Git'] })).toHaveLength(0)
  })

  it('whitespace-only query is treated as empty', () => {
    expect(filterTemplates(SAMPLE, { query: '   ', categories: [] })).toHaveLength(4)
  })

  it('also matches localized searchTerms (text not present in the raw fields)', () => {
    const localized = [
      { ...T({ id: 'a', name: 'Flaky Test Triage', description: 'classify failures', category: 'Testing' }), searchTerms: 'Triaje de tests inestables pruebas' },
      { ...T({ id: 'b', name: 'Merge Conflict Resolver', description: 'resolve conflicts', category: 'Git' }), searchTerms: 'Resolución de conflictos' },
    ]
    // "inestables" appears only in the searchTerms of a, not in any raw field
    expect(filterTemplates(localized, { query: 'inestables', categories: [] }).map((t) => t.id)).toEqual(['a'])
    expect(filterTemplates(localized, { query: 'conflictos', categories: [] }).map((t) => t.id)).toEqual(['b'])
  })
})

describe('categoryCounts', () => {
  it('counts per present category in canonical taxonomy order', () => {
    expect(categoryCounts(SAMPLE)).toEqual([
      { category: 'Git', count: 1 },
      { category: 'Quality', count: 1 },
      { category: 'Testing', count: 2 },
    ])
  })

  it('omits categories with no templates and ignores templates without a category', () => {
    const counts = categoryCounts([...SAMPLE, T({ id: 'e' })])
    expect(counts.find((c) => c.category === 'Performance')).toBeUndefined()
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(4)
  })

  it('canonical order matches the 15-value taxonomy', () => {
    expect(LOOP_CATEGORY_ORDER).toHaveLength(15)
    expect(LOOP_CATEGORY_ORDER[0]).toBe('API')
    expect(LOOP_CATEGORY_ORDER[LOOP_CATEGORY_ORDER.length - 1]).toBe('Testing')
  })
})
