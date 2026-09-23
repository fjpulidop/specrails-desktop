import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSpecFilters,
  saveSpecFilters,
  isEmptySpecFilters,
  EMPTY_SPEC_FILTERS,
  type SpecFilters,
} from '../spec-filters'

const KEY = (p: string) => `specrails-desktop:spec-filters:${p}`

function mk(partial: Partial<SpecFilters> = {}): SpecFilters {
  return { labels: new Set(), epic: null, sprint: null, jiraStatus: null, ...partial }
}

describe('spec-filters', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty filters when projectId is null', () => {
    const f = loadSpecFilters(null)
    expect(f.labels.size).toBe(0)
    expect(f.epic).toBeNull()
    expect(f.sprint).toBeNull()
  })

  it('returns empty filters when nothing stored', () => {
    const f = loadSpecFilters('p1')
    expect(isEmptySpecFilters(f)).toBe(true)
  })

  it('round-trips labels', () => {
    saveSpecFilters('p1', mk({ labels: new Set(['bug', 'ui']) }))
    const f = loadSpecFilters('p1')
    expect([...f.labels].sort()).toEqual(['bug', 'ui'])
    expect(f.epic).toBeNull()
    expect(f.sprint).toBeNull()
  })

  it('round-trips epic + sprint', () => {
    saveSpecFilters('p1', mk({ epic: 'PROJ-100', sprint: '42' }))
    const f = loadSpecFilters('p1')
    expect(f.epic).toBe('PROJ-100')
    expect(f.sprint).toBe('42')
  })

  it('round-trips all three together', () => {
    saveSpecFilters('p1', { labels: new Set(['x']), epic: 'E-1', sprint: 'S-1' })
    const f = loadSpecFilters('p1')
    expect([...f.labels]).toEqual(['x'])
    expect(f.epic).toBe('E-1')
    expect(f.sprint).toBe('S-1')
  })

  it('scopes storage per projectId', () => {
    saveSpecFilters('p1', mk({ epic: 'A' }))
    saveSpecFilters('p2', mk({ epic: 'B' }))
    expect(loadSpecFilters('p1').epic).toBe('A')
    expect(loadSpecFilters('p2').epic).toBe('B')
  })

  it('removes the key (and reads as empty) when all filters cleared', () => {
    saveSpecFilters('p1', mk({ epic: 'A', labels: new Set(['l']) }))
    expect(localStorage.getItem(KEY('p1'))).not.toBeNull()
    saveSpecFilters('p1', EMPTY_SPEC_FILTERS)
    expect(localStorage.getItem(KEY('p1'))).toBeNull()
    expect(isEmptySpecFilters(loadSpecFilters('p1'))).toBe(true)
  })

  it('save no-ops when projectId is null', () => {
    saveSpecFilters(null, mk({ epic: 'A' }))
    expect(localStorage.length).toBe(0)
  })

  it('returns empty on malformed JSON', () => {
    localStorage.setItem(KEY('p1'), '{not json')
    expect(isEmptySpecFilters(loadSpecFilters('p1'))).toBe(true)
  })

  it('returns empty when stored value is not an object', () => {
    localStorage.setItem(KEY('p1'), '"a string"')
    expect(isEmptySpecFilters(loadSpecFilters('p1'))).toBe(true)
  })

  it('ignores non-string labels and non-string epic/sprint', () => {
    localStorage.setItem(
      KEY('p1'),
      JSON.stringify({ labels: ['ok', 3, null], epic: 5, sprint: { x: 1 } }),
    )
    const f = loadSpecFilters('p1')
    expect([...f.labels]).toEqual(['ok'])
    expect(f.epic).toBeNull()
    expect(f.sprint).toBeNull()
  })

  it('treats empty-string epic/sprint as null', () => {
    localStorage.setItem(KEY('p1'), JSON.stringify({ labels: [], epic: '', sprint: '' }))
    const f = loadSpecFilters('p1')
    expect(f.epic).toBeNull()
    expect(f.sprint).toBeNull()
  })

  it('survives localStorage throwing on read', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    try {
      expect(isEmptySpecFilters(loadSpecFilters('p1'))).toBe(true)
    } finally {
      Storage.prototype.getItem = orig
    }
  })

  it('survives localStorage throwing on write', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(() => saveSpecFilters('p1', mk({ epic: 'A' }))).not.toThrow()
    } finally {
      Storage.prototype.setItem = orig
    }
  })

  it('isEmptySpecFilters reflects each field', () => {
    expect(isEmptySpecFilters(mk())).toBe(true)
    expect(isEmptySpecFilters(mk({ labels: new Set(['a']) }))).toBe(false)
    expect(isEmptySpecFilters(mk({ epic: 'E' }))).toBe(false)
    expect(isEmptySpecFilters(mk({ sprint: 'S' }))).toBe(false)
    expect(isEmptySpecFilters(mk({ jiraStatus: 'Code Review' }))).toBe(false)
  })

  it('round-trips jiraStatus (raw Jira workflow status name)', () => {
    saveSpecFilters('p1', mk({ jiraStatus: 'Code Review' }))
    const f = loadSpecFilters('p1')
    expect(f.jiraStatus).toBe('Code Review')
    expect(f.labels.size).toBe(0)
  })

  it('reads a pre-jiraStatus blob as jiraStatus null (additive field)', () => {
    localStorage.setItem(KEY('p1'), JSON.stringify({ labels: ['a'], epic: 'E-1', sprint: null }))
    const f = loadSpecFilters('p1')
    expect(f.jiraStatus).toBeNull()
    expect([...f.labels]).toEqual(['a'])
    expect(f.epic).toBe('E-1')
  })
})
