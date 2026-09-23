import { describe, it, expect } from 'vitest'
import { wordDiff, arrayDiff } from '../diff-utils'

describe('wordDiff', () => {
  it('returns a single unchanged segment when inputs are identical', () => {
    const out = wordDiff('hello world', 'hello world')
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ value: 'hello world' })
  })

  it('marks every word as added when baseline is empty', () => {
    const out = wordDiff('', 'add a new spec')
    expect(out.every((p) => p.added)).toBe(true)
    expect(out.map((p) => p.value).join('')).toBe('add a new spec')
  })

  it('marks every word as removed when proposed is empty', () => {
    const out = wordDiff('old spec body', '')
    expect(out.every((p) => p.removed)).toBe(true)
    expect(out.map((p) => p.value).join('')).toBe('old spec body')
  })

  it('isolates single-word substitutions', () => {
    const out = wordDiff('Users cannot change the OS theme.', 'Users cannot override the OS theme.')
    const removed = out.filter((p) => p.removed).map((p) => p.value.trim())
    const added = out.filter((p) => p.added).map((p) => p.value.trim())
    expect(removed).toContain('change')
    expect(added).toContain('override')
    const unchanged = out.filter((p) => !p.added && !p.removed).map((p) => p.value).join('')
    expect(unchanged).toContain('Users cannot')
    expect(unchanged).toContain('the OS theme.')
  })

  it('treats completely different strings as removed + added segments', () => {
    const out = wordDiff('one two three', 'alpha beta gamma')
    expect(out.some((p) => p.removed)).toBe(true)
    expect(out.some((p) => p.added)).toBe(true)
  })
})

describe('arrayDiff', () => {
  it('returns empty result for empty inputs', () => {
    expect(arrayDiff<string>([], [])).toEqual({ added: [], removed: [], unchanged: [], ordered: [] })
  })

  it('classifies all proposed items as added when baseline is empty', () => {
    const r = arrayDiff([], ['ui', 'theme'])
    expect(r.added).toEqual(['ui', 'theme'])
    expect(r.removed).toEqual([])
    expect(r.unchanged).toEqual([])
  })

  it('classifies all baseline items as removed when proposed is empty', () => {
    const r = arrayDiff(['old', 'misc'], [])
    expect(r.added).toEqual([])
    expect(r.removed).toEqual(['old', 'misc'])
    expect(r.unchanged).toEqual([])
  })

  it('classifies mixed added / removed / unchanged correctly', () => {
    const r = arrayDiff(['ui', 'misc'], ['ui', 'theme', 'settings'])
    expect(r.unchanged).toEqual(['ui'])
    expect(r.added).toEqual(['theme', 'settings'])
    expect(r.removed).toEqual(['misc'])
  })

  it('preserves proposed order for unchanged + added in the ordered sequence', () => {
    const r = arrayDiff(['A', 'B'], ['B', 'C', 'A'])
    expect(r.ordered.map((e) => e.value)).toEqual(['B', 'C', 'A'])
    expect(r.ordered.map((e) => e.status)).toEqual(['unchanged', 'added', 'unchanged'])
    expect(r.removed).toEqual([])
  })

  it('preserves baseline order for removed', () => {
    const r = arrayDiff(['x', 'y', 'z'], ['z'])
    expect(r.removed).toEqual(['x', 'y'])
    expect(r.unchanged).toEqual(['z'])
  })

  it('dedupes duplicate inputs', () => {
    const r = arrayDiff(['a', 'a'], ['a', 'a', 'b'])
    expect(r.unchanged).toEqual(['a'])
    expect(r.added).toEqual(['b'])
    expect(r.removed).toEqual([])
  })

  it('honours a custom equality comparator (case-insensitive)', () => {
    const ci = (x: string, y: string) => x.toLowerCase() === y.toLowerCase()
    const r = arrayDiff(['UI'], ['ui', 'Theme'], ci)
    expect(r.unchanged).toEqual(['ui'])
    expect(r.added).toEqual(['Theme'])
    expect(r.removed).toEqual([])
  })
})
