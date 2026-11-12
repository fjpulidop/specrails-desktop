import { describe, it, expect } from 'vitest'
import { filterActiveConversations } from './filterActiveConversations'

const convs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

describe('filterActiveConversations', () => {
  it('keeps only live conversations', () => {
    expect(filterActiveConversations(convs, new Set(['b', 'd']), null)).toEqual([{ id: 'b' }, { id: 'd' }])
  })

  it('keeps the open conversation even when it is not live', () => {
    expect(filterActiveConversations(convs, new Set(['b']), 'c')).toEqual([{ id: 'b' }, { id: 'c' }])
  })

  it('ignores a null activeId', () => {
    expect(filterActiveConversations(convs, new Set(), null)).toEqual([])
  })

  it('ignores an undefined activeId', () => {
    expect(filterActiveConversations(convs, new Set(), undefined)).toEqual([])
  })

  it('returns an empty list for empty input', () => {
    expect(filterActiveConversations([], new Set(['a']), 'a')).toEqual([])
  })

  it('preserves the original order', () => {
    expect(filterActiveConversations(convs, new Set(['d', 'a']), 'c').map((c) => c.id)).toEqual(['a', 'c', 'd'])
  })
})
