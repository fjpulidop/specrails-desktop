import { describe, it, expect } from 'vitest'
import { parseJsonTolerant, repairJsonText } from './json-tolerant'

describe('parseJsonTolerant', () => {
  it('strict JSON parses without repair', () => {
    const r = parseJsonTolerant('{"a": 1, "b": [1, 2]}')
    expect(r).toEqual({ ok: true, value: { a: 1, b: [1, 2] }, repaired: false, repairs: [] })
  })

  it('escapes raw newlines and tabs inside strings', () => {
    const r = parseJsonTolerant('{"d": "line one\nline two\tend"}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ d: 'line one\nline two\tend' })
      expect(r.repaired).toBe(true)
      expect(r.repairs).toEqual(expect.arrayContaining(['raw_newline', 'raw_control']))
    }
  })

  it('escapes stray inner double quotes but keeps real terminators', () => {
    const r = parseJsonTolerant('{"t": "He said "hi" to me", "k": "v"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ t: 'He said "hi" to me', k: 'v' })
  })

  it('drops trailing commas and comments outside strings only', () => {
    const r = parseJsonTolerant('{\n  // note\n  "a": [1, 2,], /* c */ "b": "x, y,", \n}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ a: [1, 2], b: 'x, y,' })
      expect(r.repairs).toEqual(expect.arrayContaining(['trailing_comma', 'comment']))
    }
  })

  it('unwraps a nested code fence and surrounding prose', () => {
    const r = parseJsonTolerant('Here you go:\n```json\n{"a": 1}\n```\nDone.')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ a: 1 })
      expect(r.repairs).toContain('trimmed_wrapper')
    }
    const fenced = parseJsonTolerant('```json\n{"a": 1}\n```')
    expect(fenced.ok).toBe(true)
    if (fenced.ok) expect(fenced.repairs).toContain('nested_fence')
  })

  it('keeps valid escapes and fixes invalid ones', () => {
    const r = parseJsonTolerant('{"a": "quote \\" ok \\n it\\\'s"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ a: 'quote " ok \n it\'s' })
  })

  it('reports an unrepairable payload with the strict parser diagnostic and an excerpt', () => {
    const r = parseJsonTolerant('{"a": 1 "b": 2}')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/JSON/)
      expect(typeof r.position === 'number' || r.position === null).toBe(true)
    }
  })

  it('never throws on garbage', () => {
    expect(parseJsonTolerant('').ok).toBe(false)
    expect(parseJsonTolerant('not json at all').ok).toBe(false)
    expect(parseJsonTolerant('{"a": "unterminated').ok).toBe(false)
  })

  it('repairJsonText handles a dangling escape at the end without throwing', () => {
    const { text, repairs } = repairJsonText('{"a": "x\\')
    expect(repairs).toContain('dangling_escape')
    expect(text.startsWith('{"a": "x')).toBe(true)
  })
})
