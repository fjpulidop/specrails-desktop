import { describe, it, expect } from 'vitest'
import { railIdFromIndex, railIndexFromId, MAX_RAILS } from '../rail-id'

describe('rail-id (client rail id ⇄ server railIndex identity mapping)', () => {
  it('railIdFromIndex is 1-based: 0 → rail-1', () => {
    expect(railIdFromIndex(0)).toBe('rail-1')
    expect(railIdFromIndex(3)).toBe('rail-4')
    expect(railIdFromIndex(11)).toBe('rail-12')
  })

  it('railIndexFromId parses canonical ids back to 0-based indices', () => {
    expect(railIndexFromId('rail-1')).toBe(0)
    expect(railIndexFromId('rail-4')).toBe(3)
    expect(railIndexFromId('rail-12')).toBe(11)
  })

  it('round-trips', () => {
    for (let i = 0; i < MAX_RAILS; i++) {
      expect(railIndexFromId(railIdFromIndex(i))).toBe(i)
    }
  })

  it('returns null for non-canonical ids (callers fall back to array position)', () => {
    expect(railIndexFromId('rail-loop')).toBeNull()
    expect(railIndexFromId('rail-')).toBeNull()
    expect(railIndexFromId('rail-0')).toBeNull() // ids are 1-based
    expect(railIndexFromId('rail--3')).toBeNull()
    expect(railIndexFromId('specs')).toBeNull()
    expect(railIndexFromId('')).toBeNull()
    expect(railIndexFromId('rail-1.5')).toBeNull()
  })

  it('mirrors the server cap', () => {
    expect(MAX_RAILS).toBe(12)
  })
})
